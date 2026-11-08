import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

export async function prepareAider(source: string, baseline?: string): Promise<Exercise[]> {
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
      if (baseline) await cp(source, join(baseline, id), { recursive: true, filter: path => basename(path) !== ".meta" });
      const prompt = [
        `Solve the ${id} exercise in ${id}/.`,
        `Read ${id}/.docs/instructions.md and instructions.append.md if present.`,
        `Only edit these solution files inside that directory: ${solutions.join(", ")}.`,
        "Use ordinary local tools. Keep the tests, previous exercises, and other files intact. Do not access the network or spawn subagents. Stop after this exercise.",
      ].join(" ");
      return { id, language, source, solutions, examples, tests, prompt };
    }));
  }));
  return Array.from({ length: 30 }, (_, index) => byLanguage.map(items => items[index]!)).flat();
}

async function checkedFile(root: string, name: string) {
  const path = join(root, name);
  const expected = join(await realpath(root), name);
  if (!(await lstat(path)).isFile() || await realpath(path) !== expected) throw new Error(`Invalid solution file ${name}`);
  return path;
}

async function gradeExercise(exercise: Exercise, target: string, candidate: string | undefined, tools: AiderTools) {
  const rustBuild = join(target, ".cargo-target");
  await cp(exercise.source, target, { recursive: true, filter: path => basename(path) !== ".meta" });
  try {
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
    const env = { ...commandEnvironment(), GOCACHE: join(tools.cache, "go"), GOTOOLCHAIN: "local", GOPROXY: "off",
      CARGO_TARGET_DIR: rustBuild, NODE_PATH: tools.js, PYTHONDONTWRITEBYTECODE: "1" };
    const exec = async (binary: string, args: string[]) => run(binary, args, { cwd: target, env,
      windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
    let result;
    switch (exercise.language) {
      case "python": result = await exec(tools.python, ["-m", "pytest", "-q", ...exercise.tests]); break;
      case "go": result = await exec(tools.go, ["test", "./..."]); break;
      case "rust": result = await exec("cargo", ["test", "--offline", "--", "--include-ignored"]); break;
      case "javascript": {
        for (const name of exercise.tests) {
          const file = join(target, name);
          await writeFile(file, (await readFile(file, "utf8")).replace(/\bxtest\(/g, "test("));
        }
        result = await exec(process.execPath, [join(tools.js, "jest", "bin", "jest.js"), "--runInBand", "--runTestsByPath", ...exercise.tests]);
        break;
      }
      case "java": {
        const classes = join(target, ".classes");
        const jars = (await readdir(tools.jars)).filter(name => name.endsWith(".jar")).map(name => join(tools.jars, name));
        const consoleJar = jars.find(path => basename(path).startsWith("junit-platform-console-standalone-"));
        if (!consoleJar) throw new Error("JUnit console jar is missing");
        for (const name of exercise.tests) {
          const file = join(target, name);
          await writeFile(file, (await readFile(file, "utf8")).replace(/@Disabled\([^)]*\)\s*\r?\n/g, ""));
        }
        const files = (await readdir(join(target, "src"), { recursive: true })).filter(name => name.endsWith(".java"));
        await mkdir(classes);
        await exec("javac", ["-encoding", "UTF-8", "-cp", jars.join(delimiter), "-d", classes, ...files.map(name => join("src", name))]);
        result = await exec("java", ["-jar", consoleJar, "execute", "--class-path",
          [classes, ...jars.filter(path => path !== consoleJar)].join(delimiter), "--scan-classpath", "--fail-if-no-tests"]);
        break;
      }
    }
    return { id: exercise.id, passed: true, log: result.stdout + result.stderr };
  } catch (cause) {
    const error = cause as Error & { stdout?: string; stderr?: string };
    return { id: exercise.id, passed: false, log: [error.message, error.stdout, error.stderr].filter(Boolean).join("\n") };
  } finally {
    if (exercise.language === "rust" && await realpath(rustBuild).catch(() => undefined) === join(await realpath(target), ".cargo-target")) {
      await rm(rustBuild, { recursive: true, force: true });
    }
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
