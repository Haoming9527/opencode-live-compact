# Web-Bench React 20 — recorded comparison

[Project overview](../../../README.md) · [Benchmark commands](../../README.md) · [Raw comparison](comparison.json)

Completed **November 9, 2026, 13:44 SGT / 05:44 UTC**. This bundle contains the unchanged completed-run artifacts from Daytona. [manifest.json](manifest.json) records their source paths, byte counts, and SHA-256 hashes.

## Result

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Stages passed | **20/20** | **20/20** |
| Overall cache hit rate | 97.96% | 88.73% |
| Cached input tokens | 9.177M | **4.473M** |
| Non-cached input tokens | 191.367K | 568.339K |
| Estimated API cost | $0.1549 | **$0.1501 · 3.1% lower** |
| Peak context | 191K | **112K** |
| Compaction | 0 pauses · 0 s | **14 cuts · 0.44 s** |
| Wall-clock time | 1,346 s | **1,240 s** |

Both ended with **59/59 cumulative browser tests passing**, zero failed stages, and zero skipped tests. Original OpenCode passed **19/20 stages on the first graded attempt** and repaired task 16 once; Live Compact passed **20/20 first attempts**, with no repairs. Costs and wall time include that repair.

**Native pause benefit is inconclusive:** neither version reached native compaction. Original OpenCode recorded no compaction events; Live Compact's 12 local replacement-event durations sum to **435 milliseconds** (14–175 ms each; median 22.5 ms). This is host event elapsed time, not measured user-visible waiting. This run demonstrates a smaller context and 3.1% lower estimated cost in one pair, not fewer native pauses. Combined estimated cost was **$0.3050**.

## Protocol and tested version

- Stock OpenCode **2.2.6**, model **`openai/gpt-6-luna`**, one continuous session per version, stock native compaction and output limits. Both ran concurrently in separate workspaces and profiles in the same Daytona sandbox, with no padded logs.
- One React project with **20 sequentially dependent tasks**, from Web-Bench commit [`7b31ca2b786eef120dd49ce63dd03d0c0006046d`](https://github.com/bytedance/web-bench/tree/7b31ca2b786eef120dd49ce63dd03d0c0006046d/projects/react). Both received the same ordered [prompts](prompts.json).
- Up to **three graded attempts per stage**. Each attempt was graded in a fresh copy using candidate application source and pristine cumulative tests. Ordinary edits and self-tests within an attempt are included. This is an adapted benchmark, not an official leaderboard score.
- [Offline preflight](preflight.json): starter rejected (**0/4**), reference passed **59/59 twice**, deliberately broken reference rejected (**0/4**). Runtime and fixture hashes are included; Playwright used one worker and no retries.
- Frozen build: **`ffa372a43832ae3a01226a13135de645e07d32f014271ed8abae958d14cbac81`**, also used for the [Aider comparison](../2026-11-09-aider-150/README.md). The [build manifest](plugin-build.json) records the tested files and validation metadata.

**This run predates the current defaults.** It used mixed-message span compaction, no eight-request profitability gate, a **1,000-net-token savings minimum**, and the earlier **64 MiB inline recovery archive**. It does not evaluate the later 1,000-source-token rule or 256 MiB per-session recovery files.

## Metric notes

Cache hit rate is `cachedReadTokens / totalInputTokens`; non-cached input includes cache writes. `M` means one million tokens and `K` means one thousand. Cache writes increased from **191,025** to **568,051** despite lower total cost. Mean active request context fell from **82,183** to **52,517** tokens; peak context is the largest recorded model request, not the ending transcript size.

All **14 cuts were span cuts**, grouped into **12 host replacement events**. The displayed compaction time is the sum of host event durations (historically named `usage.hostCompactionWaitMs`); local planning/application took 0.439 seconds and overlaps that time, so it is not added again. Timing telemetry is complete. Neither version made a recall call, and neither demonstrates resumption after native compaction in this live run.

Costs come from OpenCode's recorded usage and model rates, not billing receipts; they exclude sandbox fees and other runs. The pair used **114 vs 96 known model requests**. Wall time was **7.9% lower**, but one paired run and different repair paths cannot establish a general speed or quality advantage.

## Evidence files

| File | Contents |
| --- | --- |
| [comparison.json](comparison.json) | Complete paired results, usage, timing, stage outcomes, and attempt receipts |
| [comparison-runner.md](comparison-runner.md) | Original detailed tables emitted by the runner |
| [progress.jsonl](progress.jsonl) | Stage pass/fail counts and cumulative estimated cost; repair event |
| [benchmark.log](benchmark.log) | Stage progression and completion summary |
| [plugin-build.json](plugin-build.json) | Frozen tested-build fingerprint and file hashes |
| [prompts.json](prompts.json) | Ordered task prompts and their fingerprint |
| [preflight.json](preflight.json) | Starter/reference/mutation checks, logs, and environment hashes |
| [Original result](original-opencode/result.json) · [grading log](original-opencode/grade.tap) | Original OpenCode's result and each stage's final graded attempt |
| [Live Compact result](live-compact/result.json) · [grading log](live-compact/grade.tap) | Live Compact's result and each stage's final graded attempt |
| [live-compact/plugin.jsonl](live-compact/plugin.jsonl) | Planning decisions, applied cuts, timing, and recall metrics |

Historical sandbox paths are provenance, not directories you must recreate. Credentials, full model transcripts, and workspace checkouts are not included.

## Verify without model calls

From the repository root:

```sh
node benchmarks/results/2026-11-09-webbench-react-20/verify.mjs
```

This verifies downloaded-file hashes, preflight, ordered stage outcomes, repairs, final tests, progress, cuts, and the evidence table. To run a new comparison, follow the [benchmark instructions](../../README.md).
