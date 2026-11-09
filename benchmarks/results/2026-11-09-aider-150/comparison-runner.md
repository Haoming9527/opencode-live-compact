| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Exercises passed | 150/150 | 150/150 |
| Passed on first attempt | 150/150 | 150/150 |
| Repair attempts | 0 | 0 |
| Pass rate among graded exercises | 100.00% | 100.00% |
| Failed exercises and rate | 0 (0.00%) | 0 (0.00%) |
| Overall cache hit rate | 99.49% | 99.34% |
| Cached input tokens | 296,348,172 | 266,745,689 |
| Non-cached input tokens (including cache writes) | 1,518,924 | 1,759,340 |
| Estimated API cost | $6.0480 | $5.3017 |
| Peak context tokens | 782,861 | 590,633 |
| Compaction | 1 pause · 16.3 s | 93 cuts · 5.93 s |
| Wall time (seconds) | 5,106.26 | 4,633.37 |

Costs include every original and repair attempt and are estimates from OpenCode. Cache hit rate is cached reads divided by total input, including writes. Compaction time measures native and local replacement host lifecycles; planning outside those events is excluded.
