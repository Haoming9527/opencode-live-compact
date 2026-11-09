import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashText, isRecoveryReference } from "./integrity.ts";

/** File operations run only while the catalog's transaction lock is held. */
export class RecoveryPayloads {
  private readonly archiveRoot: string;
  private readonly archiveIdentity: { dev: bigint; ino: bigint };
  private readonly root: string;

  constructor(databasePath: string) {
    this.archiveRoot = dirname(databasePath);
    this.archiveIdentity = this.rootStat();
    this.root = join(this.archiveRoot, "sessions");
  }

  private rootStat() {
    const stat = lstatSync(this.archiveRoot, { bigint: true }), uid = process.getuid?.();
    if (!stat.isDirectory() ||
        (uid !== undefined && (stat.uid !== BigInt(uid) || (stat.mode & 0o077n) !== 0n))) {
      throw new Error("Non-private recovery payload path");
    }
    return stat;
  }

  private checkRoot(): void {
    const current = this.rootStat();
    if (current.dev !== this.archiveIdentity.dev || current.ino !== this.archiveIdentity.ino) {
      throw new Error("Recovery archive directory changed");
    }
  }

  private check(path: string, directory: boolean): void {
    const stat = lstatSync(path), uid = process.getuid?.();
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
      throw new Error("Non-private recovery payload path");
    }
  }

  private directory(sessionID: string, create = false): string {
    this.checkRoot();
    if (create) {
      try { mkdirSync(this.root, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.check(this.root, true);
    const directory = join(this.root, `session-${hashText(sessionID)}`);
    if (create) {
      try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.check(directory, true);
    return directory;
  }

  private path(sessionID: string, reference: string, create = false): string {
    if (!isRecoveryReference(reference)) throw new Error("Invalid recovery reference");
    return join(this.directory(sessionID, create), reference + ".json");
  }

  private syncDirectory(directory: string): void {
    // Windows cannot fsync directory handles through Node. The file itself is
    // always flushed before its durable catalog entry is committed.
    if (process.platform === "win32") return;
    const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  read(sessionID: string, reference: string, maxBytes: number): string | undefined {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return;
    try {
      const path = this.path(sessionID, reference);
      this.check(path, false);
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(descriptor), uid = process.getuid?.();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes ||
            (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) return;
        return readFileSync(descriptor, "utf8");
      } finally { closeSync(descriptor); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  write(sessionID: string, reference: string, original: string): void {
    const path = this.path(sessionID, reference, true), contents = JSON.stringify(original);
    let descriptor: number;
    try { descriptor = openSync(path, "wx", 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || this.read(sessionID, reference, Buffer.byteLength(contents)) !== contents) throw error;
      // An earlier interrupted attempt may have written identical bytes without
      // finishing its flushes. Complete durability before publishing the plan.
      const existing = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(existing); } finally { closeSync(existing); }
      this.syncDirectory(dirname(path));
      this.syncDirectory(this.root);
      this.syncDirectory(dirname(this.root));
      return;
    }
    try { writeFileSync(descriptor, contents, "utf8"); fsyncSync(descriptor); }
    catch (error) {
      closeSync(descriptor);
      unlinkSync(path);
      throw error;
    }
    closeSync(descriptor);
    this.syncDirectory(dirname(path));
    this.syncDirectory(this.root);
    this.syncDirectory(dirname(this.root));
  }

  remove(sessionID: string, reference: string): void {
    try {
      const path = this.path(sessionID, reference);
      this.check(path, false);
      unlinkSync(path);
      this.syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Reclaim files from interrupted, uncommitted writes while no writer can race. */
  sweep(known: ReadonlySet<string>): void {
    this.checkRoot();
    try { this.check(this.root, true); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const session of readdirSync(this.root)) {
      if (!/^session-[0-9a-f]{64}$/.test(session)) throw new Error("Unexpected recovery session directory");
      const directory = join(this.root, session);
      this.check(directory, true);
      for (const file of readdirSync(directory)) {
        if (!/^lc1_[0-9a-f]{32}\.json$/.test(file)) throw new Error("Unexpected recovery payload");
        const path = join(directory, file);
        this.check(path, false);
        if (!known.has(`${session}/${file}`)) unlinkSync(path);
      }
      if (!readdirSync(directory).length) rmdirSync(directory);
    }
    this.syncDirectory(this.root);
  }

  key(sessionID: string, reference: string): string { return `session-${hashText(sessionID)}/${reference}.json`; }
}
