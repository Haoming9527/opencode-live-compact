import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session";
import type { Collector } from "../../src/metrics/collector.ts";
import type { RecoveryRecord } from "../../src/recovery/store.ts";
import type { History } from "../../src/state/reconciliation.ts";

// Local hook/backup benchmark, NOT stock-host or user-blocked timing. No model calls.
// Self-check: node benchmarks/diagnostics/overhead.ts --candidate .runs/overhead-baseline
const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({ options: {
  baseline: { type: "string", default: ".runs/overhead-baseline" },
  candidate: { type: "string", default: "." },
  trials: { type: "string", default: "16" },
  warmups: { type: "string", default: "2" },
  output: { type: "string" },
  "fixture-report": { type: "string" },
} });
const integer = (value: string, min: number) => {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number >= min && number <= 100, `Expected ${min}–100, got ${value}`);
  return number;
};
const trials = integer(values.trials, 15), warmups = integer(values.warmups, 1);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fixtureFiles = [
  "benchmarks/suites/webbench.ts", "benchmarks/suites/aider.ts", "benchmarks/run.ts",
  "benchmarks/runner/daytona.ts", "benchmarks/runner/arm.ts", "tests/benchmark-attempts.test.ts",
  "tests/webbench.test.ts", "tests/aider-grading.test.ts", "benchmarks/runner/metrics.ts",
  "benchmarks/runner/opencode.ts", "benchmarks/runner/attempts.ts", "benchmarks/runner/progress.ts",
  "src/recovery/private-directory.ts", "src/recovery/payloads.ts",
  "src/recovery/integrity.ts", "src/config.ts", "src/metrics/collector.ts",
];
// Separate fresh archives isolate the same stable identity across variants/trials.
// Different session IDs would change recovery references and prevent exact comparison.
const sessionID = "ses_overhead_fixture" as SessionContext["sessionID"];
const model = { providerID: "local", id: "offline-overhead" } as SessionContext["model"];
const agent = "build" as SessionContext["agent"];
type Measurement = Parameters<Collector["report"]>[1];
type Replacement = Extract<Measurement, { event: "cut" | "replacement" }>;

async function implementation(directory: string) {
  const module = async <T>(name: string) => import(pathToFileURL(join(directory, name)).href) as Promise<T>;
  const [hooks, config, recovery, collector, context] = await Promise.all([
    module<typeof import("../../src/hooks/replacement.ts")>("src/hooks/replacement.ts"),
    module<typeof import("../../src/config.ts")>("src/config.ts"),
    module<typeof import("../../src/recovery/store.ts")>("src/recovery/store.ts"),
    module<typeof import("../../src/metrics/collector.ts")>("src/metrics/collector.ts"),
    module<typeof import("../../src/hooks/context.ts")>("src/hooks/context.ts"),
  ]);
  const sources: { path: string; bytes: number; sha256: string }[] = [];
  const visit = async (folder: string) => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const bytes = await readFile(path);
        sources.push({ path: relative(directory, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  };
  await visit(join(directory, "src"));
  return { ...hooks, ...config, ...recovery, ...collector, ...context,
    directory, sources, sourceSha256: hash(JSON.stringify(sources)) };
}
const implementations = {
  baseline: await implementation(resolve(root, values.baseline)),
  candidate: await implementation(resolve(root, values.candidate)),
};
const fixtureSources = await Promise.all(fixtureFiles.map(async path => {
  // Freeze production-source reads to the original snapshot: optimizing payloads
  // must not silently change the workload between successive diagnostic runs.
  const bytes = await readFile(join(path.startsWith("src/") ? implementations.baseline.directory : root, path));
  const lines = bytes.toString("utf8").replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
  const toolPath = `/workspace/opencode-live-compact/${path}`;
  const text = [`Read file ${toolPath}, lines 1-${lines.length}`, ...lines.map((line, i) => `${i + 1}: ${line}`)].join("\n");
  return { path, bytes: bytes.length, sha256: hash(bytes), toolPath, text };
}));
const fixtureEvidence = fixtureSources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
const fixtureSha256 = hash(JSON.stringify(fixtureEvidence));
if (values["fixture-report"]) {
  const previous = JSON.parse(await readFile(resolve(root, values["fixture-report"]), "utf8"));
  assert.equal(fixtureSha256, previous.fixture.sha256, "Diagnostic input must match the previous report exactly");
}

function fixture() {
  const messages: SessionContext["messages"] = [{ role: "user", id: "msg_requirements", content: [{
    type: "text", text: "Review the benchmark runner and recovery boundaries. Preserve the existing test and execution behavior.",
  }] }];
  const history: unknown[] = [];
  fixtureSources.forEach((source, index) => {
    const id = `call_read_${index}`, messageID = `msg_read_${index}`, input = { path: source.toolPath };
    messages.push({ role: "assistant", id: messageID, content: [
      { type: "reasoning", text: `Inspect ${source.path} to follow its interfaces and dependencies.` },
      { type: "tool-call", id, name: "read", input },
    ] }, { role: "tool", content: [{ type: "tool-result", id, name: "read", result: { type: "text", value: source.text } }] });
    history.push({ type: "assistant", id: messageID, model, agent, content: [{
      type: "tool", id, name: "read", time: { created: index * 2 + 1, completed: index * 2 + 2 },
      state: { status: "completed", input, metadata: { truncated: false }, content: [{ type: "text", text: source.text }] },
    }] });
  });
  const request: SessionContext = { sessionID, agent, model, system: [], tools: {}, options: {}, messages };
  const contextTokens = implementations.baseline.contextSize(request, implementations.baseline.suffixSizes(request)[0]!);
  assert.ok(contextTokens > 20_000, "Actual unpadded fixture must cross the stock 20K threshold");
  const answer = "The benchmark and recovery interfaces have been reviewed.";
  history.push({ type: "assistant", id: "msg_finished", model, agent, content: [{ type: "text", text: answer }],
    tokens: { input: contextTokens, output: 14, reasoning: 0, cache: { read: 0, write: 0 } } });
  const event: SessionCompaction = { ...request, messages: [...messages, {
    role: "assistant", id: "msg_finished", content: [{ type: "text", text: answer }],
  }] };
  return { request, history: history as History, event, contextTokens };
}

type Label = keyof typeof implementations;
const runsDirectory = resolve(root, ".runs");
await mkdir(runsDirectory, { recursive: true });
const temporaryRoot = await realpath(tmpdir());
const runDirectory = await mkdtemp(join(temporaryRoot, "opencode-live-compact-overhead-"));
let sequence = 0;
async function sample(label: Label, iteration: number, warmup: boolean) {
  const implementation = implementations[label];
  const directory = join(runDirectory, `${sequence++}-${label}`);
  await mkdir(directory);
  const config = implementation.readConfig({ archiveDirectory: join(directory, "archive"),
    diagnostics: true, metricsFile: join(directory, "metrics.jsonl") });
  assert.equal(config.minimumContextTokens, 20_000);
  assert.equal(config.protectedToolRounds, 3);
  const store = new implementation.RecoveryStore({ directory: config.archiveDirectory,
    maxBytes: config.archiveMaxBytes, maxRecords: config.archiveMaxRecords, retentionMs: config.archiveRetentionMs });
  const metrics = implementation.createCollector(config);
  let phase: "outside" | "idle" | "compaction" = "outside";
  let origin = 0;
  type StoreMethod = "preserveBatch" | "get" | "getBatch";
  const observation = new AsyncLocalStorage<StoreMethod[]>();
  const storeOperations: { method: StoreMethod; nested: boolean; phase: string; startMs: number; endMs: number; durationMs: number }[] = [];
  const observeStore = async <T>(method: StoreMethod, execute: () => Promise<T>): Promise<T> => {
    const activePhase = phase, start = performance.now();
    const ancestors = observation.getStore() ?? [];
    try { return await observation.run([...ancestors, method], execute); }
    finally {
      if (activePhase !== "outside") {
        const end = performance.now();
        storeOperations.push({ method, nested: ancestors.length > 0, phase: activePhase,
          startMs: start - origin, endMs: end - origin, durationMs: end - start });
      }
    }
  };
  // Observe the real methods on the same store; no recovery behavior or IO is mocked.
  const preserveBatch = store.preserveBatch.bind(store), get = store.get.bind(store);
  store.preserveBatch = inputs => observeStore("preserveBatch", () => preserveBatch(inputs));
  store.get = (caller, reference) => observeStore("get", () => get(caller, reference));
  const batchStore = store as typeof store & {
    getBatch?: (caller: string, references: readonly string[]) => Promise<readonly (RecoveryRecord | undefined)[]>;
  };
  if (typeof batchStore.getBatch === "function") {
    const getBatch = batchStore.getBatch.bind(batchStore);
    batchStore.getBatch = (caller, references) => observeStore("getBatch", () => getBatch(caller, references));
  }
  try {
    await store.list(sessionID); // Warm catalog/schema/permissions outside the maintenance timer.
    const f = fixture(), original = JSON.stringify(f.event.messages);
    const storage = new Map<string, unknown>(), queued: string[] = [];
    const sdkCalls = { history: 0, storageGet: 0, storageSet: 0, compact: 0 };
    const ctx = {
      agent: { get: async () => ({}) },
      storage: { get: async (key: string) => { sdkCalls.storageGet++; return storage.get(key); },
        set: async (key: string, value: unknown) => { sdkCalls.storageSet++; storage.set(key, value); } },
      session: { context: async () => { sdkCalls.history++; return f.history; },
        compact: async ({ id }: { id: string }) => { sdkCalls.compact++; queued.push(id); } },
    } as unknown as Context;
    const hooks = implementation.replacementHooks(ctx, config, store, metrics);
    hooks.context(f.request);
    const cpuBefore = process.cpuUsage(), started = performance.now();
    origin = started;
    phase = "idle";
    await hooks.idle({ sessionID, background: [] });
    const idleEnded = performance.now();
    assert.equal(queued.length, 1, "The fixture must admit one replacement operation");
    phase = "compaction";
    f.history.push({ id: queued[0]!, type: "compaction", status: "running" } as History[number]);
    await hooks.compaction(f.event);
    const finished = performance.now(), cpu = process.cpuUsage(cpuBefore);
    phase = "outside";
    await metrics.flush(); // Flush, setup and validation are outside the hook interval.
    const measurements = (await readFile(config.metricsFile!, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line) as Measurement);
    const cuts = measurements.filter((row): row is Replacement => row.event === "replacement");
    assert.equal(cuts.length, 1);
    const cut = cuts[0]!;
    assert.ok(cut.count > 0 && cut.estimatedSavedTokens > 0);
    assert.equal(f.event.result?.metadata?.liveCompact, "replacement-v1");
    const output = f.event.result.native?.messages as SessionContext["messages"];
    assert.ok(Array.isArray(output));
    assert.equal(JSON.stringify(f.event.messages), original, "Input messages must remain unmodified");
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < Buffer.byteLength(original));
    assert.deepEqual(output.slice(-7), f.event.messages.slice(-7), "Recent three rounds and answer must stay exact");
    const plans = await store.list(sessionID);
    assert.equal(plans.length, cut.count);
    const records = await Promise.all(plans.map(plan => store.get(sessionID, plan.reference)));
    assert.ok(records.every(record => record && hash(JSON.stringify(record.original)) === record.sourceHash));
    const metadata = { ...f.event.result.metadata };
    delete metadata.liveCompactInputID; // Random queue ID is not model-visible content.
    const retrieval = storeOperations.filter(row => row.phase === "compaction" &&
      (row.method === "get" || row.method === "getBatch") && !row.nested);
    const coveredMs = (operations: typeof storeOperations) => {
      const intervals = [...operations].sort((a, b) => a.startMs - b.startMs);
      let total = 0, until = 0;
      for (const interval of intervals) {
        total += Math.max(0, interval.endMs - Math.max(interval.startMs, until));
        until = Math.max(until, interval.endMs);
      }
      return total;
    };
    const preserveBatchMs = coveredMs(storeOperations.filter(row => row.method === "preserveBatch" && !row.nested));
    const recoveryGetUnionMs = coveredMs(retrieval);
    return { label, iteration, warmup, durationMs: finished - started,
      idleMs: idleEnded - started, compactionMs: finished - idleEnded, cpuMs: (cpu.user + cpu.system) / 1000,
      preserveBatchMs, recoveryGetUnionMs,
      recoveryGetSumMs: retrieval.reduce((sum, row) => sum + row.durationMs, 0),
      recoveryReadCalls: { get: retrieval.filter(row => row.method === "get").length,
        getBatch: retrieval.filter(row => row.method === "getBatch").length },
      idleOutsidePreserveMs: idleEnded - started - preserveBatchMs,
      compactionOutsideGetMs: finished - idleEnded - recoveryGetUnionMs, storeOperations,
      planningMs: cut.planningMs!, applicationMs: cut.applicationMs!, reportedLocalMs: cut.durationMs,
      cuts: cut.count, strategy: cut.strategy, savedTokens: cut.estimatedSavedTokens, backups: plans.length,
      backupOriginalBytes: records.reduce((sum, record) => sum + Buffer.byteLength(record!.original), 0),
      outputSha256: hash(JSON.stringify(output)), metadataSha256: hash(JSON.stringify(metadata)), sdkCalls };
  } finally {
    await metrics.flush();
    await store.close();
  }
}

try {
  const samples: Awaited<ReturnType<typeof sample>>[] = [];
  for (let iteration = -warmups; iteration < trials; iteration++) {
    const order: Label[] = Math.abs(iteration) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const label of order) samples.push(await sample(label, iteration, iteration < 0));
  }
  const first = samples[0]!;
  for (const row of samples) {
    assert.equal(row.outputSha256, first.outputSha256, "Native messages must be exactly equal across variants/trials");
    assert.equal(row.metadataSha256, first.metadataSha256, "Decision metadata must match except for random input ID");
    assert.equal(row.cuts, first.cuts);
    assert.equal(row.savedTokens, first.savedTokens);
    assert.equal(row.backupOriginalBytes, first.backupOriginalBytes);
  }
  const measured = samples.filter(row => !row.warmup);
  const distribution = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b), midpoint = Math.floor(sorted.length / 2);
    return { median: sorted.length % 2 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, min: sorted[0]!, max: sorted.at(-1)! };
  };
  const summary = Object.fromEntries((["baseline", "candidate"] as Label[]).map(label => {
    const rows = measured.filter(row => row.label === label);
    return [label, Object.fromEntries((["durationMs", "idleMs", "compactionMs", "planningMs", "applicationMs", "cpuMs",
      "preserveBatchMs", "recoveryGetUnionMs", "recoveryGetSumMs", "idleOutsidePreserveMs", "compactionOutsideGetMs"] as const)
      .map(key => [key, distribution(rows.map(row => row[key]))]))];
  }));
  const sourceEvidence = Object.fromEntries(Object.entries(implementations).map(([label, value]) =>
    [label, { directory: value.directory, sourceSha256: value.sourceSha256, sources: value.sources }]));
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(), node: process.version, platform: process.platform,
    scope: "Offline local plugin hook elapsed time with real RecoveryStore disk IO and collector; NOT host event time or measured user-blocked latency.",
    methodology: "Fresh isolated archive per sample; catalog initialized before timer; identical stable session identity and fixture; mocked in-memory SDK history/storage/queue; alternating AB/BA pairs; warmups excluded; collector flush and output validation outside timer; real store methods wrapped only for timing; overlapping get/getBatch calls reported as top-level sum and interval union, nested calls excluded; no latency assertions.",
    trialsPerVariant: trials, warmupPairs: warmups, implementations: sourceEvidence,
    fixture: { files: fixtureEvidence, sha256: fixtureSha256, contextTokens: fixture().contextTokens,
      productionSource: "src/ reads come from the baseline snapshot; benchmark/test reads come from the repository.",
      readResults: fixtureSources.length, duplicatedOrPaddedSource: false, protectedRecentRounds: 3 },
    equivalence: { exactNativeMessages: true, outputSha256: first.outputSha256, metadataSha256: first.metadataSha256,
      cuts: first.cuts, strategy: first.strategy, savedTokens: first.savedTokens,
      backups: first.backups, backupOriginalBytes: first.backupOriginalBytes }, summary, samples,
  };
  const output = resolve(root, values.output ?? `.runs/overhead-${Date.now()}.json`);
  assert.ok(output.startsWith(runsDirectory + "/") || output.startsWith(runsDirectory + "\\"), "Reports must stay inside .runs");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Offline local hooks only; real backup IO; ${trials} measured trials per variant; ${warmups} warmup pairs.`);
  console.log(`Fixture: ${report.fixture.contextTokens} estimated tokens, ${report.fixture.readResults} real file reads; ${first.cuts} cuts, ${first.savedTokens} tokens saved; identical output ${first.outputSha256}.`);
  for (const [label, value] of Object.entries(summary)) {
    console.log(`${label}: total median ${value.durationMs!.median.toFixed(3)} ms / p95 ${value.durationMs!.p95.toFixed(3)} ms; planning median ${value.planningMs!.median.toFixed(3)} ms; application median ${value.applicationMs!.median.toFixed(3)} ms.`);
  }
  console.log(`Report: ${output}`);
} finally {
  const actual = await realpath(runDirectory);
  assert.equal(dirname(actual), temporaryRoot);
  assert.ok(basename(actual).startsWith("opencode-live-compact-overhead-"));
  await rm(actual, { recursive: true, force: true, maxRetries: 3 });
}
