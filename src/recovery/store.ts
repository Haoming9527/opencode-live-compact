import { DatabaseSync } from "node:sqlite";
import { hashText, isRecoveryReference, recoveryReference, type RecoveryIdentity } from "./integrity.ts";
import { privateArchivePath } from "./private-directory.ts";
import { RecoveryPayloads } from "./payloads.ts";

export interface RecoveryStoreOptions {
  readonly directory: string;
  readonly maxBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxRecords?: number;
  readonly retentionMs?: number;
}

export interface PreserveInput {
  readonly identity: RecoveryIdentity;
  readonly reference: string;
  readonly sourceHash: string;
  readonly checkpoint: string;
  readonly original: string;
}

export interface RecoveryPlan extends Omit<PreserveInput, "original"> {
  readonly version: 1;
  readonly active: boolean;
}

export interface RecoveryRecord extends RecoveryPlan {
  readonly original: string;
}

export type RecallLookup =
  | { status: "ok"; record: RecoveryRecord }
  | { status: "unavailable"; reason: "missing" | "expired" | "unreadable" | "storage-unavailable" };

const planColumns = "session_id, reference, identity, source_hash, checkpoint, checkpoint_hash, retired_at";
type Row = Record<string, unknown>;

function parse(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function decodePlan(row: Row): RecoveryPlan | undefined {
  const identity = parse(row.identity) as RecoveryIdentity | undefined;
  const checkpoint = parse(row.checkpoint);
  if (!identity || identity.sessionID !== row.session_id ||
      typeof identity.messageID !== "string" || typeof identity.partID !== "string" ||
      typeof identity.callID !== "string" || typeof identity.tool !== "string" ||
      typeof row.reference !== "string" || typeof row.source_hash !== "string" || typeof checkpoint !== "string" ||
      recoveryReference(identity, row.source_hash) !== row.reference || hashText(checkpoint) !== row.checkpoint_hash) {
    return undefined;
  }
  return {
    version: 1,
    identity,
    reference: row.reference,
    sourceHash: row.source_hash,
    checkpoint,
    active: row.retired_at === null,
  };
}

function decodeRecord(row: Row | undefined, payloads: RecoveryPayloads): RecoveryRecord | undefined {
  if (!row) return undefined;
  const plan = decodePlan(row);
  const original = parse(row.external === 1 && plan ? payloads.read(plan.identity.sessionID, plan.reference, Number(row.bytes)) : row.original);
  if (!plan || typeof original !== "string" || hashText(original) !== plan.sourceHash) return undefined;
  return { ...plan, original };
}

function boundedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export class RecoveryStore {
  private connection: Promise<DatabaseSync> | undefined;
  private payloads: RecoveryPayloads | undefined;
  private needsSweep = false;
  private closed = false;
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxRecords: number;
  private readonly retentionMs: number;

  constructor(options: RecoveryStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = boundedInteger(options.maxBytes ?? 256 * 1024 * 1024, "maxBytes");
    this.maxRecordBytes = boundedInteger(options.maxRecordBytes ?? 512 * 1024, "maxRecordBytes");
    this.maxRecords = boundedInteger(options.maxRecords ?? 2_000, "maxRecords");
    this.retentionMs = boundedInteger(options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000, "retentionMs");
  }

  async preserve(input: PreserveInput): Promise<boolean> {
    return this.preserveBatch([input]);
  }

  /** Preserve the complete admitted batch in one durable transaction, or preserve none. */
  async preserveBatch(inputs: readonly PreserveInput[]): Promise<boolean> {
    if (!inputs.length) return false;
    const unique = new Map<string, PreserveInput>();
    for (const input of inputs) {
      if (hashText(input.original) !== input.sourceHash ||
          recoveryReference(input.identity, input.sourceHash) !== input.reference ||
          !input.checkpoint.includes(input.reference)) return false;
      const previous = unique.get(input.reference);
      if (previous && (previous.original !== input.original || previous.checkpoint !== input.checkpoint)) return false;
      unique.set(input.reference, input);
    }
    const db = await this.database();
    if (this.needsSweep) {
      transaction(db, () => this.sweep(db));
      this.needsSweep = false;
    }
    try { return transaction(db, () => {
      const lookup = db.prepare(`SELECT ${planColumns}, original, external, bytes FROM recovery WHERE reference = ?`);
      const additions: { input: PreserveInput; bytes: number }[] = [];
      const reactivate: string[] = [];
      let totalBytes = 0;
      for (const input of unique.values()) {
        const previous = lookup.get(input.reference);
        if (previous) {
          const valid = decodeRecord(previous, this.payloads!);
          if (!valid || valid.checkpoint !== input.checkpoint || valid.original !== input.original) return false;
          if (!valid.active) reactivate.push(input.reference);
        } else {
          const bytes = Buffer.byteLength(JSON.stringify(input));
          if (bytes > this.maxRecordBytes) return false;
          additions.push({ input, bytes });
          totalBytes += bytes;
        }
      }
      if (totalBytes > this.maxBytes || additions.length > this.maxRecords) return false;
      // Incoming references stay pinned even if this batch reactivates a retired
      // record. The same SQLite write lock coordinates all sessions and processes.
      const retained = new Set(unique.keys());
      if (!this.prune(db, Date.now(), retained, totalBytes, additions.length)) return false;
      const insert = db.prepare(`INSERT INTO recovery (session_id, reference, identity, source_hash, checkpoint, checkpoint_hash, original, bytes, external)
        VALUES (?, ?, ?, ?, ?, ?, 'null', ?, 1)`);
      for (const { input, bytes } of additions) {
        this.payloads!.write(input.identity.sessionID, input.reference, input.original);
        insert.run(input.identity.sessionID, input.reference,
          JSON.stringify(input.identity), input.sourceHash, JSON.stringify(input.checkpoint), hashText(input.checkpoint), bytes);
      }
      const revive = db.prepare("UPDATE recovery SET retired_at = NULL WHERE reference = ?");
      for (const reference of reactivate) revive.run(reference);
      return true;
    }); } catch (error) {
      // A rolled-back batch may already have durable payloads. Reclaim only
      // uncommitted files under the same global lock, before another admission.
      this.needsSweep = true;
      try { transaction(db, () => this.sweep(db)); this.needsSweep = false; } catch { /* Retry before the next write. */ }
      throw error;
    }
  }

  async list(sessionID: string): Promise<readonly RecoveryPlan[]> {
    const db = await this.database();
    const plans: RecoveryPlan[] = [];
    for (const row of db.prepare(`SELECT ${planColumns} FROM recovery WHERE session_id = ? ORDER BY rowid`).all(sessionID)) {
      const plan = decodePlan(row);
      if (plan) plans.push(plan);
    }
    return plans;
  }

  async get(sessionID: string, reference: string): Promise<RecoveryRecord | undefined> {
    return (await this.getBatch(sessionID, [reference]))[0];
  }

  /** Scope every lookup to the caller; never disclose another session's records. */
  async recall(sessionID: string, reference: string): Promise<RecallLookup> {
    if (!isRecoveryReference(reference)) return { status: "unavailable", reason: "missing" };
    try {
      const db = await this.database();
      return transaction(db, () => {
        const row = db.prepare(`SELECT ${planColumns}, original, external, bytes FROM recovery WHERE session_id = ? AND reference = ?`).get(sessionID, reference);
        if (row) {
          const record = decodeRecord(row, this.payloads!);
          return record ? { status: "ok", record } : { status: "unavailable", reason: "unreadable" };
        }
        const expired = db.prepare("SELECT 1 FROM recovery_expired WHERE session_id = ? AND reference = ?").get(sessionID, reference);
        return { status: "unavailable", reason: expired ? "expired" : "missing" };
      });
    } catch {
      return { status: "unavailable", reason: "storage-unavailable" };
    }
  }

  /** Read a bounded replacement batch under one lock; validate every payload afresh. */
  async getBatch(sessionID: string, references: readonly string[]): Promise<(RecoveryRecord | undefined)[]> {
    const requested = references.map(reference => isRecoveryReference(reference) ? reference : undefined);
    if (!requested.some(reference => reference !== undefined)) return requested.map(() => undefined);
    const db = await this.database();
    return transaction(db, () => {
      const lookup = db.prepare(`SELECT ${planColumns}, original, external, bytes FROM recovery WHERE session_id = ? AND reference = ?`);
      return requested.map(reference => reference === undefined ? undefined :
        decodeRecord(lookup.get(sessionID, reference), this.payloads!));
    });
  }

  /** Validate the payload once before reusing a durable plan in a new runtime. */
  async verify(plan: RecoveryPlan): Promise<boolean> {
    const record = await this.get(plan.identity.sessionID, plan.reference);
    return record?.active === true && record.sourceHash === plan.sourceHash && record.checkpoint === plan.checkpoint;
  }

  /** Pass complete history and only the plans observed when that history was captured. */
  async reconcile(sessionID: string, activeReferences: ReadonlySet<string>, observedReferences: ReadonlySet<string>): Promise<void> {
    const db = await this.database();
    const now = Date.now();
    transaction(db, () => {
      const reactivate = db.prepare("UPDATE recovery SET retired_at = NULL WHERE session_id = ? AND reference = ? AND retired_at IS NOT NULL");
      const retire = db.prepare("UPDATE recovery SET retired_at = ? WHERE session_id = ? AND reference = ? AND retired_at IS NULL");
      for (const reference of activeReferences) reactivate.run(sessionID, reference);
      for (const reference of observedReferences) {
        if (!activeReferences.has(reference)) retire.run(now, sessionID, reference);
      }
      this.prune(db, now);
    });
  }

  async deleteSession(sessionID: string): Promise<void> {
    const db = await this.database();
    transaction(db, () => {
      for (const row of db.prepare("SELECT reference, external FROM recovery WHERE session_id = ?").all(sessionID)) {
        if (row.external === 1) this.payloads!.remove(sessionID, String(row.reference));
      }
      db.prepare("DELETE FROM recovery WHERE session_id = ?").run(sessionID);
      db.prepare("DELETE FROM recovery_expired WHERE session_id = ?").run(sessionID);
      this.sweep(db);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const db = await this.connection?.catch(() => undefined);
    db?.close();
    this.connection = undefined;
  }

  private prune(db: DatabaseSync, now: number, retained: ReadonlySet<string> = new Set(), incomingBytes = 0, incomingCount = 0): boolean {
    const usage = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM recovery").get() as
      { bytes: number; count: number };
    let bytes = usage.bytes + incomingBytes, count = usage.count + incomingCount;
    const pressure = bytes > this.maxBytes || count > this.maxRecords;
    const targetBytes = Math.floor(this.maxBytes * 0.8), targetCount = Math.floor(this.maxRecords * 0.8);
    const remove = db.prepare("DELETE FROM recovery WHERE reference = ?");
    // rowid records insertion age, independent of reads and retirement order.
    for (const row of db.prepare("SELECT session_id, reference, bytes, external, retired_at FROM recovery WHERE retired_at IS NOT NULL ORDER BY rowid").all()) {
      if (retained.has(String(row.reference))) continue;
      const expired = Number(row.retired_at) <= now - this.retentionMs;
      const needed = pressure && (bytes > targetBytes || (count > this.maxRecords && count > targetCount));
      if (!expired && !needed) continue;
      if (row.external === 1) this.payloads!.remove(String(row.session_id), String(row.reference));
      db.prepare("INSERT OR REPLACE INTO recovery_expired (session_id, reference) VALUES (?, ?)").run(String(row.session_id), String(row.reference));
      remove.run(String(row.reference));
      bytes -= Number(row.bytes);
      count--;
    }
    // Bounded, content-free tombstones explain recent expiry across restarts.
    // Once an old tombstone is evicted, recall conservatively reports missing.
    db.prepare("DELETE FROM recovery_expired WHERE rowid NOT IN (SELECT rowid FROM recovery_expired ORDER BY rowid DESC LIMIT ?)").run(this.maxRecords);
    return bytes <= this.maxBytes && count <= this.maxRecords;
  }

  private sweep(db: DatabaseSync): void {
    const known = new Set(db.prepare("SELECT session_id, reference FROM recovery WHERE external = 1").all()
      .map(row => this.payloads!.key(String(row.session_id), String(row.reference))));
    this.payloads!.sweep(known);
  }

  private database(): Promise<DatabaseSync> {
    if (this.closed) return Promise.reject(new Error("Recovery store is closed"));
    this.connection ??= this.openDatabase().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  private async openDatabase(): Promise<DatabaseSync> {
    const path = await privateArchivePath(this.directory);
    const db = new DatabaseSync(path);
    this.payloads = new RecoveryPayloads(path);
    try {
      db.exec(`
        PRAGMA busy_timeout = 25;
        PRAGMA auto_vacuum = FULL;
        PRAGMA secure_delete = ON;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS recovery (
          reference TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          identity TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          checkpoint TEXT NOT NULL,
          checkpoint_hash TEXT NOT NULL,
          original TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          retired_at INTEGER,
          external INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS recovery_expired (
          session_id TEXT NOT NULL,
          reference TEXT NOT NULL,
          PRIMARY KEY (session_id, reference)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS recovery_session ON recovery (session_id);
        CREATE INDEX IF NOT EXISTS recovery_expiry ON recovery (retired_at) WHERE retired_at IS NOT NULL;
      `);
      transaction(db, () => {
        const columns = db.prepare("PRAGMA table_info(recovery)").all();
        if (!columns.some(column => column.name === "external")) db.exec("ALTER TABLE recovery ADD COLUMN external INTEGER NOT NULL DEFAULT 0");
        // Inline rows remain authoritative after a crash during migration.
        // Remove any partial uncommitted files before trying those writes again.
        this.sweep(db);
        const migrated = db.prepare("UPDATE recovery SET original = 'null', external = 1 WHERE reference = ?");
        for (const row of db.prepare(`SELECT ${planColumns}, original, external, bytes FROM recovery WHERE external = 0 ORDER BY rowid`).all()) {
          const record = decodeRecord(row, this.payloads!);
          if (!record) continue;
          this.payloads!.write(record.identity.sessionID, record.reference, record.original);
          migrated.run(record.reference);
        }
        this.sweep(db);
        this.prune(db, Date.now());
      });
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}
