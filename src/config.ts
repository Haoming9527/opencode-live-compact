import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export function readConfig(options: Readonly<Record<string, unknown>>) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = options[name]
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : fallback
  }
  const absolute = (name: string) => {
    const value = options[name]
    return typeof value === "string" && isAbsolute(value) ? value : undefined
  }
  const platformStateRoot = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : join(homedir(), ".local", "state")
  const stateRoot = process.env.XDG_STATE_HOME || platformStateRoot
  return {
    minimumContextTokens: integer("minimumContextTokens", 20_000, 1, 2_000_000),
    minimumSavingsTokens: integer("minimumSavingsTokens", 1_000, 1, 100_000),
    protectedToolRounds: integer("protectedToolRounds", 3, 0, 100),
    maxCutsPerCycle: integer("maxCutsPerCycle", 3, 1, 20),
    archiveDirectory: absolute("archiveDirectory") ?? join(stateRoot, "opencode-live-compact"),
    archiveMaxBytes: integer("archiveMaxBytes", 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    archiveMaxRecords: integer("archiveMaxRecords", 4096, 1, 65_536),
    archiveRetentionMs: integer("archiveRetentionMs", 7 * 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000),
    dryRun: options.dryRun === true,
    diagnostics: options.diagnostics === true,
    metricsFile: absolute("metricsFile"),
  }
}

export type Config = ReturnType<typeof readConfig>
