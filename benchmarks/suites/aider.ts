import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { commandEnvironment } from "../runner/opencode.ts";

const run = promisify(execFile);
const languages = ["python", "go", "javascript", "rust", "java"] as const;
type Language = typeof languages[number];
export const aiderCommit = "7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f";
export interface AiderTools { python: string; go: string; js: string; jars: string; cache: string }
export type Aider = { exercises: Exercise[]; tools: AiderTools };

interface Exercise {
  id: string;
  language: Language;
  source: string;
  solutions: string[];
  examples: string[];
  tests: string[];
  prompt: string;
}

/** The working copy and the independent grader must execute the same assertions. */
async function enableExerciseTests(exercise: Pick<Exercise, "language" | "tests">, directory: string) {
  for (const name of exercise.tests) {
    const file = join(directory, name);
    const original = await readFile(file, "utf8");
    const enabled = exercise.language === "javascript"
      ? original.replace(/^(\s*)xtest(?=\s*\()/gm, "$1test")
      : exercise.language === "java"
        ? original.replace(/^[\t ]*@Disabled(?:\s*\(\s*"(?:\\.|[^"\\])*"\s*\))?[\t ]*\r?\n/gm, "")
        : exercise.language === "rust"
          ? original.replace(/^[\t ]*#\[ignore(?:\s*=\s*"(?:\\.|[^"\\])*")?\][\t ]*\r?\n/gm, "")
          : original;
    if (enabled !== original) await writeFile(file, enabled);
  }
}

export async function prepareAider(source: string, baseline?: string, tools?: AiderTools): Promise<Exercise[]> {
  const byLanguage = await Promise.all(languages.map(async language => {
    const practice = join(source, language, "exercises", "practice");
    const names = (await readdir(practice, { withFileTypes: true })).filter(item => item.isDirectory())
      .map(item => item.name).sort().slice(0, 30);
    if (names.length !== 30 || names.some(name => !/^[a-z0-9-]+$/.test(name))) throw new Error(`Invalid ${language} exercise list`);
    return Promise.all(names.map(async name => {
      const source = join(practice, name);
      const id = `${language}-${name}`;
      const { files } = JSON.parse(await readFile(join(source, ".meta", "config.json"), "utf8"));
      const { solution: solutions, test: tests, example: examples } = files;
      for (const paths of [solutions, tests, examples]) {
        if (!Array.isArray(paths) || !paths.length || paths.some(path =>
          typeof path !== "string" || !/^[.\w/-]+$/.test(path) || path.split("/").some(part => !part || part === ".."))) {
          throw new Error(`Invalid fixture paths for ${id}`);
        }
      }
      if (baseline) {
        const directory = join(baseline, id);
        await cp(source, directory, { recursive: true, filter: path => basename(path) !== ".meta" });
        await enableExerciseTests({ language, tests }, directory);
      }
      const prompt = [
        `Solve the ${id} exercise in ${id}/.`,
        `Read ${id}/.docs/instructions.md and instructions.append.md if present.`,
        `Only edit these solution files inside that directory: ${solutions.join(", ")}.`,
        ...(baseline && tools ? [`All supplied tests are enabled. From the project root, run node .benchmark-test.mjs ${id} before finishing and address any failing tests.`] : []),
        "Use ordinary local tools. Keep the tests, previous exercises, and other files intact. Do not access the network or spawn subagents. Stop after this exercise.",
      ].join(" ");
      return { id, language, source, solutions, examples, tests, prompt };
    }));
  }));
  const exercises = Array.from({ length: 30 }, (_, index) => byLanguage.map(items => items[index]!)).flat();
  if (baseline && tools) {
    const manifest = Object.fromEntries(exercises.map(({ id, language, tests }) => [id, { language, tests }]));
    await writeFile(join(baseline, ".benchmark-test.mjs"), [
      `import { runAiderTests } from ${JSON.stringify(import.meta.url)};`,
      'import { fileURLToPath } from "node:url";',
      'import { join } from "node:path";',
      `const exercises = ${JSON.stringify(manifest)};`,
      `const tools = ${JSON.stringify(tools)};`,
      'const id = process.argv[2];',
      'if (process.argv.length !== 3 || !Object.hasOwn(exercises, id)) throw new Error("Supply one benchmark exercise ID");',
      'try {',
      '  const result = await runAiderTests(exercises[id], join(fileURLToPath(new URL(".", import.meta.url)), id), tools);',
      '  process.stdout.write(result.stdout); process.stderr.write(result.stderr);',
      '} catch (error) {',
      '  process.stdout.write(error.stdout ?? ""); process.stderr.write(error.stderr ?? "");',
      '  console.error(error.message); process.exitCode = 1;',
      '}',
      "",
    ].join("\n"), { mode: 0o600 });
  }
  return exercises;
}

async function checkedFile(root: string, name: string) {
  const path = join(root, name);
  const expected = join(await realpath(root), name);
  if (!(await lstat(path)).isFile() || await realpath(path) !== expected) throw new Error(`Invalid solution file ${name}`);
  return path;
}

/** The model's test command and independent grading share runtime and command options. */
export async function runAiderTests(exercise: Pick<Exercise, "language" | "tests">, target: string, tools: AiderTools) {
  const rustBuild = join(target, ".cargo-target");
  let classes: string | undefined;
  await mkdir(tools.cache, { recursive: true });
  const env = { ...commandEnvironment(), GOCACHE: join(tools.cache, "go"), GOTOOLCHAIN: "local", GOPROXY: "off",
    CARGO_TARGET_DIR: rustBuild, NODE_PATH: tools.js, PYTHONDONTWRITEBYTECODE: "1" };
  const exec = async (binary: string, args: string[]) => run(binary, args, { cwd: target, env,
    windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
  try {
    switch (exercise.language) {
      case "python": return await exec(tools.python, ["-m", "pytest", "-q", ...exercise.tests]);
      case "go": return await exec(tools.go, ["test", "./..."]);
      case "rust": return await exec("cargo", ["test", "--offline", "--", "--include-ignored"]);
      case "javascript": return await exec(process.execPath, [join(tools.js, "jest", "bin", "jest.js"), "--runInBand", "--runTestsByPath", ...exercise.tests]);
      case "java": {
        classes = await mkdtemp(join(await realpath(target), ".classes-"));
        const jars = (await readdir(tools.jars)).filter(name => name.endsWith(".jar")).map(name => join(tools.jars, name));
        const consoleJar = jars.find(path => basename(path).startsWith("junit-platform-console-standalone-"));
        if (!consoleJar) throw new Error("JUnit console jar is missing");
        const files = (await readdir(join(target, "src"), { recursive: true })).filter(name => name.endsWith(".java"));
        await exec("javac", ["-encoding", "UTF-8", "-cp", jars.join(delimiter), "-d", classes, ...files.map(name => join("src", name))]);
        return await exec("java", ["-jar", consoleJar, "execute", "--class-path",
          [classes, ...jars.filter(path => path !== consoleJar)].join(delimiter), "--scan-classpath", "--fail-if-no-tests"]);
      }
    }
  } finally {
    if (classes && dirname(classes) === await realpath(target) && await realpath(classes).catch(() => undefined) === classes) {
      await rm(classes, { recursive: true, force: true });
    }
    if (exercise.language === "rust" && await realpath(rustBuild).catch(() => undefined) === join(await realpath(target), ".cargo-target")) {
      await rm(rustBuild, { recursive: true, force: true });
    }
  }
}

async function gradeExercise(exercise: Exercise, target: string, candidate: string | undefined, tools: AiderTools) {
  await cp(exercise.source, target, { recursive: true, filter: path => basename(path) !== ".meta" });
  try {
    await enableExerciseTests(exercise, target);
    if (!candidate && exercise.language === "java") {
      for (const example of exercise.examples) {
        if (exercise.solutions.some(name => basename(name) === basename(example))) continue;
        await cp(join(exercise.source, example), join(target, "src", "main", "java", basename(example)));
      }
    }
    for (const name of exercise.solutions) {
      let from: string | undefined;
      if (candidate) from = await checkedFile(join(candidate, exercise.id), name);
      else {
        const example = exercise.examples.find(path => basename(path) === basename(name)) ??
          (exercise.solutions.filter(path => extname(path) === extname(name)).length === 1
            ? exercise.examples.find(path => extname(path) === extname(name)) : undefined);
        if (example) from = join(exercise.source, example);
        else if (exercise.language === "rust" && name === "Cargo.toml") {
          from = await checkedFile(exercise.source, ".meta/Cargo-example.toml").catch(() => undefined);
        }
      }
      if (from) {
        await mkdir(dirname(join(target, name)), { recursive: true });
        await cp(from, join(target, name));
      }
    }
    const result = await runAiderTests(exercise, target, tools);
    return { id: exercise.id, passed: true, log: result.stdout + result.stderr };
  } catch (cause) {
    const error = cause as Error & { stdout?: string; stderr?: string };
    return { id: exercise.id, passed: false, log: [error.message, error.stdout, error.stderr].filter(Boolean).join("\n") };
  }
}

export async function gradeAider(exercises: readonly Exercise[], directory: string, candidate: string | undefined, tools: AiderTools,
    previous?: string) {
  await mkdir(tools.cache, { recursive: true });
  const entries: Awaited<ReturnType<typeof gradeExercise>>[] = [];
  const statuses = previous ? [...previous.matchAll(/^(ok|not ok) ([a-z][a-z0-9-]+)\r?$/gm)] : [];
  if (previous && (candidate || statuses.length !== exercises.length ||
      !statuses.every((status, index) => status[2] === exercises[index]?.id))) throw new Error("Retry reference order does not match Aider fixtures");
  for (let start = 0; start < exercises.length; start += 10) {
    entries.push(...await Promise.all(exercises.slice(start, start + 10).map((exercise, offset) =>
      statuses[start + offset]?.[1] === "ok" ? { id: exercise.id, passed: true, log: "Verified in the previous reference preflight." }
        : gradeExercise(exercise, join(directory, exercise.id), candidate, tools))));
  }
  const passed = entries.filter(entry => entry.passed).length;
  return { total: entries.length, passed, failed: entries.length - passed,
    success: entries.length === 150 && passed === 150,
    outcomes: entries.map(({ id, passed }) => ({ id, passed })),
    log: entries.map(entry => `${entry.passed ? "ok" : "not ok"} ${entry.id}\n${entry.log}`).join("\n") };
}
