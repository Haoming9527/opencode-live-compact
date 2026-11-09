| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Stages passed within attempt limit | 20/20 | 20/20 |
| Stages failed | 0 | 0 |
| Stages not graded | 0 | 0 |
| Stages passed on first attempt | 20/20 | 20/20 |
| Repair attempts | 0 | 0 |
| Final cumulative tests passed | 59/59 (through task-20) | 59/59 (through task-20) |
| Final cumulative tests failed / skipped | 0 / 0 | 0 / 0 |

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Estimated API cost, including repairs | $0.1655 | $0.0958 |
| Cached input tokens | 10,081,088 | 4,492,828 |
| Uncached input tokens | 333 | 291 |
| Cache-write tokens | 202,921 | 142,575 |
| Overall cache hit rate | 98.02% | 96.92% |
| Output tokens | 41,675 | 35,788 |
| Known model requests | 111 | 97 |
| Peak active context tokens | 202,924 | 104,970 |
| Mean active context tokens | 92,651.73 | 47,790.66 |

| Metric | Original OpenCode | Live Compact |
| --- | ---: | ---: |
| Native compaction events | 0 | 0 |
| First native compaction stage | none | none |
| Native compaction event duration | 0 s | 0 s |
| Live Compact cuts | 0 | 5 |
| Local replacement events | 0 | 5 |
| Local full-context replay events | 0 | 0 |
| Local maintenance event duration | 0 s | 0.49 s |
| Total compaction event duration | 0 s | 0.49 s |
| Recorded cut planning + application | 0 s | 0.12 s |
| Recall calls | 0 | 0 |
| Wall time | 1,361.08 s | 1,307.88 s |

Costs are OpenCode estimates, not billing receipts. Stage outcomes retain failures after the fixed repair limit; final cumulative test results show the ending application. This is an adapted Web-Bench run with three attempts per stage by default, not an official leaderboard score.

Event durations sum paired host start/end timestamps; they do not measure user-blocked latency. Local planning can occur outside these events, while application overlaps them, so local processing is not added again. Full-context replays count as local maintenance, not cuts or native compactions.

Native compaction comparison is inconclusive: Original OpenCode must compact automatically, both runs must finish, and event timing must be complete.
