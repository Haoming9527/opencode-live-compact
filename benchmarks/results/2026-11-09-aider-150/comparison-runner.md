| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Exercises passed | 150/150 | 150/150 |
| Passed on first attempt | 150/150 | 150/150 |
| Repair attempts | 0 | 0 |
| Pass rate among graded exercises | 100.00% | 100.00% |
| Failed exercises and rate | 0 (0.00%) | 0 (0.00%) |
| Overall cache hit rate | 99.11% | 99.55% |
| Cached input tokens | 260,578,030 | 268,551,702 |
| Non-cached input tokens (including cache writes) | 2,327,205 | 1,221,638 |
| Estimated API cost | $5.5539 | $5.3839 |
| Peak context tokens | 783,361 | 694,644 |
| Compaction cuts/events · event duration | 1 native event · 12.27 s | 58 cuts · 3.97 s |
| Wall time (seconds) | 4,784.51 | 4,333.26 |

Costs include every original and repair attempt and are estimates from OpenCode. Cache hit rate is cached reads divided by total input, including writes. Compaction duration sums paired host start/end events, including local full-context replays; it is not measured user-blocked latency. Planning outside those events is excluded.
