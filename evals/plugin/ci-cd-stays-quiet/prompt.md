---
description: A branch-management request that belongs to git-workflow-and-versioning. Guards the ci-cd-and-automation description against firing on any git or build mention.
expected_outcome: Rebase steps; ci-cd-and-automation is never invoked.
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Rebase my feature branch onto main and tell me how to resolve the conflict in build.gradle.kts.
