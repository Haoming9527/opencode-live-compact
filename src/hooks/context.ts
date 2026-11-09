import type { SessionContext } from "@opencode/plugin/promise/session"

export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4)

type Message = SessionContext["messages"][number]

function estimatePart(part: Message["content"][number], estimate: typeof estimateTokens) {
  if ("text" in part && typeof part.text === "string") return estimate(part.text)
  if (part.type === "tool-call") return estimate(part.name + JSON.stringify(part.input))
  if (part.type === "tool-result") {
    const result = part.result
    return estimate(
      result && typeof result === "object" && "type" in result && result.type === "text" &&
      "value" in result && typeof result.value === "string" ? result.value : JSON.stringify(result),
    )
  }
  return 0
}

/** Retained content after an edited part still belongs to the rebuilt suffix. */
export function tokensAfterPart(message: Message, partIndex: number, estimate = estimateTokens) {
  let tokens = 0
  for (let index = partIndex + 1; index < message.content.length; index++) {
    tokens += estimatePart(message.content[index]!, estimate)
  }
  return tokens
}

// This provider-independent estimate is separate from billed usage.
function estimateMessage(message: Message) {
  return 4 + tokensAfterPart(message, -1)
}

export function suffixSizes(event: SessionContext) {
  const suffix = new Array<number>(event.messages.length + 1).fill(0)
  for (let index = event.messages.length - 1; index >= 0; index--) {
    suffix[index] = suffix[index + 1]! + estimateMessage(event.messages[index]!)
  }
  return suffix
}

export function contextSize(event: SessionContext, messages: number) {
  return messages +
    event.system.reduce((sum, part) => sum + estimateTokens(part.text), 0) +
    Object.entries(event.tools).reduce((sum, [name, tool]) => (
      sum + estimateTokens(name + tool.description + JSON.stringify(tool.input))
    ), 0)
}
