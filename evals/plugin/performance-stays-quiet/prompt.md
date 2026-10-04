---
description: A crash investigation that belongs to debugging-and-error-recovery. Guards the performance-optimization description against firing on every "find out why".
expected_outcome: A crash diagnosis; performance-optimization is never invoked.
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

The CLI crashes when listing Sudos that have no avatar. Find out why.

```
$ ./sudo-cli list --limit 200
Exception in thread "main" java.lang.NullPointerException: Cannot invoke "Avatar.getUrl()" because "sudo.avatar" is null
    at com.example.cli.ListCommand.render(ListCommand.kt:42)
```
