| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Exercises passed | 150/150 | 150/150 |
| Passed on first attempt | 149/150 | 150/150 |
| Repair attempts | 1 | 0 |
| Pass rate among graded exercises | 100.00% | 100.00% |
| Failed exercises and rate | 0 (0.00%) | 0 (0.00%) |
| Overall cache hit rate | 99.24% | 99.56% |
| Cached input tokens | 302,385,451 | 265,961,899 |
| Non-cached input tokens (including cache writes) | 2,329,581 | 1,170,496 |
| Estimated API cost | $6.2952 | $5.3972 |
| Peak context tokens | 783,016 | 762,020 |
| Compaction cuts/events · event duration | 1 native event · 15.11 s | 37 cuts · 2.51 s |
| Wall time (seconds) | 5,526.11 | 3,636.6 |

Costs include every original and repair attempt and are estimates from OpenCode. Cache hit rate is cached reads divided by total input, including writes. Compaction duration sums paired host start/end events, including local full-context replays; it is not measured user-blocked latency. Planning outside those events is excluded.
