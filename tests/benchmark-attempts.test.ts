import assert from "node:assert/strict";
import { test } from "node:test";
import { repairFeedback, runExerciseAttempts } from "../benchmarks/runner/attempts.ts";

test("first-attempt success checks budget once and retains cumulative cost without a repair", async () => {
  let budgets = 0;
  const result = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a; edit solution.js only.",
    beforeAttempt: () => { budgets++; },
    execute: async (prompt, attempt) => {
      assert.equal(attempt, 1);
      assert.equal(prompt, "Solve exercise-a; edit solution.js only.");
      return { receipt: { before: 1, after: 4 }, estimatedUsd: 0.2 };
    },
    grade: async () => ({ passed: true, log: "all tests passed" }),
    onRepair: () => assert.fail("A passed exercise must not receive another turn"),
  });
  assert.equal(budgets, 1);
  assert.equal(result.startedAttempts, 1);
  assert.equal(result.attempts[0]?.estimatedUsd, 0.2);
  assert.equal(result.stopped, undefined);
});

test("grades each attempt before admission of a bounded same-task repair", async () => {
  const order: string[] = [];
  let cost = 0;
  const result = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a; edit solution.js only.",
    beforeAttempt: attempt => { order.push(`budget-${attempt}-${cost}`); },
    execute: async (prompt, attempt) => {
      order.push(`execute-${attempt}`);
      if (attempt === 2) {
        assert.match(prompt, /Expected: 16/);
        assert.match(prompt, /Only edit the declared solution files/);
        assert.match(prompt, /Do not change tests/);
        assert.match(prompt, /Solve exercise-a/);
      }
      cost = attempt === 1 ? 0.2 : 0.35;
      return { receipt: { before: attempt * 10, after: attempt * 10 + 4 }, estimatedUsd: cost };
    },
    grade: async attempt => { order.push(`grade-${attempt}`); return { passed: attempt === 2, log: "Expected: 16; actual: 15.999999999999998" }; },
    onRepair: attempt => { order.push(`repair-${attempt}`); },
  });
  assert.deepEqual(order, ["budget-1-0", "execute-1", "grade-1", "budget-2-0.2", "repair-2", "execute-2", "grade-2"]);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.grade.passed, false);
  assert.equal(result.attempts.at(-1)?.grade.passed, true);
  assert.equal(result.attempts.at(-1)?.estimatedUsd, 0.35);
  assert.equal(result.stopped, undefined);
});

test("attempt exhaustion remains a failed exercise and never requests an extra turn", async () => {
  let admissions = 0;
  const result = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a.",
    beforeAttempt: () => { admissions++; },
    execute: async (_prompt, attempt) => ({ receipt: attempt, estimatedUsd: attempt * 0.1 }),
    grade: async () => ({ passed: false, log: "assertion failed" }),
  });
  assert.equal(admissions, 3);
  assert.equal(result.startedAttempts, 3);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts.at(-1)?.grade.passed, false);
  assert.equal(result.stopped, undefined);
});

test("budget denial before a repair preserves the existing failed grade and cost", async () => {
  const denied = new Error("Combined budget exhausted");
  let cost = 0;
  const result = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a.",
    beforeAttempt: () => { if (cost > 0) throw denied; },
    execute: async () => { cost = 0.3; return { receipt: 1, estimatedUsd: cost }; },
    grade: async () => ({ passed: false, log: "assertion failed" }),
    onRepair: () => assert.fail("A refused repair must not be logged as started"),
  });
  assert.equal(result.stopped, denied);
  assert.equal(result.startedAttempts, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.grade.passed, false);
  assert.equal(result.attempts[0]?.estimatedUsd, 0.3);
});

test("initial budget denial and provider failure never cause speculative retries", async () => {
  const failure = new Error("No admission");
  const blocked = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a.",
    beforeAttempt: () => { throw failure; },
    execute: async () => assert.fail("Budget denied"),
    grade: async () => assert.fail("No candidate exists"),
  });
  assert.equal(blocked.startedAttempts, 0);
  assert.deepEqual(blocked.attempts, []);
  assert.equal(blocked.stopped, failure);
  let requests = 0;
  const interrupted = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a.",
    beforeAttempt: () => {},
    execute: async () => { requests++; throw failure; },
    grade: async () => assert.fail("A failed execution is not a completed candidate"),
  });
  assert.equal(requests, 1);
  assert.equal(interrupted.startedAttempts, 1);
  assert.equal(interrupted.stopped, failure);
});

test("repair feedback is bounded and preserves actual head and tail failure details", () => {
  const feedback = repairFeedback("Only exercise-a.", "\u001b[31mExpected 16\u001b[0m\n" + "x".repeat(30_000) + "\n1 test failed");
  assert.match(feedback, /Expected 16/);
  assert.match(feedback, /1 test failed/);
  assert.match(feedback, /Middle of test output omitted/);
  assert.doesNotMatch(feedback, /\u001b/);
  assert.ok(feedback.length < 8_600);
});

test("a failed repair execution retains the previous grade without grading an unfinished turn", async () => {
  const failure = new Error("Provider connection failed during repair");
  let grades = 0;
  const result = await runExerciseAttempts({
    maxAttempts: 3, prompt: "Solve exercise-a.", beforeAttempt: () => {},
    execute: async (_prompt, attempt) => {
      if (attempt > 1) throw failure;
      return { receipt: 1, estimatedUsd: 0.2 };
    },
    grade: async () => { grades++; return { passed: false, log: "Expected: 16" }; },
  });
  assert.equal(result.startedAttempts, 2);
  assert.equal(result.attempts.length, 1);
  assert.equal(grades, 1);
  assert.equal(result.attempts[0]?.grade.passed, false);
  assert.equal(result.attempts[0]?.estimatedUsd, 0.2);
  assert.equal(result.stopped, failure);
});

test("invalid attempt limits fail before budget admission or execution", async () => {
  for (const maxAttempts of [0, 1.5, 6, Number.NaN]) {
    await assert.rejects(runExerciseAttempts({
      maxAttempts, prompt: "Solve exercise-a.",
      beforeAttempt: () => assert.fail("Invalid policy"),
      execute: async () => assert.fail("Invalid policy"),
      grade: async () => assert.fail("Invalid policy"),
    }), /integer from 1 through 5/);
  }
});

test("cumulative application repairs preserve earlier behavior without forbidding source changes", async () => {
  const result = await runExerciseAttempts({
    maxAttempts: 3,
    prompt: "Implement task-3 in src. Run node .benchmark-test.mjs task-3.",
    repairInstructions: "Edit only src files. Preserve earlier task behavior. Do not edit tests, configuration, or dependencies.",
    beforeAttempt: () => {},
    execute: async (prompt, attempt) => {
      if (attempt === 2) {
        assert.match(prompt, /task-3/);
        assert.match(prompt, /Preserve earlier task behavior/);
        assert.match(prompt, /task-1 regression/);
        assert.doesNotMatch(prompt, /previous exercises/);
      }
      return { receipt: attempt, estimatedUsd: attempt * 0.1 };
    },
    grade: async attempt => ({ passed: attempt === 2, log: "task-3 passes; task-1 regression failed" }),
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.grade.passed, false);
  assert.equal(result.attempts.at(-1)?.grade.passed, true);
});
