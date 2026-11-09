# Aider Polyglot 150 — recorded comparison

[Project overview](../../../README.md) · [Benchmark commands](../../README.md) · [Raw comparison](comparison.json)

Completed **November 9, 2026, 13:19 SGT / 05:19 UTC**. These files are the original completed-run artifacts downloaded from Daytona. Their byte counts, SHA-256 hashes, and source paths are recorded in [manifest.json](manifest.json).

## Result

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Passed | **150/150** | **150/150** |
| Overall cache hit rate | 99.49% | 99.34% |
| Cached input tokens | 296.35M | **266.75M** |
| Non-cached input tokens | 1.519M | 1.759M |
| Estimated API cost | $6.048 | **$5.302 · 12.3% lower** |
| Peak context | 783K | **591K** |
| Compaction | 1 pause · 16.30 s | **93 cuts · 5.93 s** |
| Wall-clock time | 5,106 s | **4,633 s** |

Both versions passed all 150 exercises on their first graded attempt, with zero failed exercises and zero repair attempts. Combined estimated API cost was **$11.3496**. Live Compact's summed host compaction-event duration was **63.6% lower** and its wall-clock time was **9.3% lower** in this pair.

## Protocol and tested version

- Stock OpenCode **2.2.6**, model **`openai/gpt-6-luna`**, one continuous session per version.
- Same 150 exercises in the same order: the first 30 alphabetical exercises in each of Python, Go, JavaScript, Rust, and Java, interleaved by language. This is a selected Polyglot workload, not the entire upstream benchmark or an official leaderboard score.
- Fixture commit [`7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f). Exact runner prompts and their fingerprint are in [prompts.json](prompts.json).
- Both versions ran concurrently in separate workspaces and profiles in the same Daytona sandbox. Stock native compaction and output limits stayed enabled. The plugin was enabled only for Live Compact; no padded logs were added.
- Up to three graded attempts were allowed per exercise. All exercises passed the first graded attempt; ordinary editing and self-testing within that attempt remain part of the workload.
- The reference passed all 150 exercises. Final grading used pristine tests and candidate solution files; supplied skipped tests were enabled by the runner.
- Frozen build fingerprint: `ffa372a43832ae3a01226a13135de645e07d32f014271ed8abae958d14cbac81`. The [build manifest](plugin-build.json) records the tested files and validation metadata.

**This run predates the current defaults.** It used the mixed-message span implementation, no eight-request profitability gate, a **1,000-net-token savings minimum**, and the earlier **64 MiB inline recovery archive**. The later 1,000-source-token policy and 256 MiB per-session recovery files are not evaluated by these results.

## Read the numbers correctly

| Displayed metric | Source / calculation |
| --- | --- |
| Passed | `grade.passed / stagesExpected` |
| Overall cache hit rate | `usage.cachedReadTokens / usage.totalInputTokens` |
| Cached input tokens | `usage.cachedReadTokens` |
| Non-cached input tokens | `usage.uncachedInputTokens + usage.cacheWriteTokens` |
| Estimated API cost | `usage.costEstimateUsd`, from recorded usage and OpenCode model rates |
| Peak context | `usage.peakActiveContextTokens` |
| Compaction | Native pause count or incremental cut count, followed by `usage.hostCompactionWaitMs` |
| Wall-clock time | `wallSeconds` |

`M` means one million tokens; `K` means one thousand. Displayed values are rounded; the JSON retains the full precision. Internal raw labels `control` and `plugin` correspond to **Original OpenCode** and **Live Compact**.

Original OpenCode had **one automatic native compaction**, at `javascript-rational-numbers` (exercise 138), taking **16.301 seconds**. Live Compact had **zero native compactions** and **93 cuts grouped into 81 replacement events**: 21 span cuts and 72 individual cuts. Those local host events took **5.928 seconds** in total. Timing telemetry is complete for both versions.

Local planning/application time was **6.304 seconds**. It overlaps host-event timing in part, so it must not be added wholesale to the 5.928 seconds. The compact table reports summed host compaction-event duration for both versions; planning outside host events is excluded. These event intervals do not measure user-visible blocking. The historical `*WaitMs` JSON field names are retained unchanged.

No recall calls occurred in this pair. Exact recovery and operation after native compaction have separate offline integration coverage; this workload does not establish either through live recall or treatment-side native compaction.

Costs are usage-based estimates, not provider billing receipts, and exclude sandbox charges and other runs. Cache writes increased from **1,516,440** to **1,756,658** despite lower total cost. This is one paired sample: it does not isolate all causes of the wall-clock difference or establish savings across providers and tasks.

## Evidence files

| File | Contents |
| --- | --- |
| [comparison.json](comparison.json) | Complete paired results, usage, timing, grade outcomes, and per-exercise attempt receipts |
| [comparison-runner.md](comparison-runner.md) | Original table emitted by the runner |
| [progress.jsonl](progress.jsonl) | Per-exercise pass/fail counts and cumulative estimated cost on each line |
| [benchmark.log](benchmark.log) | Runner stage progression and completion summary |
| [plugin-build.json](plugin-build.json) | Frozen tested-build fingerprint and file hashes |
| [prompts.json](prompts.json) | Ordered task prompts and their fingerprint |
| [reference.tap](reference.tap) | Reference acceptance-test output |
| [original-opencode/result.json](original-opencode/result.json) | Original OpenCode's complete result |
| [original-opencode/grade.tap](original-opencode/grade.tap) | Original OpenCode's independent grading log |
| [live-compact/result.json](live-compact/result.json) | Live Compact's complete result |
| [live-compact/grade.tap](live-compact/grade.tap) | Live Compact's independent grading log |
| [live-compact/plugin.jsonl](live-compact/plugin.jsonl) | Planning decisions, applied cuts, strategies, timing, and recall metrics |

The downloaded files are unchanged; a credential scan passed before they were added. Historical sandbox paths in logs are provenance, not paths you must recreate. Workspace checkouts, credentials, and full model transcripts are not part of this bundle.

## Verify without model calls

From the repository root:

```sh
node benchmarks/results/2026-11-09-aider-150/verify.mjs
```

This checks every downloaded file's hash, validates the result/progress/cut totals, and prints the eight-row evidence table above. To run a new paid comparison, use the [benchmark instructions](../../README.md); the current source uses the newer policy described above.
