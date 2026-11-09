import { randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionCompaction, SessionContext, SessionIdle } from "@opencode/plugin/promise/session"
import type { Config } from "../config.ts"
import { eligibleResult } from "../engine/eligibility.ts"
import type { EligibleResult } from "../engine/eligibility.ts"
import { createPlanningDiagnostics, planCuts, scorePlan } from "../engine/planner.ts"
import type { Candidate } from "../engine/planner.ts"
import { applySpans, planSpans, isSpanCheckpoint } from "../engine/span.ts"
import type { Collector } from "../metrics/collector.ts"
import { hashText } from "../recovery/integrity.ts"
import type { RecoveryStore } from "../recovery/store.ts"
import { completedProse, completedRounds, completedTurnTokens, pairKey, proseCandidate, visibleTargets } from "../state/reconciliation.ts"
import { contextSize, estimateTokens, suffixSizes, tokensAfterPart } from "./context.ts"

function activeToolMessages(history: Awaited<ReturnType<Context["session"]["context"]>>) {
  return new Set(history.flatMap(entry => entry.type === "assistant" && entry.content.some(part =>
    part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") ? [entry.id] : []))
}

const marker = "replacement-v1"
export const pendingKey = (id: string) => `replacement/${id}`
type Model = { providerID: string; id: string; variant?: string }
type Finished = Extract<Candidate["tool"]["state"], { status: "completed" }>
type Evidence = {
  identity: Candidate["identity"]
  input: Finished["input"]
  metadata: Finished["metadata"]
  hash: string
}
// Carry eligibility evidence, never executable commands or arbitrary tool metadata.
// Shell/search eligibility checks only the presence of a string input, not its
// contents. Empty sentinels preserve that check without duplicating long inputs.
function evidence(candidate: Candidate, hash: string): Evidence {
  const state = candidate.tool.state
  if (state.status !== "completed") throw new Error("Nonterminal evidence")
  const input = candidate.identity.tool === "read"
    ? Object.fromEntries(["path", "offset"].filter(key => key in state.input).map(key => [key, state.input[key]!]))
    : candidate.identity.tool === "shell" ? { command: "" }
    : ["glob", "grep"].includes(candidate.identity.tool) ? { pattern: "" } : {}
  const keys = candidate.identity.tool === "read" ? ["truncated"]
    : candidate.identity.tool === "glob" ? ["count", "truncated"]
    : candidate.identity.tool === "grep" ? ["matches", "truncated"]
    : candidate.identity.tool === "shell" ? ["exit", "signal", "timeout", "status", "shellID", "truncated"] : []
  const metadata = state.metadata ? Object.fromEntries(keys.filter(key => key in state.metadata!).map(key => [key, state.metadata![key]!])) : undefined
  return { identity: candidate.identity, input, metadata, hash }
}

type Pending = {
  id: string
  model: Model
  turn: string
  prefixHash: string
  rounds: Evidence[][]
  prose: Evidence[]
  references: string[]
  saved: number
  suffix: number
  planningMs: number
  strategy?: "spans" | "individual"
}

const sameModel = (left: Model | undefined, right: Model) =>
  left?.providerID === right.providerID && left.id === right.id && left.variant === right.variant

function recoverRounds(value: unknown, sessionID: string, visible: ReturnType<typeof visibleTargets>): Candidate[][] {
  if (!Array.isArray(value)) return []
  return (value as Evidence[][]).filter(Array.isArray).map((round) => round.flatMap((entry) => {
    if (entry?.identity?.sessionID !== sessionID) return []
    const { identity, input, metadata, hash } = entry
    const result = visible.get(pairKey(identity.messageID, identity.callID))
    if (!result || result.name !== identity.tool || hashText(result.text) !== hash) return []
    return [{
      identity,
      tool: {
        id: identity.callID, name: identity.tool, type: "tool", time: { created: 0 },
        state: { status: "completed", input, metadata, content: [{ type: "text", text: result.text }] },
      },
    }]
  }))
}

export function replacementHooks(ctx: Context, config: Config, store: RecoveryStore, metrics: Collector) {
  const requests = new Map<string, SessionContext>()
  const pending = new Map<string, Pending>()
  const context = (event: SessionContext) => {
    const start = performance.now()
    requests.delete(event.sessionID)
    requests.set(event.sessionID, event)
    if (requests.size > 32) requests.delete(requests.keys().next().value!)
    if (config.diagnostics) metrics.report(event.sessionID, {
      event: "context", messageCount: event.messages.length, durationMs: performance.now() - start,
    })
  }

  const idle = async ({ sessionID }: SessionIdle) => {
    const request = requests.get(sessionID)
    requests.delete(sessionID)
    if (!request) {
      metrics.report(sessionID, { event: "planning", reason: "no-request-snapshot", durationMs: 0 })
      return
    }
    pending.delete(sessionID)
    const started = performance.now()
    const skip = (reason: string, counts?: Record<string, number>) => metrics.report(sessionID, {
      event: "planning", reason, counts, durationMs: performance.now() - started,
    })
    try {
      const history = await ctx.session.context({ sessionID })
      const turn = history.findLast((entry) => entry.type === "assistant" || entry.type === "idle")
      if (turn?.type !== "assistant" || turn.error || !sameModel(turn.model, request.model)) return skip("unfinished-or-model-changed")
      if (history.some((entry) => entry.type === "system") || request.messages.some((message) =>
        message.role === "system" || message.content.some((part) => part.type === "media" ||
          (part.type === "tool-result" && part.result.type === "content" && part.result.value.some((item) => item.type === "file"))))) return skip("protected-instructions-or-media")
      const measured = completedTurnTokens(history, history.length, request)
      if (measured !== undefined && measured < config.minimumContextTokens) return skip("below-context-threshold")
      // Other hooks may edit this request. Measure its final view once, at idle.
      const suffix = suffixSizes(request)
      const total = contextSize(request, suffix[0]!)
      if ((measured ?? total) < config.minimumContextTokens) return skip("below-context-threshold")

      const protectedIDs = activeToolMessages(history)
      const visible = visibleTargets(request.messages)
      const previous = history.findLast((entry) => entry.type === "compaction" && entry.status === "completed")
      const prior = previous?.metadata?.liveCompact === marker &&
        previous.type === "compaction" && previous.status === "completed" && sameModel(previous.model, request.model)
        ? previous.metadata : undefined
      const carry = recoverRounds(prior?.liveCompactRounds, sessionID, visible)
      const rounds = [...carry, ...completedRounds(history, sessionID)]
      const prose = [...recoverRounds([prior?.liveCompactProse], sessionID, visible).flat(),
        ...completedProse(history, sessionID, turn.id)]
      const floor = Math.max(
        request.messages.findLastIndex(message => message.role === "assistant" &&
          message.content.some(part => part.type === "text" && isSpanCheckpoint(part.text))),
        ...Array.from(visible.values(), item => isSpanCheckpoint(item.text) || item.text.includes("[Live Compact omitted ") ? item.index : -1),
      )
      const counts = { protected: config.protectedToolRounds ? rounds.slice(-config.protectedToolRounds).flat().length : 0,
        beforeCheckpoint: 0, changed: 0, unsupported: 0, eligible: 0,
        sourceBelowMinimum: 0, sourceAtOrAboveMinimum: 0, sourceTokens: 0 }
      // Share parsing only while both planners inspect this same synchronous snapshot.
      // Queued application still rereads and verifies authoritative history and backups.
      const eligibleResults = new Map<Candidate, EligibleResult>()
      const available = [...rounds.slice(0, Math.max(0, rounds.length - config.protectedToolRounds)).flat(), ...prose].flatMap((candidate) => {
        const { messageID, callID } = candidate.identity
        if (protectedIDs.has(messageID)) return []
        const match = visible.get(pairKey(messageID, callID))
        if (!match) { counts.changed++; return [] }
        if (match.index <= floor) { counts.beforeCheckpoint++; return [] }
        const source = eligibleResult(candidate)
        if (!source) { counts.unsupported++; return [] }
        if (source.sourceText !== match.text) { counts.changed++; return [] }
        counts.eligible++
        const sourceTokens = estimateTokens(source.sourceText)
        counts.sourceTokens += sourceTokens
        if (sourceTokens < config.minimumSourceTokens) counts.sourceBelowMinimum++
        else counts.sourceAtOrAboveMinimum++
        const indexed = { ...candidate, index: match.index,
          suffixTokens: (suffix[match.index + 1] ?? 0) + tokensAfterPart(request.messages[match.index]!, match.partIndex) }
        eligibleResults.set(indexed, source)
        return [indexed]
      }).sort((a, b) => a.index - b.index)
      if (!available.length) return skip("no-eligible-history", counts)
      const options = { minimumSourceTokens: config.minimumSourceTokens, maxCutsPerCycle: config.maxCutsPerCycle,
        estimateTokens, eligibleResults }
      const alternatives = { individual: createPlanningDiagnostics(), spans: createPlanningDiagnostics() }
      const spanBatch = config.compactSpans ? planSpans(sessionID, request.messages, available, suffix,
        { ...options, diagnostics: alternatives.spans }) : []
      const individual = planCuts(available, { ...options, diagnostics: alternatives.individual })
      eligibleResults.clear()
      const reportDecision = (reason: string, strategy?: "spans" | "individual") => metrics.report(sessionID, { event: "planning", reason, strategy, counts, alternatives,
        contextTokens: measured ?? total, scoreUnit: "prefix-weighted-savings", durationMs: performance.now() - started })
      const spanSaved = spanBatch.reduce((sum, span) => sum + span.saved, 0)
      const individualSaved = individual.reduce((sum, cut) => sum + cut.estimatedSavingsTokens, 0)
      const useSpans = spanBatch.length > 0 && scorePlan(spanSaved, spanBatch[0]!.suffix) >=
        scorePlan(individualSaved, individual[0]?.cacheSuffixTokens ?? 0)
      const spans = useSpans ? spanBatch : []
      const cuts = useSpans ? [] : individual
      if (!spans.length && !cuts.length) return reportDecision("insufficient-savings")
      const saved = useSpans ? spanSaved : individualSaved
      const rebuilt = useSpans ? spans[0]!.suffix : cuts[0]!.cacheSuffixTokens
      reportDecision("admitted", useSpans ? "spans" : "individual")
      if (config.dryRun) {
        metrics.report(sessionID, { event: "cut", count: spans.length || cuts.length, durationMs: performance.now() - started,
          estimatedSavedTokens: saved, estimatedCacheSuffixTokens: rebuilt, dryRun: true })
        return
      }
      // The summary route can use an explicitly configured auxiliary model.
      const agent = await ctx.agent.get({ agentID: "compaction" }).catch(() => undefined)
      if (agent?.data?.model && !sameModel(agent.data.model, request.model)) return skip("compaction-model-changed")
      const archives = spans.length ? spans.map(({ identity, reference, sourceHash, checkpoint, original }) =>
        ({ identity, reference, sourceHash, checkpoint, original })) : cuts.map(cut => ({
        identity: cut.identity, reference: cut.reference, sourceHash: cut.sourceHash,
        checkpoint: cut.replacement, original: cut.sourceText,
      }))
      if (!await store.preserveBatch(archives)) return skip("archive-unavailable", counts)
      const references = archives.map(archive => archive.reference)
      const positions = spans.length ? spans.flatMap(span => [span.start, span.lastChanged]) : cuts
        .map((cut) => visible.get(pairKey(cut.identity.messageID, cut.identity.callID))!.index)
      const lastCut = Math.max(...positions)
      // The replacement becomes the next active-history boundary. Carry every
      // unchanged eligible result after the cut so a later turn can still select it.
      // Empty round slots matter: they preserve the age of the protected recent work.
      const remainingRounds = rounds.map((round) => round.flatMap((candidate) => {
        const { identity, tool } = candidate
        const result = visible.get(pairKey(identity.messageID, identity.callID))
        if (!result || result.index <= lastCut || tool.state.status !== "completed" ||
            eligibleResult(candidate)?.sourceText !== result.text) return []
        return [evidence(candidate, hashText(result.text))]
      }))
      let firstRound = 0
      while (firstRound < remainingRounds.length - Math.max(1, config.protectedToolRounds) && !remainingRounds[firstRound]!.length) firstRound++
      const tail = remainingRounds.slice(firstRound)
      const latestProse = proseCandidate(turn, sessionID)
      const keptProse = [...prose, ...(latestProse ? [latestProse] : [])].flatMap(candidate => {
        const source = eligibleResult(candidate)
        const position = visible.get(pairKey(candidate.identity.messageID, candidate.identity.callID))?.index
        if (!source || (candidate !== latestProse && (position === undefined || position <= lastCut))) return []
        return [{ identity: candidate.identity, input: {}, hash: hashText(source.sourceText), metadata: undefined }]
      })
      const plan: Pending = { id: `msg_${randomUUID().replaceAll("-", "")}`, model: request.model, turn: turn.id,
        prefixHash: hashText(JSON.stringify(request.messages.slice(0, Math.min(...positions)))),
        references, rounds: tail, prose: keptProse, saved, suffix: rebuilt, strategy: useSpans ? "spans" : "individual",
        planningMs: performance.now() - started }
      await ctx.storage.set(pendingKey(sessionID), JSON.parse(JSON.stringify(plan)))
      pending.set(sessionID, plan)
      if (pending.size > 64) pending.delete(pending.keys().next().value!)
      await ctx.session.compact({ sessionID, id: plan.id, delivery: "queue" })
    } catch {
      metrics.report(sessionID, { event: "fallback", operation: "replacement-admission" })
    }
  }

  const compactionOwnership = async (sessionID: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const plan = pending.get(sessionID) ?? await ctx.storage.get(pendingKey(sessionID)) as Pending | undefined
        if (!plan) return
        const history = await ctx.session.context({ sessionID })
        if (!history.some((entry) => entry.id === plan.id && entry.type === "compaction" && entry.status === "running")) return
        return { plan, history }
      } catch {
        if (attempt === 1) metrics.report(sessionID, { event: "fallback", operation: "compaction-ownership-unavailable" })
      }
    }
  }

  const compaction = async (event: SessionCompaction) => {
    const { sessionID } = event
    const started = performance.now()
    try {
      if (config.dryRun || event.result) return
      const ownership = await compactionOwnership(sessionID)
      if (!ownership) return
      const { plan, history } = ownership
      pending.delete(sessionID)
      // Once we own the request, a changed window or unavailable archive leaves a
      // full replayable window and still suppresses the provider summary call.
      // Hooks receive a detached request. Reuse unchanged messages and copy only edits.
      const full = event.messages.slice()
      event.result = { summary: "Live Compact preserved the full context.", native: { messages: full },
        metadata: { keepID: null, liveCompact: "replacement-noop", liveCompactInputID: plan.id } }
      const preserve = (operation: string) => metrics.report(sessionID, { event: "fallback", operation })
      const turn = history.findLast((entry) => entry.type === "assistant")
      if (turn?.id !== plan.turn || !sameModel(plan.model, event.model) || event.messages.some((message) => message.role === "system")) return preserve("replacement-context-changed")
      const replacements = new Map<number, { partIndex: number; checkpoint: string }>()
      let spanMessages: typeof event.messages | undefined
      const records = await store.getBatch(sessionID, plan.references)
      if (records.some(record => !record?.active)) return preserve("replacement-archive-unavailable")
      if (records.every(record => record?.identity.tool === "completed_span")) {
        spanMessages = applySpans(event.messages, records.filter(record => record !== undefined), plan.prefixHash)
        if (!spanMessages) return preserve("replacement-span-changed")
      } else {
        // Span replay validates its own pairs; it does not need this second index.
        const visible = visibleTargets(event.messages)
        for (const record of records) {
          if (!record || record.identity.tool === "completed_span") return preserve("replacement-record-invalid")
          const match = visible.get(pairKey(record.identity.messageID, record.identity.callID))
          if (!match || match.name !== record.identity.tool || match.text !== record.original ||
              Buffer.byteLength(JSON.stringify(record.checkpoint)) >= Buffer.byteLength(JSON.stringify(match.text))) return preserve("replacement-result-changed")
          replacements.set(match.index, { partIndex: match.partIndex, checkpoint: record.checkpoint })
        }
      }
      if (!spanMessages && hashText(JSON.stringify(event.messages.slice(0, Math.min(...replacements.keys())))) !== plan.prefixHash) return preserve("replacement-prefix-changed")
      const messages = spanMessages ?? full.map((message: (typeof event.messages)[number], index: number) => {
        const replacement = replacements.get(index)
        if (!replacement) return message
        const { partIndex, checkpoint } = replacement
        return { ...message, content: message.content.map((part, i) => {
          if (i !== partIndex) return part
          if (part.type === "text") return { ...part, text: checkpoint }
          if (part.type === "tool-result") return { ...part, result: { type: "text", value: checkpoint } }
          return part
        }) }
      })
      // Recheck authoritative tool states after queueing. Preserve entire active
      // rounds, including calls, reasoning and any partial results.
      const active = activeToolMessages(history)
      const activeCalls = new Set(event.messages.flatMap(message =>
        message.id && active.has(message.id) ? message.content.flatMap(part =>
          part.type === "tool-call" ? [part.id] : []) : []))
      for (let i = 0; i < event.messages.length; i++) {
        const original = event.messages[i]!
        if ((original.id && active.has(original.id)) || original.content.some(part =>
          part.type === "tool-result" && activeCalls.has(part.id))) {
          if (JSON.stringify(messages[i]) !== JSON.stringify(original)) return preserve("replacement-active-tool")
        }
      }
      event.result = { summary: spanMessages ? "Live Compact shortened a completed span." : "Live Compact shortened completed tool results.", native: { messages },
        metadata: { keepID: null, liveCompact: marker, liveCompactRounds: plan.rounds, liveCompactProse: plan.prose, liveCompactInputID: plan.id } }
      metrics.report(sessionID, { event: "replacement", count: plan.references.length, strategy: plan.strategy,
        durationMs: plan.planningMs + performance.now() - started, planningMs: plan.planningMs,
        applicationMs: performance.now() - started, estimatedSavedTokens: plan.saved,
        estimatedCacheSuffixTokens: plan.suffix, dryRun: false })
    } catch {
      metrics.report(sessionID, { event: "fallback", operation: "replacement-window" })
    }
  }
  return { context, idle, compaction }
}
