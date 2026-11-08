import type { RecoveryStore } from "./store.ts";

export const maxRecallCodePoints = 2_048;

export type RecallResult =
  | { readonly status: "ok"; readonly reference: string; readonly offset: number; readonly text: string; readonly nextOffset: number | null }
  | { readonly status: "unavailable" | "invalid_range" };

export async function restore(
  store: Pick<RecoveryStore, "get">,
  sessionID: string,
  reference: string,
  offset = 0,
  limit = maxRecallCodePoints,
): Promise<RecallResult> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    return { status: "invalid_range" };
  }

  const record = await store.get(sessionID, reference).catch(() => undefined);
  if (!record) return { status: "unavailable" };

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
