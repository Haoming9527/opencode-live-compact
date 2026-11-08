# OpenCode Live Compact

Live Compact saves a smaller OpenCode context window after a successful turn. It shortens eligible tool results, protects recent tool rounds, and preserves the prefix before each cut. The source results remain in OpenCode history and can be recovered by reference.

The plugin uses the [OpenCode V2 server SDK](https://opencode.ai/docs/build/plugins/server) and targets stock OpenCode 2.2.6. Local reductions use deterministic rules and make no summarization requests.

## Installation

The intended npm installation command once the package is released is:

```sh
opencode plugin add opencode-live-compact
```

For local development, run `npm ci` and `npm run build` in the plugin checkout. Add the absolute path to that directory under `plugins` in the project's `opencode.jsonc`.

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-live-compact",
      "options": {
        "minimumContextTokens": 20000,
        "minimumSavingsTokens": 1000,
        "protectedToolRounds": 3,
        "maxCutsPerCycle": 3
      }
    }
  ]
}
```

## How it works

1. OpenCode's idle hook signals successful completion with no pending inputs. The plugin checks the completed tool states and skips work when background jobs are still running. The active turn and the latest three completed tool rounds stay intact by default.
2. The planner considers completed history after the last visible checkpoint. Eligible content includes older assistant prose, stock reads, file listings, searches, and verified successful foreground shell output. Each candidate contains at most 32,000 estimated source tokens and must save at least 1,000 estimated tokens by default. The planner chooses up to three cuts, discounting estimated savings by the retained suffix that may need to be cached again. It counts that suffix once per batch. When adjacent completed results can safely be grouped, Live Compact replaces their span with one checkpoint and archives the original model-visible messages. Otherwise it shortens individual results and keeps their call/result pairs. Each checkpoint fits within 8,000 Unicode code points and keeps verbatim excerpts around one omitted span.
3. The plugin archives the originals before queuing a local compaction. Its compaction hook verifies the queued item and prefix, then returns the replacement window to OpenCode. The host persists it and uses it to size later requests. [OpenCode compaction hook](https://opencode.ai/docs/build/plugins/server#hooks)
4. OpenCode replays the saved window on the same provider and model. On a model switch, the host falls back to the original history. Stock compaction stays enabled, and later successful turns can create new replacement windows.

Use `live_compact_recall` in the source session with the reference and an optional Unicode code point offset. Each page contains up to 2,048 code points and a continuation offset. A span reference returns the exact serialized OpenCode messages, including the original call IDs and results. A fork can inherit a checkpoint, but its reference remains scoped to the source session.

OpenCode records each local replacement as a compaction event and stores the full active window for that event. The benchmark separates these events from stock compaction and counts their wait time too. Compatibility was verified with stock compaction defaults.

User messages, system instructions, provider-bound reasoning, recent assistant responses, diagnostics, and active or interrupted work stay intact. Cuts use a local byte-based token estimate. Actual prompt-cache reuse and billing depend on the provider and workload.

## Configuration

| Option | Default | Effect |
| --- | ---: | --- |
| `minimumContextTokens` | 20,000 | Start evaluating cuts at this completed-turn token usage. Use a local estimate when provider usage is unavailable. |
| `minimumSavingsTokens` | 1,000 | Minimum estimated net tokens removed per result. |
| `protectedToolRounds` | 3 | Number of most recent completed tool rounds to keep. |
| `maxCutsPerCycle` | 3 | Maximum cuts evaluated for a successful turn. |
| `archiveDirectory` | OS-local state directory | Optional absolute directory for the private archive. |
| `archiveMaxBytes` | 64 MiB | Combined limit on stored archive records, excluding SQLite overhead. |
| `archiveMaxRecords` | 4,096 | Maximum number of archive records. |
| `archiveRetentionMs` | 7 days | Grace period for records retired after history reconciliation. |
| `compactSpans` | `true` | Group adjacent eligible completed results or prose into a checkpoint without crossing a user message, protected content, or an existing checkpoint. |
| `strictCacheBudget` | `false` | Require estimated token savings to exceed the retained suffix that may need to be cached again. |
| `dryRun` | `false` | Evaluate cuts without changing requests or saving new cuts. |
| `diagnostics` | `false` | Emit cut, context, and recall measurements without transcript content. |
| `metricsFile` | stderr | Optional absolute JSON Lines destination for diagnostics. |

The archive holds local copies of eligible output and uses owner-only permissions. It uses `$XDG_STATE_HOME/opencode-live-compact` when set. Otherwise it uses `%LOCALAPPDATA%/opencode-live-compact` on Windows and `~/.local/state/opencode-live-compact` elsewhere. Live checkpoints are retained. If the store is unavailable or full, the plugin sends the original result.

## Verification

```sh
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

The stock integration test needs OpenCode 2.2.6 on PATH and uses a local scripted provider. The [benchmark runner](benchmarks/) separates offline harness checks from metered paired trials. A smaller request is evidence of reduced context pressure. Cost, cache reuse, native compaction wait, and task correctness are measured separately.

Inspired by the design of [DSH Live Compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact#readme). 

Licensed under the [MIT License](LICENSE).
