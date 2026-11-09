import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { commandEnvironment } from "../runner/opencode.ts";

const run = promisify(execFile);
export const webBenchCommit = "7b31ca2b786eef120dd49ce63dd03d0c0006046d";
export const webBenchTestCases = 59;
export const webBenchStageTestCases = [4, 3, 1, 2, 2, 3, 2, 4, 4, 4, 3, 4, 5, 2, 4, 3, 2, 3, 3, 1] as const;
const configuration = ["package.json", "playwright.config.js", "vite.config.ts", "tsconfig.json", "typings.d.ts"];
export interface WebBench {
  stages: { id: string; number: number; prompt: string }[];
  fixture: string;
  initial: string;
  reference?: string;
  nodeModules: string;
  playwrightCLI: string;
  browsersPath: string;
  port: number;
  timeoutMs: number;
  hashes: Record<string, string>;
  sourceHashes: Record<string, string>;
  runtimeHashes: Record<string, string>;
}
export interface WebBenchGrade {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  success: boolean;
  assertionFailures: number;
  outcomes: { id: string; passed: boolean }[];
  log: string;
  infrastructureError?: string;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reject links rather than copying files outside the candidate's source tree. */
async function sourceFiles(root: string): Promise<string[]> {
  const names: string[] = [];
  let bytes = 0;
  const visit = async (directory: string, prefix = "") => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not a plain source directory: ${prefix || "."}`);
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const path = join(directory, item.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Source link is not allowed: ${relative}`);
      if (info.isDirectory()) await visit(path, relative);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 64 * 1024 * 1024 || names.length >= 10_000) throw new Error("Source exceeds the fixture size limit");
        names.push(relative);
      } else throw new Error(`Non-regular source file: ${relative}`);
    }
  };
  await visit(root);
  return names;
}

async function copySource(source: string, target: string) {
  for (const name of await sourceFiles(source)) {
    const destination = join(target, name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(source, name)), { flag: "wx" });
  }
}

async function freshDirectory(directory: string) {
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
}

function stageNumber(id: string) {
  const match = /^task-([1-9]|1\d|20)$/.exec(id);
  if (!match) throw new Error("Supply one Web-Bench stage ID, task-1 through task-20");
  return Number(match[1]);
}

/** Require a clean pinned fixture; a revision label alone cannot verify an archive. */
export async function prepareWebBench(source: string, baseline: string, options: {
  browsersPath?: string; port?: number; timeoutMs?: number;
} = {}): Promise<WebBench> {
  source = await realpath(source);
  const revision = (await run("git", ["rev-parse", "HEAD"], {
    cwd: source, env: commandEnvironment(), windowsHide: true,
  })).stdout.trim();
  if (revision !== webBenchCommit) throw new Error(`Web-Bench fixture must be pinned to ${webBenchCommit}`);
  const protectedPaths = ["projects/react", "libraries/test-util", "common/config/rush/pnpm-lock.yaml"];
  await run("git", ["diff", "--exit-code", "--no-ext-diff", "--quiet", webBenchCommit, "--", ...protectedPaths], {
    cwd: source, env: commandEnvironment(), windowsHide: true,
  });
  const untracked = (await run("git", ["ls-files", "--others", "--exclude-standard", "--", ...protectedPaths], {
    cwd: source, env: commandEnvironment(), windowsHide: true,
  })).stdout.trim();
  if (untracked) throw new Error("Unexpected untracked files in the protected Web-Bench fixture");
  const tracked = (await run("git", ["ls-tree", "-r", "--name-only", webBenchCommit, "--", ...protectedPaths], {
    cwd: source, env: commandEnvironment(), windowsHide: true,
  })).stdout.trim().split(/\r?\n/);
  const sourceHashes = Object.fromEntries(await Promise.all(tracked.map(async name => [name, digest(await readFile(join(source, name)))])));
  const project = join(source, "projects", "react");
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  if (manifest.name !== "@web-bench/react" || manifest.devDependencies?.["@playwright/test"] !== "1.57.0") {
    throw new Error("Unexpected Web-Bench React fixture or Playwright version");
  }
  const nodeModules = await realpath(join(project, "node_modules"));
  const installed = JSON.parse(await readFile(join(nodeModules, "@playwright", "test", "package.json"), "utf8"));
  if (installed.version !== "1.57.0") throw new Error("Install the fixture's exact Playwright 1.57.0 runtime");
  const playwrightCLI = await realpath(join(nodeModules, "@playwright", "test", "cli.js"));
  const runtimeFiles = [join(nodeModules, "@playwright", "test", "package.json"), playwrightCLI];
  for (const name of ["package.json", "src/index.js", "src/css.js"]) {
    const path = join(nodeModules, "@web-bench", "test-util", name);
    if (digest(await readFile(path)) !== sourceHashes[`libraries/test-util/${name}`]) throw new Error(`Installed test helper differs from pinned source: ${name}`);
    runtimeFiles.push(path);
  }
  const runtimeHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async path => [await realpath(path), digest(await readFile(path))])));
  const browsersPath = resolve(options.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
    : process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright")));
  const raw = (await readFile(join(project, "tasks.jsonl"), "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
  raw.sort((a, b) => stageNumber(a.id) - stageNumber(b.id));
  if (raw.length !== 20 || raw.some((task, index) => task.id !== `task-${index + 1}` || typeof task.description !== "string" || !task.description.trim())) {
    throw new Error("Expected exactly Web-Bench React tasks 1 through 20");
  }
  const port = options.port ?? 0;
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Web-Bench runtime options");
  await freshDirectory(baseline);
  const fixture = await mkdtemp(join(dirname(baseline), "webbench-tests-"));
  for (const name of configuration) {
    const data = await readFile(join(project, name));
    await writeFile(join(fixture, name), data);
    await writeFile(join(baseline, name), data);
  }
  await copySource(join(project, "test"), join(fixture, "test"));
  await copySource(join(project, "test"), join(baseline, "test"));
  await copySource(join(project, "src-init"), join(fixture, "src-init"));
  await copySource(join(project, "src-init"), join(baseline, "src"));
  await writeFile(join(fixture, "LICENSE.md"), await readFile(join(source, "LICENSE.md")));
  await writeFile(join(baseline, "LICENSE.web-bench.md"), await readFile(join(source, "LICENSE.md")));
  await writeFile(join(baseline, ".gitignore"), "node_modules/\n.benchmark-grades/\nplaywright-report/\ntest-results/\ndist/\n");
  await symlink(nodeModules, join(baseline, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const hashes = Object.fromEntries(await Promise.all((await sourceFiles(fixture)).map(async name => [name, digest(await readFile(join(fixture, name)))])));
  const stages = raw.map((task, index) => ({ id: task.id as string, number: index + 1, prompt: [
    task.description,
    `Implement Web-Bench React ${task.id} in src/. Keep all previous features working.`,
    "Only edit src/ files and assets; leave src/index.html, tests, configuration and dependencies intact.",
    `Run node .benchmark-test.mjs ${task.id} from the project root and fix any failing cumulative tests before finishing.`,
    "Use ordinary local tools. Do not access the network, reference implementations, files outside this workspace, or subagents. Stop after this stage.",
  ].join("\n\n") }));
  const suite: WebBench = { stages, fixture, initial: join(fixture, "src-init"), reference: join(project, "src"),
    nodeModules, playwrightCLI, browsersPath, port, timeoutMs, hashes, sourceHashes, runtimeHashes };
  // This helper contains no reference path, solution, or future task descriptions.
  const { reference: _reference, stages: _stages, sourceHashes: _sourceHashes, ...selfTest } = suite;
  await writeFile(join(baseline, ".benchmark-test.mjs"), [
    `import { gradeWebBench } from ${JSON.stringify(import.meta.url)};`,
    'import { mkdir, mkdtemp } from "node:fs/promises";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const suite = ${JSON.stringify({ ...selfTest, stages: [] })};`,
    'if (process.argv.length !== 3 || !/^task-([1-9]|1\\d|20)$/.test(process.argv[2])) throw new Error("Supply one Web-Bench stage ID, task-1 through task-20");',
    'const workspace = dirname(fileURLToPath(import.meta.url));',
    'const folder = join(workspace, ".benchmark-grades"); await mkdir(folder, { recursive: true });',
    'const attempt = await mkdtemp(join(folder, "attempt-"));',
    'const result = await gradeWebBench(suite, process.argv[2], join(attempt, "graded"), workspace);',
    'process.stdout.write(result.log + "\\n");',
    'process.exitCode = result.success ? 0 : 1;',
    "",
  ].join("\n"), { mode: 0o600 });
  return suite;
}

interface TestResult { status?: string; error?: { message?: string }; errors?: { message?: string }[] }
interface ReportTest { status?: string; expectedStatus?: string; results?: TestResult[]; projectName?: string }
interface ReportSpec { file?: string; title?: string; tests?: ReportTest[] }
interface ReportSuite { file?: string; suites?: ReportSuite[]; specs?: ReportSpec[] }
interface PlaywrightReport { suites?: ReportSuite[]; errors?: { message?: string }[]; stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number } }

export function parseWebBenchReport(report: PlaywrightReport, stageID: string, exitCode: number): WebBenchGrade {
  const through = stageNumber(stageID);
  const cases: { stage: number; spec: ReportSpec; test: ReportTest }[] = [];
  const visit = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file ?? "";
      const match = /(?:^|[\\/])task-(\d+)\.spec\.js$/.exec(file);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > through) throw new Error(`Unexpected test file in report: ${file}`);
      for (const test of spec.tests ?? []) cases.push({ stage: Number(match[1]), spec, test });
    }
    for (const nested of suite.suites ?? []) visit(nested);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const problems = [...(report.errors ?? []).map(error => error.message ?? "Playwright reported a global error")];
  if (!cases.length) problems.push("No test cases ran");
  for (let n = 1; n <= through; n++) {
    const count = cases.filter(item => item.stage === n).length;
    if (count !== webBenchStageTestCases[n - 1]) problems.push(`Expected ${webBenchStageTestCases[n - 1]} task-${n} test cases, received ${count}`);
  }
  if (through === 20 && cases.length !== webBenchTestCases) problems.push(`Expected ${webBenchTestCases} cases, received ${cases.length}`);
  let passed = 0, failed = 0, skipped = 0, assertionFailures = 0;
  const logs: string[] = [];
  const identities = new Set<string>();
  for (const { stage, spec, test } of cases) {
    const identity = JSON.stringify([stage, spec.title, test.projectName]);
    if (!spec.title || identities.has(identity)) problems.push(`Missing or duplicate test identity in task-${stage}`);
    identities.add(identity);
    const results = test.results ?? [];
    const result = results[0];
    const messages = [...(result?.errors ?? []).map(error => error.message ?? ""), result?.error?.message ?? ""].filter(Boolean).map(stripVTControlCharacters);
    if (results.length !== 1 || test.expectedStatus !== "passed" || test.projectName !== "chromium") problems.push(`Unexpected retries, expected status, or project for ${spec.title}`);
    if (result?.status === "passed" && test.status === "expected") passed++;
    else if (result?.status === "skipped" || test.status === "skipped") skipped++;
    else failed++;
    if (messages.some(message => /\bexpect\s*\(/.test(message))) assertionFailures++;
    if (messages.some(message => /Executable doesn't exist|browserType\.launch|Failed to launch|Target page, context or browser has been closed|ENOSPC|ENOMEM|EADDRINUSE/.test(message))) {
      problems.push(`Browser/runtime failure in ${spec.title}`);
    }
    logs.push(`${result?.status === "passed" ? "ok" : "not ok"} task-${stage}: ${spec.title ?? "unnamed test"}${messages.length ? "\n" + [...new Set(messages)].join("\n") : ""}`);
  }
  const stats = report.stats;
  if (!stats || stats.expected !== passed || stats.unexpected !== failed || stats.skipped !== skipped || stats.flaky !== 0) problems.push("Playwright summary does not match individual results");
  if ((passed === cases.length && exitCode !== 0) || (failed + skipped > 0 && exitCode === 0 && failed > 0)) problems.push("Playwright exit status disagrees with results");
  const outcomes = Array.from({ length: through }, (_, index) => ({ id: `task-${index + 1}`, passed: cases.some(item => item.stage === index + 1) &&
    cases.filter(item => item.stage === index + 1).every(item => item.test.status === "expected" && item.test.results?.[0]?.status === "passed") }));
  const infrastructureError = problems.length ? [...new Set(problems)].join("; ") : undefined;
  return { total: cases.length, passed, failed, skipped, success: !infrastructureError && cases.length > 0 && passed === cases.length,
    assertionFailures, outcomes, log: [...logs, `${passed} passed, ${failed} failed, ${skipped} skipped (${cases.length} test cases)`, ...(infrastructureError ? [infrastructureError] : [])].join("\n"),
    ...(infrastructureError ? { infrastructureError } : {}) };
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const closed = once(server, "close");
  server.close();
  await closed;
  if (!address || typeof address === "string") throw new Error("No loopback test port available");
  return address.port;
}

/** Each grade gets pristine tests/configuration and only candidate src files. */
export async function gradeWebBench(suite: WebBench, stageID: string, directory: string, candidate?: string): Promise<WebBenchGrade> {
  const through = stageNumber(stageID);
  try {
    await freshDirectory(directory);
    for (const [path, expected] of Object.entries(suite.runtimeHashes)) {
      if (digest(await readFile(path)) !== expected) throw new Error(`Installed grading runtime changed: ${basename(path)}`);
    }
    for (const [name, expected] of Object.entries(suite.hashes)) {
      const bytes = await readFile(join(suite.fixture, name));
      if (digest(bytes) !== expected) throw new Error(`Pristine grading fixture changed: ${name}`);
      if (name.startsWith("src-init/")) continue;
      const target = join(directory, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
    const source = candidate ? join(candidate, "src") : suite.reference;
    if (!source) throw new Error("Reference source is unavailable");
    if (!candidate) for (const [name, hash] of Object.entries(suite.sourceHashes)) {
      if (name.startsWith("projects/react/src/") && digest(await readFile(join(source, name.slice("projects/react/src/".length)))) !== hash) {
        throw new Error(`Pinned reference source changed: ${name}`);
      }
    }
    const index = await readFile(join(source, "index.html"));
    if (digest(index) !== suite.hashes["src-init/index.html"]) throw new Error("Candidate changed protected src/index.html");
    await copySource(source, join(directory, "src"));
    await symlink(suite.nodeModules, join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const reportFile = join(directory, "playwright-results.json");
    const port = suite.port || await availablePort();
    const env = { ...commandEnvironment(), PATH: [join(suite.nodeModules, ".bin"), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
      CI: "1", EVAL_PROJECT_ROOT: join(await realpath(directory), "src"), EVAL_PROJECT_PORT: String(port),
      MAX_TEST_WORKERS: "1", IS_EVAL_PRODUCTION: "1", PLAYWRIGHT_BROWSERS_PATH: suite.browsersPath,
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, npm_config_offline: "true", npm_config_update_notifier: "false" };
    const args = [suite.playwrightCLI, "test", ...Array.from({ length: through }, (_, index) => `task-${index + 1}\\.spec\\.js$`),
      "--config", join(directory, "playwright.config.js"), "--project=chromium", "--workers=1", "--retries=0", "--reporter=json", `--global-timeout=${Math.floor(suite.timeoutMs)}`];
    let exitCode = 0, stdout = "", stderr = "";
    try {
      const result = await run(process.execPath, args, { cwd: directory, env, windowsHide: true, timeout: suite.timeoutMs + 15_000, maxBuffer: 8 * 1024 * 1024 });
      stdout = result.stdout; stderr = result.stderr;
    } catch (cause) {
      const error = cause as Error & { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
      stdout = error.stdout ?? ""; stderr = error.stderr ?? "";
      if (typeof error.code !== "number" || error.killed || error.signal) throw new Error(`Playwright could not complete: ${error.message}`);
      exitCode = error.code;
    }
    await writeFile(join(directory, "process.log"), stdout + stderr);
    const report = JSON.parse(await readFile(reportFile, "utf8")) as PlaywrightReport;
    const result = parseWebBenchReport(report, stageID, exitCode);
    await writeFile(join(directory, "grade.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { total: 0, passed: 0, failed: 0, skipped: 0, success: false, assertionFailures: 0, outcomes: [],
      infrastructureError: message, log: `Web-Bench grading did not complete: ${message}` };
  }
}

export async function preflightWebBench(suite: WebBench, directory: string) {
  await freshDirectory(directory);
  const baselineSource = join(directory, "initial");
  await copySource(suite.initial, join(baselineSource, "src"));
  const baseline = await gradeWebBench(suite, "task-1", join(directory, "baseline"), baselineSource);
  const first = await gradeWebBench(suite, "task-20", join(directory, "reference-1"));
  const second = await gradeWebBench(suite, "task-20", join(directory, "reference-2"));
  if (!suite.reference) throw new Error("Reference source is unavailable for preflight");
  const mutationSource = join(directory, "mutation-source");
  await copySource(suite.reference, join(mutationSource, "src"));
  await writeFile(join(mutationSource, "src", "App.tsx"), 'import React from "react";\nexport default function App() { return <div>Missing blog behavior</div>; }\n');
  const mutation = await gradeWebBench(suite, "task-1", join(directory, "mutation"), mutationSource);
  const referenceConsistent = first.total === second.total && JSON.stringify(first.outcomes) === JSON.stringify(second.outcomes);
  const assertionFailure = (result: WebBenchGrade) => !result.infrastructureError && result.failed > 0 && result.assertionFailures > 0;
  return { success: assertionFailure(baseline) && first.success && second.success && referenceConsistent && assertionFailure(mutation),
    baseline, reference: [first, second] as const, mutation, referenceConsistent };
}
