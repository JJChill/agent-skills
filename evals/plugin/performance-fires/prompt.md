---
description: Issue #59. Something is slow at runtime and the user asks why. performance-optimization should fire; on 0.6.8 it fired in 0 of 3 runs on this phrasing.
expected_outcome: performance-optimization is invoked before the investigation.
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

The CLI takes several seconds to list 200 Sudos at runtime. Find out why.

```
$ time ./sudo-cli list --limit 200 > /dev/null
real    0m6.412s
user    0m0.902s
sys     0m0.117s
```
