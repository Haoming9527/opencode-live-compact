import { hashText, recoveryReference } from "../recovery/integrity.ts";
import type { RecoveryIdentity } from "../recovery/integrity.ts";
import { buildCheckpoint } from "./checkpoint.ts";
import { eligibleResult } from "./eligibility.ts";
import type { Candidate } from "./eligibility.ts";

export interface Cut {
  readonly identity: RecoveryIdentity;
  readonly sourceHash: string;
  readonly sourceText: string;
  readonly replacement: string;
  readonly reference: string;
  readonly estimatedSavingsTokens: number;
  readonly cacheSuffixTokens: number;
}

export type TokenEstimate = (text: string) => number;
const maximumSourceTokens = 32_000;

export function reduce(candidate: Candidate, estimateTokens: TokenEstimate, minimumSavingsTokens: number): Cut | undefined {
  const result = eligibleResult(candidate);
  if (!result) return;
  const sourceTokens = estimateTokens(result.sourceText);
  if (!Number.isFinite(sourceTokens) || sourceTokens > maximumSourceTokens || sourceTokens < minimumSavingsTokens) return;
  const sourceHash = hashText(result.sourceText);
  const reference = recoveryReference(candidate.identity, sourceHash);
  const checkpoint = buildCheckpoint(result, reference);
  if (!checkpoint) return;
  const { replacement, changedTail } = checkpoint;
  if (Buffer.byteLength(JSON.stringify(replacement)) >= Buffer.byteLength(JSON.stringify(result.sourceText))) return;
  const estimatedSavingsTokens = sourceTokens - estimateTokens(replacement);
  if (!Number.isFinite(estimatedSavingsTokens) || estimatedSavingsTokens <= 0 || estimatedSavingsTokens < minimumSavingsTokens) return;
  const cacheSuffixTokens = (candidate.suffixTokens ?? 0) + estimateTokens(changedTail);
  if (!Number.isFinite(cacheSuffixTokens) || cacheSuffixTokens < 0) return;
  return {
    identity: candidate.identity,
    sourceHash,
    sourceText: result.sourceText,
    replacement,
    reference,
    estimatedSavingsTokens,
    cacheSuffixTokens,
  };
}

