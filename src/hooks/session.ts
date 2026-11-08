import { setTimeout as delay } from "node:timers/promises"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Collector } from "../metrics/collector.ts"
import type { RecoveryStore } from "../recovery/store.ts"
import { activeReferences } from "../state/reconciliation.ts"
import { pendingKey } from "./replacement.ts"

export function watchSessionEvents(ctx: Context, store: RecoveryStore, metrics: Collector, dryRun: boolean) {
  const controller = new AbortController()
  const subscribed = (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
          types: ["session.compaction.ended", "session.deleted"],
        })) {
          if (event.location && event.location.directory !== ctx.location.directory) continue
          const { sessionID } = event.data
          if (dryRun) continue
          try {
            if (event.type === "session.deleted") {
              await ctx.storage.remove(pendingKey(sessionID))
              await store.deleteSession(sessionID)
            } else if (event.data.native?.messages === undefined) {
              // A local summary bounds all models. Model-specific and opaque
              // windows may still replay, so those keep their archive references.
              const plans = await store.list(sessionID)
              if (!plans.length) continue
              const history = await ctx.session.context({ sessionID })
              const latest = history.findLast((item) => item.type === "compaction" && item.status === "completed")
              if (latest?.type !== "compaction" || latest.status !== "completed" || latest.native?.messages !== undefined) continue
              await store.reconcile(sessionID, activeReferences(history, plans, []), new Set(plans.map((plan) => plan.reference)))
            }
          } catch {
            metrics.report(sessionID, { event: "fallback", operation: "session-cleanup" })
          }
        }
      } catch {
        if (!controller.signal.aborted) metrics.report("", { event: "fallback", operation: "event-stream" })
      }
      await delay(1_000, undefined, { signal: controller.signal }).catch(() => {})
    }
  })()
  return async () => {
    controller.abort()
    await subscribed
  }
}

