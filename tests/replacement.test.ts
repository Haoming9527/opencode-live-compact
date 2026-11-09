import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionCompaction } from "@opencode/plugin/promise/session"
import { readConfig } from "../src/config.ts"
import { pendingKey, replacementHooks } from "../src/hooks/replacement.ts"
import type { Collector } from "../src/metrics/collector.ts"
import type { RecoveryStore } from "../src/recovery/store.ts"

const sessionID = "ses_replacement_ownership" as SessionCompaction["sessionID"]
const model: SessionCompaction["model"] = {
  providerID: "local" as SessionCompaction["model"]["providerID"],
  id: "fixture" as SessionCompaction["model"]["id"],
}

function fixture(options: {
  storageFailures?: number
  historyFailures?: number
  archiveThrows?: boolean
  owned?: boolean
  missingPlan?: boolean
} = {}) {
  const calls = { storage: 0, history: 0, archive: 0 }
  const measurements: Parameters<Collector["report"]>[1][] = []
  const plan = { id: "msg_own_compaction", model, turn: "msg_completed", prefixHash: "unused",
    references: ["lc1_" + "a".repeat(32)], rounds: [], prose: [], saved: 1_500, suffix: 100, planningMs: 1 }
  const ctx = {
    storage: { get: async (key: string) => {
      assert.equal(key, pendingKey(sessionID))
      if (++calls.storage <= (options.storageFailures ?? 0)) throw new Error("Pending storage temporarily unavailable")
      return options.missingPlan ? undefined : plan
    } },
    session: { context: async (input: { sessionID: string }) => {
      assert.equal(input.sessionID, sessionID)
      if (++calls.history <= (options.historyFailures ?? 0)) throw new Error("Host history temporarily unavailable")
      return [
        { id: plan.turn, type: "assistant", model, content: [] },
        { id: options.owned === false ? "msg_native_compaction" : plan.id, type: "compaction", status: "running" },
      ]
    } },
  } as unknown as Context
  const store = { get: async (caller: string, reference: string) => {
    assert.equal(caller, sessionID)
    assert.equal(reference, plan.references[0])
    calls.archive++
    if (options.archiveThrows) throw new Error("Archive unavailable after admission")
    // A missing original must preserve the full view, even for a confirmed local operation.
    return undefined
  } } as unknown as RecoveryStore
  const metrics: Collector = { report: (_sessionID, measurement) => { measurements.push(measurement) }, flush: async () => {} }
  const hooks = replacementHooks(ctx, readConfig({}), store, metrics)
  const event: SessionCompaction = { sessionID, agent: "build" as SessionCompaction["agent"], model, system: [], tools: {}, options: {}, messages: [
    { role: "user", id: "msg_requirement", content: [{ type: "text", text: "Preserve this requirement exactly." }] },
    { role: "assistant", id: plan.turn, content: [{ type: "text", text: "The completed response." }] },
  ] }
  return { hooks, event, calls, measurements }
}

function fullReplay(event: SessionCompaction, original: string) {
  assert.equal(JSON.stringify(event.messages), original, "the hook must not mutate the incoming view")
  assert.ok(event.result, "a supplied result lets the host skip its model summary request")
  assert.equal(event.result.metadata?.liveCompact, "replacement-noop")
  assert.deepEqual(event.result.native?.messages, event.messages)
}

test("confirmed ownership uses one storage/history read and preserves unavailable originals", async () => {
  const { hooks, event, calls, measurements } = fixture()
  const original = JSON.stringify(event.messages)
  await hooks.compaction(event)
  fullReplay(event, original)
  assert.deepEqual(calls, { storage: 1, history: 1, archive: 1 })
  assert.deepEqual(measurements, [])
})

test("one transient history failure still produces an owned full replay without a model summary", async () => {
  const { hooks, event, calls, measurements } = fixture({ historyFailures: 1 })
  const original = JSON.stringify(event.messages)
  await hooks.compaction(event)
  fullReplay(event, original)
  assert.deepEqual(calls, { storage: 2, history: 2, archive: 1 })
  assert.deepEqual(measurements, [])
})

test("one transient pending-storage failure recovers a saved plan before preserving the full view", async () => {
  const { hooks, event, calls, measurements } = fixture({ storageFailures: 1 })
  const original = JSON.stringify(event.messages)
  await hooks.compaction(event)
  fullReplay(event, original)
  assert.deepEqual(calls, { storage: 2, history: 1, archive: 1 })
  assert.deepEqual(measurements, [])
})

test("an archive exception after confirmed ownership keeps the full local replay", async () => {
  const { hooks, event, calls, measurements } = fixture({ archiveThrows: true })
  const original = JSON.stringify(event.messages)
  await hooks.compaction(event)
  fullReplay(event, original)
  assert.deepEqual(calls, { storage: 1, history: 1, archive: 1 })
  assert.deepEqual(measurements, [{ event: "fallback", operation: "replacement-window" }])
})

for (const dependency of ["storage", "history"] as const) {
  test(`persistent ${dependency} failure stops after two attempts and leaves native compaction untouched`, async () => {
    const { hooks, event, calls, measurements } = fixture({ [`${dependency}Failures`]: Infinity })
    const original = JSON.stringify(event.messages)
    await hooks.compaction(event)
    assert.equal(event.result, undefined, "an unverified pending plan cannot claim a native compaction")
    assert.equal(JSON.stringify(event.messages), original)
    assert.equal(calls[dependency], 2)
    assert.equal(calls.archive, 0)
    assert.deepEqual(measurements, [{ event: "fallback", operation: "compaction-ownership-unavailable" }])
  })
}

test("a foreign running compaction is not claimed, including after a transient history failure", async () => {
  const { hooks, event, calls, measurements } = fixture({ owned: false, historyFailures: 1 })
  const original = JSON.stringify(event.messages)
  await hooks.compaction(event)
  assert.equal(event.result, undefined)
  assert.equal(JSON.stringify(event.messages), original)
  assert.deepEqual(calls, { storage: 2, history: 2, archive: 0 })
  assert.deepEqual(measurements, [])
})

test("missing plans and an existing hook result do not trigger extra ownership reads", async () => {
  const missing = fixture({ missingPlan: true })
  await missing.hooks.compaction(missing.event)
  assert.equal(missing.event.result, undefined)
  assert.deepEqual(missing.calls, { storage: 1, history: 0, archive: 0 })
  const supplied = fixture()
  const result = { summary: "Another plugin already handled this compaction." }
  supplied.event.result = result
  await supplied.hooks.compaction(supplied.event)
  assert.equal(supplied.event.result, result)
  assert.deepEqual(supplied.calls, { storage: 0, history: 0, archive: 0 })
})
