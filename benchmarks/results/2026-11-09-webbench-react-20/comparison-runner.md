| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Stages passed within attempt limit | 20/20 | 20/20 |
| Stages failed | 0 | 0 |
| Stages not graded | 0 | 0 |
| Stages passed on first attempt | 19/20 | 20/20 |
| Repair attempts | 1 | 0 |
| Final cumulative tests passed | 59/59 (through task-20) | 59/59 (through task-20) |
| Final cumulative tests failed / skipped | 0 / 0 | 0 / 0 |

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Estimated API cost, including repairs | $0.1549 | $0.1501 |
| Cached input tokens | 9,177,484 | 4,473,333 |
| Uncached input tokens | 342 | 288 |
| Cache-write tokens | 191,025 | 568,051 |
| Overall cache hit rate | 97.96% | 88.73% |
| Output tokens | 39,149 | 37,379 |
| Known model requests | 114 | 96 |
| Peak active context tokens | 191,028 | 111,748 |
| Mean active context tokens | 82,182.9 | 52,517.42 |

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Native compaction pauses | 0 | 0 |
| First native compaction stage | none | none |
| Native compaction wait | 0 s | 0 s |
| Live Compact cuts | 0 | 14 |
| Local replacement host wait | 0 s | 0.44 s |
| Total host compaction wait | 0 s | 0.44 s |
| Local replacement processing | 0 s | 0.44 s |
| Recall calls | 0 | 0 |
| Wall time | 1,346.09 s | 1,240.22 s |

Costs are OpenCode estimates, not billing receipts. Stage outcomes retain failures after the fixed repair limit; final cumulative test results show the ending application. This is an adapted Web-Bench run with three attempts per stage by default, not an official leaderboard score.

Pause comparison is inconclusive: Original OpenCode must compact automatically, both runs must finish, and timing telemetry must be complete.
