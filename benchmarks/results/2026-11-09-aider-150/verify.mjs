import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL(name, import.meta.url));
const json = name => JSON.parse(read(name).toString("utf8"));
const lines = name => read(name).toString("utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
const manifest = json("manifest.json");
for (const file of manifest.files) {
  assert.match(file.path, /^(?!.*(?:^|\/)\.\.\/)[a-z0-9/_.-]+$/i);
  const bytes = read(file.path);
  assert.equal(bytes.length, file.bytes, `${file.path}: byte count`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `${file.path}: SHA-256`);
}

const report = json("comparison.json");
const prompts = json("prompts.json");
assert.equal(prompts.prompts.length, 150);
assert.equal(createHash("sha256").update(JSON.stringify(prompts.prompts)).digest("hex"), prompts.promptsSha256);
assert.equal(report.completePairs, 1);
const { control: original, plugin: compact, comparison } = report.results[0];
assert.deepEqual(original, json("original-opencode/result.json"));
assert.deepEqual(compact, json("live-compact/result.json"));
assert.equal(comparison.comparable, true);
assert.equal(comparison.bothPassed, true);
assert.equal(json("plugin-build.json").buildSha256, manifest.testedBuildSha256);
assert.equal(report.model.id, "gpt-6-luna");
const progress = lines("progress.jsonl");
for (const [arm, result] of [["control", original], ["plugin", compact]]) {
  assert.equal(result.stagesCompleted, 150);
  assert.equal(result.grade.passed, 150);
  assert.equal(result.grade.failed, 0);
  assert.equal(result.attempts.length, 150);
  assert.ok(result.attempts.every(attempt => attempt.firstAttemptPassed && attempt.startedAttempts === 1));
  const graded = progress.filter(row => row.event === "exercise-graded" && row.arm === arm);
  assert.equal(graded.length, 150);
  assert.deepEqual(graded.map(row => row.stage), result.grade.outcomes.map(row => row.id));
  assert.equal(graded.at(-1).estimatedUsd, result.usage.costEstimateUsd);
  assert.equal(graded.at(-1).passed, 150);
  assert.equal(graded.at(-1).failed, 0);
  assert.equal(result.usage.totalInputTokens,
    result.usage.cachedReadTokens + result.usage.cacheWriteTokens + result.usage.uncachedInputTokens);
  assert.equal(result.usage.nativeCompactionTimingComplete, true);
}
assert.deepEqual(original.grade.outcomes, compact.grade.outcomes);
const replacements = lines("live-compact/plugin.jsonl").filter(row => row.event === "replacement" && !row.dryRun);
assert.equal(replacements.length, compact.usage.replacementWindows);
assert.equal(replacements.reduce((sum, row) => sum + row.count, 0), compact.usage.replacementCuts);
assert.equal(replacements.filter(row => row.strategy === "spans").reduce((sum, row) => sum + row.count, 0), 21);
assert.equal(replacements.filter(row => row.strategy === "individual").reduce((sum, row) => sum + row.count, 0), 72);

const savings = (100 * (1 - compact.usage.costEstimateUsd / original.usage.costEstimateUsd)).toFixed(1);
const values = result => {
  const u = result.usage;
  return [
    `**${result.grade.passed}/${result.stagesExpected}**`,
    `${(100 * u.cachedReadTokens / u.totalInputTokens).toFixed(2)}%`,
    `${(u.cachedReadTokens / 1e6).toFixed(2)}M`,
    `${((u.uncachedInputTokens + u.cacheWriteTokens) / 1e6).toFixed(3)}M`,
    `$${u.costEstimateUsd.toFixed(3)}`,
    `${Math.round(u.peakActiveContextTokens / 1e3)}K`,
    `${u.replacementCuts ? `${u.replacementCuts} cuts` : `${u.nativeCompactionPauses} pause`} · ${(u.hostCompactionWaitMs / 1000).toFixed(2)} s`,
    `${Math.round(result.wallSeconds).toLocaleString("en-US")} s`,
  ];
};
const a = values(original), b = values(compact);
b[4] += ` · ${savings}% lower`;
for (const index of [2, 4, 5, 6, 7]) b[index] = `**${b[index]}**`;
const labels = ["Passed", "Overall cache hit rate", "Cached input tokens", "Non-cached input tokens",
  "Estimated API cost", "Peak context", "Compaction", "Wall-clock time"];
const table = ["| Metric | Original OpenCode | Live Compact |", "| --- | ---: | ---: |",
  ...labels.map((label, index) => `| ${label} | ${a[index]} | ${b[index]} |`)].join("\n");
for (const document of ["README.md", "../../../README.md"]) {
  assert.ok(read(document).toString("utf8").replaceAll("\r\n", "\n").includes(table), `${document}: table agrees with source data`);
}
console.log(`Verified ${manifest.files.length} source files, both 150/150 results, 93 cuts, and both README tables.\n\n${table}`);
