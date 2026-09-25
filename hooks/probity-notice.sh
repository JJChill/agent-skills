#!/bin/bash
# agent-skills Probity notice (SessionStart)
#
# Probity (hooks/PROBITY.md) only enforces the config of the project
# Claude Code was opened on: its PreToolUse hook lives in that
# project's .claude/settings.json and finds probity.config.* by
# searching upward from $CLAUDE_PROJECT_DIR. A session opened on a
# parent folder of several repositories therefore enforces nothing,
# silently. This hook says so when configs exist below the project but
# not at it, and prints nothing otherwise, so a normal session pays no
# context cost.
#
# When it prints, the output is the standard SessionStart envelope
#   {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}

dir="${CLAUDE_PROJECT_DIR:-$PWD}"

for ext in ts mts js mjs; do
  [ -f "$dir/probity.config.$ext" ] && exit 0
done

# Only configs at a repository root (.git or .claude beside them)
# count: template configs inside a package are not live configs.
list=""
while IFS= read -r config; do
  [ -n "$config" ] || continue
  repo="${config%/*}"
  if [ -e "$repo/.git" ] || [ -d "$repo/.claude" ]; then
    list="$list
  - ${config#"$dir"/}"
  fi
done <<FOUND
$(find "$dir" -mindepth 2 -maxdepth 3 \
    \( -name node_modules -o -name .git -o -name build -o -name dist \) -prune -o \
    -type f \( -name probity.config.ts -o -name probity.config.mts \
    -o -name probity.config.js -o -name probity.config.mjs \) -print 2>/dev/null)
FOUND
[ -n "$list" ] || exit 0

notice="agent-skills: Probity configs exist below this project but not at its root ($dir):$list
Probity rules are NOT enforced in this session: the hook and config are read from the folder Claude Code was opened on. To enforce them, open Claude Code in that repository's folder instead."

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg notice "$notice" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $notice}}'
else
  node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: process.argv[1]}}))' "$notice" 2>/dev/null || true
fi
