import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL(name, import.meta.url));
const json = name => JSON.parse(read(name).toString("utf8"));
const lines = name => read(name).toString("utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const manifest = json("manifest.json");
for (const file of manifest.files) {
  assert.match(file.path, /^(?!.*(?:^|\/)\.\.\/)[a-z0-9/_.-]+$/i);
  const bytes = read(file.path);
  assert.equal(bytes.length, file.bytes, `${file.path}: byte count`);
  assert.equal(hash(bytes), file.sha256, `${file.path}: SHA-256`);
}

const report = json("comparison.json");
const prompts = json("prompts.json");
const ids = Array.from({ length: 20 }, (_, i) => `task-${i + 1}`);
const stageCounts = [4, 3, 1, 2, 2, 3, 2, 4, 4, 4, 3, 4, 5, 2, 4, 3, 2, 3, 3, 1];
const cumulativeCounts = stageCounts.map((_, i) => stageCounts.slice(0, i + 1).reduce((a, b) => a + b, 0));
assert.deepEqual(prompts.prompts.map(prompt => prompt.id), ids);
assert.equal(hash(JSON.stringify(prompts.prompts)), prompts.promptsSha256);
assert.equal(manifest.opencodeVersion, "2.2.6");
assert.equal(manifest.fixtureCommit, "7b31ca2b786eef120dd49ce63dd03d0c0006046d");
assert.deepEqual(report.model, { providerID: "openai", id: "gpt-6-luna" });
assert.equal(report.completePairs, 1);
assert.equal(report.expectedPairs, 1);
assert.equal(report.results.length, 1);
const { control: original, plugin: compact, comparison } = report.results[0];
assert.deepEqual(original, json("original-opencode/result.json"));
assert.deepEqual(compact, json("live-compact/result.json"));
assert.deepEqual(original.modelConfiguration, compact.modelConfiguration);
assert.equal(comparison.comparable, true);
assert.equal(comparison.bothPassed, true);
assert.equal(json("plugin-build.json").buildSha256, manifest.testedBuildSha256);
assert.ok(Math.abs(report.spent - original.usage.costEstimateUsd - compact.usage.costEstimateUsd) < 1e-12);

const preflight = json("preflight.json");
assert.equal(preflight.success, true);
for (const rejected of [preflight.baseline, preflight.mutation]) {
  assert.equal(rejected.success, false);
  assert.equal(rejected.total, 4);
  assert.equal(rejected.passed, 0);
  assert.equal(rejected.failed, 4);
}
assert.equal(preflight.reference.length, 2);
for (const reference of preflight.reference) {
  assert.equal(reference.success, true);
  assert.equal(reference.total, 59);
  assert.equal(reference.passed, 59);
  assert.equal(reference.failed, 0);
  assert.equal(reference.skipped, 0);
}

const progress = lines("progress.jsonl");
for (const [arm, folder, result] of [
  ["control", "original-opencode", original], ["plugin", "live-compact", compact],
]) {
  assert.equal(result.stagesCompleted, 20);
  assert.equal(result.stagesExpected, 20);
  assert.equal(result.grade.passed, 20);
  assert.equal(result.grade.failed, 0);
  assert.equal(result.grade.success, true);
  assert.equal(result.attemptPolicy.maxAttempts, 3);
  assert.deepEqual(result.attempts.map(attempt => attempt.id), ids);
  assert.deepEqual(result.testCases, {
    total: 59, passed: 59, failed: 0, skipped: 0, success: true, throughStage: "task-20",
  });
  result.attempts.forEach((stage, i) => {
    assert.equal(stage.attempts, stage.outcomes.length);
    assert.equal(stage.startedAttempts, stage.outcomes.length);
    assert.equal(stage.firstAttemptPassed, stage.outcomes[0].passed);
    assert.equal(stage.outcomes.at(-1).passed, true);
    stage.outcomes.forEach((outcome, index) => {
      assert.equal(outcome.attempt, index + 1);
      assert.equal(outcome.testCases.total, cumulativeCounts[i]);
      assert.equal(outcome.testCases.passed + outcome.testCases.failed + outcome.testCases.skipped, outcome.testCases.total);
      assert.equal(outcome.passed, outcome.testCases.success);
    });
  });
  const graded = progress.filter(row => row.event === "exercise-graded" && row.arm === arm);
  assert.deepEqual(graded.map(row => row.stage), ids);
  assert.deepEqual(graded.map(row => row.stage), result.grade.outcomes.map(row => row.id));
  graded.forEach((row, i) => {
    assert.equal(row.outcome, "pass");
    assert.equal(row.passed, i + 1);
    assert.equal(row.failed, 0);
    assert.equal(row.estimatedUsd, result.attempts[i].outcomes.at(-1).estimatedUsd);
  });
  assert.equal(graded.at(-1).estimatedUsd, result.usage.costEstimateUsd);
  const repairs = progress.filter(row => row.event === "exercise-repair" && row.arm === arm);
  assert.equal(repairs.length, sum(result.attempts, "startedAttempts") - 20);
  assert.equal(result.usage.totalInputTokens,
    result.usage.cachedReadTokens + result.usage.cacheWriteTokens + result.usage.uncachedInputTokens);
  assert.equal(result.usage.nativeCompactionTimingComplete, true);
  assert.equal(result.usage.nativeCompactionPauses, 0);
  assert.equal(result.usage.nativeCompactionWaitMs, 0);
  assert.equal(result.usage.firstNativeCompactionStage, null);
  const summaries = [...read(`${folder}/grade.tap`).toString("utf8")
    .matchAll(/^(\d+) passed, (\d+) failed, (\d+) skipped \((\d+) test cases\)$/gm)];
  assert.deepEqual(summaries.map(match => Number(match[1])), cumulativeCounts);
  assert.ok(summaries.every(match => match[2] === "0" && match[3] === "0" && match[1] === match[4]));
}
assert.equal(original.attempts.filter(stage => stage.firstAttemptPassed).length, 19);
assert.equal(compact.attempts.filter(stage => stage.firstAttemptPassed).length, 20);
assert.equal(sum(original.attempts, "startedAttempts"), 21);
assert.equal(sum(compact.attempts, "startedAttempts"), 20);
assert.equal(original.attempts.find(stage => !stage.firstAttemptPassed).id, "task-16");
for (const key of ["nativePausesDelta", "nativeWaitDeltaMs", "hostCompactionWaitDeltaMs"]) {
  assert.equal(comparison[key], null, "No native compaction: pause comparison must remain inconclusive");
}

const replacements = lines("live-compact/plugin.jsonl").filter(row => row.event === "replacement" && !row.dryRun);
assert.equal(replacements.length, 12);
assert.equal(replacements.length, compact.usage.replacementWindows);
assert.ok(replacements.every(row => row.strategy === "spans" && row.sessionID === compact.sessionID));
assert.equal(sum(replacements, "count"), 14);
assert.equal(sum(replacements, "count"), compact.usage.replacementCuts);
assert.equal(sum(replacements, "estimatedSavedTokens"), compact.usage.estimatedSavedTokens);
assert.equal(sum(compact.usage.replacementWindowEvents, "durationMs"), compact.usage.hostCompactionWaitMs);
assert.equal(compact.usage.hostCompactionWaitMs, 435);

const originalUsage = original.usage, compactUsage = compact.usage;
const hit = usage => `${(100 * usage.cachedReadTokens / usage.totalInputTokens).toFixed(2)}%`;
const cached = usage => `${(usage.cachedReadTokens / 1e6).toFixed(3)}M`;
const nonCached = usage => `${((usage.uncachedInputTokens + usage.cacheWriteTokens) / 1e3).toFixed(3)}K`;
const cost = usage => `$${usage.costEstimateUsd.toFixed(4)}`;
const savings = ((1 - compactUsage.costEstimateUsd / originalUsage.costEstimateUsd) * 100).toFixed(1);
const peak = usage => `${Math.round(usage.peakActiveContextTokens / 1e3)}K`;
const seconds = value => Math.round(value).toLocaleString("en-US");
const table = [
  "| Metric | Original OpenCode | Live Compact |",
  "| --- | ---: | ---: |",
  "| Stages passed | **20/20** | **20/20** |",
  `| Overall cache hit rate | ${hit(originalUsage)} | ${hit(compactUsage)} |`,
  `| Cached input tokens | ${cached(originalUsage)} | **${cached(compactUsage)}** |`,
  `| Non-cached input tokens | ${nonCached(originalUsage)} | ${nonCached(compactUsage)} |`,
  `| Estimated API cost | ${cost(originalUsage)} | **${cost(compactUsage)} · ${savings}% lower** |`,
  `| Peak context | ${peak(originalUsage)} | **${peak(compactUsage)}** |`,
  `| Compaction | 0 pauses · 0 s | **${compactUsage.replacementCuts} cuts · ${(Math.round(compactUsage.hostCompactionWaitMs / 10) / 100).toFixed(2)} s** |`,
  `| Wall-clock time | ${seconds(original.wallSeconds)} s | **${seconds(compact.wallSeconds)} s** |`,
].join("\n");
assert.ok(read("README.md").toString("utf8").replaceAll("\r\n", "\n").includes(table), "Evidence table must match recorded results");
console.log(`Verified ${manifest.files.length} raw files, preflight, 40 graded stages, one repair, 59/59 final tests per version, and 14 cuts. Native pause comparison is inconclusive.\n\n${table}`);
