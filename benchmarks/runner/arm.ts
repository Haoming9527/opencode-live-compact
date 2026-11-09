import { spawnSync } from "node:child_process";
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { ModelRef, OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { observeStage, summarize } from "./metrics.ts";
import type { PluginMetric, StageReceipt } from "./metrics.ts";
import { commandEnvironment, startOpenCode } from "./opencode.ts";
import type { Suite as ExistingSuite, Stage } from "../suites/workloads.ts";
import { gradeAider } from "../suites/aider.ts";
import type { Aider } from "../suites/aider.ts";
import { gradeWebBench } from "../suites/webbench.ts";
import type { WebBench } from "../suites/webbench.ts";

import { grade } from "../suites/workloads.ts";
import { logGrades } from "./progress.ts";
import { runExerciseAttempts } from "./attempts.ts";

const eventTypes = [
  "session.inbox.delivered", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.started", "session.step.ended", "session.step.failed", "session.retry.scheduled",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
] as const;
export type Arm = "control" | "plugin";
export type Suite = ExistingSuite | "aider" | "webbench";

type TestCases = Pick<Awaited<ReturnType<typeof gradeWebBench>>, "total" | "passed" | "failed" | "skipped" | "success">;

async function retainedText(client: OpenCodeClient, sessionID: string, signal: AbortSignal) {
  const context = await client.session.context({ sessionID }, { signal });
  const answer = context.findLast(message => message.type === "assistant" && message.content.some(part => part.type === "text"));
  if (answer?.type !== "assistant") return false;
  const text = answer.content.map(part => part.type === "text" ? part.text : "").join("\n");
  return /^\s*RETENTION:\s*invalid-version\s*,\s*invalid-range\s*$/m.test(text);
}

async function readDiagnostics(file: string) {
  try {
    const raw = await readFile(file, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as PluginMetric);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function meteredModel(client: OpenCodeClient, directory: string, model: ModelRef, signal: AbortSignal) {
  const until = Date.now() + 30_000;
  for (;;) {
    signal.throwIfAborted();
    try {
      const list = await client.model.list({ location: { directory } }, { signal });
      const entry = list.data.find(item => item.providerID === model.providerID && item.id === model.id);
      if (entry?.enabled && entry.cost.some(tier => tier.input > 0 && tier.output > 0)) return entry;
    } catch (error) {
      if (Date.now() >= until) throw error;
    }
    if (Date.now() >= until) throw new Error(`A metered ${model.providerID}/${model.id} is unavailable in the isolated profile`);
    await delay(350, undefined, { signal });
  }
}

interface ArmOptions {
  projectRoot: string;
  binary?: string;
  suite: Suite;
  arm: Arm;
  directory: string;
  baseline: string;
  aider?: Aider;
  webbench?: WebBench;
  prompts: readonly Stage[];
  progressFile: string;
  trial: number;
  model: ModelRef;
  key: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxAttempts?: number;
  beforeStage(estimatedCostUsd: number): void;
  afterArm(estimatedCostUsd: number): void;
}

export async function runArm(options: ArmOptions) {
  const { suite, arm, directory, baseline, model, key, signal } = options;
  const stagedGrading = suite === "aider" || suite === "webbench";
  if ((suite === "aider" && !options.aider) || (suite === "webbench" && !options.webbench)) {
    throw new Error(`The ${suite} benchmark fixture is missing`);
  }
  const workspace = join(directory, "project");
  const profile = join(directory, "profile");
  const metricsFile = join(directory, "plugin.jsonl");
  const started = performance.now();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(baseline, workspace, { recursive: true });
  const archiveDirectory = arm === "plugin" ? await mkdtemp(join(await realpath(tmpdir()), "opencode-benchmark-archive-")) : undefined;
  const config = arm === "control" ? {} : {
    plugins: [{
      package: pathToFileURL(options.projectRoot).href,
      options: { diagnostics: true, metricsFile, archiveDirectory },
    }],
  };
  await writeFile(join(workspace, "opencode.json"), JSON.stringify(config, null, 2));
  const git = spawnSync("git", ["init", "--quiet"], { cwd: workspace, env: commandEnvironment(), windowsHide: true });
  if (git.status !== 0) throw new Error(git.error?.message ?? "Could not initialize the isolated benchmark checkout");
  const staged = spawnSync("git", ["-c", "core.autocrlf=false", "add", "-A", "--", ".", ":(exclude)opencode.json"], {
    cwd: workspace, env: commandEnvironment(), windowsHide: true,
  });
  if (staged.status !== 0) throw new Error(staged.error?.message ?? "Could not index the benchmark baseline");

  const host = await startOpenCode({
    binary: options.binary, directory: workspace, profile, signal,
    toolPaths: options.aider ? [dirname(options.aider.tools.go), dirname(options.aider.tools.python)] : undefined,
  });
  const { client } = host;
  const log: OpenCodeEvent[] = [];
  const completed: StageReceipt[] = [];
  const exerciseGrades: Awaited<ReturnType<typeof gradeAider>>["outcomes"] = [];
  const exerciseLogs: string[] = [];
  const exerciseAttempts: { id: string; attempts: number; startedAttempts: number; firstAttemptPassed: boolean | null;
    outcomes: { attempt: number; passed: boolean; estimatedUsd: number; gradeDirectory: string; testCases?: TestCases }[] }[] = [];
  let finalTestCases: (TestCases & { throughStage: string }) | undefined;
  let sessionID: string | undefined;
  let credentialID: string | undefined;
  let current: SessionInfo | undefined;
  const eventController = new AbortController();
  let eventTask: Promise<void> | undefined;
  let connected = false;
  let eventStreamFailed = false;
  let error: string | undefined;
  let retentionCorrect: boolean | null = null;
  let modelConfiguration;
  try {
    const credential = await client.credential.create({ integrationID: model.providerID, value: { type: "key", key }, activate: true }, { signal });
    credentialID = credential.id;
    const entry = await meteredModel(client, workspace, model, signal);
    modelConfiguration = { cost: entry.cost, limit: entry.limit, modelID: entry.modelID };
    const loaded = await client.plugin.list({ location: { directory: workspace } }, { signal });
    const liveCompact = loaded.data.some(plugin => plugin.id === "opencode-live-compact" && plugin.state.status === "active");
    if (liveCompact !== (arm === "plugin")) throw new Error("The loaded plugins do not match the benchmark arm");
    current = await client.session.create({
      location: { directory: workspace },
      title: `Live Compact benchmark (${suite})`,
      model,
      permissions: ["subagent", "webfetch", "websearch", "external_directory"].map(action => ({ action, resource: "*", effect: "deny" as const })),
    }, { signal });
    sessionID = current.id;

    eventTask = (async () => {
      try {
        for await (const event of client.event.subscribe({ types: [...eventTypes], signal: eventController.signal })) {
          if (event.type === "server.connected") connected = true;
          else if ("sessionID" in event.data && event.data.sessionID === sessionID && "durable" in event) log.push(event);
        }
      } catch {
        // Public subscriptions are live-only on stock 2.2.6. A gap invalidates timing.
      } finally {
        if (!eventController.signal.aborted) eventStreamFailed = true;
      }
    })();
    const connectionTimeout = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    while (!connected && !eventStreamFailed) await delay(25, undefined, { signal: connectionTimeout });
    if (eventStreamFailed) throw new Error("OpenCode event stream failed before the first stage");

    for (const stage of options.prompts) {
      signal.throwIfAborted();
      if (!stagedGrading) {
        options.beforeStage(current.cost);
        await appendFile(options.progressFile, JSON.stringify({ event: "stage-started", arm, trial: options.trial, stage: stage.id, completed: completed.length,
          expected: options.prompts.length, estimatedUsd: current.cost, time: new Date().toISOString() }) + "\n");
      }
      process.stdout.write(`${suite}/${arm} stage ${completed.length + 1}: ${stage.id} ($${current.cost.toFixed(4)} estimated so far)\n`);
      // One deadline gates the original and repair turns. Bounded grading may finish
      // after it expires so the last completed solution still receives a score.
      const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
      const activeSessionID = sessionID;
      const receipts: StageReceipt[] = [];
      const execute = async (text: string) => {
        stageSignal.throwIfAborted();
        const firstEvent = log.length;
        const admission = await client.session.prompt({ sessionID: activeSessionID, text, delivery: "queue" }, { signal: stageSignal });
        let stageOutcome: ReturnType<typeof observeStage>;
        for (;;) {
          if (eventStreamFailed) throw new Error("OpenCode event stream failed during the stage");
          stageOutcome = observeStage(log.slice(firstEvent), admission.id, stage.id);
          if (stageOutcome) break;
          await delay(100, undefined, { signal: stageSignal });
        }
        current = await client.session.get({ sessionID: activeSessionID }, { signal: stageSignal });
        if ((current.time.idle ?? -1) < stageOutcome.endedAt) throw new Error(`Stage ${stage.id} has no matching persisted idle marker`);
        receipts.push(stageOutcome.receipt);
        if (!stageOutcome.success) throw new Error(`Stage ${stage.id} ended with ${stageOutcome.outcome}`);
        if (!stageOutcome.meteredPrimary) throw new Error(`Stage ${stage.id} did not report metered primary usage. Stopping before another admission.`);
        return { receipt: stageOutcome.receipt, estimatedUsd: current.cost };
      };
      const aider = suite === "aider" ? options.aider : undefined;
      const exercise = aider?.exercises[completed.length];
      const webbench = suite === "webbench" ? options.webbench : undefined;
      const webStage = webbench?.stages[completed.length];
      if (stagedGrading) {
        if ((suite === "aider" ? exercise?.id : webStage?.id) !== stage.id) {
          throw new Error(`${suite} exercise order differs from prompt order`);
        }
        const attemptDirectory = (attempt: number) => join(directory, "attempts", stage.id, `attempt-${attempt}`);
        const result = await runExerciseAttempts({
          maxAttempts: options.maxAttempts ?? 3,
          prompt: stage.prompt,
          repairInstructions: suite === "webbench"
            ? "Edit only the application's permitted src files. Preserve the behavior required by earlier tasks while fixing the cumulative tests. Do not edit tests, the test runner, configuration, or dependencies. Run the supplied cumulative test command before finishing."
            : undefined,
          beforeAttempt: async () => {
            stageSignal.throwIfAborted();
            current = await client.session.get({ sessionID: activeSessionID }, { signal: stageSignal });
            options.beforeStage(current.cost);
          },
          execute,
          grade: async (attempt) => {
            const folder = attemptDirectory(attempt);
            const result = webbench
              ? await gradeWebBench(webbench, stage.id, join(folder, "graded"), workspace)
              : await gradeAider([exercise!], join(folder, "graded"), workspace, aider!.tools);
            await mkdir(folder, { recursive: true });
            await writeFile(join(folder, "grade.tap"), result.log, { mode: 0o600 });
            const { log: gradeLog, ...receipt } = result;
            await writeFile(join(folder, "grade.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
            if ("infrastructureError" in result && result.infrastructureError) {
              throw new Error(`WebBench evaluator failed: ${result.infrastructureError}`);
            }
            let testCases: TestCases | undefined;
            if (webbench) {
              if (!("skipped" in result) || typeof result.skipped !== "number" || result.total < 1) {
                throw new Error("Independent WebBench grading returned no test cases");
              }
              const { total, passed, failed, skipped, success } = result;
              testCases = { total, passed, failed, skipped, success };
            }
            const passed = webbench ? result.success : result.outcomes[0]?.passed;
            if ((!webbench && result.total !== 1) || passed === undefined) throw new Error("Independent exercise grading returned no result");
            return { passed, log: gradeLog, outcome: { id: stage.id, passed }, testCases };
          },
          onRepair: async (attempt, previous) => {
            process.stdout.write(`${suite}/${arm} ${stage.id}: repair attempt ${attempt}/${options.maxAttempts ?? 3} ($${previous.estimatedUsd.toFixed(4)} estimated total)\n`);
            await appendFile(options.progressFile, JSON.stringify({ event: "exercise-repair", arm, trial: options.trial,
              stage: stage.id, attempt, maxAttempts: options.maxAttempts ?? 3, estimatedUsd: previous.estimatedUsd,
              time: new Date().toISOString() }) + "\n");
          },
        });
        const first = receipts[0], last = receipts.at(-1);
        if (first && last) completed.push({ id: stage.id, before: first.before, after: last.after });
        exerciseAttempts.push({ id: stage.id, attempts: result.attempts.length, startedAttempts: result.startedAttempts,
          firstAttemptPassed: result.attempts[0]?.grade.passed ?? null,
          outcomes: result.attempts.map(attempt => ({ attempt: attempt.attempt, passed: attempt.grade.passed,
            estimatedUsd: attempt.estimatedUsd, gradeDirectory: attemptDirectory(attempt.attempt), testCases: attempt.grade.testCases })) });
        const final = result.attempts.at(-1);
        if (final) {
          await logGrades(options.progressFile, arm, [final.grade.outcome], exerciseGrades, options.trial,
            current!.cost, options.prompts.length);
          exerciseGrades.push(final.grade.outcome);
          exerciseLogs.push(final.grade.log);
          if (final.grade.testCases) finalTestCases = { ...final.grade.testCases, throughStage: stage.id };
        }
        if (result.stopped !== undefined) throw result.stopped;
      } else {
        const result = await execute(stage.prompt);
        completed.push(result.receipt);
      }
    }
    const children = await client.session.list({ parentID: sessionID, limit: 1 }, { signal });
    if (children.data.length > 0) throw new Error("An unexpected child session made this arm incomparable");
    if (suite === "semver") retentionCorrect = await retainedText(client, sessionID, signal);
    current = await client.session.get({ sessionID }, { signal });
  } catch (cause) {
    error = cause instanceof Error && !cause.message.includes(key)
      ? cause.message.split(/\r?\n/)[0] : "OpenCode arm failed";
    if (sessionID) {
      await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
      current = await client.session.get({ sessionID }, { signal: AbortSignal.timeout(5_000) }).catch(() => current);
    }
  } finally {
    eventController.abort();
    await eventTask;
    if (credentialID) {
      await client.credential.remove({ credentialID }, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }
    await host.close();
    const profileInfo = await lstat(profile);
    const expected = join(await realpath(directory), "profile");
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink() || await realpath(profile) !== expected) {
      throw new Error("The isolated OpenCode profile moved during the run. Check its credentials before cleanup.");
    }
    await rm(expected, { recursive: true, force: true });
    if (archiveDirectory && await realpath(archiveDirectory) === archiveDirectory && !(await lstat(archiveDirectory)).isSymbolicLink()) {
      await rm(archiveDirectory, { recursive: true, force: true });
    }
  }
  if (current) options.afterArm(current.cost);
  const diagnostics = await readDiagnostics(metricsFile);

  const freshCandidate = join(directory, "graded");
  if (!stagedGrading) await cp(workspace, freshCandidate, {
    recursive: true,
    filter: async source => ![".git", ".opencode", "opencode.json", "node_modules", ".env"].includes(basename(source)) &&
      !(await lstat(source)).isSymbolicLink(),
  });
  const wallSeconds = (performance.now() - started) / 1000;
  const passed = exerciseGrades.filter(grade => grade.passed).length;
  const { log: gradeLog, ...gradingResult } = stagedGrading
    ? { total: exerciseGrades.length, passed, failed: exerciseGrades.length - passed, success: passed === options.prompts.length,
      outcomes: exerciseGrades, log: exerciseLogs.join("\n") }
    : grade(suite as ExistingSuite, freshCandidate, baseline);
  await writeFile(join(directory, "grade.tap"), gradeLog, { mode: 0o600 });
  const armResult = {
    suite, arm, sessionID, modelConfiguration, stagesCompleted: completed.length, stagesExpected: options.prompts.length, wallSeconds,
    error, retentionCorrect, grade: gradingResult,
    ...(stagedGrading ? { attemptPolicy: { maxAttempts: options.maxAttempts ?? 3 }, attempts: exerciseAttempts } : {}),
    ...(suite === "webbench" ? { testCases: finalTestCases ?? null } : {}),
    usage: current ? summarize(current, log, completed, diagnostics, !eventStreamFailed && completed.length === options.prompts.length) : null,
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(armResult, null, 2), { mode: 0o600 });
  return armResult;
}

export type ArmResult = Awaited<ReturnType<typeof runArm>>;

