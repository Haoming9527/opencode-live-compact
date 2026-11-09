import assert from "node:assert/strict"
import { test } from "node:test"
import { createCollector } from "../src/metrics/collector.ts"
import { readConfig } from "../src/config.ts"

test("default status explains skips without diagnostics or repeated log spam", async t => {
  const lines: string[] = []
  t.mock.method(console, "error", (line: string) => lines.push(line))
  const collector = createCollector(readConfig({}))
  const skipped = { event: "planning", reason: "below-context-threshold", durationMs: 1 } as const
  collector.report("session-a", skipped)
  collector.report("session-a", skipped)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /INFO.*below-context-threshold/)
  assert.deepEqual(collector.status("session-a"), { last: skipped, planning: skipped })
  assert.deepEqual(collector.status("session-b"), { state: "waiting-for-completed-turn" })
  collector.report("session-a", { event: "planning", reason: "archive-unavailable", durationMs: 2 })
  assert.match(lines.at(-1)!, /WARN.*archive-unavailable/)
  collector.report("session-a", { event: "fallback", operation: "replacement-prefix-changed" })
  assert.match(lines.at(-1)!, /WARN.*replacement-prefix-changed/)
  await collector.flush()
})

test("status cache is bounded and context diagnostics do not hide the planning reason", t => {
  t.mock.method(console, "error", () => {})
  const collector = createCollector(readConfig({}))
  for (let i = 0; i < 130; i++) collector.report(`session-${i}`, { event: "planning", reason: "no-eligible-history", durationMs: 0 })
  assert.deepEqual(collector.status("session-0"), { state: "waiting-for-completed-turn" })
  const before = collector.status("session-129")
  collector.report("session-129", { event: "context", messageCount: 10, durationMs: 1 })
  assert.deepEqual(collector.status("session-129"), before)
})
