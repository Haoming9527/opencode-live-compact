import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ModelRef } from "@opencode/client";
import { runArm } from "./runner/arm.ts";
import type { Arm, ArmResult, Suite } from "./runner/arm.ts";
import { launchDaytona } from "./runner/daytona.ts";
import { formatProgress } from "./runner/progress.ts";
import { grade, prepareBaseline, prepareReference, stages } from "./suites/workloads.ts";
import type { Suite as ExistingSuite } from "./suites/workloads.ts";
import { gradeAider, prepareAider } from "./suites/aider.ts";
import type { Aider } from "./suites/aider.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = parseArgs({ options: {
  preflight: { type: "boolean" },
  live: { type: "boolean" },
  target: { type: "string", default: "local" },
  "daytona-sandbox": { type: "string", default: "Benchmark-sandbox" },
  "daytona-project-dir": { type: "string", default: "~/benchmark-progress/cloud/repo" },
  help: { type: "boolean" },
  "format-progress": { type: "boolean" },
  model: { type: "string" },
  variant: { type: "string" },
  "key-env": { type: "string" },
  "opencode-bin": { type: "string" },
  "semver-tarball": { type: "string" },
  "aider-fixture-dir": { type: "string" },
  "aider-tools-dir": { type: "string" },
  "aider-js-dir": { type: "string" },
  "aider-verified": { type: "string" },
  "aider-retry-reference": { type: "string" },
  parallel: { type: "boolean" },
  python: { type: "string", default: "python" },
  "budget-usd": { type: "string" },
  "reserve-usd": { type: "string" },
  "timeout-minutes": { type: "string" },
  trials: { type: "string" },
  suite: { type: "string", default: "all" },
} }).values;

function positive(raw: string | undefined, name: string) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function usage() {
  process.stdout.write(`Usage\n  npm run benchmark -- --preflight [--suite all|short|semver|aider]\n  npm run benchmark -- --live --model provider/model --key-env VARIABLE --budget-usd N --reserve-usd N [--parallel] [--trials 3] [--target local|daytona]\n\n  cat progress.jsonl | node benchmarks/run.ts --format-progress\n\nThe reserve is required for each stage. OpenCode records charges after requests, so this is a stage-admission check.\n`);
}

function englishTable(control: ArmResult, plugin: ArmResult) {
  const count = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const values = (arm: ArmResult) => {
    const u = arm.usage;
    const hit = u?.totalInputTokens ? u.cachedReadTokens / u.totalInputTokens * 100 : null;
    const rate = (value: number) => arm.grade.total ? `${(100 * value / arm.grade.total).toFixed(2)}%` : "—";
    return [
      `${arm.grade.passed}/${arm.stagesExpected}`,
      rate(arm.grade.passed), `${arm.grade.failed} (${rate(arm.grade.failed)})`,
      hit === null ? "—" : `${hit.toFixed(2)}%`,
      count(u?.cachedReadTokens), count(u?.uncachedInputTokens), count(u?.cacheWriteTokens),
      u ? `$${u.costEstimateUsd.toFixed(4)}` : "—", count(u?.peakActiveContextTokens),
      u ? `${u.nativeCompactionPauses} · ${count(u.nativeCompactionWaitMs / 1000)} s` : "—",
      u ? `${u.replacementCuts} · ${count(u.replacementHostWaitMs / 1000)} s` : "—",
      count(arm.wallSeconds),
    ];
  };
  const rows = ["Exercises passed", "Pass rate among graded exercises", "Failed exercises and rate", "Overall cache hit rate", "Cached input tokens", "Uncached input tokens",
    "Cache write tokens", "Estimated API cost", "Peak context tokens", "Stock compaction count and wait",
    "Local cuts and host wait", "Wall time (seconds)"];
  const stock = values(control);
  const treatment = values(plugin);
  return [
    "| Metric | Stock OpenCode | Live Compact |",
    "| --- | ---: | ---: |",
    ...rows.map((row, index) => `| ${row} | ${stock[index]} | ${treatment[index]} |`),
    "", "Cache hit rate is cached reads divided by total input, including writes. Costs are estimates from OpenCode.",
  ].join("\n");
}

function compare(control: ArmResult, treatment: ArmResult) {
  const comparable = !control.error && !treatment.error && control.stagesCompleted === control.stagesExpected &&
    treatment.stagesCompleted === treatment.stagesExpected &&
    JSON.stringify(control.modelConfiguration) === JSON.stringify(treatment.modelConfiguration);
  const bothPassed = control.grade.success && treatment.grade.success &&
    (control.suite !== "semver" || (control.retentionCorrect === true && treatment.retentionCorrect === true));
  const stock = control.usage;
  const plugin = treatment.usage;
  const timingComparable = comparable && stock !== null && plugin !== null && stock.automaticNativeCompactionPauses > 0 &&
    stock.nativeCompactionTimingComplete && plugin.nativeCompactionTimingComplete;
  return {
    comparable,
    bothPassed,
    costDeltaUsd: comparable && stock && plugin ? plugin.costEstimateUsd - stock.costEstimateUsd : null,
    peakContextDelta: comparable && stock?.peakActiveContextTokens != null && plugin?.peakActiveContextTokens != null
      ? plugin.peakActiveContextTokens - stock.peakActiveContextTokens : null,
    meanContextDelta: comparable && stock?.meanActiveContextTokens != null && plugin?.meanActiveContextTokens != null
      ? plugin.meanActiveContextTokens - stock.meanActiveContextTokens : null,
    nativePausesDelta: timingComparable ? plugin.nativeCompactionPauses - stock.nativeCompactionPauses : null,
    nativeWaitDeltaMs: timingComparable ? plugin.nativeCompactionWaitMs - stock.nativeCompactionWaitMs : null,
    hostCompactionWaitDeltaMs: timingComparable ? plugin.hostCompactionWaitMs - stock.hostCompactionWaitMs : null,
  };
}

async function main() {
  if (cli["format-progress"]) { await formatProgress(); return; }
  if (cli.help || (!cli.preflight && !cli.live)) { usage(); return; }
  if (cli.preflight && cli.live) throw new Error("Choose one mode");
  if (cli.target === "daytona") {
    if (!cli.live) throw new Error("The Daytona target requires --live");
    const { target, "daytona-sandbox": sandbox, "daytona-project-dir": checkout, ...options } = cli;
    const args = Object.entries(options).flatMap(([name, value]) =>
      typeof value === "string" ? [`--${name}=${value}`] : value ? [`--${name}`] : []);
    launchDaytona(sandbox!, checkout!, args);
    return;
  }
  if (cli.target !== "local") throw new Error("--target must be local or daytona");
  const suites: Suite[] = cli.suite === "all" ? ["short", "semver"]
    : cli.suite === "short" || cli.suite === "semver" || cli.suite === "aider" ? [cli.suite] : [];
  if (!suites.length) throw new Error("--suite must be all, short, semver, or aider");
  let model: ModelRef | undefined;
  let key: string | undefined;
  let budget = 0;
  let reserve = 0;
  let trials = 0;
  let timeoutMs = 0;
  if (cli.live) {
    const match = /^([^/]+)\/(.+)$/.exec(cli.model ?? "");
    if (!match?.[1] || !match[2]) throw new Error("--live requires --model provider/model");
    model = { providerID: match[1], id: match[2], variant: cli.variant };
    key = process.env[cli["key-env"] ?? ""];
    if (!key) throw new Error("--live requires --key-env naming a populated environment variable");
    budget = positive(cli["budget-usd"], "--budget-usd");
    reserve = positive(cli["reserve-usd"], "--reserve-usd");
    if (reserve > budget) throw new Error("Stage reserve exceeds the combined spend cap");
    trials = positive(cli.trials ?? "3", "--trials");
    if (!Number.isSafeInteger(trials)) throw new Error("--trials must be a positive integer");
    timeoutMs = positive(cli["timeout-minutes"] ?? "15", "--timeout-minutes") * 60_000;
    await readFile(join(projectRoot, "dist", "index.js"));
  }

  const cancel = new AbortController();
  const stop = () => cancel.abort(new Error("Benchmark interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const runs = join(projectRoot, ".runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(runs, cli.live ? "live-" : "preflight-"));
  process.stdout.write(`Run artifacts: ${root}\n`);
  const progressFile = process.env.OPENCODE_BENCHMARK_PROGRESS_FILE ?? join(root, "progress.jsonl");
  if (cli.live) await writeFile(progressFile, "", { flag: "wx", mode: 0o600 });
  let spent = 0;
  let budgetStopped = false;
  const results: { suite: Suite; trial: number; control: ArmResult; plugin: ArmResult; comparison: ReturnType<typeof compare> }[] = [];
  for (const suite of suites) {
    const fixtures = join(root, suite);
    const baseline = join(fixtures, "baseline");
    const reference = join(fixtures, "reference");
    let aider: Aider | undefined;
    if (suite === "aider") {
      const source = cli["aider-fixture-dir"];
      const toolsDirectory = cli["aider-tools-dir"];
      const jsDirectory = cli["aider-js-dir"];
      if (!source || !toolsDirectory || !jsDirectory) throw new Error("Aider requires --aider-fixture-dir, --aider-tools-dir and --aider-js-dir");
      const tools = { python: cli.python ?? "python", go: resolve(toolsDirectory, "go", "bin", process.platform === "win32" ? "go.exe" : "go"),
        js: resolve(jsDirectory), jars: resolve(toolsDirectory), cache: resolve(toolsDirectory, "cache") };
      aider = { exercises: await prepareAider(resolve(source), baseline), tools };
    } else {
      await prepareBaseline(suite, baseline, cli["semver-tarball"] ? resolve(cli["semver-tarball"]) : undefined);
      await prepareReference(suite, baseline, reference);
    }
    const prompts = aider ? aider.exercises.map(({ id, prompt }) => ({ id, prompt })) : stages(suite as ExistingSuite);
    const promptsSha256 = createHash("sha256").update(JSON.stringify(prompts)).digest("hex");
    const verified = cli["aider-verified"];
    const reuse = aider && verified ? await (async () => {
      const manifest = JSON.parse(await readFile(join(resolve(verified), "prompts.json"), "utf8"));
      const log = await readFile(join(resolve(verified), "reference.tap"), "utf8");
      const passed = [...log.matchAll(/^ok ([a-z][a-z0-9-]+)\r?$/gm)].map(match => match[1]);
      if (manifest.promptsSha256 !== promptsSha256 || passed.length !== 150 ||
          !passed.every((id, index) => id === prompts[index]?.id)) throw new Error("Aider preflight does not match the ordered exercise manifest");
      return { total: 150, passed: 150, failed: 0, success: true, log };
    })() : undefined;
    const retryReference = cli["aider-retry-reference"];
    const expected = reuse ?? (aider ? await gradeAider(aider.exercises, reference, undefined, aider.tools,
      retryReference ? await readFile(resolve(retryReference), "utf8") : undefined)
      : grade(suite as ExistingSuite, reference, baseline));
    const original = aider ? undefined : grade(suite as ExistingSuite, baseline, baseline);
    if (original) await writeFile(join(fixtures, "baseline.tap"), original.log, { mode: 0o600 });
    await writeFile(join(fixtures, "reference.tap"), expected.log, { mode: 0o600 });
    const reproduced = !original || (!original.success && original.failed > 0);
    if (!reproduced || !expected.success) throw new Error(`Invalid ${suite} acceptance fixture. See ${fixtures}`);
    await writeFile(join(fixtures, "prompts.json"), JSON.stringify({ promptsSha256, prompts }, null, 2), { mode: 0o600 });
    const baselineLabel = original ? `baseline ${original.passed}/${original.total}, ` : "";
    process.stdout.write(`${suite} preflight: ${baselineLabel}reference ${expected.passed}/${expected.total}\n`);
    if (!model || !key) continue;

    for (let trial = 1; trial <= trials; trial++) {
      const arms: readonly Arm[] = trial % 2 === 1 ? ["control", "plugin"] : ["plugin", "control"];
      let control;
      let plugin;
      const admitted = new Map<Arm, number>();
      const execute = async (arm: Arm) => {
        cancel.signal.throwIfAborted();
        if (budgetStopped || spent + reserve > budget || !model || !key) return;
        const result = await runArm({
          projectRoot, binary: cli["opencode-bin"], suite, arm, model, key, baseline, aider, prompts, signal: cancel.signal, timeoutMs,
          directory: join(fixtures, `trial-${trial}`, arm),
          progressFile,
          trial,
          beforeStage(estimatedCostUsd) {
            admitted.set(arm, estimatedCostUsd);
            const pending = [...admitted.values()].reduce((sum, cost) => sum + cost + reserve, 0);
            if (!budgetStopped && spent + pending <= budget) return;
            budgetStopped = true;
            throw new Error("Combined budget reserve prevents another stage");
          },
          afterArm(estimatedCostUsd) { admitted.delete(arm); spent += estimatedCostUsd; },
        });
        if (arm === "control") control = result;
        else plugin = result;
        if (result.error) process.stderr.write(`${suite}/${arm}: ${result.error}\n`);
      };
      if (cli.parallel || suite === "aider") {
        const parallel = await Promise.allSettled(arms.map(execute));
        for (const result of parallel) if (result.status === "rejected") throw result.reason;
      } else for (const arm of arms) await execute(arm);
      if (!control || !plugin) break;
      const comparison = compare(control, plugin);
      results.push({ suite, trial, control, plugin, comparison });
      await writeFile(join(root, "comparison.json"), JSON.stringify({ model, spent, results }, null, 2), { mode: 0o600 });
      if (suite === "aider") await writeFile(join(root, `comparison-${trial}.md`), englishTable(control, plugin) + "\n", { mode: 0o600 });
      process.stdout.write(`${suite} trial ${trial}: ${JSON.stringify(comparison)}\n`);
    }
  }

  if (model) {
    const completePairs = results.filter(result => result.comparison.comparable).length;
    const expectedPairs = suites.length * trials;
    await writeFile(join(root, "comparison.json"), JSON.stringify({
      model, budget, reserve, spent, expectedPairs, completePairs, results,
    }, null, 2), { mode: 0o600 });
    process.stdout.write(`Completed comparable pairs: ${completePairs}/${expectedPairs}. Estimated spend: $${spent.toFixed(4)}\n`);
    if (completePairs !== expectedPairs) process.exitCode = 1;
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Benchmark failed"}\n`);
  process.exitCode = 1;
});
