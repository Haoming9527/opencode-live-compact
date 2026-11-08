import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Candidate } from "../engine/planner.ts"
import { recoveryReferences } from "../recovery/integrity.ts"
import type { RecoveryPlan } from "../recovery/store.ts"

export type History = Awaited<ReturnType<Context["session"]["context"]>>
export type Assistant = Extract<History[number], { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
type Message = SessionContext["messages"][number]
type ToolMessage = Extract<Message, { role: "tool" }>
type ToolResult = ToolMessage["content"][number]

export const pairKey = (messageID: string, callID: string) => JSON.stringify([messageID, callID])

export function visibleResults(messages: readonly Message[]) {
  const calls = new Map<string, { messageID: string; name: string } | undefined>()
  const results = new Map<string, { index: number; message: ToolMessage; part: ToolResult; text: string }>()
  const seenResults = new Set<string>()
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && message.id) {
      for (const part of message.content) {
        if (part.type !== "tool-call") continue
        calls.set(part.id, calls.has(part.id) || part.providerExecuted ? undefined : { messageID: message.id, name: part.name })
      }
    }
    if (message.role !== "tool") continue
    for (const part of message.content) {
      const call = calls.get(part.id)
      if (!call) continue
      const key = pairKey(call.messageID, part.id)
      if (seenResults.has(key)) results.delete(key)
      else if (
        message.content.length === 1 &&
        part.name === call.name &&
        !part.providerExecuted &&
        typeof part.result === "object" && part.result !== null &&
        "type" in part.result && part.result.type === "text" &&
        "value" in part.result && typeof part.result.value === "string"
      ) {
        results.set(key, { index, message, part, text: part.result.value })
      }
      seenResults.add(key)
    }
  }
  // Even an ID collision discovered later invalidates a preceding match.
  for (const [key, result] of results) {
    if (!calls.get(result.part.id)) results.delete(key)
  }
  return results
}

function hasTerminalRound(tools: readonly Tool[]) {
  return tools.length > 0 && tools.every((tool) => tool.state.status === "completed" || tool.state.status === "error")
}

export function completedRounds(history: History, sessionID: string) {
  const pending: Assistant[] = []
  const rounds: Candidate[][] = []
  const finish = (succeeded: boolean) => {
    const eligible = succeeded && !pending.some((step) => step.error)
    for (const step of pending) {
      const tools = step.content.filter((part): part is Tool => part.type === "tool")
      if (!hasTerminalRound(tools)) continue
      rounds.push(eligible && tools.every((tool) => tool.state.status === "completed") ? tools.map((tool) => ({
        identity: { sessionID, messageID: step.id, partID: tool.id, callID: tool.id, tool: tool.name },
        tool,
      })) : [])
    }
    pending.length = 0
  }
  for (const entry of history) {
    if (entry.type === "assistant") pending.push(entry)
    if (entry.type === "idle") finish(entry.outcome === "succeeded")
  }
  // Called only by the host's successful end-of-work hook, before idle is persisted.
  finish(true)
  return rounds
}

export function completedProse(history: History, sessionID: string, currentTurn: string) {
  const candidates: Candidate[] = []
  let pending: Assistant[] = []
  for (const entry of history) {
    if (entry.type === "assistant") pending.push(entry)
    if (entry.type !== "idle") continue
    if (entry.outcome === "succeeded" && !pending.some((step) => step.error)) {
      for (const step of pending) {
        const candidate = step.id === currentTurn ? undefined : proseCandidate(step, sessionID)
        if (candidate) candidates.push(candidate)
      }
    }
    pending = []
  }
  return candidates
}

export function proseCandidate(step: Assistant, sessionID: string): Candidate | undefined {
  if (step.error || step.content.some((part) => part.type === "tool")) return
  const text = step.content.filter((part) => part.type === "text")
  if (text.length !== 1 || !text[0] || text[0].native !== undefined) return
  return {
    identity: { sessionID, messageID: step.id, callID: "text", partID: "text", tool: "assistant_text" },
    tool: { id: "text", name: "assistant_text", type: "tool", time: { created: 0 },
      state: { status: "completed", input: {}, content: [{ type: "text", text: text[0].text }] } },
  }
}

export function visibleTargets(messages: readonly Message[]) {
  const targets = new Map<string, { index: number; partIndex: number; name: string; text: string }>()
  for (const [key, result] of visibleResults(messages)) {
    targets.set(key, { index: result.index, partIndex: 0, name: result.part.name, text: result.text })
  }
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || !message.id ||
        message.content.some((part) => part.type !== "text" && part.type !== "reasoning")) continue
    const text = message.content.filter((part) => part.type === "text")
    if (text.length !== 1 || !text[0] || text[0].providerMetadata) continue
    const key = pairKey(message.id, "text")
    if (targets.has(key)) {
      targets.delete(key)
      continue
    }
    targets.set(key, { index, partIndex: message.content.indexOf(text[0]), name: "assistant_text", text: text[0].text })
  }
  return targets
}

export function completedTurnTokens(history: History, end: number, request: SessionContext) {
  const assistant = history.slice(0, end).findLast((entry) => entry.type === "assistant" || entry.type === "idle")
  if (assistant?.type !== "assistant" || assistant.error || !assistant.tokens ||
      assistant.agent !== request.agent || assistant.model.providerID !== request.model.providerID ||
      assistant.model.id !== request.model.id || assistant.model.variant !== request.model.variant) return undefined
  const { input, cache, output, reasoning } = assistant.tokens
  return input + cache.read + cache.write > 0 ? input + cache.read + cache.write + output + reasoning : undefined
}

export function activeReferences(history: History, plans: readonly RecoveryPlan[], visible: readonly unknown[]) {
  const parts = new Set<string>()
  const references = new Set<string>()
  const scan = (value: unknown) => {
    if (typeof value === "string") {
      for (const reference of recoveryReferences(value)) references.add(reference)
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) scan(nested)
    }
  }
  for (const entry of history) {
    if (entry.type === "assistant") {
      for (const part of entry.content) {
        if (part.type === "tool") {
          parts.add(pairKey(entry.id, part.id))
          if (part.state.status === "completed") scan(part.state.content)
        } else scan(part.text)
      }
    } else if (entry.type === "compaction" && entry.status === "completed") {
      scan(entry)
    } else if ("text" in entry) scan(entry.text)
  }
  for (const plan of plans) {
    if (parts.has(pairKey(plan.identity.messageID, plan.identity.callID))) references.add(plan.reference)
  }
  for (const value of visible) scan(value)
  return references
}
