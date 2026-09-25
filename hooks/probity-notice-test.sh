#!/bin/bash
# probity-notice-test.sh - Tests for the Probity SessionStart notice

set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# Fixture: a parent folder holding one repository with a live config
# and one package with a template config, plus an unrelated folder.
parent="$tmp_dir/parent"
mkdir -p "$tmp_dir/empty" "$parent/repo-a/.git" "$parent/pkg/templates"
touch "$parent/repo-a/probity.config.ts" "$parent/pkg/templates/probity.config.ts"

CLAUDE_PROJECT_DIR="$tmp_dir/empty" bash hooks/probity-notice.sh > "$tmp_dir/empty.out"
CLAUDE_PROJECT_DIR="$parent" bash hooks/probity-notice.sh > "$tmp_dir/parent.out"
CLAUDE_PROJECT_DIR="$parent/repo-a" bash hooks/probity-notice.sh > "$tmp_dir/repo.out"

TMP_DIR="$tmp_dir" node <<'NODE'
const fs = require('fs');
const path = require('path');
const read = (name) => fs.readFileSync(path.join(process.env.TMP_DIR, name), 'utf8');

if (read('empty.out') !== '') {
  throw new Error('no output expected without nested configs');
}
if (read('repo.out') !== '') {
  throw new Error('a project with its own config should get no notice');
}

const out = JSON.parse(read('parent.out')).hookSpecificOutput;
if (!out || out.hookEventName !== 'SessionStart') {
  throw new Error('notice must use the SessionStart envelope');
}
const text = out.additionalContext;
if (!text.includes('Probity rules are NOT enforced')) {
  throw new Error('parent folder should get the Probity notice');
}
if (!text.includes('  - repo-a/probity.config.ts')) {
  throw new Error('notice should list the repository config');
}
if (text.includes('pkg/templates')) {
  throw new Error('template configs outside a repository root must not be listed');
}

console.log('probity notice OK');
NODE
