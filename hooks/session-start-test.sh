#!/bin/bash
# session-start-test.sh - Tests for the SessionStart hook JSON payload

set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

has_jq=0
if command -v jq >/dev/null 2>&1; then
  has_jq=1
fi

# Workspace fixture for the Probity notice: a parent folder holding one
# repository with a live config and one package with a template config.
parent="$tmp_dir/parent"
mkdir -p "$tmp_dir/empty" "$parent/repo-a/.git" "$parent/pkg/templates"
touch "$parent/repo-a/probity.config.ts" "$parent/pkg/templates/probity.config.ts"

CLAUDE_PROJECT_DIR="$tmp_dir/empty" bash hooks/session-start.sh > "$tmp_dir/plain.json"
CLAUDE_PROJECT_DIR="$parent" bash hooks/session-start.sh > "$tmp_dir/parent.json"
CLAUDE_PROJECT_DIR="$parent/repo-a" bash hooks/session-start.sh > "$tmp_dir/repo.json"

HAS_JQ="$has_jq" TMP_DIR="$tmp_dir" node <<'NODE'
const fs = require('fs');
const path = require('path');

const hasJq = process.env.HAS_JQ === '1';
const read = (name) => {
  const payload = JSON.parse(fs.readFileSync(path.join(process.env.TMP_DIR, name), 'utf8'));
  const output = payload.hookSpecificOutput;
  if (!output || output.hookEventName !== 'SessionStart') {
    throw new Error(`${name}: expected the SessionStart envelope`);
  }
  return output.additionalContext;
};

const plain = read('plain.json');
if (!hasJq) {
  if (!plain.includes('jq is required')) {
    throw new Error('message is missing jq fallback guidance');
  }
  console.log('session-start JSON payload OK (jq missing; notice cases skipped)');
  process.exit(0);
}

if (!plain.startsWith('agent-skills loaded.')) {
  throw new Error('message is missing startup preface');
}
if (!plain.includes('# Using Agent Skills')) {
  throw new Error('message is missing using-agent-skills content');
}
if (plain.includes('Probity')) {
  throw new Error('no Probity notice expected without nested configs');
}

const parent = read('parent.json');
if (!parent.includes('Probity rules are NOT enforced')) {
  throw new Error('parent folder should get the Probity notice');
}
if (!parent.includes('  - repo-a/probity.config.ts')) {
  throw new Error('notice should list the repository config');
}
if (parent.includes('pkg/templates')) {
  throw new Error('template configs outside a repository root must not be listed');
}
if (!parent.includes('# Using Agent Skills')) {
  throw new Error('notice must not replace the meta-skill content');
}

if (read('repo.json').includes('Probity rules are NOT enforced')) {
  throw new Error('a project with its own config should get no notice');
}

console.log('session-start JSON payload OK');
NODE
