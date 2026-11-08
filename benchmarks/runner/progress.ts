import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

type ExerciseGrade = { id: string; passed: boolean };

export async function logGrades(file: string, arm: string, grades: readonly ExerciseGrade[],
  previous: readonly ExerciseGrade[], trial: number, estimatedUsd: number, expected: number) {
  let total = previous.length;
  let passed = previous.filter(grade => grade.passed).length;
  const lines = grades.map(grade => {
    total++;
    passed += Number(grade.passed);
    return JSON.stringify({ event: "exercise-graded", arm, trial, stage: grade.id, outcome: grade.passed ? "pass" : "fail",
      source: "final", estimatedUsd, expected, graded: total, passed, failed: total - passed, passRate: passed / total, failRate: (total - passed) / total,
      time: new Date().toISOString() });
  });
  if (lines.length) await appendFile(file, lines.join("\n") + "\n", { mode: 0o600 });
}

interface ProgressEvent {
  event: string;
  arm: string;
  trial: number;
  stage: string;
  completed?: number;
  expected?: number;
  estimatedUsd?: number;
  graded?: number;
  passed?: number;
  failed?: number;
  outcome?: string;
}

export async function formatProgress() {
  const costs = new Map<string, Pick<ProgressEvent, "estimatedUsd" | "expected">>();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as ProgressEvent;
    const arm = `${entry.trial}/${entry.arm}`;
    if (entry.event === "stage-started") {
      costs.set(`${arm}/${entry.completed}`, { estimatedUsd: entry.estimatedUsd, expected: entry.expected });
    }
    if (entry.event !== "exercise-graded") continue;
    // Older runs recorded the post-exercise total at the start of the next exercise.
    const legacy = costs.get(`${arm}/${entry.graded}`);
    const cost = entry.estimatedUsd ?? legacy?.estimatedUsd;
    const expected = entry.expected ?? legacy?.expected;
    const label = entry.arm === "control" ? "Stock OpenCode" : "Live Compact";
    const count = expected === undefined ? entry.graded : `${entry.graded}/${expected}`;
    const total = cost === undefined ? "cost pending" : `$${cost.toFixed(4)} estimated total`;
    process.stdout.write(`${label} | ${count} | ${entry.stage} ${entry.outcome?.toUpperCase()} | ${entry.passed} passed, ${entry.failed} failed | ${total}\n`);
  }
}
