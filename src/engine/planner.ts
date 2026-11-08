import type { Candidate } from "./eligibility.ts";
import { reduce } from "./reducer.ts";
import type { Cut, TokenEstimate } from "./reducer.ts";

export type { Candidate } from "./eligibility.ts";
export type { Cut } from "./reducer.ts";

export interface PlannerOptions {
  readonly minimumSavingsTokens: number;
  readonly maxCutsPerCycle: number;
  readonly estimateTokens: TokenEstimate;
  /** Planning weight for the retained suffix rebuilt by the earliest cut in a batch. */
  readonly cacheRebuildWeight?: number;
}

/** The controller supplies chronological, completed candidates after the last checkpoint. */
export function planCuts(candidates: readonly Candidate[], options: PlannerOptions): Cut[] {
  const cuts: Cut[] = [];
  let bestSize = 0;
  let bestScore = -Infinity;
  let savingsAfter = 0;
  const rebuildWeight = options.cacheRebuildWeight ?? 0.25;
  for (let index = candidates.length - 1; index >= 0 && cuts.length < options.maxCutsPerCycle; index--) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const cut = reduce(candidate, options.estimateTokens, options.minimumSavingsTokens);
    if (!cut) continue;
    // Later cuts make the invalidated suffix smaller. Charge for that suffix once per batch.
    const cacheSuffixTokens = Math.max(0, cut.cacheSuffixTokens - savingsAfter);
    savingsAfter += cut.estimatedSavingsTokens;
    cuts.push({ ...cut, cacheSuffixTokens });
    const score = savingsAfter - cacheSuffixTokens * rebuildWeight;
    if (score > bestScore) {
      bestScore = score;
      bestSize = cuts.length;
    }
  }
  return cuts.slice(0, bestSize).reverse();
}
