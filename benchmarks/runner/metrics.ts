import type { OpenCodeEvent, SessionInfo, TokenUsageInfo } from "@opencode/client";

export interface StageReceipt { id: string; before: number; after: number }
export interface PluginMetric {
  time?: string;
  sessionID: string;
  event: string;
  count?: number;
  durationMs?: number;
  planningMs?: number;
  applicationMs?: number;
  reason?: string;
  estimatedSavedTokens?: number;
  estimatedCacheSuffixTokens?: number;
  dryRun?: boolean;
  success?: boolean;
}

export function observeStage(events: readonly OpenCodeEvent[], inboxID: string, id: string) {
  const delivered = events.find(event => event.type === "session.inbox.delivered" && event.data.inboxID === inboxID);
  if (delivered?.type !== "session.inbox.delivered") return;
  const before = delivered.durable.seq;
  const terminal = events.find(event => (
    event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted"
  ) && event.durable.seq > before);
  if (terminal?.type !== "session.execution.succeeded" && terminal?.type !== "session.execution.failed" &&
      terminal?.type !== "session.execution.interrupted") return;
  const after = terminal.durable.seq;
  return {
    receipt: { id, before, after },
    success: terminal.type === "session.execution.succeeded",
    outcome: terminal.type,
    endedAt: terminal.created,
    meteredPrimary: events.some(event => event.type === "session.step.ended" &&
      event.durable.seq > before && event.durable.seq < after && event.data.cost > 0),
  };
}

function inputTokens(tokens: TokenUsageInfo) {
  return tokens.input + tokens.cache.read + tokens.cache.write;
}

/** Elapsed host lifecycle interval; this does not measure user-blocked time. */
type CompactionEvent = {
  stage: string | null;
  reason: "auto" | "manual";
  durationMs: number | null;
  endTime: number;
  outcome: "ended" | "failed";
};

export function summarize(info: SessionInfo, log: readonly OpenCodeEvent[], stages: readonly StageReceipt[], plugin: readonly PluginMetric[], streamComplete: boolean) {
  const requests: number[] = [];
  const nativePauses: CompactionEvent[] = [];
  const replacementWindows: CompactionEvent[] = [];
  const replacementNoopWindows: CompactionEvent[] = [];
  let started: { stage: string | null; created: number; reason: "auto" | "manual" } | undefined;
  let complete = streamComplete;
  let primaryRequests = 0;
  let retrySchedules = 0;
  let auxiliaryUsageRecords = 0;
  let failedStepsWithoutUsage = 0;
  let replacementWindowsWithUsage = 0;
  for (const event of log) {
    switch (event.type) {
      case "session.step.started":
        primaryRequests++;
        break;
      case "session.step.ended":
        if (inputTokens(event.data.tokens) > 0) requests.push(inputTokens(event.data.tokens));
        break;
      case "session.step.failed":
        if (event.data.tokens && inputTokens(event.data.tokens) > 0) requests.push(inputTokens(event.data.tokens));
        else failedStepsWithoutUsage++;
        break;
      case "session.retry.scheduled":
        retrySchedules++;
        break;
      case "session.compaction.started": {
        if (started) complete = false;
        const stage = stages.find(entry => entry.before <= event.durable.seq && event.durable.seq <= entry.after);
        started = { stage: stage?.id ?? null, created: event.created, reason: event.data.reason };
        break;
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const hasUsage = event.data.tokens && inputTokens(event.data.tokens) > 0;
        if (hasUsage) auxiliaryUsageRecords++;
        const replacement = event.type === "session.compaction.ended" && event.metadata?.liveCompact === "replacement-v1";
        const replacementNoop = event.type === "session.compaction.ended" && event.metadata?.liveCompact === "replacement-noop";
        if (replacement && hasUsage) replacementWindowsWithUsage++;
        const matchingStart = started?.reason === event.data.reason && started.created <= event.created ? started : undefined;
        if (!matchingStart) complete = false;
        // A verified full-context replay is still local maintenance. It neither
        // shortens the window nor establishes a native/model-summary compaction.
        const pauses = replacement ? replacementWindows : replacementNoop ? replacementNoopWindows : nativePauses;
        pauses.push({
          stage: matchingStart?.stage ?? null,
          reason: event.data.reason,
          durationMs: matchingStart ? event.created - matchingStart.created : null,
          endTime: event.created,
          outcome: event.type === "session.compaction.ended" ? "ended" : "failed",
        });
        started = undefined;
        break;
      }
    }
  }

  const cuts = plugin.filter(record => record.sessionID === info.id && record.event === "cut" && !record.dryRun);
  const replacements = plugin.filter(record => record.sessionID === info.id && record.event === "replacement" && !record.dryRun);
  const contextCalls = plugin.filter(record => record.sessionID === info.id && record.event === "context");
  const planning = plugin.filter(record => record.sessionID === info.id && record.event === "planning");
  const planningReasons: Record<string, number> = {};
  for (const record of planning) if (record.reason) planningReasons[record.reason] = (planningReasons[record.reason] ?? 0) + 1;
  const recalls = plugin.filter(record => record.sessionID === info.id && record.event === "recall");
  const firstSuccessfulCompaction = nativePauses.find(pause => pause.outcome === "ended");
  const replacementHostWaitMs = replacementWindows.reduce((sum, window) => sum + (window.durationMs ?? 0), 0);
  const nativeCompactionWaitMs = nativePauses.reduce((sum, pause) => sum + (pause.durationMs ?? 0), 0);
  const replacementNoopEventDurationMs = replacementNoopWindows.reduce((sum, window) => sum + (window.durationMs ?? 0), 0);
  const localMaintenanceEventDurationMs = replacementHostWaitMs + replacementNoopEventDurationMs;
  const hostCompactionEventDurationMs = nativeCompactionWaitMs + localMaintenanceEventDurationMs;
  return {
    costEstimateUsd: info.cost,
    uncachedInputTokens: info.tokens.input,
    cachedReadTokens: info.tokens.cache.read,
    cacheWriteTokens: info.tokens.cache.write,
    totalInputTokens: inputTokens(info.tokens),
    outputTokens: info.tokens.output,
    reasoningTokens: info.tokens.reasoning,
    primaryRequests,
    retrySchedules,
    auxiliaryUsageRecords,
    knownModelRequests: primaryRequests + auxiliaryUsageRecords,
    failedStepsWithoutUsage,
    primaryInputSamples: requests.length,
    peakActiveContextTokens: requests.length ? requests.reduce((peak, tokens) => Math.max(peak, tokens), 0) : null,
    meanActiveContextTokens: requests.length ? requests.reduce((sum, tokens) => sum + tokens, 0) / requests.length : null,
    nativeCompactionPauses: nativePauses.length,
    automaticNativeCompactionPauses: nativePauses.filter(pause => pause.reason === "auto").length,
    // Legacy *WaitMs fields are event-duration values, not measured user wait.
    nativeCompactionWaitMs,
    nativeCompactionEventDurationMs: nativeCompactionWaitMs,
    nativeCompactionTimingComplete: complete && started === undefined,
    firstNativeCompactionStage: nativePauses[0]?.stage ?? null,
    nativeCompactionEvents: nativePauses,
    replacementWindows: replacementWindows.length,
    replacementHostWaitMs,
    replacementWindowEvents: replacementWindows,
    replacementNoopWindows: replacementNoopWindows.length,
    replacementNoopWindowEvents: replacementNoopWindows,
    replacementNoopEventDurationMs,
    localMaintenanceEventDurationMs,
    replacementWindowsWithUsage,
    replacementWindowsAfterNativeCompaction: firstSuccessfulCompaction
      ? replacementWindows.filter(window => window.endTime > firstSuccessfulCompaction.endTime).length : null,
    replacementCuts: replacements.reduce((sum, replacement) => sum + (replacement.count ?? 0), 0),
    replacementOverheadMs: replacementWindows.length > 0 && replacements.length === 0 ? null
      : replacements.reduce((sum, replacement) => sum + (replacement.durationMs ?? 0), 0),
    replacementPlanningMs: replacements.every(record => record.planningMs !== undefined)
      ? replacements.reduce((sum, record) => sum + record.planningMs!, 0) : null,
    replacementApplicationMs: replacements.every(record => record.applicationMs !== undefined)
      ? replacements.reduce((sum, record) => sum + record.applicationMs!, 0) : null,
    planningReasons,
    hostCompactionWaitMs: hostCompactionEventDurationMs,
    hostCompactionEventDurationMs,
    cuts: cuts.reduce((sum, cut) => sum + (cut.count ?? 0), 0),
    cutsAfterNativeCompaction: firstSuccessfulCompaction
      ? cuts.filter(cut => cut.time && Date.parse(cut.time) > firstSuccessfulCompaction.endTime)
        .reduce((sum, cut) => sum + (cut.count ?? 0), 0)
      : null,
    cutOverheadMs: cuts.reduce((sum, cut) => sum + (cut.durationMs ?? 0), 0),
    contextHookOverheadMs: contextCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0),
    estimatedSavedTokens: [...cuts, ...replacements].reduce((sum, cut) => sum + (cut.estimatedSavedTokens ?? 0), 0),
    estimatedCacheSuffixTokens: [...cuts, ...replacements].reduce((sum, cut) => sum + (cut.estimatedCacheSuffixTokens ?? 0), 0),
    recalls: recalls.length,
    successfulRecalls: recalls.filter(recall => recall.success).length,
  };
}
