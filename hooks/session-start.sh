#!/bin/bash
# agent-skills session start hook
# Injects the using-agent-skills meta-skill into every new session
#
# Every output path must emit the standard SessionStart envelope
#   {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
# Hosts that validate hook output (Codex CLI, Claude Code) reject other shapes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$(dirname "$SCRIPT_DIR")/skills"
META_SKILL="$SKILLS_DIR/using-agent-skills/SKILL.md"

if ! command -v jq >/dev/null 2>&1; then
  echo '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "agent-skills: jq is required for the session-start hook but was not found on PATH. Install jq (e.g. `brew install jq` or `apt-get install jq`) to enable meta-skill injection. Skills remain available individually."}}'
  exit 0
fi

# Probity (hooks/PROBITY.md) only enforces the config of the project
# Claude Code was opened on: its PreToolUse hook lives in that
# project's .claude/settings.json and finds probity.config.* by
# searching upward from $CLAUDE_PROJECT_DIR. A session opened on a
# parent folder of several repositories therefore enforces nothing,
# silently. Say so when configs exist below the project but not at it.
probity_notice() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  local ext
  for ext in ts mts js mjs; do
    [ -f "$dir/probity.config.$ext" ] && return 0
  done
  # Only configs at a repository root (.git or .claude beside them)
  # count: template configs inside a package are not live configs.
  local config repo list=""
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
  [ -n "$list" ] || return 0
  printf '%s' "agent-skills: Probity configs exist below this project but not at its root ($dir):$list
Probity rules are NOT enforced in this session: the hook and config are read from the folder Claude Code was opened on. To enforce them, open Claude Code in that repository's folder instead."
}

NOTICE=$(probity_notice)

if [ -f "$META_SKILL" ]; then
  CONTENT=$(cat "$META_SKILL")
  # Use jq to properly escape and construct valid JSON
  jq -cn \
    --arg context "agent-skills loaded. Use the skill discovery flowchart to find the right skill for your task.

$CONTENT" \
    --arg notice "$NOTICE" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: (if $notice == "" then $context else $notice + "\n\n" + $context end)}}'
else
  jq -cn \
    --arg notice "$NOTICE" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: ([$notice, "agent-skills: using-agent-skills meta-skill not found. Skills may still be available individually."] | map(select(. != "")) | join("\n\n"))}}'
fi
