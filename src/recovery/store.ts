import { DatabaseSync } from "node:sqlite";
import { hashText, isRecoveryReference, recoveryReference, type RecoveryIdentity } from "./integrity.ts";
import { privateArchivePath } from "./private-directory.ts";

export interface RecoveryStoreOptions {
  readonly directory: string;
  readonly maxBytes: number;
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

function decodeRecord(row: Row | undefined): RecoveryRecord | undefined {
  if (!row) return undefined;
  const plan = decodePlan(row);
  const original = parse(row.original);
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
  private closed = false;
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxRecords: number;
  private readonly retentionMs: number;

  constructor(options: RecoveryStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = boundedInteger(options.maxBytes, "maxBytes");
    this.maxRecordBytes = boundedInteger(options.maxRecordBytes ?? 512 * 1024, "maxRecordBytes");
    this.maxRecords = boundedInteger(options.maxRecords ?? 2_000, "maxRecords");
    this.retentionMs = boundedInteger(options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000, "retentionMs");
  }

  async preserve(input: PreserveInput): Promise<boolean> {
    if (hashText(input.original) !== input.sourceHash ||
        recoveryReference(input.identity, input.sourceHash) !== input.reference ||
        !input.checkpoint.includes(input.reference)) return false;

    const identity = JSON.stringify(input.identity);
    const original = JSON.stringify(input.original);
    const checkpoint = JSON.stringify(input.checkpoint);
    const checkpointHash = hashText(input.checkpoint);
    const bytes = Buffer.byteLength(JSON.stringify(input));
    const db = await this.database();
    return transaction(db, () => {
      const previous = db.prepare(`SELECT ${planColumns}, original FROM recovery WHERE reference = ?`).get(input.reference);
      if (previous) {
        const valid = decodeRecord(previous);
        if (!valid || valid.checkpoint !== input.checkpoint || valid.original !== input.original) return false;
        if (!valid.active) db.prepare("UPDATE recovery SET retired_at = NULL WHERE reference = ?").run(input.reference);
        return true;
      }

      this.prune(db, Date.now());
      const usage = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM recovery").get() as
        { bytes: number; count: number };
      if (bytes > this.maxRecordBytes || usage.bytes + bytes > this.maxBytes || usage.count >= this.maxRecords) return false;
      db.prepare(`INSERT INTO recovery (session_id, reference, identity, source_hash, checkpoint, checkpoint_hash, original, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.identity.sessionID, input.reference, identity, input.sourceHash,
          checkpoint, checkpointHash, original, bytes);
      return true;
    });
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
    if (!isRecoveryReference(reference)) return undefined;
    const db = await this.database();
    const row = db.prepare(`SELECT ${planColumns}, original FROM recovery WHERE session_id = ? AND reference = ?`)
      .get(sessionID, reference);
    return decodeRecord(row);
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
    db.prepare("DELETE FROM recovery WHERE session_id = ?").run(sessionID);
  }

  async close(): Promise<void> {
    this.closed = true;
    const db = await this.connection?.catch(() => undefined);
    db?.close();
    this.connection = undefined;
  }

  private prune(db: DatabaseSync, now: number): void {
    db.prepare("DELETE FROM recovery WHERE retired_at IS NOT NULL AND retired_at <= ?").run(now - this.retentionMs);
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
    const db = new DatabaseSync(await privateArchivePath(this.directory));
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
          retired_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS recovery_session ON recovery (session_id);
        CREATE INDEX IF NOT EXISTS recovery_expiry ON recovery (retired_at) WHERE retired_at IS NOT NULL;
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}
