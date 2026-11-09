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
import { prepareWebBench, preflightWebBench } from "./suites/webbench.ts";
import type { WebBench } from "./suites/webbench.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = parseArgs({ options: {
  preflight: { type: "boolean" },
  live: { type: "boolean" },
  target: { type: "string", default: "local" },
  "daytona-sandbox": { type: "string", default: "Benchmark-sandbox" },
  "daytona-project-dir": { type: "string", default: "~/benchmark-progress/cloud/repo" },
  "wait-for-slot": { type: "boolean" },
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
  "webbench-fixture-dir": { type: "string" },
  "webbench-browsers-dir": { type: "string" },
  parallel: { type: "boolean" },
  python: { type: "string", default: "python" },
  "budget-usd": { type: "string" },
  "reserve-usd": { type: "string" },
  "timeout-minutes": { type: "string" },
  "max-attempts": { type: "string", default: "3" },
  trials: { type: "string" },
  suite: { type: "string", default: "all" },
} }).values;

function positive(raw: string | undefined, name: string) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function usage() {
  process.stdout.write(`Usage\n  npm run benchmark -- --preflight [--suite all|short|semver|aider]\n  npm run benchmark -- --live --model provider/model --key-env VARIABLE --budget-usd N --reserve-usd N [--parallel] [--trials 3] [--max-attempts 3] [--target local|daytona]\n\n  cat progress.jsonl | node benchmarks/run.ts --format-progress\n\nThe reserve is checked before each original or repair attempt. OpenCode records charges after requests, so this is an admission check.\n`);
}

function englishTable(control: ArmResult, plugin: ArmResult) {
  const count = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (control.suite === "webbench") {
    const table = (rows: [string, (arm: ArmResult) => string][]) => [
      "| Metric | Original OpenCode | Live Compact |", "| --- | ---: | ---: |",
      ...rows.map(([name, value]) => `| ${name} | ${value(control)} | ${value(plugin)} |`),
    ].join("\n");
    const seconds = (value: number | null | undefined) => value == null ? "—" : `${count(value / 1000)} s`;
    const wait = (arm: ArmResult, value: number | undefined) => arm.usage?.nativeCompactionTimingComplete ? seconds(value) : "timing incomplete";
    const quality = table([
      ["Stages passed within attempt limit", a => `${a.grade.passed}/${a.stagesExpected}`],
      ["Stages failed", a => count(a.grade.failed)],
      ["Stages not graded", a => count(a.stagesExpected - a.grade.total)],
      ["Stages passed on first attempt", a => `${a.attempts?.filter(x => x.firstAttemptPassed).length ?? 0}/${a.stagesExpected}`],
      ["Repair attempts", a => count(a.attempts?.reduce((n, x) => n + Math.max(0, x.startedAttempts - 1), 0))],
      ["Final cumulative tests passed", a => a.testCases ? `${a.testCases.passed}/${a.testCases.total} (through ${a.testCases.throughStage})` : "—"],
      ["Final cumulative tests failed / skipped", a => a.testCases ? `${a.testCases.failed} / ${a.testCases.skipped}` : "—"],
    ]);
    const usage = table([
      ["Estimated API cost, including repairs", a => a.usage ? `$${a.usage.costEstimateUsd.toFixed(4)}` : "—"],
      ["Cached input tokens", a => count(a.usage?.cachedReadTokens)],
      ["Uncached input tokens", a => count(a.usage?.uncachedInputTokens)],
      ["Cache-write tokens", a => count(a.usage?.cacheWriteTokens)],
      ["Overall cache hit rate", a => a.usage?.totalInputTokens ? `${(100 * a.usage.cachedReadTokens / a.usage.totalInputTokens).toFixed(2)}%` : "—"],
      ["Output tokens", a => count(a.usage?.outputTokens)],
      ["Known model requests", a => count(a.usage?.knownModelRequests)],
      ["Peak active context tokens", a => count(a.usage?.peakActiveContextTokens)],
      ["Mean active context tokens", a => count(a.usage?.meanActiveContextTokens)],
    ]);
    const timing = table([
      ["Native compaction pauses", a => count(a.usage?.nativeCompactionPauses)],
      ["First native compaction stage", a => a.usage?.firstNativeCompactionStage ?? "none"],
      ["Native compaction wait", a => wait(a, a.usage?.nativeCompactionWaitMs)],
      ["Live Compact cuts", a => count(a.usage?.replacementCuts)],
      ["Local replacement host wait", a => wait(a, a.usage?.replacementHostWaitMs)],
      ["Total host compaction wait", a => wait(a, a.usage?.hostCompactionWaitMs)],
      ["Local replacement processing", a => seconds(a.usage?.replacementOverheadMs)],
      ["Recall calls", a => count(a.usage?.recalls)],
      ["Wall time", a => `${count(a.wallSeconds)} s`],
    ]);
    const pauseConclusion = compare(control, plugin).nativeWaitDeltaMs === null
      ? "Pause comparison is inconclusive: Original OpenCode must compact automatically, both runs must finish, and timing telemetry must be complete."
      : "Native and local replacement host wait are reported separately and together; local processing may overlap host wait and is not added twice.";
    return [quality, usage, timing,
      "Costs are OpenCode estimates, not billing receipts. Stage outcomes retain failures after the fixed repair limit; final cumulative test results show the ending application. This is an adapted Web-Bench run with three attempts per stage by default, not an official leaderboard score.", pauseConclusion].join("\n\n");
  }
  const values = (arm: ArmResult) => {
    const u = arm.usage;
    const hit = u?.totalInputTokens ? u.cachedReadTokens / u.totalInputTokens * 100 : null;
    const rate = (value: number) => arm.grade.total ? `${(100 * value / arm.grade.total).toFixed(2)}%` : "—";
    const compaction = u ? [
      ...(u.replacementCuts ? [`${u.replacementCuts} cuts`] : []),
      ...(u.nativeCompactionPauses || !u.replacementCuts ? [`${u.nativeCompactionPauses} pause${u.nativeCompactionPauses === 1 ? "" : "s"}`] : []),
    ].join(" + ") + ` · ${u.nativeCompactionTimingComplete ? count(u.hostCompactionWaitMs / 1000) + " s" : "timing incomplete"}` : "—";
    return [
      `${arm.grade.passed}/${arm.stagesExpected}`,
      arm.attempts ? `${arm.attempts.filter(exercise => exercise.firstAttemptPassed).length}/${arm.stagesExpected}` : "—",
      arm.attempts ? count(arm.attempts.reduce((sum, exercise) => sum + Math.max(0, exercise.startedAttempts - 1), 0)) : "—",
      rate(arm.grade.passed), `${arm.grade.failed} (${rate(arm.grade.failed)})`,
      hit === null ? "—" : `${hit.toFixed(2)}%`,
      count(u?.cachedReadTokens), count(u ? u.uncachedInputTokens + u.cacheWriteTokens : null),
      u ? `$${u.costEstimateUsd.toFixed(4)}` : "—", count(u?.peakActiveContextTokens),
      compaction,
      count(arm.wallSeconds),
    ];
  };
  const rows = ["Exercises passed", "Passed on first attempt", "Repair attempts", "Pass rate among graded exercises", "Failed exercises and rate", "Overall cache hit rate", "Cached input tokens", "Non-cached input tokens (including cache writes)",
    "Estimated API cost", "Peak context tokens", "Compaction", "Wall time (seconds)"];
  const stock = values(control);
  const treatment = values(plugin);
  return [
    "| Metric | Original OpenCode | Live Compact |",
    "| --- | ---: | ---: |",
    ...rows.map((row, index) => `| ${row} | ${stock[index]} | ${treatment[index]} |`),
    "", "Costs include every original and repair attempt and are estimates from OpenCode. Cache hit rate is cached reads divided by total input, including writes. Compaction time measures native and local replacement host lifecycles; planning outside those events is excluded.",
  ].join("\n");
}

function compare(control: ArmResult, treatment: ArmResult) {
  const comparable = !control.error && !treatment.error && control.stagesCompleted === control.stagesExpected &&
    treatment.stagesCompleted === treatment.stagesExpected &&
    JSON.stringify(control.attemptPolicy) === JSON.stringify(treatment.attemptPolicy) &&
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
    const { target, "daytona-sandbox": sandbox, "daytona-project-dir": checkout, "wait-for-slot": waitForSlot, ...options } = cli;
    const args = Object.entries(options).flatMap(([name, value]) =>
      typeof value === "string" ? [`--${name}=${value}`] : value ? [`--${name}`] : []);
    launchDaytona(sandbox!, checkout!, args, { waitForSlot });
    return;
  }
  if (cli.target !== "local") throw new Error("--target must be local or daytona");
  const suites: Suite[] = cli.suite === "all" ? ["short", "semver"]
    : cli.suite === "short" || cli.suite === "semver" || cli.suite === "aider" || cli.suite === "webbench" ? [cli.suite] : [];
  if (!suites.length) throw new Error("--suite must be all, short, semver, aider, or webbench");
  let model: ModelRef | undefined;
  let key: string | undefined;
  let budget = 0;
  let reserve = 0;
  let trials = 0;
  let timeoutMs = 0;
  const maxAttempts = positive(cli["max-attempts"], "--max-attempts");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts > 5) throw new Error("--max-attempts must be an integer from 1 to 5");
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
    let webbench: WebBench | undefined;
    if (suite === "aider") {
      const source = cli["aider-fixture-dir"];
      const toolsDirectory = cli["aider-tools-dir"];
      const jsDirectory = cli["aider-js-dir"];
      if (!source || !toolsDirectory || !jsDirectory) throw new Error("Aider requires --aider-fixture-dir, --aider-tools-dir and --aider-js-dir");
      const tools = { python: cli.python ?? "python", go: resolve(toolsDirectory, "go", "bin", process.platform === "win32" ? "go.exe" : "go"),
        js: resolve(jsDirectory), jars: resolve(toolsDirectory), cache: resolve(toolsDirectory, "cache") };
      aider = { exercises: await prepareAider(resolve(source), baseline, tools), tools };
    } else if (suite === "webbench") {
      if (!cli["webbench-fixture-dir"]) throw new Error("Web-Bench requires --webbench-fixture-dir pointing to the pinned, installed fixture");
      webbench = await prepareWebBench(resolve(cli["webbench-fixture-dir"]), baseline, {
        browsersPath: cli["webbench-browsers-dir"] ? resolve(cli["webbench-browsers-dir"]) : undefined,
      });
    } else {
      await prepareBaseline(suite, baseline, cli["semver-tarball"] ? resolve(cli["semver-tarball"]) : undefined);
      await prepareReference(suite, baseline, reference);
    }
    const prompts = aider ? aider.exercises.map(({ id, prompt }) => ({ id, prompt })) : webbench ? webbench.stages : stages(suite as ExistingSuite);
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
    if (webbench) {
      process.stdout.write("webbench preflight: checking starter, full reference twice, and broken-reference rejection (no model calls)\n");
      const preflight = await preflightWebBench(webbench, join(fixtures, "preflight"));
      const dependencies = Object.fromEntries(await Promise.all(["react", "react-dom", "vite", "@vitejs/plugin-react", "typescript", "@playwright/test"].map(async name => {
        const bytes = await readFile(join(webbench.nodeModules, name, "package.json"));
        return [name, { version: JSON.parse(bytes.toString()).version, sha256: createHash("sha256").update(bytes).digest("hex") }];
      })));
      await writeFile(join(fixtures, "preflight.json"), JSON.stringify({ ...preflight, environment: {
        node: process.version, platform: process.platform, architecture: process.arch, dependencies,
        sourceHashes: webbench.sourceHashes, runtimeHashes: webbench.runtimeHashes,
        browserPath: webbench.browsersPath, workers: 1, retries: 0,
      } }, null, 2), { mode: 0o600 });
      await writeFile(join(fixtures, "prompts.json"), JSON.stringify({ promptsSha256, prompts }, null, 2), { mode: 0o600 });
      if (!preflight.success) throw new Error(`Invalid Web-Bench acceptance fixture. See ${fixtures}/preflight.json`);
      process.stdout.write(`webbench preflight: baseline and mutation rejected; full reference passed twice\n`);
    } else {
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
    }
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
          projectRoot, binary: cli["opencode-bin"], suite, arm, model, key, baseline, aider, webbench, prompts, signal: cancel.signal, timeoutMs, maxAttempts,
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
      if (cli.parallel || suite === "aider" || suite === "webbench") {
        const parallel = await Promise.allSettled(arms.map(execute));
        for (const result of parallel) if (result.status === "rejected") throw result.reason;
      } else for (const arm of arms) await execute(arm);
      if (!control || !plugin) break;
      const comparison = compare(control, plugin);
      results.push({ suite, trial, control, plugin, comparison });
      await writeFile(join(root, "comparison.json"), JSON.stringify({ model, maxAttempts, spent, results }, null, 2), { mode: 0o600 });
      if (suite === "aider" || suite === "webbench") await writeFile(join(root, `comparison-${trial}.md`), englishTable(control, plugin) + "\n", { mode: 0o600 });
      process.stdout.write(`${suite} trial ${trial}: ${JSON.stringify(comparison)}\n`);
    }
  }

  if (model) {
    const completePairs = results.filter(result => result.comparison.comparable).length;
    const expectedPairs = suites.length * trials;
    await writeFile(join(root, "comparison.json"), JSON.stringify({
      model, maxAttempts, budget, reserve, spent, expectedPairs, completePairs, results,
    }, null, 2), { mode: 0o600 });
    process.stdout.write(`Completed comparable pairs: ${completePairs}/${expectedPairs}. Estimated spend: $${spent.toFixed(4)}\n`);
    const acceptedPairs = results.filter(result => result.comparison.comparable && result.comparison.bothPassed).length;
    process.stdout.write(`Pairs passing all acceptance tests: ${acceptedPairs}/${expectedPairs}\n`);
    if (completePairs !== expectedPairs || acceptedPairs !== expectedPairs) process.exitCode = 1;
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Benchmark failed"}\n`);
  process.exitCode = 1;
});
