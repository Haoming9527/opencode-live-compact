import type { SessionContext } from "@opencode/plugin/promise/session"

export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4)

// This provider-independent estimate is separate from billed usage.
function estimateMessage(message: SessionContext["messages"][number]) {
  return 4 + message.content.reduce((sum, part) => {
    if ("text" in part && typeof part.text === "string") return sum + estimateTokens(part.text)
    if (part.type === "tool-call") return sum + estimateTokens(part.name + JSON.stringify(part.input))
    if (part.type === "tool-result") {
      const result = part.result
      return sum + estimateTokens(
        result && typeof result === "object" && "type" in result && result.type === "text" &&
        "value" in result && typeof result.value === "string" ? result.value : JSON.stringify(result),
      )
    }
    return sum
  }, 0)
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
