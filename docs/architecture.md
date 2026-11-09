# Architecture and configuration

[Back to the project overview](../README.md)

## How it works

1. OpenCode's idle hook signals successful completion with no pending inputs. The plugin checks the completed tool states and skips work when background jobs are still running. The active turn and the latest three completed tool rounds stay intact by default.
2. The planner considers completed history after the last visible checkpoint. Eligible content includes older assistant prose, stock reads, file listings, searches, and verified successful foreground shell output. Each cut must contain at least 1,000 estimated tokens of source text selected for shortening by default; a span can combine several smaller entries. Preserved reasoning, tool-call arguments, and unchanged results do not count toward that minimum. Ordinary cuts contain at most 32,000 estimated source tokens. Every changed entry must reduce both estimated tokens and serialized size, including its checkpoint and recall reference; saving fewer than 1,000 tokens is allowed. It compares batches of up to three completed spans or individual results. Each span stays within completed work and user/checkpoint boundaries. Shortened entries share an archive reference, with their replacement text bounded by an 8,000-code-point budget per span.
3. The planner ranks useful batches by estimated tokens saved, discounted by the retained suffix after the earliest cut: `saved / (1 + suffix / saved)`. This favors larger reductions and shorter suffixes without rejecting a useful cut because of cache prices. It is a selection heuristic, not a cost estimate. Originals are preserved together in one durable transaction before queuing a local compaction. The compaction hook rechecks the queued item, original contents, and prefix, then constructs the replacement window by copying only changed messages. The host persists it and uses it to size later requests. [OpenCode compaction hook](https://opencode.ai/docs/build/plugins/server#hooks)
4. OpenCode replays the saved window on the same provider and model. On a model switch, the host falls back to the original history. Stock compaction stays enabled, and later successful turns can create new replacement windows.

Use `live_compact_recall` in the source session with the reference and an optional Unicode code point offset. Each page contains up to 2,048 code points and a continuation offset. A span reference returns the exact serialized OpenCode messages, including the original call IDs and results. A fork can inherit a checkpoint, but its reference remains scoped to the source session.

Span cuts preserve OpenCode's mixed messages in place. Reasoning, tool calls, their arguments, result IDs, and message order remain unchanged; only eligible result text or eligible older assistant text is shortened. Unsupported results in a parallel tool round stay intact. The archive stores the exact original span and a validated replacement recipe, so replay after a restart applies the same edits. Preserved reasoning and tool-call tokens are excluded from estimated savings.

OpenCode records each local replacement as a compaction event and stores the full active window for that event. The benchmark separates these events from stock compaction and records their start-to-end durations. These intervals do not directly measure user-visible waiting: planning can occur before an event, while application overlaps it. A full-context replay is local maintenance, not another cut or a native summary. Compatibility was verified with stock compaction defaults.

User messages, system instructions, provider-bound reasoning, recent assistant responses, diagnostics, and active or interrupted work stay intact. Cuts use a local byte-based token estimate. Actual prompt-cache reuse and billing depend on the provider and workload.

An otherwise eligible tool result above 32,000 estimated tokens can use a small recovery pointer instead of an excerpt. Its exact header, truncation notice, and observed status remain. This exception never applies to assistant prose. The full original must fit the archive's 512 KiB per-record limit and be stored successfully; otherwise it stays visible.

## Configuration

| Option | Default | Effect |
| --- | ---: | --- |
| `minimumContextTokens` | 20,000 | Start evaluating cuts at this completed-turn token usage. Use a local estimate when provider usage is unavailable. |
| `minimumSourceTokens` | 1,000 | Minimum estimated source tokens selected for shortening in one result or completed span. Every replacement must still be strictly smaller. |
| `protectedToolRounds` | 3 | Number of most recent completed tool rounds to keep. |
| `maxCutsPerCycle` | 3 | Maximum completed spans or individual results replaced in one successful-turn maintenance cycle. |
| `archiveDirectory` | OS-local state directory | Optional absolute directory for the private archive. |
| `archiveMaxBytes` | 256 MiB | Combined limit across all session archives, excluding SQLite overhead. Before a write would exceed it, remove the oldest retired records toward 80% usage. |
| `archiveMaxRecords` | 4,096 | Maximum number of archive records. |
| `archiveRetentionMs` | 7 days | Normal grace period for retired records. Capacity pressure can remove them sooner; active checkpoints stay protected. |
| `compactSpans` | `true` | Group adjacent eligible completed results or prose into a checkpoint without crossing a user message, protected content, or an existing checkpoint. |
| `dryRun` | `false` | Evaluate cuts without changing requests or saving new cuts. |
| `diagnostics` | `false` | Emit planning reasons, candidate counts, selected span or individual strategy, separate planning/application durations, cuts, and recall measurements without transcript content. |
| `metricsFile` | stderr | Optional absolute JSON Lines destination for diagnostics. |

The archive holds local copies of eligible output and uses owner-only permissions. It uses `$XDG_STATE_HOME/opencode-live-compact` when set. Otherwise it uses `%LOCALAPPDATA%/opencode-live-compact` on Windows and `~/.local/state/opencode-live-compact` elsewhere. Recovery files live under `recovery-v1/sessions/session-<session-hash>/<reference>.json`; the session hash prevents unsafe paths and name collisions. A shared SQLite catalog tracks integrity, references, and the total budget. Existing inline backups migrate without changing recall references.

Before a write would exceed the global 256 MiB cap, cleanup removes the oldest retired records first and aims to leave usage at or below 80%, including the incoming batch. Normal cleanup also removes retired records after their retention period. Active checkpoints and references being preserved in the current batch are never evicted. A stopped process alone does not make an OpenCode session's backups disposable. If protected records leave insufficient room, or preservation fails, the plugin keeps the full original context.

When handling a queued replacement, the plugin retries a failed pending-plan or history read once. If both attempts fail, OpenCode 2.2.6's compaction hook does not provide enough identity information to safely distinguish plugin maintenance from native compaction. The plugin reports `compaction-ownership-unavailable` and leaves the host in control; a model summary remains possible on this error path. Once ownership is confirmed, an unavailable archive produces a full local replay without a summary request.

The plugin measures the request once at idle instead of scanning its complete text for every context-hook diagnostic. Both planners reuse the same parsed eligible outputs within that synchronous planning cycle; the cache is cleared before asynchronous admission and is never reused across turns. Span processing checks message/call/result identities across the complete history, but parses detailed blocks only for candidate or verified archived spans. Span application also avoids building an unused individual-result index.

Queued application still rereads authoritative history and durable backups and verifies their hashes, tool pairs, and unchanged prefix. Recovery reads for a bounded cut batch share one catalog transaction; every payload is still checked afresh. A single filesystem stat validates the recovery root's type, permissions, and identity together. These optimizations do not change selection rules or skip preservation checks. Planning needs no model-price lookup. The stock host still serializes and persists each replacement window; local processing cannot have zero cost.

The span planner evaluates smaller contiguous alternatives as well as larger spans, then selects nonoverlapping cuts under the same safety and size limits. The cache-suffix estimate starts at the first edited part, excluding preserved reasoning and calls before it while including retained parts after it, even within the same message. This keeps span and individual cut ranking consistent; the estimate is not a measurement of the provider's cache. Replacement windows retain the evidence for all unchanged eligible tool rounds after the last cut, so later turns can still reduce them while preserving recent-round protection.

Planning diagnostics include the context size, eligible candidate counts, and the number of size-valid candidates and batches evaluated. `insufficient-savings` means neither planning route found a useful cut. Estimated savings and retained suffix size are reported for applied replacements; actual API savings still require a paired benchmark.

