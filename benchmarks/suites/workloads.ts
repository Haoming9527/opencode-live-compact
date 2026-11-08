import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandEnvironment } from "../runner/opencode.ts";

const registry = "https://registry.npmjs.org/semver/-/semver-7.7.2.tgz";
const integrity = "RF0Fw+rO5AMf9MAyaRXI4AV0Ulj5lMHqVxxdSgiVbixSCXoEmmX/jk0CuJw4+3SqroYO9VoUh+HcuJivvtJemA==";

export type Suite = "short" | "semver";
export interface Stage { id: string; prompt: string }

const tasks = [
  {
    id: "group-by", signature: "groupBy(values, keyOf)",
    spec: "Return a Map from keys to arrays of values, preserving insertion order and key identity. Call keyOf once per value with the value and its zero-based index. Accept any iterable, including a generator.",
    reference: `const result = new Map(); let index = 0;
  for (const value of values) {
    const key = keyOf(value, index++);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;`,
  },
  {
    id: "dedent", signature: "dedent(text)",
    spec: "Remove one leading and one trailing blank line if present. Then remove the longest identical leading prefix made of spaces or tabs common to every nonblank line. Normalize LF and CRLF to LF. Render any remaining blank lines as empty strings. Preserve nonblank lines' trailing whitespace.",
    reference: `const lines = text.split(/\\r?\\n/);
  const blank = line => /^[\\t ]*$/.test(line);
  if (blank(lines[0])) lines.shift();
  if (lines.length && blank(lines.at(-1))) lines.pop();
  let prefix;
  for (const line of lines.filter(line => !blank(line))) {
    const indentation = line.match(/^[ \\t]*/)[0];
    if (prefix === undefined) prefix = indentation;
    else while (!indentation.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return lines.map(line => blank(line) ? '' : line.slice(prefix.length)).join('\\n');`,
  },
  {
    id: "merge-intervals", signature: "mergeIntervals(intervals)",
    spec: "Return a new sorted list of merged inclusive [start, end] finite-number intervals. Merge overlapping intervals and intervals whose endpoints touch. Leave the array and all pairs untouched. Throw RangeError if an interval has nonfinite endpoints or start exceeds end.",
    reference: `const ordered = intervals.map(([start, end]) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new RangeError('Invalid interval');
    return [start, end];
  }).sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval);
  }
  return merged;`,
  },
  {
    id: "parse-fields", signature: "parseFields(line)",
    spec: "Split a line into comma-delimited fields. A backslash escapes the following character, including comma and backslash. Keep empty fields and whitespace. Throw SyntaxError for a trailing backslash.",
    reference: `const fields = [''];
  let escaped = false;
  for (const char of line) {
    if (!escaped && char === ',') fields.push('');
    else if (!escaped && char === '\\\\') { escaped = true; continue; }
    else fields[fields.length - 1] += char;
    escaped = false;
  }
  if (escaped) throw new SyntaxError('Dangling escape');
  return fields;`,
  },
  {
    id: "topological-order", signature: "topologicalOrder(dependencies)",
    spec: "Accept a Map of task strings to iterable prerequisites. Return task strings in dependency order. Visit root tasks in Map order and prerequisites in iterable order, emitting a task when its dependencies have been visited. Include named prerequisites absent from the Map. Throw RangeError for a cycle.",
    reference: `const active = new Set(); const visited = new Set(); const order = [];
  function visit(task) {
    if (active.has(task)) throw new RangeError('Dependency cycle');
    if (visited.has(task)) return;
    active.add(task);
    for (const prerequisite of dependencies.get(task) ?? []) visit(prerequisite);
    active.delete(task);
    visited.add(task);
    order.push(task);
  }
  for (const task of dependencies.keys()) visit(task);
  return order;`,
  },
  {
    id: "count-words", signature: "countWords(text)",
    spec: "Return a Map from lowercase NFC-normalized words to occurrence counts. A word consists of a maximal run of Unicode letters and combining marks, and must contain a letter. Lowercase with JavaScript's locale-independent default and normalize the result to NFC. Preserve order of first occurrence.",
    reference: `const counts = new Map();
  for (const run of text.match(/[\\p{L}\\p{M}]+/gu) ?? []) {
    if (!/\\p{L}/u.test(run)) continue;
    const word = run.toLowerCase().normalize('NFC');
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;`,
  },
] as const;

const semverStages = [
  ["map-public-api", "Inspect the existing semver package entrypoint, package manifest, documentation and range implementation. Plan the addition of explainSatisfaction(version, range, options) as a root export and a direct CommonJS module at ranges/explain-satisfaction.js. Leave existing APIs and dependency lists unchanged. Do not edit this stage."],
  ["validate-input", "Create the new function module. Parse version and range using SemVer, Range and existing option conventions. Invalid versions return { satisfies: false, reason: 'invalid-version', alternatives: [] }. Invalid ranges return the same shape with reason 'invalid-range'. If both are invalid, classify version first. When using a blank range, preserve existing wildcard behavior. Apply loose and includePrerelease like satisfies."],
  ["describe-alternatives", "Inspect Range and Comparator to represent each OR alternative in the existing parsed Range order. Return one entry per parsed alternative with a comparators array of { value, passes }, keeping comparator order. value is the Comparator.value (including empty string for ANY), and passes is the result of testing that comparator against the parsed version. Do not reparse a printed range."],
  ["prerelease-rules", "Inspect the existing prerelease rules and mirror their semantics. Each alternative needs prereleaseAllowed and passes booleans. For a stable version, prereleaseAllowed is true. For prereleases it is true when includePrerelease is enabled, or when that alternative includes a non-ANY comparator with the same major, minor and patch whose own version is a prerelease. An alternative passes only when all its comparators pass and prereleaseAllowed is true."],
  ["compose-result", "Complete the aggregate result as { satisfies, reason, alternatives }. Any passing alternative means reason 'match'. Otherwise use 'prerelease-excluded' when any alternative has all comparators pass but excludes the prerelease. Use 'comparators-mismatch' otherwise. Keep results for all alternatives, even after a match. Verify representative output with node."],
  ["public-exports", "Wire up the public root export while keeping the direct require('semver/ranges/explain-satisfaction') module usable. The existing CLI, parser behavior and exports must remain compatible. Review the repository's range helpers for naming and require patterns."],
  ["document", "Add an explainSatisfaction README section that includes the function signature, the possible reasons and their priority, an OR-range example and a prerelease example. Explain how to read per-alternative prereleaseAllowed, passes and comparator values. Keep existing documentation."],
  ["regression-check", "Audit the implementation for parity with satisfies on valid inputs, including loose versions/ranges, blank ranges, OR clauses, numeric and named prereleases, ranges with different prerelease tuples, and includePrerelease. Run meaningful local checks with Node, fix any differences and keep changes scoped to this feature."],
  ["compatibility-review", "Review malformed and non-string inputs, wildcard and any-comparator handling, malformed alternatives in loose mode, huge numeric components, and build metadata. Run regressions against the existing satisfies, validRange and compare APIs. Do not modify existing behavior."],
  ["delivery", "Review the final diff, run targeted checks, and report completed changes and actual checks. Also report the two invalid-input reason strings in precedence order, comma-separated on a line beginning with RETENTION: ."],
] as const;

const common = "Stay in this project. Use local project files and ordinary tools. Do not access the network, spawn subagents, or inspect the benchmark harness. Stop when this stage is complete.";

export function stages(suite: Suite): Stage[] {
  const steps = suite === "short"
    ? tasks.map(task => [task.id, `Implement ${task.signature} in ${task.id}.cjs. ${task.spec} Keep the CommonJS export and do not modify the other exercise files. Check your implementation locally.`] as const)
    : semverStages;
  return steps.map(([id, prompt]) => ({ id, prompt: `Stage ${id}. ${common}\n\n${prompt}` }));
}

const semverReference = `const SemVer = require('../classes/semver')
const Range = require('../classes/range')
const Comparator = require('../classes/comparator')
const parseOptions = require('../internal/parse-options')
module.exports = (version, range, options) => {
  const invalid = reason => ({ satisfies: false, reason, alternatives: [] })
  options = parseOptions(options)
  try { version = new SemVer(version, options) } catch { return invalid('invalid-version') }
  try { range = new Range(range, options) } catch { return invalid('invalid-range') }
  const alternatives = range.set.map(set => {
    const comparators = set.map(comparator => ({ value: comparator.value, passes: comparator.test(version) }))
    const prereleaseAllowed = !version.prerelease.length || !!options.includePrerelease || set.some(({ semver }) =>
      semver !== Comparator.ANY && !!semver.prerelease.length &&
      semver.major === version.major && semver.minor === version.minor && semver.patch === version.patch)
    return { comparators, prereleaseAllowed, passes: prereleaseAllowed && comparators.every(item => item.passes) }
  })
  const satisfies = alternatives.some(alternative => alternative.passes)
  const excluded = alternatives.some(alternative => !alternative.prereleaseAllowed && alternative.comparators.every(item => item.passes))
  return { satisfies, reason: satisfies ? 'match' : excluded ? 'prerelease-excluded' : 'comparators-mismatch', alternatives }
}
`;

export async function prepareBaseline(suite: Suite, directory: string, semverTarball?: string) {
  await mkdir(directory, { recursive: true });
  if (suite === "short") {
    await Promise.all(tasks.map(({ id, signature }) => writeFile(join(directory, `${id}.cjs`),
      `module.exports = function ${signature} {\n  throw new Error('Not implemented');\n};\n`)));
    return;
  }

  let bytes: Buffer;
  if (semverTarball) bytes = await readFile(semverTarball);
  else {
    const response = await fetch(registry, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Semver fixture download returned HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) {
    throw new Error("The semver 7.7.2 tarball failed the pinned integrity check");
  }
  const archive = join(directory, "..", "semver-7.7.2.tgz");
  await writeFile(archive, bytes, { mode: 0o600 });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory], { windowsHide: true });
}

export async function prepareReference(suite: Suite, baseline: string, directory: string) {
  await cp(baseline, directory, { recursive: true });
  if (suite === "short") {
    await Promise.all(tasks.map(({ id, signature, reference }) => writeFile(join(directory, `${id}.cjs`),
      `module.exports = function ${signature} {\n  ${reference}\n};\n`)));
    return;
  }
  const index = join(directory, "index.js");
  const readme = join(directory, "README.md");
  await writeFile(join(directory, "ranges", "explain-satisfaction.js"), semverReference);
  await writeFile(index, `${await readFile(index, "utf8")}\nmodule.exports.explainSatisfaction = require('./ranges/explain-satisfaction')\n`);
  await writeFile(readme, `${await readFile(readme, "utf8")}\n## explainSatisfaction\n\n\`explainSatisfaction(version, range, options)\` explains a match. Reasons in order: invalid-version, invalid-range, match, prerelease-excluded, comparators-mismatch.\n\n\`explainSatisfaction('2.0.0', '^1 || ^2')\` reports match. A prerelease such as \`2.0.0-beta.1\` can be excluded even when its comparators pass. Each alternative has comparators, prereleaseAllowed and passes.\n`);
}

export function grade(suite: Suite, candidate: string, baseline: string) {
  const grading = fileURLToPath(new URL("./grading/", import.meta.url));
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(grading, `${suite}.cjs`)], {
    cwd: candidate,
    env: {
      ...commandEnvironment(),
      LIVE_COMPACT_GRADE_ROOT: candidate,
      LIVE_COMPACT_GRADE_BASELINE: baseline,
    },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const output = result.stdout ?? "";
  const total = Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0);
  const passed = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);
  const failed = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? 0);
  return {
    total, passed, failed,
    success: result.status === 0 && total === (suite === "short" ? 6 : 8) && passed === total,
    log: output + (result.stderr ?? "") + (result.error?.message ?? ""),
  };
}
