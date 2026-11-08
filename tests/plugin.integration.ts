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
import { startOpenCode, waitForTurn } from "../benchmarks/runner/opencode.ts";
import { test } from "node:test";

interface ChatMessage {
  role: string;
  content?: string | readonly { type: string; text?: string }[];
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

function writeCompletion(response: ServerResponse, request: ChatRequest, sequence: number, toolCall?: ToolCall, text = "Verified offline fixture checkpoint.") {
  const info = { id: `chatcmpl-fixture-${sequence}`, created: 1, model: request.model };
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(request.messages).length / 4), completion_tokens: 12, total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const message = toolCall ? {
    role: "assistant",
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
const archiveMarker = /\[Live Compact omitted .* reference (lc1_[0-9a-f]{32}) and offset (\d+) /;

async function scriptedProvider() {
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
        for (let index = 1; index <= 5; index++) {
          const id = readID(stage, index);
          if (result(request, id)) continue;
          call = { id, name: "read", input: { path: `fixture-${index}.ts` } };
          break;
        }
      }
      if (stage === 2 && !result(request, recallID(stage))) {
        const match = contentText(result(request, readID(1, 1)))?.match(archiveMarker);
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
      const prose = stage === 18 ? Array.from({ length: 90 }, (_, index) =>
        `Paragraph ${index}: ${"This explains the sample and illustrates how it works. ".repeat(4)}`).join("\n") : undefined;
      writeCompletion(response, request, nextResponse++, call, prose);
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

test("stock OpenCode 2.2.6 applies completed-turn cuts, recalls originals and resumes after native compaction", { timeout: 160_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-live-compact-integration-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const provider = await scriptedProvider();
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(145_000)]);
  const directory = join(root, "workspace");
  const profile = join(root, "profile");
  let host: Awaited<ReturnType<typeof startOpenCode>> | undefined;
  try {
    await mkdir(directory);
    const pluginRoot = process.env.OPENCODE_PLUGIN_DIR ?? fileURLToPath(new URL("../", import.meta.url));
    await writeFile(join(directory, "opencode.json"), JSON.stringify({
      model: "local/fixture",
      providers: {
        local: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: provider.baseURL },
          models: Object.fromEntries(["fixture", "alternate"].map((id) => [id, {
            capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 131_072, output: 4096 },
          }])),
        },
      },
      plugins: [{ package: pathToFileURL(pluginRoot).href, options: { archiveDirectory: join(root, "archive"), diagnostics: true, metricsFile: join(root, "metrics.jsonl") } }],
    }));
    await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const content = Array.from({ length: 220 }, (_, line) => `export const fixture_${index}_${line} = "original ${index}:${line} 🔍 ${"sample ".repeat(8)}";`).join("\n");
      return writeFile(join(directory, `fixture-${index + 1}.ts`), content);
    }));

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
    assert.equal(compactProse.role, "assistant");
    assert.match(contentText(compactProse) ?? "", archiveMarker);
    assert.ok((contentText(originalProse)?.length ?? 0) > (contentText(compactProse)?.length ?? 0));
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
