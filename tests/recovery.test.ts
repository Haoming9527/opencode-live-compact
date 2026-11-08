import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { hashText, recoveryReference, recoveryReferences } from "../src/recovery/integrity.ts";
import { maxRecallCodePoints, restore } from "../src/recovery/restore.ts";
import { RecoveryStore, type PreserveInput, type RecoveryStoreOptions } from "../src/recovery/store.ts";

function plan(id: string, original = "Original result", sessionID = "session-a"): PreserveInput {
  const identity = { sessionID, messageID: id, partID: `${id}-part`, callID: `${id}-call`, tool: "read" };
  const sourceHash = hashText(original);
  const reference = recoveryReference(identity, sourceHash);
  return { identity, sourceHash, reference, original, checkpoint: `File read. Restore with ${reference}.` };
}

async function archive(t: TestContext, options: Partial<RecoveryStoreOptions> = {}) {
  const temp = await realpath(tmpdir());
  const directory = await mkdtemp(join(temp, "live-compact-recovery-"));
  const stores: RecoveryStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    assert.equal(dirname(await realpath(directory)), temp);
    await rm(directory, { recursive: true, force: true });
  });
  const create = () => {
    const store = new RecoveryStore({ directory, maxBytes: 100_000, ...options });
    stores.push(store);
    return store;
  };
  return { create, directory, databasePath: join(directory, "recovery-v1", "archive.sqlite") };
}

test("recovery survives restart and restores exact text within the calling session", async (t) => {
  const { create, databasePath } = await archive(t);
  const store = create();
  const prefix = "🙂".repeat(maxRecallCodePoints);
  const item = plan("old", `${prefix}\0é\ud800\r\n`);
  assert.equal(await store.preserve(item), true);
  assert.equal(await store.preserve(item), true);
  assert.equal(await store.preserve({ ...item, checkpoint: `Another view of ${item.reference}` }), false);
  assert.equal(await store.preserve({ ...item, original: "changed original" }), false);
  await store.close();

  const restarted = create();
  const [stored] = await restarted.list(item.identity.sessionID);
  assert.equal(stored?.reference, item.reference);
  assert.equal(stored?.checkpoint, item.checkpoint);
  assert.equal(stored && "original" in stored, false);
  assert.ok(stored);
  assert.equal(await restarted.verify(stored), true);
  const first = await restore(restarted, item.identity.sessionID, item.reference, 0, maxRecallCodePoints + 10);
  assert.deepEqual(first, { status: "ok", reference: item.reference, offset: 0, text: prefix, nextOffset: maxRecallCodePoints });
  const last = await restore(restarted, item.identity.sessionID, item.reference, maxRecallCodePoints);
  assert.deepEqual(last, { status: "ok", reference: item.reference, offset: maxRecallCodePoints, text: "\0é\ud800\r\n", nextOffset: null });
  assert.deepEqual(await restore(restarted, "session-b", item.reference), { status: "unavailable" });
  assert.deepEqual(await restore(restarted, item.identity.sessionID, "../archive.sqlite"), { status: "unavailable" });
  assert.deepEqual(await restore(restarted, item.identity.sessionID, item.reference, -1), { status: "invalid_range" });
  if (process.platform !== "win32") {
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(databasePath))).mode & 0o777, 0o700);
  }
});

test("cleanup preserves references carried in a native summary and plans outside its snapshot", async (t) => {
  const { create } = await archive(t, { maxRecords: 3, retentionMs: 0 });
  const store = create();
  const summarized = plan("summarized");
  const retired = plan("retired");
  const concurrent = plan("concurrent");
  const fresh = plan("fresh");
  const otherSession = plan("other", "Another result", "session-b");
  assert.equal(await store.preserve(summarized), true);
  assert.equal(await store.preserve(retired), true);
  const observed = new Set((await store.list("session-a")).map((record) => record.reference));
  assert.equal(await store.preserve(concurrent), true);
  assert.equal(await store.preserve(fresh), false);
  assert.equal(await store.preserve(otherSession), false);

  const active = recoveryReferences(`Native summary. See ${summarized.reference}.`);
  await store.reconcile("session-a", active, observed);
  assert.equal(await store.get("session-a", retired.reference), undefined);
  assert.equal((await store.get("session-a", summarized.reference))?.active, true);
  assert.equal((await store.get("session-a", concurrent.reference))?.active, true);
  assert.equal(await store.preserve(otherSession), true);
  await store.deleteSession("session-a");
  assert.equal(await store.get("session-a", summarized.reference), undefined);
  assert.equal((await store.get("session-b", otherSession.reference))?.original, otherSession.original);
});

test("storage byte budgets reject new entries without evicting active records", async (t) => {
  const item = plan("small");
  const { create } = await archive(t, { maxBytes: Buffer.byteLength(JSON.stringify(item)), maxRecordBytes: 1_000 });
  const store = create();
  assert.equal(await store.preserve(plan("oversize", "x".repeat(2_000))), false);
  assert.equal(await store.preserve(item), true);
  assert.equal(await store.preserve(plan("another")), false);
  assert.equal((await store.get("session-a", item.reference))?.original, item.original);
});

test("integrity failures do not return damaged records", async (t) => {
  const { create, databasePath } = await archive(t);
  const store = create();
  const item = plan("corrupt");
  assert.equal(await store.preserve(item), true);
  const db = new DatabaseSync(databasePath);
  try {
    const [stored] = await store.list("session-a");
    assert.ok(stored);
    db.prepare("UPDATE recovery SET original = ? WHERE reference = ?").run(JSON.stringify("corrupt"), item.reference);
    assert.equal(await store.verify(stored), false);
    assert.deepEqual(await restore(store, "session-a", item.reference), { status: "unavailable" });
    db.prepare("UPDATE recovery SET checkpoint = ? WHERE reference = ?").run(JSON.stringify("corrupt"), item.reference);
    assert.deepEqual(await store.list("session-a"), []);
  } finally {
    db.close();
  }
});
