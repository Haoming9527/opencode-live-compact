import type { Candidate, EligibleResult } from "./eligibility.ts";
import { reduce } from "./reducer.ts";
import type { Cut, TokenEstimate } from "./reducer.ts";

export type { Candidate } from "./eligibility.ts";
export type { Cut } from "./reducer.ts";

/** Counts describe candidate alternatives examined in one maintenance cycle, not unique history. */
export interface PlanningDiagnostics {
  sizeValidCandidates: number;
  evaluatedBatches: number;
}

export const createPlanningDiagnostics = (): PlanningDiagnostics => ({ sizeValidCandidates: 0, evaluatedBatches: 0 });

export interface PlannerOptions {
  readonly minimumSourceTokens: number;
  readonly maxCutsPerCycle: number;
  readonly estimateTokens: TokenEstimate;
  readonly diagnostics?: PlanningDiagnostics;
  /** Parsed from this cycle's unchanged snapshot; never retained across awaits or turns. */
  readonly eligibleResults?: ReadonlyMap<Candidate, EligibleResult>;
}

export function recordPlanEvaluation(options: PlannerOptions): void {
  if (options.diagnostics) options.diagnostics.evaluatedBatches++;
}

export function scorePlan(saved: number, suffix: number): number {
  if (!Number.isFinite(saved) || saved <= 0 || !Number.isFinite(suffix) || suffix < 0) return -Infinity;
  return Math.max(Number.MIN_VALUE, saved / (1 + suffix / saved));
}

/** The controller supplies chronological, completed candidates after the last checkpoint. */
export function planCuts(candidates: readonly Candidate[], options: PlannerOptions): Cut[] {
  const limit = options.maxCutsPerCycle;
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  type Selection = { cut: Cut; next: Selection | undefined };
  const later: { head: Selection | undefined; saved: number }[] = [{ head: undefined, saved: 0 }];
  let best: Selection | undefined;
  let bestScore = 0;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const cut = reduce(candidate, options.estimateTokens, options.minimumSourceTokens, options.eligibleResults?.get(candidate));
    if (!cut) continue;
    if (options.diagnostics) options.diagnostics.sizeValidCandidates++;
    for (let size = Math.min(limit, later.length); size >= 1; size--) {
      const prior = later[size - 1];
      if (!prior) continue;
      const saved = prior.saved + cut.estimatedSavingsTokens;
      const selected: Selection = { cut, next: prior.head };
      const suffix = Math.max(0, cut.cacheSuffixTokens - prior.saved);
      const score = scorePlan(saved, suffix);
      recordPlanEvaluation(options);
      if (score > bestScore) {
        bestScore = score;
        best = selected;
      }
      if (!later[size] || saved > later[size]!.saved) later[size] = { head: selected, saved };
    }
  }
  const cuts: Cut[] = [];
  for (let selected = best; selected; selected = selected.next) cuts.push(selected.cut);
  let savingsAfter = 0;
  return cuts.toReversed().map(cut => {
    const selected = { ...cut, cacheSuffixTokens: Math.max(0, cut.cacheSuffixTokens - savingsAfter) };
    savingsAfter += cut.estimatedSavingsTokens;
    return selected;
  }).reverse();
}
