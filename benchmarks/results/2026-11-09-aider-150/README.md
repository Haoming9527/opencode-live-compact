# Aider Polyglot 150 — fixed-preview comparison

[Project overview](../../../README.md) · [Benchmark commands](../../README.md) · [Raw comparison](comparison.json) · [Detailed runner table](comparison-runner.md)

Completed **November 9, 2026, 19:53 SGT / 11:53 UTC**. The 12 downloaded artifacts, including the pre-launch build fingerprint, are unchanged; [manifest.json](manifest.json) records their source paths, byte counts, and SHA-256 hashes.

## Result

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Passed | **150/150** | **150/150** |
| Overall cache hit rate | 99.24% | **99.56%** |
| Cached input tokens | 302.39M | **265.96M** |
| Non-cached input tokens | 2.330M | **1.170M** |
| Estimated API cost | $6.295 | **$5.397 · 14.3% lower** |
| Peak context | 783K | **762K** |
| Compaction | 1 pause · 15.11 s | **37 cuts · 2.51 s** |
| Wall-clock time | 5,526 s | **3,637 s** |

Both versions finished all 150 exercises with zero final failures. Original OpenCode passed **149/150 on the first graded attempt** and repaired **javascript-palindrome-products** once; Live Compact passed **150/150 first attempts**, with no repairs. Costs and time include the repair.

Combined estimated API cost was **$11.6923**, within the fresh $15 combined budget. Live Compact cost **14.3% less**, with **83.4% less summed host compaction-event time** and **34.2% less wall-clock time** in this pair.

## Protocol and build provenance

- Stock OpenCode **2.2.6**, model **openai/gpt-6-luna**, one continuous session per version, stock compaction and output limits.
- Same 150 exercises and ordered prompts: the first 30 alphabetical exercises in each of Python, Go, JavaScript, Rust, and Java, interleaved by language. This is a selected Polyglot workload, not the entire upstream benchmark or an official leaderboard score.
- Fixture commit [7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f). [prompts.json](prompts.json) records the exact prompts and their fingerprint.
- Both versions ran concurrently in separate workspaces and profiles in Daytona. Only Live Compact enabled the plugin; no padded logs were added.
- Up to three graded attempts were allowed per exercise. Ordinary editing and self-tests within an attempt remain part of cost and time.
- Offline reference passed all 150 exercises. Candidate solutions were graded against pristine tests; the runner enabled supplied skipped tests.
- Source revision **b435cb88ddf5a35cb63785ba8ff5a2fff37acdd8** includes the bounded adaptive-preview fix, the 1,000-source-token floor, 256 MiB recovery cap, and corrected cache-suffix ranking. [plugin-build.json](plugin-build.json) fingerprints source, compiled plugin, and runner files **before launch**, at **18:19:34 SGT / 10:19:34 UTC**. The React comparison uses the earlier **d1b707c** revision.

## Interpret the metrics

Original OpenCode compacted natively once at **java-pov (exercise 130)**, taking **15.106 seconds**. Live Compact had no native compaction and made **37 cuts across 35 local replacement events**: **27 span cuts and 10 individual cuts**. Their host event durations summed to **2.505 seconds**.

Recorded local planning plus application took **2.666 seconds**. Application overlaps host event duration, while planning can precede it; these values must not be added together. Host event duration is not measured user-visible blocking. Timing telemetry is complete.

Cache hit rate is cached reads divided by all input, including cache writes. Non-cached input includes cache writes. Cached reads decreased **302.39M → 265.96M**, and non-cached input decreased **2.330M → 1.170M**. Cache writes decreased **2,326,917 → 1,168,423**. The versions made **888 → 691 known model requests**.

Peak context decreased only **2.7%**, while mean request context **increased from 342,650 to 386,588 tokens**. This run does not show lower context on every measure. It also made fewer cuts than the preceding 58-cut run, so it does not establish that the preview fix increased cut frequency.

No recall calls occurred. Neither live recall nor resumption after treatment-side native compaction was exercised by this run; these have separate offline integration coverage.

Costs are OpenCode usage-based estimates, not provider invoices, and exclude sandbox charges. One pair, different model trajectories, and the original version's repair prevent attributing the full cost or wall-time difference to the preview fix. Earlier results remain in Git history.

## Evidence and verification

[comparison.json](comparison.json) contains full results and usage; [progress.jsonl](progress.jsonl) contains pass/fail and cumulative cost per exercise. [benchmark.log](benchmark.log), [reference.tap](reference.tap), each version's result and grading log, and [plugin diagnostics](live-compact/plugin.jsonl) provide supporting records. Full model transcripts, credentials, and workspaces are not included.

Run without model calls:

```sh
node benchmarks/results/2026-11-09-aider-150/verify.mjs
```

The verifier checks raw-file hashes, result/progress consistency, attempts, cut counts and strategies, event durations, and the table above.
