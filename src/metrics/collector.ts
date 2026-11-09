import { appendFile } from "node:fs/promises"
import type { Config } from "../config.ts"
import type { PlanningDiagnostics } from "../engine/planner.ts"

type Measurement =
  | { event: "cut" | "replacement"; count: number; strategy?: "spans" | "individual"; durationMs: number; planningMs?: number; applicationMs?: number; estimatedSavedTokens: number; estimatedCacheSuffixTokens: number; dryRun: boolean }
  | { event: "planning"; reason: string; strategy?: "spans" | "individual"; counts?: Record<string, number>; durationMs: number;
      contextTokens?: number; scoreUnit?: "prefix-weighted-savings";
      alternatives?: { individual: PlanningDiagnostics; spans: PlanningDiagnostics } }
  | { event: "context"; messageCount: number; durationMs: number }
  | { event: "recall"; success: boolean }
  | { event: "fallback"; operation: string }

export function createCollector(config: Config) {
  let pending = Promise.resolve()
  const states = new Map<string, { last: Measurement; planning?: Measurement; warning?: Measurement }>()
  const emitted = new Map<string, string>()
  const status = (sessionID: string) => states.get(sessionID) ?? { state: "waiting-for-completed-turn" }

  const report = (sessionID: string, measurement: Measurement) => {
    if (measurement.event !== "context") {
      const previous = states.get(sessionID)
      states.set(sessionID, { ...previous, last: measurement,
        ...(measurement.event === "planning" ? { planning: measurement } : {}),
        ...(measurement.event === "fallback" ? { warning: measurement } : {}) })
      if (states.size > 128) { const oldest = states.keys().next().value!; states.delete(oldest); emitted.delete(oldest) }
    }
    if (!config.diagnostics) {
      const reason = measurement.event === "planning" ? measurement.reason
        : measurement.event === "fallback" ? measurement.operation : undefined
      if (reason) {
        const key = `${measurement.event}:${reason}`
        if (emitted.get(sessionID) !== key) {
          emitted.set(sessionID, key)
          const warning = measurement.event === "fallback" || reason === "archive-unavailable"
          console.error(`[opencode-live-compact] ${warning ? "WARN" : "INFO"} ${JSON.stringify({ sessionID, reason })}`)
        }
      }
      return
    }
    const row = JSON.stringify({ time: new Date().toISOString(), sessionID, ...measurement })
    const file = config.metricsFile
    if (!file) {
      console.error(`[opencode-live-compact] ${row}`)
      return
    }
    pending = pending.then(() => appendFile(file, row + "\n", { mode: 0o600 })).catch(() => {})
  }
  return { report, flush: () => pending, status }
}

export type Collector = Pick<ReturnType<typeof createCollector>, "report" | "flush">
