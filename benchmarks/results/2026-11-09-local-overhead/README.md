# Local overhead comparison

This measures the **previous plugin versus the optimized plugin**, not Original OpenCode versus Live Compact. It is an offline diagnostic using real recovery-file IO and identical completed-turn input. OpenCode history, storage, and queue APIs are represented by in-memory stand-ins; no model is called.

## Final measurements

| Platform | Previous median | Updated median | Previous p95 | Updated p95 |
| --- | ---: | ---: | ---: | ---: |
| Daytona Linux, Node 24.22.1 | 11.210 ms | 10.807 ms | 12.603 ms | 11.918 ms |
| Windows, Node 26.12.1 | 75.254 ms | 73.672 ms | 87.572 ms | 92.670 ms |

Linux's median was **3.6% lower** in this diagnostic, a small observed reduction. Windows' median was 2.1% lower but its tail was worse; a Windows latency benefit is inconclusive. These timings do not establish a general speedup, reduced model cost, or reduced user-visible waiting.

Both platforms produced **exactly the same replacement messages and decision metadata** as the previous implementation: 2 span cuts, 32,848 estimated tokens saved, and 2 verified backups containing 147,960 original bytes. The original Web-Bench's **435 ms of host compaction-event time is unchanged**; this experiment does not measure the host's scheduling, serialization, or persistence.

## Protocol

- Baseline: source from commit `6348a6c`, before the overhead changes.
- 17 distinct real TypeScript source-file reads, with no padding or duplicated source. The resulting context is 36,375 estimated tokens; the latest three rounds remain protected.
- 16 measured trials per version, alternating execution order, plus two warmup pairs. Every sample uses a fresh isolated archive and the same session identity.
- Archive/catalog initialization, diagnostic flush, and result validation occur outside the timer. The timer includes idle planning, durable preservation, queued-hook application, and fresh recovery reads. It excludes real host API/queue latency.
- Reference inputs are fixed to the baseline source snapshot. Both final reports share fixture SHA-256 `df02e6e91f3af827ba2f9df27d62c44dbdd55d15def15321d5c834948e5c48ba` and output SHA-256 `6aaad14e6a2ef32c5e35a771dfd0be3b3029524b0007bb37b009a0960a25035e`.
- The updated source fingerprint is `76ff83f78802c777ee6b40e00dbb96250f7e3d385900a793b6014342eca7e0f3`. Each report includes per-file fingerprints and every timing sample.

The changes reuse parsed eligibility only within synchronous planning, restrict detailed span inspection while retaining global identity checks, remove an unused span index, batch recovery reads under one transaction, and avoid duplicate root stats. Backup durability, integrity, session isolation, and cut-selection rules stay intact.

## Evidence

| File | Purpose |
| --- | --- |
| [windows-baseline-check.json](windows-baseline-check.json) | Baseline-versus-baseline harness check |
| [windows-scans.json](windows-scans.json) | Initial parsing/scan optimization: no measured overall improvement |
| [windows-profile.json](windows-profile.json) | Recovery IO attribution used to select the second optimization |
| [windows-final.json](windows-final.json) | Final Windows comparison, including its worse p95 |
| [linux-final.json](linux-final.json) | Final comparison in the existing Daytona sandbox |

Compare versions **within each report**. Conditions varied between runs; the initial Windows result and final Windows result must not be compared as if they were a controlled pair. Retrieval intervals are combined as a union so overlapping Promise-based reads are not double-counted. Profiling includes real disk reads, hashes, path checks, and fsyncs.

[Run the diagnostic](../../README.md#measure-local-plugin-overhead-without-a-model) · [Timing harness](../../diagnostics/overhead.ts)
