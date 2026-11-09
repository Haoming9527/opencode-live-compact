import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { hashText, recoveryReference, recoveryReferences } from "../src/recovery/integrity.ts";
import { maxRecallCodePoints, restore } from "../src/recovery/restore.ts";
import { RecoveryStore, type PreserveInput, type RecoveryStoreOptions } from "../src/recovery/store.ts";
import { privateArchivePath } from "../src/recovery/private-directory.ts";
import { readConfig } from "../src/config.ts";

const payloadPath = (directory: string, item: PreserveInput) => join(directory, "recovery-v1", "sessions",
  `session-${hashText(item.identity.sessionID)}`, `${item.reference}.json`);

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

test("batch reads preserve request order, duplicates, session isolation and retirement state", async t => {
  const { create } = await archive(t);
  const store = create();
  const first = plan("batch-first"), second = plan("batch-second"), retired = plan("batch-retired");
  const foreign = plan("batch-foreign", "Other session", "session-b"), missing = plan("batch-missing");
  assert.equal(await store.preserveBatch([first, second, retired, foreign]), true);
  await store.reconcile("session-a", new Set([first.reference, second.reference]), new Set([retired.reference]));
  const records = await store.getBatch("session-a", [second.reference, "../archive.sqlite", foreign.reference,
    missing.reference, first.reference, second.reference, retired.reference]);
  assert.deepEqual(records.map(record => record && [record.reference, record.original, record.active]), [
    [second.reference, second.original, true], undefined, undefined, undefined,
    [first.reference, first.original, true], [second.reference, second.original, true],
    [retired.reference, retired.original, false],
  ]);
  const references = [first.reference];
  const pending = store.getBatch("session-a", references);
  references.splice(0, 1, second.reference, retired.reference);
  assert.deepEqual((await pending).map(record => record?.reference), [first.reference], "requests are captured before awaiting the database");
});

test("empty and invalid batch reads do not open a database", async t => {
  const { create, databasePath } = await archive(t);
  const store = create();
  assert.deepEqual(await store.getBatch("session-a", []), []);
  assert.deepEqual(await store.getBatch("session-a", ["invalid", "../archive.sqlite", ""]), [undefined, undefined, undefined]);
  assert.equal(await store.get("session-a", "invalid"), undefined);
  await assert.rejects(stat(databasePath), { code: "ENOENT" });
});

test("batch reads revalidate changed, missing and corrupt archives on every call", async t => {
  const { create, directory, databasePath } = await archive(t);
  const store = create(), first = plan("batch-live-first"), second = plan("batch-live-second");
  assert.equal(await store.preserveBatch([first, second]), true);
  const references = [first.reference, second.reference];
  assert.deepEqual((await store.getBatch("session-a", references)).map(record => record?.original), [first.original, second.original]);
  await writeFile(payloadPath(directory, first), JSON.stringify("damaged"));
  assert.deepEqual((await store.getBatch("session-a", references)).map(record => record?.original), [undefined, second.original]);
  await writeFile(payloadPath(directory, first), JSON.stringify(first.original));
  await rm(payloadPath(directory, second));
  assert.deepEqual((await store.getBatch("session-a", references)).map(record => record?.original), [first.original, undefined]);
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE recovery SET checkpoint = ? WHERE reference = ?").run(JSON.stringify("damaged"), first.reference);
    assert.deepEqual(await store.getBatch("session-a", references), [undefined, undefined]);
  } finally { db.close(); }
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

test("a recovery batch is all-or-nothing when capacity or integrity fails", async (t) => {
  const { create } = await archive(t, { maxRecords: 2 });
  const store = create();
  const first = plan("first"), second = plan("second"), third = plan("third");
  assert.equal(await store.preserveBatch([first, second, third]), false);
  assert.deepEqual(await store.list("session-a"), []);
  assert.equal(await store.preserveBatch([first, { ...second, original: "corrupt" }]), false);
  assert.deepEqual(await store.list("session-a"), []);
  assert.equal(await store.preserveBatch([first, first, second]), true);
  assert.equal((await store.list("session-a")).length, 2);
  assert.equal(await store.preserveBatch([first, third]), false);
  assert.equal((await store.get("session-a", first.reference))?.original, first.original);
  assert.equal(await store.get("session-a", third.reference), undefined);
});

test("integrity failures do not return damaged records", async (t) => {
  const { create, directory, databasePath } = await archive(t);
  const store = create();
  const item = plan("corrupt");
  assert.equal(await store.preserve(item), true);
  const db = new DatabaseSync(databasePath);
  try {
    const [stored] = await store.list("session-a");
    assert.ok(stored);
    await writeFile(payloadPath(directory, item), JSON.stringify("corrupt"));
    assert.equal(await store.verify(stored), false);
    assert.deepEqual(await restore(store, "session-a", item.reference), { status: "unavailable" });
    db.prepare("UPDATE recovery SET checkpoint = ? WHERE reference = ?").run(JSON.stringify("corrupt"), item.reference);
    assert.deepEqual(await store.list("session-a"), []);
  } finally {
    db.close();
  }
});

test("recovery uses isolated session directories and a 256 MiB default", async (t) => {
  assert.equal(readConfig({}).archiveMaxBytes, 256 * 1024 * 1024);
  const { create, directory } = await archive(t, { maxBytes: undefined });
  const store = create();
  const a = plan("same-id", "first original", "../../outside\\CON:");
  const b = plan("same-id", "second original", "session-b");
  assert.equal(await store.preserveBatch([a, b]), true);
  for (const item of [a, b]) {
    assert.equal(JSON.parse(await readFile(payloadPath(directory, item), "utf8")), item.original);
    assert.equal((await store.get(item.identity.sessionID, item.reference))?.original, item.original);
    if (process.platform !== "win32") {
      assert.equal((await stat(payloadPath(directory, item))).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(payloadPath(directory, item)))).mode & 0o777, 0o700);
    }
  }
  assert.deepEqual((await readdir(join(directory, "recovery-v1", "sessions"))).sort(),
    [a, b].map(item => `session-${hashText(item.identity.sessionID)}`).sort());
  assert.equal(await store.get(b.identity.sessionID, a.reference), undefined);
  await store.deleteSession(a.identity.sessionID);
  await assert.rejects(readFile(payloadPath(directory, a)), { code: "ENOENT" });
  assert.equal((await store.get(b.identity.sessionID, b.reference))?.original, b.original);
});

test("capacity pressure removes oldest retired backups toward 80% before their retention expires", async (t) => {
  const items = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map(id => plan(id, "x".repeat(2_048)));
  const size = Buffer.byteLength(JSON.stringify(items[0]));
  assert.ok(items.every(item => Buffer.byteLength(JSON.stringify(item)) === size));
  const { create, directory, databasePath } = await archive(t, { maxBytes: 4 * size });
  const store = create();
  assert.equal(await store.preserveBatch(items.slice(0, 4)), true);
  await store.reconcile("session-a", new Set([items[3]!.reference]), new Set(items.slice(0, 4).map(item => item.reference)));
  assert.equal((await store.list("session-a")).length, 4, "unexpired backups stay until there is pressure");
  assert.equal(await store.preserve(items[4]!), true);
  for (const item of items.slice(0, 2)) {
    assert.equal(await store.get("session-a", item.reference), undefined);
    await assert.rejects(readFile(payloadPath(directory, item)), { code: "ENOENT" });
  }
  for (const item of items.slice(2)) assert.equal((await store.get("session-a", item.reference))?.original, item.original);
  assert.equal((await store.get("session-a", items[3]!.reference))?.active, true);
  const db = new DatabaseSync(databasePath);
  try {
    const usage = db.prepare("SELECT SUM(bytes) AS bytes FROM recovery").get() as { bytes: number };
    assert.ok(usage.bytes <= Math.floor(4 * size * 0.8));
  } finally { db.close(); }
});

test("global capacity protects other sessions and references being reactivated in the batch", async (t) => {
  const first = plan("first", "x".repeat(2_048));
  const other = plan("other", "x".repeat(2_048), "session-b");
  const fresh = plan("fresh", "x".repeat(2_048));
  const bytes = (item: PreserveInput) => Buffer.byteLength(JSON.stringify(item));
  const { create, directory } = await archive(t, { maxBytes: bytes(first) + bytes(other) });
  const store = create();
  assert.equal(await store.preserveBatch([first, other]), true);
  await store.reconcile("session-a", new Set(), new Set([first.reference]));
  assert.equal(await store.preserveBatch([first, fresh]), false, "reactivating a backup pins it even before commit");
  assert.equal((await store.get("session-a", first.reference))?.original, first.original);
  assert.equal((await store.get("session-b", other.reference))?.active, true);
  assert.equal(await store.get("session-a", fresh.reference), undefined);
  await assert.rejects(readFile(payloadPath(directory, fresh)), { code: "ENOENT" });
});

test("missing retired files are already freed, while missing active originals remain unavailable", async (t) => {
  const first = plan("first", "x".repeat(2_048)), fresh = plan("fresh", "x".repeat(2_048));
  const { create, directory } = await archive(t, { maxBytes: Buffer.byteLength(JSON.stringify(first)) });
  const store = create();
  assert.equal(await store.preserve(first), true);
  await rm(payloadPath(directory, first));
  assert.deepEqual(await restore(store, "session-a", first.reference), { status: "unavailable" });
  await store.reconcile("session-a", new Set(), new Set([first.reference]));
  assert.equal(await store.preserve(fresh), true);
  assert.equal(await store.get("session-a", first.reference), undefined);
  assert.equal((await store.get("session-a", fresh.reference))?.original, fresh.original);
});

test("legacy inline backups migrate to session files without changing recall references", async (t) => {
  const { create, directory, databasePath } = await archive(t);
  const item = plan("legacy", "Exact original\ud800\r\n🙂");
  const legacy = new DatabaseSync(await privateArchivePath(directory));
  try {
    legacy.exec(`CREATE TABLE recovery (
      reference TEXT PRIMARY KEY, session_id TEXT NOT NULL, identity TEXT NOT NULL,
      source_hash TEXT NOT NULL, checkpoint TEXT NOT NULL, checkpoint_hash TEXT NOT NULL,
      original TEXT NOT NULL, bytes INTEGER NOT NULL, retired_at INTEGER
    ) STRICT`);
    legacy.prepare("INSERT INTO recovery VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(
      item.reference, item.identity.sessionID, JSON.stringify(item.identity), item.sourceHash,
      JSON.stringify(item.checkpoint), hashText(item.checkpoint), JSON.stringify(item.original), Buffer.byteLength(JSON.stringify(item)));
  } finally { legacy.close(); }
  const store = create();
  assert.equal((await store.get("session-a", item.reference))?.original, item.original);
  assert.equal(JSON.parse(await readFile(payloadPath(directory, item), "utf8")), item.original);
  await store.close();
  const restarted = create();
  assert.deepEqual(await restore(restarted, "session-a", item.reference),
    { status: "ok", reference: item.reference, offset: 0, text: item.original, nextOffset: null });
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare("SELECT original, external FROM recovery WHERE reference = ?").get(item.reference)!;
    assert.equal(row.external, 1);
    assert.notEqual(row.original, JSON.stringify(item.original), "the catalog no longer duplicates the original");
  } finally { db.close(); }
});

test("restart clears unindexed payloads without deleting committed backups", async (t) => {
  const { create, directory } = await archive(t);
  const active = plan("active"), orphan = plan("orphan");
  const store = create();
  assert.equal(await store.preserve(active), true);
  await store.close();
  await writeFile(payloadPath(directory, orphan), JSON.stringify(orphan.original), { mode: 0o600 });
  const restarted = create();
  assert.equal((await restarted.get("session-a", active.reference))?.original, active.original);
  await assert.rejects(readFile(payloadPath(directory, orphan)), { code: "ENOENT" });
  assert.equal(await restarted.get("session-a", orphan.reference), undefined);
});
