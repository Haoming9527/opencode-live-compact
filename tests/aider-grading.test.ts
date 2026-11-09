import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gradeAider, prepareAider } from "../benchmarks/suites/aider.ts";

const exec = promisify(execFile);
const sources = {
  javascript: [
    'const assert = require("node:assert/strict");',
    'const answer = require("./solution.cjs");',
    'test("ordinary", () => assert.equal(answer(1), 1));',
    'xtest("previously skipped", () => assert.equal(answer(2), 2));',
    '// xtest("example only", () => {});',
    '',
  ].join("\n"),
  java: [
    '@Disabled', '@Test', 'void bare() {}',
    '@Disabled("reason with (parentheses)")', '@Test', 'void reason() {}',
    '@Disabled("reason with \\"quotes\\"")', '@Test', 'void quoted() {}',
    '// @Disabled("comment only")', '',
  ].join("\n"),
  rust: [
    '#[test]', '#[ignore]', 'fn bare() {}',
    '#[test]', '#[ignore = "reason with ] bracket"]', 'fn reason() {}',
    '// #[ignore]', '',
  ].join("\n"),
  python: 'def test_example():\n    assert True\n',
  go: 'func TestExample(t *testing.T) {}\n',
};

test("working tests and independent grading share enabled assertions and the same test command", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "live-compact-grading-"));
  try {
    const fixture = join(root, "fixture");
    const baseline = join(root, "baseline");
    await Promise.all(Object.entries(sources).flatMap(([language, source]) => Array.from({ length: 30 }, async (_, index) => {
      const directory = join(fixture, language, "exercises", "practice", `exercise-${String(index).padStart(2, "0")}`);
      await mkdir(join(directory, ".meta"), { recursive: true });
      await writeFile(join(directory, ".meta", "config.json"), JSON.stringify({ files: {
        solution: ["solution.cjs"], test: ["tests.cjs"], example: [".meta/example.cjs"],
      } }));
      await writeFile(join(directory, "solution.cjs"), "module.exports = () => 1;\n");
      await writeFile(join(directory, ".meta", "example.cjs"), "module.exports = value => value;\n");
      await writeFile(join(directory, "tests.cjs"), source);
    })));
    const tools = { python: process.execPath, go: process.execPath, js: join(root, "node_modules"),
      jars: join(root, "jars"), cache: join(root, "cache") };
    // This local runtime adapter executes registered assertions without a package download.
    const jest = join(tools.js, "jest", "bin");
    await mkdir(jest, { recursive: true });
    await writeFile(join(jest, "jest.js"), [
      'const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");',
      'const file = path.resolve(process.argv.at(-1));',
      'const local = require("node:module").createRequire(file);',
      'let executed = 0;',
      'vm.runInNewContext(fs.readFileSync(file, "utf8"), { require: local,',
      '  test: (_, assertion) => { executed++; assertion(); }, xtest: () => {} });',
      'if (!executed) throw new Error("No tests executed");',
      'console.log(executed + " assertions passed");',
      '',
    ].join("\n"));
    const exercises = await prepareAider(fixture, baseline, tools);
    assert.equal(exercises.length, 150);
    for (const [language, original] of Object.entries(sources)) {
      const id = `${language}-exercise-00`;
      const prepared = await readFile(join(baseline, id, "tests.cjs"), "utf8");
      assert.equal(await readFile(join(fixture, language, "exercises", "practice", "exercise-00", "tests.cjs"), "utf8"), original);
      if (language === "java") {
        assert.doesNotMatch(prepared, /^\s*@Disabled/m);
        assert.match(prepared, /\/\/ @Disabled/);
        assert.equal((prepared.match(/@Test/g) ?? []).length, 3);
      } else if (language === "rust") {
        assert.doesNotMatch(prepared, /^\s*#\[ignore/m);
        assert.match(prepared, /\/\/ #\[ignore\]/);
        assert.equal((prepared.match(/#\[test\]/g) ?? []).length, 2);
      } else if (language === "javascript") {
        assert.doesNotMatch(prepared, /^\s*xtest\(/m);
        assert.match(prepared, /\/\/ xtest/);
      } else assert.equal(prepared, original);
    }
    const exercise = exercises.find(entry => entry.id === "javascript-exercise-00")!;
    assert.match(exercise.prompt, /node \.benchmark-test\.mjs javascript-exercise-00/);
    const runner = join(baseline, ".benchmark-test.mjs");
    const manifest = await readFile(runner, "utf8");
    assert.doesNotMatch(manifest, /example\.cjs|\.meta[\\/]/);
    await assert.rejects(exec(process.execPath, [runner, "../reference"], { cwd: baseline }), /Supply one benchmark exercise ID/);
    await assert.rejects(exec(process.execPath, [runner, exercise.id], { cwd: baseline }), /1 !== 2/);
    const first = await gradeAider([exercise], join(root, "graded-failure"), baseline, tools);
    assert.equal(first.failed, 1);
    assert.equal(await readFile(join(root, "graded-failure", exercise.id, "tests.cjs"), "utf8"),
      await readFile(join(baseline, exercise.id, "tests.cjs"), "utf8"));

    // Disabling a candidate test cannot affect the independently restored assertion.
    await writeFile(join(baseline, exercise.id, "tests.cjs"), sources.javascript);
    assert.equal((await gradeAider([exercise], join(root, "graded-tampered"), baseline, tools)).failed, 1);
    const reference = await gradeAider([exercise], join(root, "reference"), undefined, tools);
    assert.equal(reference.passed, 1);
    assert.match(reference.log, /2 assertions passed/);
  } finally {
    if (await realpath(root) === root && root.startsWith(join(await realpath(tmpdir()), "live-compact-grading-"))) {
      await rm(root, { recursive: true, force: true });
    }
  }
});
