import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gradeWebBench, parseWebBenchReport, webBenchStageTestCases } from "../benchmarks/suites/webbench.ts";
import type { WebBench } from "../benchmarks/suites/webbench.ts";

function report(counts: readonly number[] = [4], fail = false) {
  const suites = counts.map((count, stage) => ({ file: `task-${stage + 1}.spec.js`, specs: Array.from({ length: count }, (_, index) => ({
    file: `task-${stage + 1}.spec.js`, title: `case ${index + 1}`,
    tests: [{ projectName: "chromium", expectedStatus: "passed", status: fail ? "unexpected" : "expected",
      results: [{ status: fail ? "failed" : "passed", errors: fail ? [{ message: "Error: \u001b[2mexpect\u001b[22m(locator).toBeVisible() failed" }] : [] }] }],
  })) }));
  const total = counts.reduce((sum, count) => sum + count, 0);
  return { suites, errors: [], stats: { expected: fail ? 0 : total, unexpected: fail ? total : 0, skipped: 0, flaky: 0 } };
}

test("Web-Bench grading requires actual cumulative cases, matching totals, and no retries or skips", () => {
  const full = report(webBenchStageTestCases);
  const result = parseWebBenchReport(full, "task-20", 0);
  assert.equal(result.total, 59);
  assert.equal(result.passed, 59);
  assert.equal(result.outcomes.length, 20);
  assert.equal(result.success, true);
  assert.equal(parseWebBenchReport(report([4]), "task-2", 0).success, false);
  assert.match(parseWebBenchReport(report([4]), "task-2", 0).infrastructureError!, /Expected 3 task-2 test cases, received 0/);
  assert.match(parseWebBenchReport(report([1]), "task-1", 0).infrastructureError!, /Expected 4 task-1 test cases, received 1/);
  assert.match(parseWebBenchReport(report([]), "task-1", 0).infrastructureError!, /No test cases ran/);
  const incomplete = report([...Array.from({ length: 19 }, () => 3), 1]);
  assert.match(parseWebBenchReport(incomplete, "task-20", 0).infrastructureError!, /Expected 59/);
  const retries = report([1]);
  retries.suites[0]!.specs[0]!.tests[0]!.results.push({ status: "passed", errors: [] });
  assert.match(parseWebBenchReport(retries, "task-1", 0).infrastructureError!, /Unexpected retries/);
  const skipped = report([1]);
  skipped.suites[0]!.specs[0]!.tests[0]!.status = "skipped";
  skipped.suites[0]!.specs[0]!.tests[0]!.results[0]!.status = "skipped";
  skipped.stats = { expected: 0, unexpected: 0, skipped: 1, flaky: 0 };
  assert.equal(parseWebBenchReport(skipped, "task-1", 0).skipped, 1);
  assert.equal(parseWebBenchReport(skipped, "task-1", 0).success, false);
  const mismatched = report([1]);
  mismatched.stats.expected = 0;
  assert.match(parseWebBenchReport(mismatched, "task-1", 0).infrastructureError!, /summary does not match/);
  const duplicates = report([4]);
  duplicates.suites[0]!.specs[1]!.title = duplicates.suites[0]!.specs[0]!.title;
  assert.match(parseWebBenchReport(duplicates, "task-1", 0).infrastructureError!, /duplicate test identity/);
});

test("assertion failures are distinguished from missing browser infrastructure", () => {
  const assertion = parseWebBenchReport(report([4], true), "task-1", 1);
  assert.equal(assertion.failed, 4);
  assert.equal(assertion.assertionFailures, 4);
  assert.equal(assertion.infrastructureError, undefined);
  const runtime = report([1], true);
  runtime.suites[0]!.specs[0]!.tests[0]!.results[0]!.errors = [{ message: "browserType.launch: Executable doesn't exist" }];
  const result = parseWebBenchReport(runtime, "task-1", 1);
  assert.match(result.infrastructureError!, /Browser\/runtime failure/);
  assert.equal(result.assertionFailures, 0);
});

test("fresh grading ignores candidate tests and configuration and checks fixture integrity", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "webbench-grading-"));
  try {
    const fixture = join(root, "fixture");
    const candidate = join(root, "candidate");
    const nodeModules = join(root, "runtime", "node_modules");
    await Promise.all([mkdir(fixture), mkdir(join(candidate, "src"), { recursive: true }), mkdir(nodeModules, { recursive: true })]);
    const contents: Record<string, string> = {
      "playwright.config.js": "// pristine configuration\n",
      "test/task-1.spec.js": "// pristine assertions\n",
      "src-init/index.html": "<div id='root'></div>\n",
    };
    for (const [name, content] of Object.entries(contents)) {
      const path = join(fixture, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content);
    }
    const hashes = Object.fromEntries(Object.entries(contents).map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")]));
    const cli = join(root, "runtime", "cli.cjs");
    // A local test-process probe checks the adapter contract without downloading a browser.
    await writeFile(cli, [
      'const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");',
      'assert.equal(fs.readFileSync("playwright.config.js", "utf8"), "// pristine configuration\\n");',
      'assert.equal(fs.readFileSync("test/task-1.spec.js", "utf8"), "// pristine assertions\\n");',
      'assert(process.argv.includes("--retries=0")); assert(process.argv.includes("--workers=1"));',
      'assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(process.env.DAYTONA_API_KEY, undefined);',
      'assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, "explicit-browser-cache");',
      'assert(Number(process.env.EVAL_PROJECT_PORT) > 0);',
      'const passed = fs.readFileSync(path.join(process.env.EVAL_PROJECT_ROOT, "App.tsx"), "utf8") === "working feature";',
      `const result = ${JSON.stringify(report([4]))};`,
      'if (!passed) { result.stats = { expected: 0, unexpected: 4, skipped: 0, flaky: 0 };',
      '  for (const spec of result.suites[0].specs) { const test = spec.tests[0]; test.status = "unexpected";',
      '    test.results = [{ status: "failed", errors: [{ message: "Error: expect(feature).toBeCorrect()" }] }]; } }',
      'fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(result));',
      'process.exitCode = passed ? 0 : 1;',
    ].join("\n"));
    const suite: WebBench = { stages: [], fixture, initial: join(fixture, "src-init"), nodeModules, playwrightCLI: cli,
      browsersPath: "explicit-browser-cache", port: 0, timeoutMs: 5_000, hashes, sourceHashes: {}, runtimeHashes: {} };
    await writeFile(join(candidate, "src", "index.html"), contents["src-init/index.html"]!);
    await writeFile(join(candidate, "src", "App.tsx"), "broken feature");
    await writeFile(join(candidate, "playwright.config.js"), "// disable tests");
    await mkdir(join(candidate, "test"));
    await writeFile(join(candidate, "test", "task-1.spec.js"), "// skip all assertions");
    const broken = await gradeWebBench(suite, "task-1", join(root, "graded-broken"), candidate);
    assert.equal(broken.failed, 4, broken.log);
    assert.equal(broken.infrastructureError, undefined, broken.log);
    assert.equal(await readFile(join(root, "graded-broken", "test", "task-1.spec.js"), "utf8"), "// pristine assertions\n");
    await writeFile(join(candidate, "src", "App.tsx"), "working feature");
    const fixed = await gradeWebBench(suite, "task-1", join(root, "graded-fixed"), candidate);
    assert.equal(fixed.success, true, fixed.log);
    const repeated = await gradeWebBench(suite, "task-1", join(root, "graded-fixed"), candidate);
    assert.match(repeated.infrastructureError!, /EEXIST/);
    await writeFile(join(fixture, "test", "task-1.spec.js"), "// compromised fixture");
    const corrupted = await gradeWebBench(suite, "task-1", join(root, "graded-corrupt"), candidate);
    assert.match(corrupted.infrastructureError!, /Pristine grading fixture changed/);
    await writeFile(join(fixture, "test", "task-1.spec.js"), contents["test/task-1.spec.js"]!);
    await symlink(fixture, join(candidate, "src", "escape"), process.platform === "win32" ? "junction" : "dir");
    const escaped = await gradeWebBench(suite, "task-1", join(root, "graded-escape"), candidate);
    assert.match(escaped.infrastructureError!, /Source link is not allowed/);
  } finally {
    if (await realpath(root) === root && root.startsWith(join(await realpath(tmpdir()), "webbench-grading-"))) await rm(root, { recursive: true, force: true });
  }
});
