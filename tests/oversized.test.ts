import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { reduce } from "../src/engine/reducer.ts"
import type { Candidate } from "../src/engine/eligibility.ts"
import { estimateTokens } from "../src/hooks/context.ts"
import { hashText, recoveryReference } from "../src/recovery/integrity.ts"
import { RecoveryStore } from "../src/recovery/store.ts"
import { restore } from "../src/recovery/restore.ts"

function read(path = "src/large.ts", rows = 650): Candidate {
  const text = [`Read file ${path}, lines 1-${rows}`,
    ...Array.from({ length: rows }, (_, index) => `${index + 1}: const item = "${"record 🦊 ".repeat(22)}";`),
    `[Output truncated. Continue reading with offset: ${rows + 1}]`].join("\n")
  return {
    identity: { sessionID: "ses_oversized", messageID: "msg_source", partID: "read", callID: "read", tool: "read" },
    suffixTokens: 42,
    tool: { type: "tool", id: "read", name: "read", time: { created: 0, completed: 1 },
      state: { status: "completed", input: { path }, metadata: { truncated: true },
        content: [{ type: "text", text }] } },
  }
}

test("oversized safe tool output becomes a small pointer with exact coordinates and truncation notice", () => {
  const candidate = read()
  const before = structuredClone(candidate)
  const cut = reduce(candidate, estimateTokens, 1_000)
  assert.ok(cut)
  assert.ok(estimateTokens(cut.sourceText) > 32_000)
  assert.deepEqual(candidate, before)
  assert.deepEqual(cut.identity, candidate.identity)
  assert.equal(cut.sourceHash, hashText(cut.sourceText))
  assert.equal(cut.reference, recoveryReference(cut.identity, cut.sourceHash))
  assert.ok(cut.replacement.startsWith("Read file src/large.ts, lines 1-650\n"))
  assert.ok(cut.replacement.endsWith("\n[Output truncated. Continue reading with offset: 651]"))
  assert.match(cut.replacement, /oversized historical read tool result \(650 lines\)/)
  assert.match(cut.replacement, /reference lc1_[0-9a-f]{32} and offset 0 /)
  assert.ok([...cut.replacement].length <= 8_000)
  assert.ok(!cut.replacement.includes("const item"))
  const changedTail = cut.replacement.slice(cut.replacement.indexOf("\n") + 1)
  assert.equal(cut.cacheSuffixTokens, 42 + estimateTokens(changedTail))
})

test("pointer budget respects Unicode and skips oversized headers instead of altering provenance", () => {
  const path = `src/${"界".repeat(7_300)}.ts`
  const cut = reduce(read(path), estimateTokens, 1_000)
  assert.ok(cut)
  assert.ok(cut.replacement.startsWith(`Read file ${path}, lines 1-650\n`))
  assert.ok([...cut.replacement].length <= 8_000)
  assert.ok(Buffer.byteLength(cut.replacement) > 8_000, "budget counts Unicode code points, not bytes")
  assert.equal(reduce(read(`src/${"界".repeat(8_000)}.ts`), estimateTokens, 1_000), undefined)
})

test("pointer exception does not relax eligibility or remove oversized assistant prose", () => {
  assert.equal(reduce(read("AGENTS.md"), estimateTokens, 1_000), undefined)
  const candidate = read()
  assert.equal(candidate.tool.state.status, "completed")
  const original = candidate.tool.state.content[0]
  assert.equal(original?.type, "text")
  const shell = (metadata: Record<string, number | boolean>, text = original.text): Candidate => ({
    ...candidate, identity: { ...candidate.identity, tool: "shell" },
    tool: { ...candidate.tool, name: "shell", state: { status: "completed", input: { command: "git log" },
      metadata, content: [{ type: "text", text }] } },
  })
  const success = reduce(shell({ exit: 0, truncated: false }), estimateTokens, 1_000)
  assert.ok(success)
  assert.match(success.replacement, /historical shell tool result/)
  assert.match(success.replacement, /host recorded exit code 0/)
  assert.equal(reduce(shell({ exit: 1, truncated: false }), estimateTokens, 1_000), undefined)
  assert.equal(reduce(shell({ exit: 0, truncated: false }, original.text + "\nWarning: incomplete"), estimateTokens, 1_000), undefined)
  const prose: Candidate = { ...candidate, identity: { ...candidate.identity, tool: "assistant_text" },
    tool: { ...candidate.tool, name: "assistant_text", state: { status: "completed", input: {},
      content: [{ type: "text", text: original.text }] } } }
  assert.equal(reduce(prose, estimateTokens, 1_000), undefined)
  assert.equal(reduce({ ...candidate, tool: { ...candidate.tool, executed: true } }, estimateTokens, 1_000), undefined)
})

test("oversized pointers retain exact same-session recovery and refuse archives above the storage cap", async t => {
  const temp = await realpath(tmpdir())
  const directory = await mkdtemp(join(temp, "live-compact-pointer-"))
  const store = new RecoveryStore({ directory, maxBytes: 2 * 1024 * 1024 })
  t.after(async () => {
    await store.close()
    assert.equal(dirname(await realpath(directory)), temp)
    await rm(directory, { recursive: true, force: true })
  })
  const cut = reduce(read(), estimateTokens, 1_000)
  assert.ok(cut)
  const preserved = { identity: cut.identity, sourceHash: cut.sourceHash, reference: cut.reference,
    original: cut.sourceText, checkpoint: cut.replacement }
  assert.equal(await store.preserve(preserved), true)
  assert.equal((await store.get(cut.identity.sessionID, cut.reference))?.original, cut.sourceText)
  const recall = await restore(store, cut.identity.sessionID, cut.reference, 0, 2_048)
  assert.equal(recall.status, "ok")
  assert.equal(recall.text, [...cut.sourceText].slice(0, 2_048).join(""))
  assert.deepEqual(await restore(store, "different_session", cut.reference), { status: "unavailable" })

  const candidate = read("src/too-large.ts", 3_000)
  const before = structuredClone(candidate)
  const tooLarge = reduce(candidate, estimateTokens, 1_000)
  assert.ok(tooLarge)
  assert.ok(Buffer.byteLength(tooLarge.sourceText) > 512 * 1024)
  assert.equal(await store.preserve({ identity: tooLarge.identity, sourceHash: tooLarge.sourceHash,
    reference: tooLarge.reference, original: tooLarge.sourceText, checkpoint: tooLarge.replacement }), false)
  assert.equal(await store.get(tooLarge.identity.sessionID, tooLarge.reference), undefined)
  assert.deepEqual(candidate, before)
})
