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
  const report = (sessionID: string, measurement: Measurement) => {
    if (!config.diagnostics) return
    const row = JSON.stringify({ time: new Date().toISOString(), sessionID, ...measurement })
    const file = config.metricsFile
    if (!file) {
      console.error(`[opencode-live-compact] ${row}`)
      return
    }
    pending = pending.then(() => appendFile(file, row + "\n", { mode: 0o600 })).catch(() => {})
  }
  return { report, flush: () => pending }
}

export type Collector = ReturnType<typeof createCollector>
