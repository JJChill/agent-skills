---
description: Issue #59. A plain request to add one CI job, with the current pipeline inline. ci-cd-and-automation should fire; on 0.6.8 it fired in 0 of 3 runs on this phrasing.
expected_outcome: ci-cd-and-automation is invoked before the job is written.
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Add an Android emulator test job to the GitLab pipeline. Here's the current `.gitlab-ci.yml`:

```yaml
stages: [build, test]

build:
  stage: build
  image: gradle:8.10-jdk17
  script:
    - ./gradlew assemble

unit-tests:
  stage: test
  image: gradle:8.10-jdk17
  script:
    - ./gradlew test
```
