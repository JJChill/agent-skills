#!/bin/bash
# userPromptSubmit hook that forces explicit skill evaluation.
#
# Kiro CLI port of .claude/hooks/skill-activation-forced-eval.sh. Kiro has
# no Skill() tool, so "activation" means the agent READS the relevant
# SKILL.md before implementing. This hook's stdout is injected into context
# on every user prompt (see Kiro's Hooks docs: userPromptSubmit stdout is
# added to the agent's context on exit 0).
#
# Install either project-locally (.kiro/hooks/) — referenced by
# kiro-agent.template.json — or user-wide (~/.kiro/hooks/) for a global
# default agent. Both work; the project-local copy keeps a checkout
# self-contained (no per-machine global prerequisite).

cat <<'EOF'
INSTRUCTION: MANDATORY SKILL ACTIVATION SEQUENCE

Step 1 - EVALUATE (do this in your response):
For each skill listed in this session's available skills, state:
  [skill-name] - YES/NO - [one-line reason]

Step 2 - ACTIVATE (do this immediately after Step 1):
IF any skills are YES -> Read that skill's SKILL.md (e.g.
  .kiro/skills/<skill-name>/SKILL.md) for EACH relevant skill NOW, and follow it.
IF no skills are YES -> State "No skills needed" and proceed.

Step 3 - IMPLEMENT:
Only after Step 2 is complete, proceed with implementation.

CRITICAL: You MUST load (read) each YES skill's SKILL.md in Step 2 before
implementing. The evaluation (Step 1) is WORTHLESS unless you ACTIVATE (Step 2)
the skills. Skip the whole sequence only for trivial conversational replies that
touch no skill's domain.

Example of correct sequence:
- test-driven-development: YES - changing behaviour, needs RED->GREEN->REFACTOR
- code-review-and-quality: YES - will review the diff before done
- perfetto-sql: NO - no trace analysis in this task

[Then IMMEDIATELY read the SKILL.md for each YES skill:]
> Read .kiro/skills/test-driven-development/SKILL.md
> Read .kiro/skills/code-review-and-quality/SKILL.md

[THEN and ONLY THEN start implementation]
EOF
