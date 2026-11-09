# Web-Bench React 20 — updated plugin

[Project overview](../../../README.md) · [Raw results](comparison.json) · [File hashes](manifest.json) · [Detailed comparison](comparison-runner.md)

Completed November 9, 2026, 15:43 SGT. Both versions passed 20/20 tasks on their first graded attempt, with no repairs and 59/59 final browser tests.

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Estimated API cost | $0.1655 | **$0.0958 · 42.1% lower** |
| Cached input | 10.081M | 4.493M |
| Non-cached input, including writes | 203,254 | 142,866 |
| Cache hit rate | 98.02% | 96.92% |
| Peak context | 202,924 | 104,970 |
| Native pauses | 0 | 0 |
| Local cuts | 0 | 5 |
| Local planning + application | 0 | 124 ms |
| Host event duration | 0 | 487 ms |
| Wall time | 1,361 s | 1,308 s |

Stock OpenCode 2.2.6 and GPT-6 Luna ran concurrently in isolated profiles, one continuous session each, stock defaults and no padded logs. Three graded attempts per stage were permitted. The pinned Web-Bench fixture and ordered prompts match the earlier run. Offline preflight rejected the starter and broken reference and passed the full reference twice.

Updated source: d1b707c, using the 1,000-source-token floor and 256 MiB recovery cap. The compiled-file hashes in plugin-build.json were verified against Daytona after completion; this is reconstructed provenance, not a launch-time fingerprint. The manifest hashes 11 unchanged raw artifacts.

Host event duration overlaps local application; these timings must not be added. User-visible waiting was not measured. Neither version compacted natively, so reduced native pauses remain unproven. Neither called recall. Costs are usage-based estimates, not invoices. One pair does not isolate the cache fix from model variation. The Aider graphic still shows its earlier build until the current run finishes.

Verify without model calls: node benchmarks/results/2026-11-09-webbench-react-20/verify.mjs
