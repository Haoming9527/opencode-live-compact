import assert from "node:assert/strict";
import fs from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { hashText, recoveryReference } from "../src/recovery/integrity.ts";
import { RecoveryStore, type PreserveInput, type RecoveryStoreOptions } from "../src/recovery/store.ts";

const plan = (id: string, sessionID = "session-a"): PreserveInput => {
  const identity = { sessionID, messageID: id, partID: id, callID: id, tool: "read" };
  const original = `Source ${id} ${"x".repeat(128)}`, sourceHash = hashText(original);
  const reference = recoveryReference(identity, sourceHash);
  return { identity, original, sourceHash, reference, checkpoint: `Recall ${reference}` };
};

async function fixture(t: TestContext, options: Partial<RecoveryStoreOptions> = {}) {
  const temp = await realpath(tmpdir()), directory = await mkdtemp(join(temp, "live-compact-security-"));
  const stores: RecoveryStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    assert.equal(dirname(await realpath(directory)), temp);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    create() { const store = new RecoveryStore({ directory, maxBytes: 100_000, ...options }); stores.push(store); return store; },
    payload(item: PreserveInput) {
      return join(directory, "recovery-v1", "sessions", `session-${hashText(item.identity.sessionID)}`, `${item.reference}.json`);
    },
  };
}

test("external payload hardlinks cannot be recalled or deleted through the archive", async t => {
  const setup = await fixture(t), store = setup.create(), item = plan("linked");
  assert.equal(await store.preserve(item), true);
  const payload = setup.payload(item), outside = join(setup.directory, "outside.json");
  await rename(payload, outside);
  await link(outside, payload);
  assert.equal(await store.get(item.identity.sessionID, item.reference).catch(() => undefined), undefined);
  await assert.rejects(store.deleteSession(item.identity.sessionID));
  assert.equal(await readFile(outside, "utf8"), JSON.stringify(item.original));
});

test("a substituted session directory never exposes or deletes its external target", async t => {
  const setup = await fixture(t), store = setup.create(), item = plan("redirected");
  assert.equal(await store.preserve(item), true);
  const session = dirname(setup.payload(item)), held = join(setup.directory, "held"), outside = join(setup.directory, "outside");
  await rename(session, held);
  await mkdir(outside, { mode: 0o700 });
  const external = join(outside, `${item.reference}.json`);
  await writeFile(external, JSON.stringify(item.original), { mode: 0o600 });
  try { await symlink(outside, session, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("This host does not permit directory links");
    return;
  }
  try {
    assert.equal(await store.get(item.identity.sessionID, item.reference).catch(() => undefined), undefined);
    await assert.rejects(store.deleteSession(item.identity.sessionID));
    assert.equal(await readFile(external, "utf8"), JSON.stringify(item.original));
  } finally { await unlink(session); }
});

test("an enlarged corrupt payload is rejected before reading its contents", async t => {
  const setup = await fixture(t), store = setup.create(), item = plan("bounded");
  assert.equal(await store.preserve(item), true);
  const payload = setup.payload(item), oversized = Buffer.byteLength(JSON.stringify(item)) + 1;
  await writeFile(payload, "x".repeat(oversized));
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads++;
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.equal(await store.get(item.identity.sessionID, item.reference), undefined);
    assert.equal(reads, 0, "the size guard must run before a potentially large allocation");
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test("a substituted archive ancestor cannot redirect an already-open catalog to another payload tree", async t => {
  const setup = await fixture(t), store = setup.create(), item = plan("ancestor");
  assert.equal(await store.preserve(item), true);
  const archive = join(setup.directory, "recovery-v1"), held = join(setup.directory, "held-v1"), outside = join(setup.directory, "outside-v1");
  try { await rename(archive, held); }
  catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    t.skip("This host prevents renaming a directory containing the open catalog");
    return;
  }
  const external = join(outside, "sessions", `session-${hashText(item.identity.sessionID)}`, `${item.reference}.json`);
  await mkdir(dirname(external), { recursive: true, mode: 0o700 });
  await writeFile(external, JSON.stringify(item.original), { mode: 0o600 });
  let linked = false;
  try {
    await symlink(outside, archive, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    assert.equal(await store.get(item.identity.sessionID, item.reference).catch(() => undefined), undefined);
    await assert.rejects(store.deleteSession(item.identity.sessionID));
    assert.equal(await readFile(external, "utf8"), JSON.stringify(item.original));
  } finally {
    if (linked) await unlink(archive);
    await rename(held, archive);
  }
});

test("independent stores sharing the catalog cannot each spend the same free capacity", async t => {
  const a = plan("a", "session-a"), b = plan("b", "session-b");
  const setup = await fixture(t, { maxBytes: Math.max(...[a, b].map(item => Buffer.byteLength(JSON.stringify(item)))) });
  const first = setup.create(), second = setup.create();
  const outcomes = await Promise.all([first.preserve(a), second.preserve(b)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const winner = outcomes[0] ? a : b, loser = outcomes[0] ? b : a;
  assert.equal((await second.get(winner.identity.sessionID, winner.reference))?.original, winner.original);
  assert.equal(await first.get(loser.identity.sessionID, loser.reference), undefined);
});

test("a partial batch write cannot publish plans or damage an existing live original", async t => {
  const setup = await fixture(t), store = setup.create();
  const live = plan("live"), first = plan("first"), second = plan("second");
  assert.equal(await store.preserve(live), true);
  // The first payload can be written, but a directory at the second file path
  // makes its exclusive create fail after work has already begun.
  await mkdir(setup.payload(second), { mode: 0o700 });
  assert.equal(await store.preserveBatch([first, second]).catch(() => false), false);
  assert.deepEqual((await store.list("session-a")).map(item => item.reference), [live.reference]);
  assert.equal((await store.get("session-a", live.reference))?.original, live.original);
  assert.equal(await store.get("session-a", first.reference), undefined);
  await rmdir(setup.payload(second));
  await store.close();
  const restarted = setup.create();
  assert.equal((await restarted.get("session-a", live.reference))?.original, live.original);
  await assert.rejects(readFile(setup.payload(first)), { code: "ENOENT" });
  assert.equal(await restarted.preserveBatch([first, second]), true);
});

test("restart recovers an interrupted inline migration with a partial external payload", async t => {
  const setup = await fixture(t), store = setup.create(), item = plan("migration");
  assert.equal(await store.preserve(item), true);
  await store.close();
  // A rolled-back migration still has the authoritative inline original even
  // if its process died midway through publishing an external copy.
  const db = new DatabaseSync(join(setup.directory, "recovery-v1", "archive.sqlite"));
  try {
    db.prepare("UPDATE recovery SET external = 0, original = ? WHERE reference = ?")
      .run(JSON.stringify(item.original), item.reference);
  } finally { db.close(); }
  await writeFile(setup.payload(item), '"partial');
  const restarted = setup.create();
  assert.equal((await restarted.get(item.identity.sessionID, item.reference))?.original, item.original);
  assert.equal(await readFile(setup.payload(item), "utf8"), JSON.stringify(item.original));
});
