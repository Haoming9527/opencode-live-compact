import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session"
import { readConfig } from "../src/config.ts"
import { replacementHooks } from "../src/hooks/replacement.ts"
import type { Collector } from "../src/metrics/collector.ts"
import type { PreserveInput, RecoveryRecord, RecoveryStore } from "../src/recovery/store.ts"
import type { History } from "../src/state/reconciliation.ts"
import { pairKey, visibleTargets } from "../src/state/reconciliation.ts"

type Message = SessionContext["messages"][number]
const sessionID = "ses_retained_history" as SessionContext["sessionID"]
const model = { providerID: "local", id: "fixture" } as SessionContext["model"]
const agent = "build" as SessionContext["agent"]

function fixture(recentErrors: boolean, mixedSpan = false, options: Record<string, unknown> = {}) {
  const messages: Message[] = [{ role: "user", id: "msg_requirement", content: [{ type: "text", text: "Keep the earlier requirements." }] }]
  const rounds: unknown[] = []
  const append = (name: string, lines: number, width: number, error = false) => {
    const id = `call_${name}`, messageID = `msg_${name}`, path = `src/${name}.ts`
    const text = [`Read file ${path}, lines 1-${lines}`, ...Array.from({ length: lines }, (_, i) => `${i + 1}: ${"x".repeat(width)}`)].join("\n")
    messages.push({ role: "assistant", id: messageID, content: [{ type: "tool-call", id, name: "read", input: { path } }] },
      { role: "tool", content: [{ type: "tool-result", id, name: "read", result: { type: "text", value: text } }] })
    rounds.push({ type: "assistant", id: messageID, model, agent, content: [{
      type: "tool", id, name: "read", time: { created: 1, completed: 2 },
      state: error ? { status: "error", input: { path }, error: "Already handled tool failure." }
        : { status: "completed", input: { path }, metadata: { truncated: false }, content: [{ type: "text", text }] },
    }] })
  }
  if (mixedSpan) {
    append("span1", 24, 360)
    append("span2", 24, 360)
    append("span_tail", 1, 8)
    const calls = [messages[1]!, messages[3]!, messages[5]!]
    const first = calls[0]!
    assert.equal(first.role, "assistant")
    messages.splice(1, 6, { ...first, content: [
      { type: "reasoning", text: "Keep this reasoning and all three parallel calls exactly.",
        providerMetadata: { fixture: { signature: "retained" } } },
      ...calls.flatMap(message => {
        assert.equal(message.role, "assistant")
        return message.content
      }),
    ] }, messages[2]!, messages[4]!, messages[6]!)
    const parallel = rounds.slice(0, 3) as { content: unknown[] }[]
    rounds.splice(0, 3, { ...parallel[0], content: parallel.flatMap(round => round.content) })
    messages.push({ role: "user", id: "msg_boundary", content: [{ type: "text", text: "Continue with the next file." }] })
    append("retained", 120, 80)
  } else {
    append("large", 200, 300)
    append("retained", 120, 180)
  }
  if (!recentErrors && !mixedSpan) {
    append("small1", 1, 8)
    append("small2", 1, 8)
  }
  for (let i = 1; i <= 3; i++) append(`recent${i}`, 1, 8, recentErrors)
  const answer = (id: string) => ({ type: "assistant", id, model, agent,
    content: [{ type: "text", text: "The turn finished." }],
    tokens: { input: 30_000, output: 12, reasoning: 0, cache: { read: 0, write: 0 } } })
  let history = [...rounds, answer("msg_finished1")] as History
  const storage = new Map<string, unknown>()
  const archives = new Map<string, RecoveryRecord>()
  const queued: { id: string }[] = []
  const ctx = {
    model: { list: async () => ({ data: [{ ...model, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] }) },
    agent: { get: async () => ({}) },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value) } },
    session: {
      context: async () => history,
      compact: async ({ id }: { id: string }) => { queued.push({ id }) },
    },
  } as unknown as Context
  const store = {
    preserveBatch: async (inputs: PreserveInput[]) => {
      for (const input of inputs) archives.set(input.reference, { ...input, active: true, version: 1 })
      return true
    },
    getBatch: async (caller: string, references: readonly string[]) =>
      references.map(reference => caller === sessionID ? archives.get(reference) : undefined),
  } as unknown as RecoveryStore
  const measurements: Parameters<Collector["report"]>[1][] = []
  const metrics: Collector = { report: (_sessionID, measurement) => { measurements.push(measurement) }, flush: async () => {} }
  const config = readConfig({ compactSpans: mixedSpan, maxCutsPerCycle: 1, ...options })
  const request = (value: Message[]): SessionContext => ({ sessionID, agent, model, system: [], tools: {}, options: {}, messages: value })
  const makeHooks = () => replacementHooks(ctx, config, store, metrics)
  const apply = async (hooks: ReturnType<typeof makeHooks>, view: Message[], turn: number) => {
    const queuedID = queued.at(-1)?.id
    assert.ok(queuedID)
    history = [...history, { id: queuedID, type: "compaction", status: "running" }] as History
    const event: SessionCompaction = { ...request(view), messages: [...view, {
      role: "assistant", id: `msg_finished${turn}`, content: [{ type: "text", text: "The turn finished." }],
    }] }
    await hooks.compaction(event)
    assert.equal(event.result?.metadata?.liveCompact, "replacement-v1")
    assert.ok(Array.isArray(event.result.native?.messages))
    return event.result
  }
  return { messages, queued, request, makeHooks, apply, measurements,
    resume(result: NonNullable<SessionCompaction["result"]>) {
      history = [{ id: queued[0]!.id, type: "compaction", status: "completed", model,
        metadata: result.metadata, native: result.native },
      { id: "msg_idle", type: "idle", outcome: "succeeded" }, answer("msg_finished2")] as History
      return [...result.native!.messages as Message[], {
        role: "user", id: "msg_followup", content: [{ type: "text", text: "Continue with the next task." }],
      } as Message]
    },
  }
}

for (const compactSpans of [true, false]) {
  test(`signed tool results stay exact while other eligible work compacts (spans ${compactSpans ? "enabled" : "disabled"})`, async t => {
    for (const location of ["message", "part", "result"] as const) await t.test(location, async () => {
      const f = fixture(false, false, { compactSpans })
      const signed = f.messages[2]!
      assert.equal(signed.role, "tool")
      const part = signed.content[0]!
      const target = location === "message" ? signed : location === "part" ? part : part.result
      Object.assign(target, { providerMetadata: { provider: { signature: "signed-original" } } })
      const hooks = f.makeHooks()
      hooks.context(f.request(f.messages))
      await hooks.idle({ sessionID, background: [] })
      assert.equal(f.queued.length, 1, "rejecting signed text must not block unrelated eligible output")
      const result = await f.apply(hooks, f.messages, 1)
      const output = result.native!.messages as Message[]
      assert.deepEqual(output[2], signed, "the signature and its original text must remain together")
      assert.notDeepEqual(output[4], f.messages[4], "the unprotected eligible result is still shortened")
    })
  })

  test(`OpenAI item IDs remain eligible and exact (spans ${compactSpans ? "enabled" : "disabled"})`, async () => {
    const f = fixture(false, false, { compactSpans })
    const message = f.messages[2]!
    assert.equal(message.role, "tool")
    const metadata = { openai: { itemId: "fc_original_item" } }
    Object.assign(message.content[0]!, { providerMetadata: metadata })
    const hooks = f.makeHooks()
    hooks.context(f.request(f.messages))
    await hooks.idle({ sessionID, background: [] })
    assert.equal(f.queued.length, 1)
    const result = await f.apply(hooks, f.messages, 1)
    const changed = (result.native!.messages as Message[])[2]!
    assert.equal(changed.role, "tool")
    assert.notDeepEqual(changed.content[0]!.result, message.content[0]!.result)
    assert.deepEqual(changed.content[0]!.providerMetadata, metadata)
  })
}

test("planning diagnostics distinguish eligible source sizes without recording content", async () => {
  const f = fixture(false)
  const hooks = f.makeHooks()
  hooks.context(f.request(f.messages))
  await hooks.idle({ sessionID, background: [] })
  const decision = f.measurements.findLast(value => value.event === "planning")
  assert.ok(decision?.event === "planning")
  assert.equal(decision.counts?.eligible, 4)
  assert.equal(decision.counts?.sourceBelowMinimum, 2)
  assert.equal(decision.counts?.sourceAtOrAboveMinimum, 2)
  assert.ok(decision.counts!.sourceTokens! > 20_000)
  assert.ok(Object.values(decision.counts!).every(value => typeof value === "number"))
})

test("signed reasoning permits plain assistant text while message or text signatures protect the target", () => {
  const message: Message = { role: "assistant", id: "msg_prose", content: [
    { type: "reasoning", text: "Preserve reasoning.", providerMetadata: { provider: { signature: "reasoning-only" } } },
    { type: "text", text: "Earlier assistant text." },
  ] }
  const key = pairKey(message.id!, "text")
  assert.ok(visibleTargets([message]).has(key))
  const signedMessage = { ...message, providerMetadata: { provider: { signature: "whole-message" } } }
  assert.equal(visibleTargets([signedMessage]).has(key), false)
  Object.assign(message.content[1]!, { providerMetadata: { provider: { signature: "text-only" } } })
  assert.equal(visibleTargets([message]).has(key), false)
})

test("individual prose cuts charge trailing reasoning and preserve it through replay", async () => {
  const suffixes: number[] = [], savings: number[] = []
  const text = Array.from({ length: 32 }, (_, line) => `Observation ${line}: ${"x".repeat(180)}`).join("\n")
  for (const bytes of [0, 32_000]) {
    const reasoning = { type: "reasoning" as const, text: "r".repeat(bytes),
      providerMetadata: { fixture: { signature: "preserved-reasoning" } } }
    const messages: Message[] = [
      { role: "user", id: "msg_prefix", content: [{ type: "text", text: "Keep the earlier instructions." }] },
      { role: "assistant", id: "msg_prose", content: [{ type: "text", text }, reasoning] },
      { role: "user", id: "msg_tail", content: [{ type: "text", text: "Continue with the next task." }] },
    ]
    let history = [
      { type: "assistant", id: "msg_prose", model, agent, content: [{ type: "text", text }] },
      { type: "idle", id: "msg_prose_idle", outcome: "succeeded" },
      { type: "assistant", id: "msg_finished", model, agent, content: [{ type: "text", text: "The turn finished." }],
        tokens: { input: 30_000, output: 12, reasoning: 0, cache: { read: 0, write: 0 } } },
    ] as History
    const storage = new Map<string, unknown>(), archives = new Map<string, RecoveryRecord>()
    const queued: string[] = []
    const ctx = {
      agent: { get: async () => ({}) },
      storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value) } },
      session: { context: async () => history, compact: async ({ id }: { id: string }) => { queued.push(id) } },
    } as unknown as Context
    const store = {
      preserveBatch: async (inputs: PreserveInput[]) => {
        for (const input of inputs) archives.set(input.reference, { ...input, active: true, version: 1 })
        return true
      },
      getBatch: async (caller: string, references: readonly string[]) =>
        references.map(reference => caller === sessionID ? archives.get(reference) : undefined),
    } as unknown as RecoveryStore
    const measurements: Parameters<Collector["report"]>[1][] = []
    const metrics: Collector = { report: (_sessionID, value) => { measurements.push(value) }, flush: async () => {} }
    const hooks = replacementHooks(ctx, readConfig({ compactSpans: false, maxCutsPerCycle: 1 }), store, metrics)
    const request: SessionContext = { sessionID, agent, model, system: [], tools: {}, options: {}, messages }
    hooks.context(request)
    await hooks.idle({ sessionID, background: [] })
    assert.equal(queued.length, 1)
    assert.equal(archives.size, 1)
    assert.equal([...archives.values()][0]!.identity.tool, "assistant_text")
    history = [...history, { type: "compaction", id: queued[0], status: "running" }] as History
    const event: SessionCompaction = { ...request }
    await hooks.compaction(event)
    assert.equal(event.result?.metadata?.liveCompact, "replacement-v1")
    const output = event.result.native!.messages as Message[]
    assert.notDeepEqual(output[1]!.content[0], messages[1]!.content[0])
    assert.equal(output[1]!.content[1], reasoning, "trailing reasoning and its signature remain unchanged")
    assert.equal(output[0], messages[0])
    assert.equal(output[2], messages[2])
    const measurement = measurements.findLast(value => value.event === "replacement")
    assert.ok(measurement?.event === "replacement")
    assert.equal(measurement.strategy, "individual")
    assert.equal(measurement.count, 1)
    suffixes.push(measurement.estimatedCacheSuffixTokens)
    savings.push(measurement.estimatedSavedTokens)
  }
  assert.equal(savings[1], savings[0], "the same prose cut saves the same text")
  assert.equal(suffixes[1]! - suffixes[0]!, 8_000, "32,000 retained ASCII bytes add 8,000 suffix tokens")
})

test("a mixed span carries an unedited parallel result and keeps its checkpoint prefix stable after restart", async () => {
  const f = fixture(false, true)
  const hooks = f.makeHooks()
  hooks.context(f.request(f.messages))
  await hooks.idle({ sessionID, background: [] })
  assert.equal(f.queued.length, 1)
  const decision = f.measurements.findLast(measurement => measurement.event === "planning")
  assert.equal(decision?.event === "planning" ? decision.strategy : undefined, "spans")
  const first = await f.apply(hooks, f.messages, 1)
  const firstView = first.native!.messages as Message[]
  assert.deepEqual(firstView[1], f.messages[1], "reasoning and every parallel tool call remain exact")
  for (const index of [2, 3]) {
    const before = f.messages[index]!, after = firstView[index]!
    assert.equal(before.role, "tool")
    assert.equal(after.role, "tool")
    assert.notDeepEqual(after.content[0]!.result, before.content[0]!.result)
    assert.deepEqual({ ...after, content: [{ ...after.content[0], result: before.content[0]!.result }] }, before,
      "only the paired result text changes")
  }
  assert.deepEqual(firstView[4], f.messages[4], "the tiny trailing result in the same parallel round stays intact")
  const carried = first.metadata!.liveCompactRounds as { identity: { callID: string } }[][]
  assert.ok(carried.flat().some(entry => entry.identity.callID === "call_span_tail"),
    "the boundary is the last edited result, not the end of its archived native block")
  assert.ok(!carried.flat().some(entry => ["call_span1", "call_span2"].includes(entry.identity.callID)))

  const nextView = f.resume(first)
  const restarted = f.makeHooks()
  restarted.context(f.request(nextView))
  await restarted.idle({ sessionID, background: [] })
  assert.equal(f.queued.length, 2, "uncut history beyond the span checkpoint remains selectable after restart")
  const second = await f.apply(restarted, nextView, 2)
  const output = second.native!.messages as Message[]
  const position = nextView.findIndex(message => message.role === "tool" && message.content[0]?.id === "call_retained")
  assert.ok(position > 4)
  assert.equal(JSON.stringify(output.slice(0, position)), JSON.stringify(nextView.slice(0, position)),
    "the first span's reasoning, calls, checkpoints, and unedited parallel tail remain byte-for-byte stable")
  assert.notDeepEqual(output[position], nextView[position])
  assert.deepEqual(output.slice(position + 1, nextView.length), nextView.slice(position + 1), "recent tool rounds remain exact")
})

for (const recentErrors of [false, true]) {
  test(`uncut history after the checkpoint remains eligible after replay and restart (${recentErrors ? "empty recent rounds" : "completed recent rounds"})`, async () => {
    const f = fixture(recentErrors)
    const firstHooks = f.makeHooks()
    firstHooks.context(f.request(f.messages))
    await firstHooks.idle({ sessionID, background: [] })
    assert.equal(f.queued.length, 1)
    const first = await f.apply(firstHooks, f.messages, 1)
    const carried = first.metadata!.liveCompactRounds as { identity: { callID: string } }[][]
    assert.ok(carried.flat().some(entry => entry.identity.callID === "call_retained"),
      "all unchanged eligible results after the cut must survive, not only the latest three rounds")
    assert.ok(!carried.flat().some(entry => entry.identity.callID === "call_large"), "the existing checkpoint cannot be compressed again")
    if (recentErrors) assert.deepEqual(carried.slice(-3), [[], [], []], "unavailable recent rounds must still count toward protection")

    const nextView = f.resume(first)
    const restarted = f.makeHooks()
    restarted.context(f.request(nextView))
    await restarted.idle({ sessionID, background: [] })
    assert.equal(f.queued.length, 2, "the retained older result must be eligible in a later completed turn")
    const second = await f.apply(restarted, nextView, 2)
    const output = second.native!.messages as Message[]
    const position = nextView.findIndex(message => message.role === "tool" && message.content[0]?.id === "call_retained")
    assert.ok(position >= 0)
    assert.equal(JSON.stringify(output.slice(0, position)), JSON.stringify(nextView.slice(0, position)), "the original prefix and first checkpoint stay byte-for-byte stable")
    assert.notDeepEqual(output[position], nextView[position])
    for (let i = 1; i <= 3; i++) {
      const retained = (view: Message[]) => view.find(message => message.role === "tool" && message.content[0]?.id === `call_recent${i}`)
      assert.deepEqual(retained(output), retained(nextView), "the latest three tool rounds remain intact")
    }
  })
}
