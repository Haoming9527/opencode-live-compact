import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenCodeEvent, SessionInfo } from "@opencode/client";
import { observeStage, summarize } from "../benchmarks/runner/metrics.ts";

const info: SessionInfo = {
  id: "ses_benchmark", projectID: "project_benchmark", cost: 1.25,
  tokens: { input: 100, output: 10, reasoning: 3, cache: { read: 40, write: 20 } },
  location: { directory: "/benchmark" }, time: { created: 0, updated: 75 },
};
const stages = [{ id: "first", before: 1, after: 5 }, { id: "second", before: 8, after: 20 }];
const entry = (seq: number, created: number) => ({
  id: `evt_${seq}`, created, durable: { aggregateID: info.id, seq, version: 1 as const },
});
const started: OpenCodeEvent = { ...entry(8, 50), type: "session.compaction.started", data: { sessionID: info.id, reason: "auto" } };
const ended: OpenCodeEvent = {
  ...entry(13, 75), type: "session.compaction.ended", data: { sessionID: info.id, reason: "auto", text: "summary", tokens: info.tokens },
};

test("attributes native event duration to the completed stage and reports observed cache categories", () => {
  const usage = summarize(info, [started, ended], stages, [
    { event: "cut", count: 1, durationMs: 2, time: new Date(70).toISOString(), sessionID: info.id },
    { event: "cut", count: 2, durationMs: 3, time: new Date(90).toISOString(), sessionID: info.id },
    { event: "cut", count: 9, dryRun: true, sessionID: info.id },
    { event: "context", durationMs: 7, sessionID: info.id },
    { event: "recall", success: true, sessionID: info.id },
    { event: "cut", count: 11, sessionID: "other" },
  ], true);
  assert.equal(usage.costEstimateUsd, 1.25);
  assert.equal(usage.totalInputTokens, 160);
  assert.equal(usage.cachedReadTokens, 40);
  assert.equal(usage.cacheWriteTokens, 20);
  assert.equal(usage.nativeCompactionTimingComplete, true);
  assert.equal(usage.nativeCompactionWaitMs, 25);
  assert.equal(usage.nativeCompactionEventDurationMs, 25);
  assert.equal(usage.hostCompactionEventDurationMs, 25);
  assert.equal(usage.firstNativeCompactionStage, "second");
  assert.equal(usage.cuts, 3);
  assert.equal(usage.cutsAfterNativeCompaction, 2);
  assert.equal(usage.cutOverheadMs, 5);
  assert.equal(usage.contextHookOverheadMs, 7);
  assert.equal(usage.successfulRecalls, 1);
});

test("requires paired host events and a complete live stream for timing", () => {
  for (const [events, complete] of [[[started], true], [[ended], true], [[started, ended], false]] as const) {
    assert.equal(summarize(info, events, stages, [], complete).nativeCompactionTimingComplete, false);
  }
});

test("separates deterministic replacements from host model work and preserves inter-stage timing", () => {
  const manualStart: OpenCodeEvent = {
    ...entry(6, 20), type: "session.compaction.started", data: { sessionID: info.id, reason: "manual", inputID: "msg_replacement" },
  };
  const replacement: OpenCodeEvent = {
    ...entry(7, 26), type: "session.compaction.ended", metadata: { liveCompact: "replacement-v1" },
    data: { sessionID: info.id, reason: "manual", text: "", native: { messages: [] } },
  };
  const fallback: OpenCodeEvent[] = [
    { ...manualStart, ...entry(15, 76) },
    { ...ended, ...entry(16, 79), data: { ...ended.data, reason: "manual", native: { messages: [] } } },
  ];
  const automaticReplacement: OpenCodeEvent[] = [
    { ...started, ...entry(17, 80) },
    { ...replacement, ...entry(18, 85), data: { ...replacement.data, reason: "auto" } },
  ];
  const usage = summarize(info, [manualStart, replacement, started, ended, ...fallback, ...automaticReplacement], stages, [
    { event: "replacement", sessionID: info.id, count: 2, durationMs: 3, planningMs: 1, applicationMs: 2, estimatedSavedTokens: 1200, estimatedCacheSuffixTokens: 500 },
    { event: "replacement", sessionID: info.id, count: 1, durationMs: 4, planningMs: 1, applicationMs: 3, estimatedSavedTokens: 1000, estimatedCacheSuffixTokens: 200 },
    { event: "planning", sessionID: info.id, reason: "size-or-cache-budget" },
    { event: "replacement", sessionID: info.id, count: 4, durationMs: 50, dryRun: true },
    { event: "replacement", sessionID: "other", count: 9, durationMs: 90 },
  ], true);

  assert.equal(usage.automaticNativeCompactionPauses, 1);
  assert.equal(usage.nativeCompactionPauses, 2);
  assert.equal(usage.nativeCompactionWaitMs, 28);
  assert.equal(usage.replacementWindows, 2);
  assert.equal(usage.replacementWindowsAfterNativeCompaction, 1);
  assert.equal(usage.replacementHostWaitMs, 11);
  assert.equal(usage.hostCompactionWaitMs, 39);
  assert.equal(usage.hostCompactionEventDurationMs, 39);
  assert.equal(usage.localMaintenanceEventDurationMs, 11);
  assert.equal(usage.replacementNoopWindows, 0);
  assert.equal(usage.replacementCuts, 3);
  assert.equal(usage.replacementOverheadMs, 7);
  assert.equal(usage.replacementPlanningMs, 2);
  assert.equal(usage.replacementApplicationMs, 5);
  assert.equal(usage.estimatedSavedTokens, 2200);
  assert.equal(usage.estimatedCacheSuffixTokens, 700);
  assert.deepEqual(usage.planningReasons, { "size-or-cache-budget": 1 });
  assert.equal(usage.replacementWindowsWithUsage, 0);
  assert.equal(usage.nativeCompactionTimingComplete, true);
  assert.equal(usage.replacementWindowEvents[0]?.stage, null);
  assert.equal(usage.replacementWindowEvents[1]?.stage, "second");
});

test("counts full-context replays as local maintenance without inventing cuts or native compactions", () => {
  const localStart = (seq: number, created: number): OpenCodeEvent => ({
    ...entry(seq, created), type: "session.compaction.started", data: { sessionID: info.id, reason: "manual" },
  });
  const localEnd = (seq: number, created: number, marker: string): OpenCodeEvent => ({
    ...entry(seq, created), type: "session.compaction.ended", metadata: { liveCompact: marker },
    data: { sessionID: info.id, reason: "manual", text: "", native: { messages: [] } },
  });
  const usage = summarize(info, [
    localStart(2, 10), localEnd(3, 18, "replacement-noop"),
    localStart(4, 20), localEnd(5, 30, "replacement-v1"),
    started, ended,
    localStart(14, 80), localEnd(15, 85, "replacement-noop"),
  ], stages, [{ event: "replacement", sessionID: info.id, count: 2, durationMs: 3 }], true);

  assert.equal(usage.nativeCompactionPauses, 1);
  assert.equal(usage.automaticNativeCompactionPauses, 1);
  assert.equal(usage.firstNativeCompactionStage, "second");
  assert.equal(usage.nativeCompactionEventDurationMs, 25);
  assert.equal(usage.nativeCompactionWaitMs, 25);
  assert.equal(usage.replacementWindows, 1);
  assert.equal(usage.replacementCuts, 2);
  assert.equal(usage.replacementHostWaitMs, 10);
  assert.equal(usage.replacementNoopWindows, 2);
  assert.deepEqual(usage.replacementNoopWindowEvents.map(event => event.durationMs), [8, 5]);
  assert.equal(usage.replacementNoopEventDurationMs, 13);
  assert.equal(usage.localMaintenanceEventDurationMs, 23);
  assert.equal(usage.hostCompactionEventDurationMs, 48);
  assert.equal(usage.hostCompactionWaitMs, 48);
  assert.equal(usage.replacementWindowsAfterNativeCompaction, 0);
  assert.equal(usage.auxiliaryUsageRecords, 1);
  assert.equal(usage.nativeCompactionTimingComplete, true);

  const onlyReplay = summarize(info, [localStart(2, 10), localEnd(3, 18, "replacement-noop")], stages, [], true);
  assert.equal(onlyReplay.nativeCompactionPauses, 0);
  assert.equal(onlyReplay.firstNativeCompactionStage, null);
  assert.equal(onlyReplay.replacementWindowsAfterNativeCompaction, null);
  assert.equal(onlyReplay.replacementWindows, 0);
  assert.equal(onlyReplay.replacementCuts, 0);
  assert.equal(onlyReplay.localMaintenanceEventDurationMs, 8);
  assert.equal(onlyReplay.knownModelRequests, 0);
});

test("a maintenance drain cannot complete a stage before that prompt is delivered", () => {
  const terminal = (seq: number): OpenCodeEvent => ({
    ...entry(seq, seq), type: "session.execution.succeeded", data: { sessionID: info.id },
  });
  const delivered: OpenCodeEvent = {
    ...entry(8, 8), type: "session.inbox.delivered", data: { sessionID: info.id, inboxID: "msg_prompt" },
  };
  const billed = (seq: number): OpenCodeEvent => ({
    ...entry(seq, seq), type: "session.step.ended",
    data: { sessionID: info.id, assistantMessageID: "msg_answer", finish: "stop", cost: 0.03, tokens: info.tokens },
  });
  assert.equal(observeStage([terminal(6), delivered], "msg_prompt", "stage"), undefined);
  assert.equal(observeStage([billed(5), terminal(6), delivered, terminal(10)], "msg_prompt", "stage")?.meteredPrimary, false);
  const observed = observeStage([terminal(6), delivered, billed(9), terminal(10)], "msg_prompt", "stage");
  assert.deepEqual(observed?.receipt, { id: "stage", before: 8, after: 10 });
  assert.equal(observed?.meteredPrimary, true);
});
