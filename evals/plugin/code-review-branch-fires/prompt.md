---
description: Issue #59. A review request that names a branch and a path but pastes no diff. code-review-and-quality should fire (directly or through the review command); on 0.6.8 it fired in 0 of 3 runs on this phrasing.
expected_outcome: code-review-and-quality is invoked before the review starts.
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Review the changes on this branch to sdk/anonyome before I merge.
