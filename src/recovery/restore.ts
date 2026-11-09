import type { RecallLookup, RecoveryStore } from "./store.ts";

export const maxRecallCodePoints = 2_048;

export type RecallResult =
  | { readonly status: "ok"; readonly reference: string; readonly offset: number; readonly text: string; readonly nextOffset: number | null }
  | { readonly status: "invalid_range" }
  | { readonly status: "unavailable"; readonly reason: Extract<RecallLookup, { status: "unavailable" }>["reason"]; readonly action: "Re-read the original source or rerun the relevant tool; do not infer omitted details." };

export async function restore(
  store: Pick<RecoveryStore, "recall">,
  sessionID: string,
  reference: string,
  offset = 0,
  limit = maxRecallCodePoints,
): Promise<RecallResult> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    return { status: "invalid_range" };
  }

  const lookup = await store.recall(sessionID, reference).catch(() => ({ status: "unavailable", reason: "storage-unavailable" } as const));
  if (lookup.status === "unavailable") return { ...lookup, action: "Re-read the original source or rerun the relevant tool; do not infer omitted details." };
  const record = lookup.record;

  let codePoints = 0;
  let start = 0;
  let end = 0;
  const pageLength = Math.min(limit, maxRecallCodePoints);
  for (const point of record.original) {
    if (codePoints === offset) start = end;
    if (codePoints - offset === pageLength) {
      return { status: "ok", reference, offset, text: record.original.slice(start, end), nextOffset: codePoints };
    }
    codePoints++;
    end += point.length;
  }
  if (offset > codePoints) return { status: "invalid_range" };
  return {
    status: "ok",
    reference,
    offset,
    text: offset === codePoints ? "" : record.original.slice(start),
    nextOffset: null,
  };
}
