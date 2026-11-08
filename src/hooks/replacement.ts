import { randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionCompaction, SessionContext, SessionIdle } from "@opencode/plugin/promise/session"
import type { Config } from "../config.ts"
import { eligibleResult } from "../engine/eligibility.ts"
import { planCuts } from "../engine/planner.ts"
import type { Candidate } from "../engine/planner.ts"
import { applySpan, planSpan, spanMarker } from "../engine/span.ts"
import type { Collector } from "../metrics/collector.ts"
import { hashText } from "../recovery/integrity.ts"
import type { RecoveryStore } from "../recovery/store.ts"
import { completedProse, completedRounds, completedTurnTokens, pairKey, proseCandidate, visibleTargets } from "../state/reconciliation.ts"
import { contextSize, estimateTokens, suffixSizes } from "./context.ts"

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
      event: "context", estimatedTokens: contextSize(event, suffixSizes(event)[0]!),
      estimatedReducedTokens: 0, durationMs: performance.now() - start,
    })
  }

  const idle = async ({ sessionID, background }: SessionIdle) => {
    const request = requests.get(sessionID)
    requests.delete(sessionID)
    if (!request || background.length) return
    pending.delete(sessionID)
    const started = performance.now()
    try {
      const history = await ctx.session.context({ sessionID })
      const turn = history.findLast((entry) => entry.type === "assistant" || entry.type === "idle")
      if (turn?.type !== "assistant" || turn.error || !sameModel(turn.model, request.model)) return
      // A saved window advances the host instruction baseline. Keep histories with
      // chronological instruction updates on the ordinary OpenCode path.
      if (history.some((entry) => entry.type === "system") || request.messages.some((message) =>
        message.role === "system" || message.content.some((part) => part.type === "media" ||
          (part.type === "tool-result" && part.result.type === "content" && part.result.value.some((item) => item.type === "file"))))) return
      const measured = completedTurnTokens(history, history.length, request)
      if (measured !== undefined && measured < config.minimumContextTokens) return
      const suffix = suffixSizes(request)
      if ((measured ?? contextSize(request, suffix[0]!)) < config.minimumContextTokens) return

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
          message.content.some(part => part.type === "text" && part.text.startsWith(spanMarker))),
        ...Array.from(visible.values(), item => item.text.includes("[Live Compact omitted ") ? item.index : -1),
      )
      const available = [...rounds.slice(0, Math.max(0, rounds.length - config.protectedToolRounds)).flat(), ...prose].flatMap((candidate) => {
        const { messageID, callID } = candidate.identity
        const match = visible.get(pairKey(messageID, callID))
        const source = eligibleResult(candidate)
        if (!match || match.index <= floor || source?.sourceText !== match.text) return []
        return [{ ...candidate, index: match.index, suffixTokens: suffix[match.index + 1] ?? 0 }]
      }).sort((a, b) => a.index - b.index)
      const options = { ...config, estimateTokens }
      const span = config.compactSpans ? planSpan(sessionID, request.messages, available, suffix, options) : undefined
      const cuts = span ? [] : planCuts(available, options)
      if (!span && !cuts.length) return
      if (config.dryRun) {
        metrics.report(sessionID, { event: "cut", count: span ? 1 : cuts.length, durationMs: performance.now() - started,
          estimatedSavedTokens: span?.saved ?? cuts.reduce((total, cut) => total + cut.estimatedSavingsTokens, 0),
          estimatedCacheSuffixTokens: span?.suffix ?? Math.max(...cuts.map((cut) => cut.cacheSuffixTokens)), dryRun: true })
        return
      }
      // The summary route can use an explicitly configured auxiliary model.
      const agent = await ctx.agent.get({ agentID: "compaction" }).catch(() => undefined)
      if (agent?.data?.model && !sameModel(agent.data.model, request.model)) return
      const references: string[] = []
      let saved = 0
      if (span) {
        const { identity, reference, sourceHash, checkpoint, original } = span
        if (!await store.preserve({ identity, reference, sourceHash, checkpoint, original })) return
        references.push(reference)
        saved = span.saved
      }
      for (const cut of cuts) {
        if (!await store.preserve({ identity: cut.identity, reference: cut.reference, sourceHash: cut.sourceHash,
          checkpoint: cut.replacement, original: cut.sourceText })) continue
        references.push(cut.reference)
        saved += cut.estimatedSavingsTokens
      }
      if (!references.length) return
      const positions = span ? [span.start, span.end - 1] : cuts.filter((cut) => references.includes(cut.reference))
        .map((cut) => visible.get(pairKey(cut.identity.messageID, cut.identity.callID))!.index)
      const lastCut = Math.max(...positions)
      const tail = rounds.slice(-Math.max(1, config.protectedToolRounds)).map((round) => round.flatMap((candidate) => {
        const { identity, tool } = candidate
        const result = visible.get(pairKey(identity.messageID, identity.callID))
        if (!result || result.index <= lastCut || tool.state.status !== "completed" ||
            eligibleResult(candidate)?.sourceText !== result.text) return []
        return [{ identity, input: tool.state.input, metadata: tool.state.metadata, hash: hashText(result.text) }]
      }))
      const latestProse = proseCandidate(turn, sessionID)
      const keptProse = [...prose, ...(latestProse ? [latestProse] : [])].flatMap(candidate => {
        const source = eligibleResult(candidate)
        const position = visible.get(pairKey(candidate.identity.messageID, candidate.identity.callID))?.index
        if (!source || (candidate !== latestProse && (position === undefined || position <= lastCut))) return []
        return [{ identity: candidate.identity, input: {}, hash: hashText(source.sourceText), metadata: undefined }]
      })
      const plan: Pending = { id: `msg_${randomUUID().replaceAll("-", "")}`, model: request.model, turn: turn.id,
        prefixHash: hashText(JSON.stringify(request.messages.slice(0, Math.min(...positions)))),
        references, rounds: tail, prose: keptProse, saved, suffix: span?.suffix ?? Math.max(...cuts.map((cut) => cut.cacheSuffixTokens)),
        planningMs: performance.now() - started }
      await ctx.storage.set(pendingKey(sessionID), JSON.parse(JSON.stringify(plan)))
      pending.set(sessionID, plan)
      if (pending.size > 64) pending.delete(pending.keys().next().value!)
      await ctx.session.compact({ sessionID, id: plan.id, delivery: "queue" })
    } catch {
      metrics.report(sessionID, { event: "fallback", operation: "replacement-admission" })
    }
  }

  const compaction = async (event: SessionCompaction) => {
    const { sessionID } = event
    const started = performance.now()
    try {
      if (config.dryRun || event.result) return
      const plan = pending.get(sessionID) ?? await ctx.storage.get(pendingKey(sessionID)) as Pending | undefined
      if (!plan) return
      const history = await ctx.session.context({ sessionID })
      if (!history.some((entry) => entry.id === plan.id && entry.type === "compaction" && entry.status === "running")) return
      pending.delete(sessionID)
      // Once we own the request, a changed window or unavailable archive leaves a
      // full replayable window and still suppresses the provider summary call.
      const full = JSON.parse(JSON.stringify(event.messages))
      event.result = { summary: "Live Compact preserved the full context.", native: { messages: full },
        metadata: { keepID: null, liveCompact: "replacement-noop", liveCompactInputID: plan.id } }
      const turn = history.findLast((entry) => entry.type === "assistant")
      if (turn?.id !== plan.turn || !sameModel(plan.model, event.model) || event.messages.some((message) => message.role === "system")) return
      const visible = visibleTargets(event.messages)
      const replacements = new Map<number, { partIndex: number; checkpoint: string }>()
      let spanMessages: typeof event.messages | undefined
      for (const reference of plan.references) {
        const record = await store.get(sessionID, reference)
        if (!record?.active) return
        if (record.identity.tool === "completed_span") {
          if (plan.references.length !== 1) return
          spanMessages = applySpan(event.messages, record, plan.prefixHash)
          if (!spanMessages) return
          break
        }
        const match = visible.get(pairKey(record.identity.messageID, record.identity.callID))
        if (!match || match.name !== record.identity.tool || match.text !== record.original ||
            Buffer.byteLength(JSON.stringify(record.checkpoint)) >= Buffer.byteLength(JSON.stringify(match.text))) return
        replacements.set(match.index, { partIndex: match.partIndex, checkpoint: record.checkpoint })
      }
      if (!spanMessages && hashText(JSON.stringify(event.messages.slice(0, Math.min(...replacements.keys())))) !== plan.prefixHash) return
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
      event.result = { summary: spanMessages ? "Live Compact shortened a completed span." : "Live Compact shortened completed tool results.", native: { messages },
        metadata: { keepID: null, liveCompact: marker, liveCompactRounds: plan.rounds, liveCompactProse: plan.prose, liveCompactInputID: plan.id } }
      metrics.report(sessionID, { event: "replacement", count: plan.references.length,
        durationMs: plan.planningMs + performance.now() - started, estimatedSavedTokens: plan.saved,
        estimatedCacheSuffixTokens: plan.suffix, dryRun: false })
    } catch {
      metrics.report(sessionID, { event: "fallback", operation: "replacement-window" })
    }
  }
  return { context, idle, compaction }
}
