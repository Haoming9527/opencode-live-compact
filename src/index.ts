import { Plugin } from "@opencode/plugin"
import { readConfig } from "./config.ts"
import { replacementHooks } from "./hooks/replacement.ts"
import { watchSessionEvents } from "./hooks/session.ts"
import { createCollector } from "./metrics/collector.ts"
import { maxRecallCodePoints, restore } from "./recovery/restore.ts"
import { RecoveryStore } from "./recovery/store.ts"

export default Plugin.define({
  id: "opencode-live-compact",
  async setup(ctx) {
    const config = readConfig(ctx.options)
    const metrics = createCollector(config)
    const store = new RecoveryStore({
      directory: config.archiveDirectory,
      maxBytes: config.archiveMaxBytes,
      maxRecords: config.archiveMaxRecords,
      retentionMs: config.archiveRetentionMs,
    })
    const registrations: { dispose(): Promise<void> }[] = []
    const replacement = replacementHooks(ctx, config, store, metrics)
    const stop = watchSessionEvents(ctx, store, metrics, config.dryRun)
    const cleanup = async () => {
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
      await stop()
      await Promise.allSettled([store.close(), metrics.flush()])
    }

    try {
      registrations.push(await ctx.session.hook("compaction", replacement.compaction))
      registrations.push(await ctx.session.hook("experimental.idle", replacement.idle))
      registrations.push(await ctx.tool.transform((editor) => {
        editor.add({
          name: "live_compact_status",
          description: "Check this session's latest Live Compact planning or failure reason. Contains no conversation content.",
          options: { codemode: false },
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_input, { sessionID }) => ({ content: JSON.stringify(metrics.status(sessionID)) }),
        })
        editor.add({
          name: "live_compact_recall",
          description: "Retrieve exact text from a Live Compact checkpoint in this session. Use the reference printed in the checkpoint and continue with nextOffset as needed.",
          options: { codemode: false },
          input: {
            type: "object",
            properties: {
              reference: { type: "string", pattern: "^lc1_[0-9a-f]{32}$" },
              offset: { type: "integer", minimum: 0, description: "Zero-based Unicode code point offset in the original text." },
              limit: { type: "integer", minimum: 1, maximum: maxRecallCodePoints },
            },
            required: ["reference"],
            additionalProperties: false,
          },
          execute: async (input, { sessionID }) => {
            const { reference, offset, limit } = input as { reference: string; offset?: number; limit?: number }
            const result = await restore(store, sessionID, reference, offset, limit)
            metrics.report(sessionID, { event: "recall", success: result.status === "ok" })
            return { content: JSON.stringify(result) }
          },
        })
      }))
      await ctx.tool.reload()
      registrations.push(await ctx.session.hook("context", replacement.context))
    } catch {
      metrics.report("", { event: "fallback", operation: "setup" })
      await cleanup()
      return
    }
    return cleanup
  },
})
