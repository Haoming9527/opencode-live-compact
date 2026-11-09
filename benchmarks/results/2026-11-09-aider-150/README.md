# Aider Polyglot 150 — updated plugin comparison

[Project overview](../../../README.md) · [Benchmark commands](../../README.md) · [Raw comparison](comparison.json) · [Detailed runner table](comparison-runner.md)

Completed **November 9, 2026, 18:01 SGT / 10:01 UTC**. The 11 raw completed-run artifacts downloaded from Daytona are unchanged; [manifest.json](manifest.json) records their source paths, byte counts, and SHA-256 hashes.

## Result

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Passed | **150/150** | **150/150** |
| Overall cache hit rate | 99.11% | **99.55%** |
| Cached input tokens | 260.58M | 268.55M |
| Non-cached input tokens | 2.327M | **1.222M** |
| Estimated API cost | $5.554 | **$5.384 · 3.1% lower** |
| Peak context | 783K | **695K** |
| Compaction | 1 pause · 12.27 s | **58 cuts · 3.97 s** |
| Wall-clock time | 4,785 s | **4,333 s** |

Both versions passed all 150 exercises on their first graded attempt, with zero failures and zero repair attempts. Combined estimated API cost was **$10.9378**. Live Compact cost **3.1% less**, with **67.7% less summed host compaction-event time** and **9.4% less wall-clock time** in this pair.

## Protocol and build provenance

- Stock OpenCode **2.2.6**, model **openai/gpt-6-luna**, one continuous session per version, stock compaction and output limits.
- Same 150 exercises and ordered prompts: the first 30 alphabetical exercises in each of Python, Go, JavaScript, Rust, and Java, interleaved by language. This is a selected Polyglot workload, not the entire upstream benchmark or an official leaderboard score.
- Fixture commit [7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f). [prompts.json](prompts.json) records the exact prompts and their fingerprint.
- Both versions ran concurrently in separate workspaces and profiles in Daytona. Only Live Compact enabled the plugin; no padded logs were added.
- Up to three graded attempts were allowed per exercise; every first graded attempt passed. Ordinary editing and self-tests within an attempt remain part of cost and time.
- Offline reference passed all 150 exercises. Candidate solutions were graded against pristine tests; the runner enabled supplied skipped tests.
- Source revision **d1b707c** used the 1,000-source-token floor, 256 MiB recovery cap, and corrected cache-suffix ranking. The [build metadata](plugin-build.json) was copied from the preceding React run's post-run hash verification of the same deployed checkout. It is reconstructed provenance, **not an independently captured Aider launch-time fingerprint**.

## Interpret the metrics

Original OpenCode compacted natively once at **javascript-queen-attack (exercise 133)**, taking **12.273 seconds**. Live Compact had no native compaction and made **58 cuts across 53 local replacement events**: **24 span cuts and 34 individual cuts**. Their host event durations summed to **3.965 seconds**.

Recorded local planning plus application took **3.952 seconds**. Application overlaps host event duration, while planning can precede it; these values must not be added together. Host event duration is not measured user-visible blocking. Timing telemetry is complete.

Cache hit rate is cached reads divided by all input, including cache writes. Non-cached input includes cache writes. Cached reads increased **260.58M → 268.55M**, while non-cached input decreased **2.327M → 1.222M**. Cache writes decreased **2,324,928 → 1,219,274**. Total input increased despite the lower peak context and cost. The versions made **759 → 788 known model requests**.

No recall calls occurred. Neither live recall nor resumption after treatment-side native compaction was exercised by this run; these have separate offline integration coverage.

Costs are OpenCode usage-based estimates, not provider invoices, and exclude sandbox charges. One pair does not isolate the effect of the cache fix from model variation or establish universal savings. Earlier results remain in Git history.

## Evidence and verification

[comparison.json](comparison.json) contains full results and usage; [progress.jsonl](progress.jsonl) contains pass/fail and cumulative cost per exercise. [benchmark.log](benchmark.log), [reference.tap](reference.tap), each version's result and grading log, and [plugin diagnostics](live-compact/plugin.jsonl) provide supporting records. Full model transcripts, credentials, and workspaces are not included.

Run without model calls:

```sh
node benchmarks/results/2026-11-09-aider-150/verify.mjs
```

The verifier checks raw-file hashes, result/progress consistency, cut counts and strategies, event durations, and the table above.
