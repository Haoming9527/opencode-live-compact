import assert from "node:assert/strict";
import { test } from "node:test";
import { planCuts, scorePlan } from "../src/engine/planner.ts";
import type { Candidate, PlannerOptions } from "../src/engine/planner.ts";
import { reduce } from "../src/engine/reducer.ts";

const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
const options: PlannerOptions = {
  minimumSourceTokens: 1_000, maxCutsPerCycle: 3, estimateTokens,
};

function read(id: string, suffixTokens = 0, count = 160): Candidate {
  const lines = Array.from({ length: count }, (_, i) => `${i + 1}: export const value${i} = "${"example ".repeat(16)}";`);
  return {
    identity: { sessionID: "ses_ranking", messageID: `msg_${id}`, partID: id, callID: id, tool: "read" },
    suffixTokens,
    tool: { type: "tool", id, name: "read", time: { created: 0 }, state: {
      status: "completed", input: { path: "src/example.ts" }, metadata: { truncated: false },
      content: [{ type: "text", text: [`Read file src/example.ts, lines 1-${count}`, ...lines].join("\n") }],
    } },
  };
}

test("ranks valid savings by the changed suffix without making it an admission gate", () => {
  assert.equal(scorePlan(1_000, 0), 1_000);
  assert.equal(scorePlan(1_000, 1_000), 500);
  assert.equal(scorePlan(1_000, 9_000), 100);
  assert.ok(scorePlan(2_000, 1_000) > scorePlan(1_000, 1_000));
  assert.ok(scorePlan(1_000, 1_000_000) > 0);
  assert.ok(scorePlan(Number.MIN_VALUE, Number.MAX_VALUE) > 0);
  assert.ok(scorePlan(Number.MAX_VALUE, Number.MAX_VALUE) > 0);
});

test("invalid savings or suffix estimates cannot become selected cuts", () => {
  for (const [saved, suffix] of [[NaN, 1], [Infinity, 1], [-1, 0], [0, 0], [1, -1], [1, NaN], [1, Infinity]]) {
    assert.equal(scorePlan(saved!, suffix!), -Infinity);
  }
  assert.deepEqual(planCuts([read("invalid", Infinity)], options), []);
  assert.deepEqual(planCuts([read("invalid", NaN)], options), []);
});

test("plans a batch against one changed suffix and keeps the chosen prefix intact", () => {
  const newest = read("newest", 100);
  const source = newest.tool.state.status === "completed" && newest.tool.state.content[0];
  assert.ok(source && source.type === "text");
  const older = read("older", estimateTokens(source.text) + 100);
  const ancient = read("ancient", 100_000);
  const before = structuredClone([ancient, older, newest]);
  const cuts = planCuts([ancient, older, newest], options);
  assert.deepEqual(cuts.map(cut => cut.identity.callID), ["older", "newest"]);
  assert.deepEqual([ancient, older, newest], before);
  const standaloneOlder = reduce(older, estimateTokens, options.minimumSourceTokens);
  assert.ok(standaloneOlder && cuts[0] && cuts[1]);
  assert.equal(cuts[0].cacheSuffixTokens, standaloneOlder.cacheSuffixTokens - cuts[1].estimatedSavingsTokens);
  assert.equal(planCuts([ancient], options).length, 1, "a large suffix affects ranking only");
  assert.deepEqual(planCuts([older, newest], { ...options, maxCutsPerCycle: 1 }).map(cut => cut.identity.callID), ["newest"]);
});

test("a cut limit still selects an older result when its larger savings outweigh its longer suffix", () => {
  const newest = read("small-newest", 3_000, 100);
  const source = newest.tool.state.status === "completed" && newest.tool.state.content[0];
  assert.ok(source && source.type === "text");
  const older = read("large-older", 3_000 + estimateTokens(source.text), 600);
  const oneCut = { ...options, maxCutsPerCycle: 1 };
  assert.equal(planCuts([newest], oneCut).length, 1);
  const selected = planCuts([older, newest], oneCut);
  assert.deepEqual(selected.map(cut => cut.identity.callID), ["large-older"]);
  const standaloneOlder = reduce(older, estimateTokens, options.minimumSourceTokens);
  assert.ok(standaloneOlder && selected[0]);
  assert.equal(selected[0].cacheSuffixTokens, standaloneOlder.cacheSuffixTokens);
});
