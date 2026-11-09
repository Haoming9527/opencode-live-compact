import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenCodeClient } from "@opencode/client";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { startOpenCode, waitForTurn } from "../benchmarks/runner/opencode.ts";
import { test } from "node:test";
import { RecoveryStore } from "../src/recovery/store.ts";
import { estimateTokens } from "../src/hooks/context.ts";

interface ChatMessage {
  role: string;
  content?: string | readonly { type: string; text?: string }[];
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: readonly { id: string; function: { name: string } }[];
}

interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: { function: { name: string } }[];
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function contentText(message: ChatMessage | undefined): string | undefined {
  if (!message?.content) return;
  return typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("");
}

function result(request: ChatRequest, id: string) {
  return request.messages.find((message) => message.role === "tool" && message.tool_call_id === id);
}

function stageNumber(request: ChatRequest): number | undefined {
  const user = request.messages.findLast((message) => message.role === "user");
  const match = contentText(user)?.match(/^lc-integration-stage-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function writeCompletion(response: ServerResponse, request: ChatRequest, sequence: number, toolCall?: ToolCall, text = "Verified offline fixture checkpoint.", reasoning?: string) {
  const info = { id: `chatcmpl-fixture-${sequence}`, created: 1, model: request.model };
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(request.messages).length / 4), completion_tokens: 12, total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const message = toolCall ? {
    role: "assistant",
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }],
  } : { role: "assistant", content: text };
  const finishReason = toolCall ? "tool_calls" : "stop";
  if (!request.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ...info, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finishReason }], usage }));
    return;
  }
  const chunk = (choices: unknown[], metrics?: typeof usage) => `data: ${JSON.stringify({ ...info, object: "chat.completion.chunk", choices, usage: metrics })}\n\n`;
  const delta = "tool_calls" in message ? { ...message, tool_calls: message.tool_calls?.map((call) => ({ index: 0, ...call })) } : message;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.write(chunk([{ index: 0, delta, finish_reason: null }]));
  response.write(chunk([{ index: 0, delta: {}, finish_reason: finishReason }]));
  response.end(chunk([], usage) + "data: [DONE]\n\n");
}

const readID = (stage: number, index: number) => `call_lc_read_${stage}_${index}`;
const recallID = (stage: number) => `call_lc_recall_${stage}`;
const reasoningText = (id: string) => `Inspect ${id} before continuing the offline fixture. Preserve this reasoning exactly. 🔍`;
const archiveMarker = /\[Live Compact omitted .* reference (lc1_[0-9a-f]{32}) and offset (\d+) /;
// A roomy fixture model makes any accidental near-capacity trigger observable.
const fixtureContextTokens = 262_144;

async function scriptedProvider(span = false, reads = 5, reasoning = false) {
  const requests = new Map<number, ChatRequest[]>();
  const compactionRequests: ChatRequest[] = [];
  const errors: unknown[] = [];
  let nextResponse = 1;
  let previousReference: string | undefined;
  const http = createServer(async (incoming, response) => {
    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest;
      const stage = stageNumber(request);
      if (!stage || !request.tools?.some((tool) => tool.function.name === "read")) {
        const compaction = request.messages.some((message) => contentText(message)?.includes("<template>\n## Objective"));
        if (compaction) compactionRequests.push(request);
        writeCompletion(response, request, nextResponse++, undefined, compaction ? "## Objective\n- Exercise the offline coding fixtures." : undefined);
        return;
      }
      const entries = requests.get(stage) ?? [];
      entries.push(request);
      requests.set(stage, entries);
      if (stage === 2 && entries.length === 1) {
        response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "0" });
        response.end(JSON.stringify({ error: { message: "Intentional offline retry", type: "server_error" } }));
        return;
      }
      let call: ToolCall | undefined;
      if ([1, 4, 6, 9, 11, 13, 15].includes(stage)) {
        for (let index = 1; index <= reads; index++) {
          const id = readID(stage, index);
          if (result(request, id)) continue;
          call = { id, name: "read", input: { path: `fixture-${index}.ts` } };
          break;
        }
      }
      if (stage === 21 && !result(request, "call_lc_status")) {
        call = { id: "call_lc_status", name: "live_compact_status", input: {} };
      }
      if (stage === 2 && !result(request, recallID(stage))) {
        const match = span
          ? request.messages.map(contentText).find(text => text?.startsWith("[Live Compact completed span"))
            ?.match(/ reference (lc1_[0-9a-f]{32}) and offset (\d+) /)
          : contentText(result(request, readID(1, 1)))?.match(archiveMarker);
        assert.ok(match?.[1] && match[2], "first follow-up should carry the previous turn's checkpoint");
        previousReference = match[1];
        call = { id: recallID(stage), name: "live_compact_recall", input: { reference: previousReference, offset: Number(match[2]), limit: 33 } };
      }
      if ((stage === 5 || stage === 8) && !result(request, recallID(stage))) {
        assert.ok(previousReference);
        call = { id: recallID(stage), name: "live_compact_recall", input: { reference: previousReference, limit: 25 } };
      }
      if (stage === 6 && !call) {
        response.writeHead(422, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Intentional offline model failure", type: "invalid_request_error" } }));
        return;
      }
      if (stage === 9 && !call) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        response.flushHeaders();
        return;
      }
      if (call) assert.ok(request.tools.some((tool) => tool.function.name === call.name),
        `missing ${call.name}. Available tools: ${request.tools.map((tool) => tool.function.name).join(", ")}`);
      const prose = stage === 18 ? Array.from({ length: 400 }, (_, index) =>
        `Paragraph ${index}: ${"This explains the sample and illustrates how it works. ".repeat(4)}`).join("\n") : undefined;
      writeCompletion(response, request, nextResponse++, call, prose, reasoning && call ? reasoningText(call.id) : undefined);
    } catch (error) {
      errors.push(error);
      response.writeHead(422, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid offline fixture request", type: "invalid_request_error" } }));
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    compactionRequests,
    errors,
    close: async () => {
      const closed = once(http, "close");
      http.close();
      http.closeAllConnections();
      await closed;
    },
  };
}

async function waitForModel(client: OpenCodeClient, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    const models = await client.model.list(undefined, { signal }).catch(() => undefined);
    if (models?.data.some((model) => model.providerID === "local" && model.id === "fixture")) return;
    await delay(200, undefined, { signal });
  }
}

async function prompt(client: OpenCodeClient, sessionID: string, stage: number, signal: AbortSignal) {
  const before = await client.session.get({ sessionID }, { signal });
  await client.session.prompt({ sessionID, text: `lc-integration-stage-${stage}`, delivery: "queue" }, { signal });
  return waitForTurn(client, sessionID, before.time.idle, signal);
}

function assertTransition(previous: ChatRequest, next: ChatRequest, previousStage: number) {
  const id = readID(previousStage, 1);
  const oldTool = result(previous, id);
  const newTool = result(next, id);
  assert.ok(oldTool && newTool);
  assert.equal(newTool.tool_call_id, oldTool.tool_call_id);
  const index = previous.messages.indexOf(oldTool);
  assert.equal(next.messages.indexOf(newTool), index);
  assert.equal(JSON.stringify(next.messages.slice(0, index)), JSON.stringify(previous.messages.slice(0, index)));
  const full = contentText(oldTool);
  const checkpoint = contentText(newTool);
  const match = checkpoint?.match(archiveMarker);
  assert.ok(full && checkpoint && match?.[2]);
  const prefix = checkpoint.slice(0, match.index);
  assert.equal(JSON.stringify(full.slice(0, prefix.length)), JSON.stringify(prefix));
  for (let recent = 3; recent <= 5; recent++) {
    const recentID = readID(previousStage, recent);
    assert.ok(result(previous, recentID));
    assert.deepEqual(result(next, recentID), result(previous, recentID));
  }
  assert.match(contentText(result(next, readID(previousStage, 2))) ?? "", archiveMarker);
  return { full, checkpoint, offset: Number(match[2]) };
}

async function writePluginFixture(root: string, directory: string, baseURL: string, compactSpans: boolean, reads = 5,
  options: Record<string, unknown> = {},
  modelCost = { input: 0, output: 0, cache: { read: 0, write: 0 } }) {
  await mkdir(directory);
  const pluginRoot = process.env.OPENCODE_PLUGIN_DIR ?? fileURLToPath(new URL("../", import.meta.url));
  await writeFile(join(directory, "opencode.json"), JSON.stringify({
    model: "local/fixture",
    providers: {
      local: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: baseURL },
        models: Object.fromEntries(["fixture", "alternate"].map((id) => [id, {
          capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: fixtureContextTokens, output: 4096 },
          type: "chat", cost: [modelCost],
        }])),
      },
    },
    plugins: [{ package: pathToFileURL(pluginRoot).href, options: { compactSpans, archiveDirectory: join(root, "archive"), diagnostics: true, metricsFile: join(root, "metrics.jsonl"), ...options } }],
  }));
  await Promise.all(Array.from({ length: reads }, (_, index) => {
    const content = Array.from({ length: 220 }, (_, line) => `export const fixture_${index}_${line} = "original ${index}:${line} 🔍 ${"sample ".repeat(8)}";`).join("\n");
    return writeFile(join(directory, `fixture-${index + 1}.ts`), content);
  }));
}

test("stock OpenCode 2.2.6 applies completed-turn cuts, recalls originals and resumes after native compaction", { timeout: 160_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-live-compact-integration-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const provider = await scriptedProvider();
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(145_000)]);
  const directory = join(root, "workspace");
  const profile = join(root, "profile");
  let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
  try {
    await writePluginFixture(root, directory, provider.baseURL, false);

    host = await startOpenCode({ directory, profile, signal, offline: true });
    await waitForModel(host.client, signal);
    const created = await host.client.session.create({ title: "Offline Live Compact integration", model: { providerID: "local", id: "fixture" } }, { signal });
    const sessionID = created.id;
    const run = async (stage: number, expectedOutcome = "succeeded", id = sessionID) => {
      assert.ok(host);
      const finished = await prompt(host.client, id, stage, signal);
      assert.deepEqual(provider.errors, []);
      assert.equal(finished.outcome, expectedOutcome, `stage ${stage}`);
      const requests = provider.requests.get(stage);
      assert.ok(requests?.length, `stage ${stage} made no primary requests`);
      return requests;
    };

    const first = await run(1);
    const originating = first.at(-1);
    assert.ok(originating);
    assert.equal(first.length, 6);
    for (const request of first) {
      for (let index = 1; index <= 5; index++) {
        const text = contentText(result(request, readID(1, index)));
        if (text) assert.doesNotMatch(text, archiveMarker);
      }
    }
    const second = await run(2);
    const [followUp, retried, afterRecall] = second;
    assert.equal(second.length, 3);
    assert.ok(followUp && retried && afterRecall);
    assert.equal(JSON.stringify(retried.messages), JSON.stringify(followUp.messages));
    const cut = assertTransition(originating, followUp, 1);
    const recalled = JSON.parse(contentText(result(afterRecall, recallID(2))) ?? "null");
    assert.equal(recalled.status, "ok");
    assert.equal(recalled.text, [...cut.full].slice(cut.offset, cut.offset + 33).join(""));
    assert.equal(recalled.nextOffset, cut.offset + 33);
    assert.equal(contentText(result(afterRecall, readID(1, 1))), cut.checkpoint);
    const transcript = await host.client.session.context({ sessionID }, { signal });
    const durable = transcript.find((item) => item.type === "compaction");
    assert.ok(durable?.type === "compaction" && durable.status === "completed");
    assert.equal(durable.metadata?.liveCompact, "replacement-v1");
    assert.ok(Array.isArray(durable.native?.messages));
    // A round protected at the first cut becomes eligible after another tool round.
    assert.match(JSON.stringify(durable.native.messages.find((message) =>
      JSON.stringify(message).includes(readID(1, 3)) && JSON.stringify(message).includes("[Live Compact omitted"))), archiveMarker);
    assert.equal(provider.compactionRequests.length, 0);
    await host.client.session.switchModel({ sessionID, model: { providerID: "local", id: "alternate" } }, { signal });
    const [alternate] = await run(17);
    assert.ok(alternate);
    assert.equal(contentText(result(alternate, readID(1, 1))), cut.full);
    await host.client.session.switchModel({ sessionID, model: { providerID: "local", id: "fixture" } }, { signal });

    await host.close();
    host = await startOpenCode({ directory, profile, signal, offline: true });
    await waitForModel(host.client, signal);
    const [afterRestart] = await run(3);
    assert.ok(afterRestart);
    assert.equal(contentText(result(afterRestart, readID(1, 1))), cut.checkpoint);

    const compacted = await host.client.session.compact({ sessionID, delivery: "queue" }, { signal });
    for (;;) {
      const history = await host.client.session.context({ sessionID }, { signal });
      const marker = history.find((item) => item.id === compacted.id);
      if (marker?.type === "compaction" && marker.status !== "running") {
        assert.equal(marker.status, "completed", JSON.stringify(marker));
        break;
      }
      await delay(200, undefined, { signal });
    }
    assert.equal(provider.compactionRequests.length, 1);
    const afterNative = (await run(4)).at(-1);
    const [resumed, resumedRecall] = await run(5);
    assert.ok(afterNative && resumed && resumedRecall);
    assertTransition(afterNative, resumed, 4);
    assert.equal(provider.compactionRequests.length, 1);
    const oldRecord = JSON.parse(contentText(result(resumedRecall, recallID(5))) ?? "null");
    if (oldRecord.status !== "ok") {
      const inspection = new RecoveryStore({ directory: join(root, "archive"), maxBytes: 64 * 1024 * 1024 });
      try {
        const reference = cut.checkpoint.match(archiveMarker)?.[1];
        assert.ok(reference);
        const archived = await inspection.get(sessionID, reference);
        t.diagnostic(JSON.stringify({ recallAfterNativeCompaction: oldRecord, reference,
          archived: archived ? { active: archived.active, originalMatches: archived.original === cut.full } : null,
          records: (await inspection.list(sessionID)).map(record => ({ reference: record.reference, active: record.active })) }));
      } catch (error) {
        t.diagnostic(`Archive inspection after recall failure: ${String(error)}`);
      } finally {
        await inspection.close();
      }
    }
    assert.equal(oldRecord.status, "ok");
    assert.equal(oldRecord.text, [...cut.full].slice(0, 25).join(""));

    await run(6, "failed");
    const [afterFailure] = await run(7);
    assert.ok(afterFailure);
    for (let index = 1; index <= 5; index++) {
      const text = contentText(result(afterFailure, readID(6, index)));
      assert.ok(text, "failed turn's tool output remains visible");
      assert.doesNotMatch(text, archiveMarker);
    }

    const other = await host.client.session.create({ title: "Unrelated session", model: { providerID: "local", id: "fixture" } }, { signal });
    const [, foreignRecall] = await run(8, "succeeded", other.id);
    assert.ok(foreignRecall);
    assert.equal(JSON.parse(contentText(result(foreignRecall, recallID(8))) ?? "null").status, "unavailable");

    const beforeInterrupt = await host.client.session.get({ sessionID }, { signal });
    await host.client.session.prompt({ sessionID, text: "lc-integration-stage-9", delivery: "queue" }, { signal });
    while ((provider.requests.get(9)?.length ?? 0) < 6) await delay(100, undefined, { signal });
    await host.client.session.interrupt({ sessionID }, { signal });
    const interrupted = await waitForTurn(host.client, sessionID, beforeInterrupt.time.idle, signal);
    assert.equal(interrupted.outcome, "interrupted");
    const [afterInterrupt] = await run(10);
    assert.ok(afterInterrupt);
    for (let index = 1; index <= 5; index++) {
      const text = contentText(result(afterInterrupt, readID(9, index)));
      assert.ok(text, "interrupted turn's completed tool result remains visible");
      assert.doesNotMatch(text, archiveMarker);
    }
    const proseSession = await host.client.session.create({ title: "Older prose", model: { providerID: "local", id: "fixture" } }, { signal });
    await run(18, "succeeded", proseSession.id);
    const [unmodified] = await run(19, "succeeded", proseSession.id);
    const [shortened] = await run(20, "succeeded", proseSession.id);
    const originalProse = unmodified?.messages.find(message => contentText(message)?.startsWith("Paragraph 0:"));
    const compactProse = shortened?.messages.find(message => contentText(message)?.startsWith("Paragraph 0:"));
    assert.ok(originalProse && compactProse);
    const proseTokens = estimateTokens(contentText(originalProse) ?? "");
    assert.ok(proseTokens >= 20_000 && proseTokens <= 32_000,
      `the prose fixture itself must cross the default context gate without exceeding the source limit: ${proseTokens}`);
    assert.equal(compactProse.role, "assistant");
    if (!archiveMarker.test(contentText(compactProse) ?? "")) {
      const history = await host.client.session.context({ sessionID: proseSession.id }, { signal });
      const metrics = (await readFile(join(root, "metrics.jsonl"), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line)).filter(row => row.sessionID === proseSession.id);
      t.diagnostic(JSON.stringify({ proseHistory: history, proseMetrics: metrics }, (_key, value) =>
        typeof value === "string" && value.length > 240 ? `${value.slice(0, 160)}… (${value.length} characters)` : value));
    }
    assert.match(contentText(compactProse) ?? "", archiveMarker);
    assert.ok((contentText(originalProse)?.length ?? 0) > (contentText(compactProse)?.length ?? 0));
    const statusRequests = await run(21, "succeeded", proseSession.id);
    const status = JSON.parse(contentText(result(statusRequests.at(-1)!, "call_lc_status")) ?? "null");
    assert.equal(status.planning.event, "planning");
    assert.equal(typeof status.planning.reason, "string");
    assert.ok(!JSON.stringify(status).includes("Paragraph 0:"), "status must not expose transcript content");
  } catch (error) {
    const details = [];
    for (const file of await readdir(profile).catch(() => [] as string[])) {
      if (!/^server-\d+\.log$/.test(file)) continue;
      details.push((await readFile(join(profile, file), "utf8")).slice(-4000));
    }
    const metrics = await readFile(join(root, "metrics.jsonl"), "utf8").catch(() => "");
    if (metrics) details.push(metrics.slice(-2500));
    if (details.some(Boolean)) t.diagnostic(details.join("\n"));
    throw error;
  } finally {
    await host?.close();
    await provider.close();
  }
});

test("stock OpenCode persists an early cut despite a long protected suffix without another model call", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-live-compact-span-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const provider = await scriptedProvider(true);
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(85_000)]);
  const directory = join(root, "workspace");
  let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
  let store: RecoveryStore | undefined;
  try {
    // Advertised prices are fixture data; every provider request stays offline.
    // These rates made a suffix longer than the savings fail the former eight-request payback gate.
    await writePluginFixture(root, directory, provider.baseURL, true, 5, {},
      { input: 0.1, output: 0.1, cache: { read: 0.01, write: 0.125 } });
    host = await startOpenCode({ directory, profile: join(root, "profile"), signal, offline: true });
    const { client } = host;
    await waitForModel(client, signal);
    const session = await client.session.create({ title: "Completed span", model: { providerID: "local", id: "fixture" } }, { signal });
    assert.equal((await prompt(client, session.id, 1, signal)).outcome, "succeeded");
    const original = provider.requests.get(1)?.at(-1);
    assert.ok(original);
    const reportedInput = Math.ceil(JSON.stringify(original.messages).length / 4);
    assert.ok(reportedInput >= 20_000, `fixture should cross the default early threshold: ${reportedInput}`);
    assert.ok(reportedInput < fixtureContextTokens / 2, `cut must happen well before 80% capacity: ${reportedInput}`);
    const atTurnEnd = await client.session.context({ sessionID: session.id }, { signal });
    assert.ok(atTurnEnd.some(entry => entry.type === "compaction" && entry.status === "completed" &&
      entry.metadata?.liveCompact === "replacement-v1" && Array.isArray(entry.native?.messages)),
    "the replacement must already be persisted before submitting the next user turn");
    assert.equal(provider.requests.get(1)?.length, 6, "only the five reads and final answer should call the provider");
    assert.equal(provider.compactionRequests.length, 0, "local maintenance must not request a model summary");
    t.diagnostic(`Persisted turn-end cut at ${reportedInput} scripted input tokens (${(100 * reportedInput / fixtureContextTokens).toFixed(1)}% of the window), before the next prompt.`);
    assert.equal((await prompt(client, session.id, 2, signal)).outcome, "succeeded");
    assert.deepEqual(provider.errors, []);
    const [next, retry, recalled] = provider.requests.get(2) ?? [];
    assert.ok(next && retry && recalled);
    assert.deepEqual(next.messages, retry.messages);
    const start = original.messages.findIndex(message => message.tool_calls?.some(call => call.id === readID(1, 1)));
    const marker = next.messages.findIndex(message => contentText(message)?.startsWith("[Live Compact completed span"));
    assert.ok(start >= 0);
    assert.equal(marker, start + 1);
    const protectedStart = original.messages.findIndex(message => message.tool_calls?.some(call => call.id === readID(1, 3)));
    assert.ok(protectedStart > start);
    assert.ok(JSON.stringify(original.messages.slice(protectedStart)).length >
      JSON.stringify(original.messages.slice(start, protectedStart)).length,
    "the protected suffix must be longer than the entire shortened span, preventing eight-request cache payback");
    assert.deepEqual(next.messages.slice(0, marker), original.messages.slice(0, marker));
    assert.equal(next.messages.filter(message => contentText(message)?.startsWith("[Live Compact completed span")).length, 2);
    assert.equal(next.messages[marker]?.role, "tool");
    for (const index of [1, 2]) {
      const id = readID(1, index);
      const before = result(original, id);
      const after = result(next, id);
      assert.ok(before && after);
      assert.match(contentText(after) ?? "", /^\[Live Compact completed span/);
      assert.ok((contentText(after)?.length ?? 0) < (contentText(before)?.length ?? 0));
      assert.equal(next.messages.indexOf(after), original.messages.indexOf(before));
      const call = (message: ChatMessage) => message.tool_calls?.some(call => call.id === id);
      assert.deepEqual(next.messages.find(call), original.messages.find(call));
    }
    for (const index of [3, 4, 5]) {
      assert.deepEqual(result(next, readID(1, index)), result(original, readID(1, index)));
    }
    const payload = JSON.parse(contentText(result(recalled, recallID(2))) ?? "null");
    assert.equal(payload.status, "ok");
    store = new RecoveryStore({ directory: join(root, "archive"), maxBytes: 64 * 1024 * 1024 });
    const archive = await store.get(session.id, payload.reference);
    assert.ok(archive);
    const archived = JSON.parse(archive.original);
    assert.equal(archived.length, 4);
    assert.equal(archived[1].content[0].result.value, contentText(result(original, readID(1, 1))));
    assert.equal(archived[3].content[0].result.value, contentText(result(original, readID(1, 2))));
    assert.equal(payload.text, [...archive.original].slice(0, 33).join(""));
    assert.equal(payload.nextOffset, 33);
    assert.equal(provider.compactionRequests.length, 0);
  } finally {
    await store?.close();
    await host?.close();
    await provider.close();
  }
});

test("stock OpenCode keeps complete outputs and makes no summary request when backup fails", { timeout: 160_000 }, async (t) => {
  for (const mode of ["capacity", "filesystem"] as const) await t.test(mode, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-live-compact-backup-"));
    const provider = await scriptedProvider(true);
    const directory = join(root, "workspace");
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(70_000)]);
    let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
    try {
      if (mode === "filesystem") await writeFile(join(root, "archive"), "This file prevents archive directory creation.");
      await writePluginFixture(root, directory, provider.baseURL, true, 5,
        mode === "capacity" ? { archiveMaxBytes: 1024 } : {});
      host = await startOpenCode({ directory, profile: join(root, "profile"), signal, offline: true });
      await waitForModel(host.client, signal);
      const session = await host.client.session.create({ model: { providerID: "local", id: "fixture" } }, { signal });
      assert.equal((await prompt(host.client, session.id, 1, signal)).outcome, "succeeded");
      const original = provider.requests.get(1)?.at(-1);
      assert.ok(original);
      const history = await host.client.session.context({ sessionID: session.id }, { signal });
      assert.equal(history.some(entry => entry.type === "compaction"), false, "failed backup must not queue maintenance");
      assert.equal((await prompt(host.client, session.id, 3, signal)).outcome, "succeeded");
      const followUp = provider.requests.get(3)?.[0];
      assert.ok(followUp);
      assert.equal(JSON.stringify(followUp.messages.slice(0, original.messages.length)), JSON.stringify(original.messages));
      for (let index = 1; index <= 5; index++) {
        assert.deepEqual(result(followUp, readID(1, index)), result(original, readID(1, index)));
        assert.doesNotMatch(contentText(result(followUp, readID(1, index))) ?? "", archiveMarker);
      }
      assert.deepEqual(provider.errors, []);
      assert.equal(provider.compactionRequests.length, 0);
    } finally {
      await host?.close();
      await provider.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("stock OpenCode admits small mixed reasoning/tool spans and preserves exact native pairs", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-live-compact-batch-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const provider = await scriptedProvider(true, 10, true);
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(85_000)]);
  const directory = join(root, "workspace");
  let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
  let store: RecoveryStore | undefined;
  try {
    await writePluginFixture(root, directory, provider.baseURL, true, 10);
    // Seven individually ineligible outputs combine into a useful span. The
    // three larger protected reads keep the default 20,000-token gate active.
    await Promise.all(Array.from({ length: 7 }, (_, index) => writeFile(join(directory, `fixture-${index + 1}.ts`),
      Array.from({ length: 24 }, (_, line) => `export const short_${index}_${line} = "original ${index}:${line} 🔍 ${"sample ".repeat(8)}";`).join("\n"))));
    host = await startOpenCode({ directory, profile: join(root, "profile"), signal, offline: true });
    await waitForModel(host.client, signal);
    const session = await host.client.session.create({ model: { providerID: "local", id: "fixture" } }, { signal });
    assert.equal((await prompt(host.client, session.id, 1, signal)).outcome, "succeeded");
    const original = provider.requests.get(1)?.at(-1);
    assert.ok(original);
    assert.equal(provider.requests.get(1)?.length, 11, "only ten reads and a final answer should call the provider");
    for (const request of provider.requests.get(1) ?? []) for (let index = 1; index <= 10; index++) {
      const text = contentText(result(request, readID(1, index)));
      if (text) assert.doesNotMatch(text, /\[Live Compact (?:omitted|completed span)/,
        "the originating model turn must see every result in full");
    }
    for (let index = 1; index <= 7; index++) {
      const text = contentText(result(original, readID(1, index)));
      assert.ok(text);
      assert.ok(estimateTokens(text) < 1_000, `read ${index} is below the individual source-size floor`);
    }
    const atTurnEnd = await host.client.session.context({ sessionID: session.id }, { signal });
    const durable = atTurnEnd.find(entry => entry.type === "compaction" && entry.status === "completed" &&
      entry.metadata?.liveCompact === "replacement-v1");
    assert.ok(durable?.type === "compaction" && durable.status === "completed" && Array.isArray(durable.native?.messages),
      "the mixed span must be durable before the next prompt");
    const native = durable.native.messages as unknown as SessionContext["messages"];
    const shortened = native.flatMap(message => message.content.filter(part =>
      part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string" &&
      part.result.value.startsWith("[Live Compact completed span")));
    assert.equal(shortened.length, 7);
    const references = shortened.map(part => part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string"
      ? part.result.value.match(/ reference (lc1_[0-9a-f]{32}) and offset 0 /)?.[1] : undefined);
    assert.ok(references[0]);
    const uniqueReferences = [...new Set(references)];
    assert.equal(uniqueReferences.length, 2, "the two selected spans each share an exact-source archive");
    store = new RecoveryStore({ directory: join(root, "archive"), maxBytes: 64 * 1024 * 1024 });
    const archives = await Promise.all(uniqueReferences.map(async reference => {
      assert.ok(reference && store);
      const archive = await store.get(session.id, reference);
      assert.ok(archive);
      return archive;
    }));
    let archivedMessages = 0;
    for (const archive of archives) {
      const archived = JSON.parse(archive.original) as SessionContext["messages"];
      assert.ok(archived.length >= 4, "each admitted span combines at least two individually ineligible outputs");
      const sourceTokens = archived.reduce((sum, message) => sum + message.content.reduce((total, part) =>
        total + (part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string"
          ? estimateTokens(part.result.value) : 0), 0), 0);
      assert.ok(sourceTokens >= 1_000, "each cut reaches the source floor without crediting preserved reasoning or calls");
      archivedMessages += archived.length;
      const nativeStart = native.findIndex(message => message.role === "assistant" && message.id === archived[0]?.id);
      assert.ok(nativeStart >= 0);
      for (const [index, before] of archived.entries()) {
        const after = native[nativeStart + index];
        assert.ok(after);
        if (before.role === "assistant") {
          const call = before.content.find(part => part.type === "tool-call");
          const reasoning = before.content.find(part => part.type === "reasoning");
          assert.ok(call?.type === "tool-call" && reasoning?.type === "reasoning",
            "the stock host must present reasoning and tool calls in the same native message");
          assert.equal(reasoning.text, reasoningText(call.id));
          assert.ok(Object.values(reasoning.providerMetadata ?? {}).some(value => value.reasoningField === "reasoning_content"),
            "the host reasoning metadata must be exercised");
          assert.deepEqual(after, before, "reasoning, tool calls, identifiers and provider metadata remain exact");
        } else {
          assert.equal(before.role, "tool");
          const part = before.content[0];
          const replacement = after.content[0];
          assert.ok(part?.type === "tool-result" && part.result.type === "text" &&
            replacement?.type === "tool-result" && replacement.result.type === "text");
          assert.equal(part.result.value, contentText(result(original, part.id)), "the archive contains the exact original output");
          assert.deepEqual(after, { ...before, content: [{ ...part, result: { ...part.result, value: replacement.result.value } }] },
            "only the result text changes; the result identity and metadata remain exact");
        }
      }
    }
    assert.equal(archivedMessages, 14, "the archives retain all seven assistant/result pairs exactly once");
    const metrics = (await readFile(join(root, "metrics.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const admitted = metrics.find(row => row.event === "planning" && row.reason === "admitted");
    assert.ok(admitted && admitted.contextTokens >= 20_000, "the default early threshold must remain active");
    assert.equal(admitted.alternatives.individual.sizeValidCandidates, 0);
    assert.ok(admitted.alternatives.spans.sizeValidCandidates > 0);
    assert.equal(admitted.strategy, "spans");
    const replacement = metrics.find(row => row.event === "replacement");
    assert.ok(replacement?.estimatedSavedTokens > 0, "the replacement must still reduce estimated context");
    assert.equal(replacement.count, archives.length);
    assert.equal(provider.compactionRequests.length, 0);
    assert.equal((await prompt(host.client, session.id, 2, signal)).outcome, "succeeded");
    assert.deepEqual(provider.errors, []);
    const [next, retry, recalled] = provider.requests.get(2) ?? [];
    assert.ok(next && retry && recalled);
    assert.deepEqual(next.messages, retry.messages);
    const checkpoints = next.messages.filter(message => contentText(message)?.startsWith("[Live Compact completed span"));
    assert.equal(checkpoints.length, 7);
    const first = next.messages.indexOf(checkpoints[0]!);
    assert.equal(JSON.stringify(next.messages.slice(0, first)), JSON.stringify(original.messages.slice(0, first)));
    let saved = 0;
    for (let index = 1; index <= 10; index++) {
      const id = readID(1, index);
      const call = (message: ChatMessage) => message.tool_calls?.some(call => call.id === id);
      const originalCall: ChatMessage | undefined = original.messages.find(call);
      assert.equal(originalCall?.reasoning_content, reasoningText(id));
      assert.deepEqual(next.messages.find(call), originalCall);
      const before = result(original, id);
      const after = result(next, id);
      assert.ok(before && after);
      assert.equal(next.messages.indexOf(after), original.messages.indexOf(before));
      assert.deepEqual(after, { ...before, content: after.content });
      saved += estimateTokens(contentText(before) ?? "") - estimateTokens(contentText(after) ?? "");
    }
    assert.ok(saved > 0);
    for (const index of [8, 9, 10]) assert.deepEqual(result(next, readID(1, index)), result(original, readID(1, index)));
    const payload = JSON.parse(contentText(result(recalled, recallID(2))) ?? "null");
    const archive = archives[0]!;
    assert.equal(payload.status, "ok");
    assert.equal(payload.reference, archive.reference);
    assert.equal(payload.text, [...archive.original].slice(0, 33).join(""));
    assert.equal(payload.nextOffset, 33);
    t.diagnostic(`Preserved seven reasoning/tool pairs; ${saved} net tokens saved with zero individually admissible outputs.`);
    assert.equal(provider.compactionRequests.length, 0);
  } finally {
    await store?.close();
    await host?.close();
    await provider.close();
  }
});

test("stock OpenCode admits 1,000-token sources even when net savings are below 1,000", { timeout: 160_000 }, async (t) => {
  for (const strategy of ["spans", "individual"] as const) await t.test(strategy, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-live-compact-source-floor-"));
    const compactSpans = strategy === "spans";
    const provider = await scriptedProvider(compactSpans, 5, true);
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(70_000)]);
    const directory = join(root, "workspace");
    let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
    let store: RecoveryStore | undefined;
    try {
      await writePluginFixture(root, directory, provider.baseURL, compactSpans);
      // Only the first two outputs are old enough to cut. Their source reaches
      // 1K tokens, but keeping excerpts and recall markers saves less than 1K.
      await Promise.all([0, 1].map(index => writeFile(join(directory, `fixture-${index + 1}.ts`),
        Array.from({ length: 24 }, (_, line) =>
          `export const small_${index}_${line} = "original ${index}:${line} 🔍 ${"sample ".repeat(compactSpans ? 6 : index === 0 ? 17 : 0)}";`).join("\n"))));
      host = await startOpenCode({ directory, profile: join(root, "profile"), signal, offline: true });
      await waitForModel(host.client, signal);
      const session = await host.client.session.create({ model: { providerID: "local", id: "fixture" } }, { signal });
      assert.equal((await prompt(host.client, session.id, 1, signal)).outcome, "succeeded");
      const original = provider.requests.get(1)?.at(-1);
      assert.ok(original);
      assert.equal(provider.requests.get(1)?.length, 6);
      for (const request of provider.requests.get(1) ?? []) for (let index = 1; index <= 5; index++) {
        const text = contentText(result(request, readID(1, index)));
        if (text) assert.doesNotMatch(text, /\[Live Compact (?:omitted|completed span)/);
      }
      const source = [1, 2].map(index => contentText(result(original, readID(1, index))));
      assert.ok(source[0] && source[1]);
      const sourceTokens = compactSpans ? estimateTokens(source[0]) + estimateTokens(source[1]) : estimateTokens(source[0]);
      assert.ok(sourceTokens >= 1_000);
      if (compactSpans) assert.ok(source.every(text => estimateTokens(text!) < 1_000));
      else assert.ok(estimateTokens(source[1]) < 1_000);
      const history = await host.client.session.context({ sessionID: session.id }, { signal });
      const durable = history.find(entry => entry.type === "compaction" && entry.status === "completed" &&
        entry.metadata?.liveCompact === "replacement-v1");
      assert.ok(durable?.type === "compaction" && durable.status === "completed" && Array.isArray(durable.native?.messages),
        "a cut with sub-1K savings must already be durable at the completed-turn boundary");
      const metrics = (await readFile(join(root, "metrics.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const admitted = metrics.find(row => row.event === "planning" && row.reason === "admitted");
      assert.ok(admitted?.contextTokens >= 20_000);
      assert.equal(admitted.strategy, strategy);
      const replacement = metrics.find(row => row.event === "replacement");
      assert.equal(replacement?.count, 1);
      assert.ok(replacement.estimatedSavedTokens > 0 && replacement.estimatedSavedTokens < 1_000);
      assert.equal(provider.compactionRequests.length, 0);

      assert.equal((await prompt(host.client, session.id, 2, signal)).outcome, "succeeded");
      assert.deepEqual(provider.errors, []);
      const [next, retry, recalled] = provider.requests.get(2) ?? [];
      assert.ok(next && retry && recalled);
      assert.deepEqual(next.messages, retry.messages);
      const firstTool = result(original, readID(1, 1));
      assert.ok(firstTool);
      const first = original.messages.indexOf(firstTool);
      assert.equal(JSON.stringify(next.messages.slice(0, first)), JSON.stringify(original.messages.slice(0, first)));
      let saved = 0;
      for (let index = 1; index <= 5; index++) {
        const id = readID(1, index), before = result(original, id), after = result(next, id);
        assert.ok(before && after);
        assert.equal(next.messages.indexOf(after), original.messages.indexOf(before));
        assert.deepEqual(after, { ...before, content: after.content });
        const call = (message: ChatMessage) => message.tool_calls?.some(entry => entry.id === id);
        assert.equal(original.messages.find(call)?.reasoning_content, reasoningText(id));
        assert.deepEqual(next.messages.find(call), original.messages.find(call));
        const oldText = contentText(before)!, newText = contentText(after)!;
        if (index <= (compactSpans ? 2 : 1)) {
          assert.ok(estimateTokens(newText) < estimateTokens(oldText));
          assert.ok(Buffer.byteLength(JSON.stringify(newText)) < Buffer.byteLength(JSON.stringify(oldText)));
        } else assert.deepEqual(after, before, "below-floor and recent outputs remain unchanged");
        saved += estimateTokens(oldText) - estimateTokens(newText);
      }
      assert.equal(saved, replacement.estimatedSavedTokens);
      assert.ok(saved > 0 && saved < 1_000, `expected a positive sub-1K cut, received ${saved}`);
      const payload = JSON.parse(contentText(result(recalled, recallID(2))) ?? "null");
      assert.equal(payload.status, "ok");
      store = new RecoveryStore({ directory: join(root, "archive"), maxBytes: 64 * 1024 * 1024 });
      const archive = await store.get(session.id, payload.reference);
      assert.ok(archive);
      const offset = compactSpans ? 0 : Number(contentText(result(next, readID(1, 1)))?.match(archiveMarker)?.[2]);
      assert.equal(payload.text, [...archive.original].slice(offset, offset + 33).join(""));
      assert.equal(payload.nextOffset, offset + 33);
      assert.equal(provider.compactionRequests.length, 0);
      t.diagnostic(`${strategy}: ${sourceTokens} source tokens, ${saved} net tokens saved, with default completion and protection thresholds.`);
    } finally {
      await store?.close();
      await host?.close();
      await provider.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test("stock OpenCode can persist an idle replacement window without a model call", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-native-window-integration-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const provider = await scriptedProvider();
  const directory = join(root, "workspace");
  const profile = join(root, "profile");
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(110_000)]);
  let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
  try {
    const fixture = join(directory, "window-probe");
    await mkdir(fixture, { recursive: true });
    await copyFile(new URL("./native-window.fixture.ts", import.meta.url), join(fixture, "index.ts"));
    const model = { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 131_072, output: 131_072 } };
    await writeFile(join(directory, "opencode.json"), JSON.stringify({
      model: "local/fixture",
      providers: { local: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.baseURL }, models: { fixture: model, alternate: model } } },
      plugins: ["./window-probe"],
    }));
    await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const lines = Array.from({ length: 220 }, (_, line) => `export const row_${index}_${line} = "source ${index}:${line} ${"sample ".repeat(10)}";`);
      return writeFile(join(directory, `fixture-${index + 1}.ts`), lines.join("\n"));
    }));
    host = await startOpenCode({ directory, profile, signal, offline: true });
    const { client } = host;
    await waitForModel(client, signal);
    const selected = { providerID: "local", id: "fixture" };
    const create = async (title: string) => (await client.session.create({ title, model: selected }, { signal })).id;
    const run = async (sessionID: string, stage: number) => {
      const finished = await prompt(client, sessionID, stage, signal);
      assert.deepEqual(provider.errors, []);
      assert.equal(finished.outcome, "succeeded", `stage ${stage}`);
      const requests = provider.requests.get(stage);
      assert.ok(requests?.length);
      return requests;
    };
    const checkpoint = async (sessionID: string) => {
      const history = await client.session.context({ sessionID }, { signal });
      const marker = history[0];
      assert.ok(marker?.type === "compaction" && marker.status === "completed", `no durable replacement: ${history.map((item) => item.type).join(", ")}`);
      assert.equal(marker.metadata?.fixtureReplacement, marker.id);
      assert.equal(marker.reason, "manual");
      assert.equal(marker.model?.providerID, selected.providerID);
      assert.equal(marker.model?.id, selected.id);
      assert.ok(Array.isArray(marker.native?.messages));
      return marker.id;
    };
    const assertReplacement = (stage: number, before: ChatRequest, after: ChatRequest) => {
      const toolID = readID(stage, 1);
      const original = result(before, toolID);
      const rewritten = result(after, toolID);
      assert.ok(original && rewritten);
      const position = before.messages.indexOf(original);
      assert.equal(after.messages.indexOf(rewritten), position);
      assert.equal(JSON.stringify(after.messages.slice(0, position)), JSON.stringify(before.messages.slice(0, position)));
      const full = contentText(original);
      const shortened = contentText(rewritten);
      assert.ok(full && shortened);
      assert.ok(shortened.endsWith("\n[Fixture replacement]"));
      assert.ok(full.startsWith(shortened.slice(0, -"[Fixture replacement]".length)));
      assert.ok(shortened.length < full.length);
      for (const index of [3, 4, 5]) assert.deepEqual(result(after, readID(stage, index)), result(before, readID(stage, index)));
      return full;
    };

    const treatment = await create("Shortened replacement window");
    const initial = await run(treatment, 11);
    assert.equal(initial.length, 6);
    assert.equal(provider.compactionRequests.length, 0);
    const firstCheckpoint = await checkpoint(treatment);
    const [firstReplay] = await run(treatment, 12);
    const original = initial.at(-1);
    assert.ok(original && firstReplay);
    const full = assertReplacement(11, original, firstReplay);

    const control = await create("Full replacement window");
    await run(control, 15);
    await checkpoint(control);
    const [fullReplay] = await run(control, 16);
    assert.ok(fullReplay);
    assert.equal(contentText(result(fullReplay, readID(15, 1))), full);
    const shortAllowance = firstReplay.max_tokens ?? firstReplay.max_completion_tokens;
    const fullAllowance = fullReplay.max_tokens ?? fullReplay.max_completion_tokens;
    assert.ok(shortAllowance && fullAllowance && shortAllowance > fullAllowance, `expected more native output room after replacement: ${shortAllowance} vs ${fullAllowance}`);
    assert.equal(provider.compactionRequests.length, 0);

    await client.session.switchModel({ sessionID: treatment, model: { providerID: "local", id: "alternate" } }, { signal });
    const [alternate] = await run(treatment, 17);
    assert.ok(alternate);
    assert.equal(contentText(result(alternate, readID(11, 1))), full);
    await client.session.switchModel({ sessionID: treatment, model: selected }, { signal });

    const manual = await client.session.compact({ sessionID: treatment }, { signal });
    for (;;) {
      const history = await client.session.context({ sessionID: treatment }, { signal });
      const marker = history.find((item) => item.id === manual.id);
      if (marker?.type === "compaction" && marker.status !== "running") {
        assert.equal(marker.status, "completed", JSON.stringify(marker));
        assert.equal(marker.metadata?.fixtureReplacement, undefined);
        break;
      }
      await delay(200, undefined, { signal });
    }
    assert.equal(provider.compactionRequests.length, 1);
    const next = (await run(treatment, 13)).at(-1);
    const nextCheckpoint = await checkpoint(treatment);
    assert.notEqual(nextCheckpoint, firstCheckpoint);
    const [nextReplay] = await run(treatment, 14);
    assert.ok(next && nextReplay);
    assertReplacement(13, next, nextReplay);
    assert.equal(provider.compactionRequests.length, 1);
  } finally {
    await host?.close();
    await provider.close();
  }
});
