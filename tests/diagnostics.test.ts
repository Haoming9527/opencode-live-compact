import assert from "node:assert/strict"
import { test } from "node:test"
import { createPlanningDiagnostics, planCuts } from "../src/engine/planner.ts"
import type { Candidate, PlannerOptions } from "../src/engine/planner.ts"

const options: PlannerOptions = {
  minimumSourceTokens: 1_000, maxCutsPerCycle: 3,
  estimateTokens: text => Math.ceil(Buffer.byteLength(text) / 4),
}

function read(lines: number, suffixTokens: number, id = "read"): Candidate {
  const body = Array.from({ length: lines }, (_, index) => `${index + 1}: export const value${index} = "${"example ".repeat(12)}";`)
  return {
    identity: { sessionID: "ses_diagnostics", messageID: `msg_${id}`, partID: `call_${id}`, callID: `call_${id}`, tool: "read" },
    suffixTokens,
    tool: { type: "tool", name: "read", id: `call_${id}`, time: { created: 0 }, state: {
      status: "completed", input: { path: "src/example.ts" }, metadata: { truncated: false },
      content: [{ type: "text", text: [`Read file src/example.ts, lines 1-${lines}`, ...body].join("\n") }],
    } },
  }
}

test("diagnostics distinguish insufficient size from useful cuts with a large suffix", () => {
  const small = createPlanningDiagnostics()
  assert.deepEqual(planCuts([read(3, 0)], { ...options, diagnostics: small }), [])
  assert.deepEqual(small, { sizeValidCandidates: 0, evaluatedBatches: 0 })

  const largeSuffix = createPlanningDiagnostics()
  const [cut] = planCuts([read(180, 100_000)], { ...options, diagnostics: largeSuffix })
  assert.ok(cut)
  assert.ok(cut.cacheSuffixTokens >= 100_000)
  assert.ok(options.estimateTokens(cut.sourceText) >= options.minimumSourceTokens)
  assert.ok(cut.estimatedSavingsTokens > 0)
  assert.deepEqual(largeSuffix, { sizeValidCandidates: 1, evaluatedBatches: 1 })
})

test("diagnostics do not change selected cuts or the caller's candidates", () => {
  const candidate = read(180, 100)
  const original = structuredClone(candidate)
  const diagnostics = createPlanningDiagnostics()
  const plain = planCuts([candidate], options)
  const observed = planCuts([candidate], { ...options, diagnostics })
  assert.equal(plain.length, 1)
  assert.deepEqual(observed, plain)
  assert.deepEqual(candidate, original)
  assert.deepEqual(diagnostics, { sizeValidCandidates: 1, evaluatedBatches: 1 })
})

test("diagnostics count candidate and batch alternatives under the cut limit", () => {
  const candidates = [read(180, 20_000, "older"), read(180, 10_000, "middle"), read(180, 0, "newest")]
  const single = createPlanningDiagnostics()
  const batch = createPlanningDiagnostics()
  assert.equal(planCuts(candidates, { ...options, maxCutsPerCycle: 1, diagnostics: single }).length, 1)
  assert.ok(planCuts(candidates, { ...options, diagnostics: batch }).length > 0)
  assert.deepEqual(single, { sizeValidCandidates: 3, evaluatedBatches: 3 })
  assert.deepEqual(batch, { sizeValidCandidates: 3, evaluatedBatches: 6 })
})
