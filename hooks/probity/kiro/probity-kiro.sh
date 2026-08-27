#!/usr/bin/env bash
#
# Probity <-> Kiro PreToolUse shim.
#
# Probity (github.com/nizos/probity) ships vendor adapters for
# claude-code, codex, and github-copilot -- but not Kiro. This shim lets
# the SAME probity.config.ts enforce the mysudovpn-ios workflow under Kiro
# by translating between Kiro's hook contract and the claude-code one:
#
#   1. Kiro fires `preToolUse` with an event JSON on stdin:
#        {"hook_event_name":"preToolUse","cwd":..,"tool_name":"fs_write",
#         "tool_input":{...}}
#      and BLOCKS a tool when the hook exits 2 (STDERR is returned to the LLM).
#
#   2. Probity's claude-code vendor expects a Claude-shaped payload
#        {"tool_name":"Write|Edit|Bash|..","tool_input":{..},"cwd":..,
#         "transcript_path":..}
#      and signals a block by printing a deny JSON to stdout with exit 0:
#        {"hookSpecificOutput":{"permissionDecision":"deny",
#         "permissionDecisionReason":"Probity: ..."}}
#
# The event<->payload and response<->reason translation lives in
# probity-kiro-translate.py (kept out of this script so stdin pipes
# cleanly). We attach a transduced transcript so history-based rules
# (green-gate, TDD) work, then convert a deny response into `exit 2`.
#
# Fail-safe posture: a genuine rule violation blocks (exit 2). Shim-internal
# errors (bad JSON, missing probity) warn on STDERR and ALLOW (exit 0) so a
# tooling bug never wedges the session; the commit green-gate remains the
# correctness backstop.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROBITY="$ROOT/node_modules/.bin/probity"
TRANSLATE="$SCRIPT_DIR/probity-kiro-translate.py"
TRANSDUCER="$SCRIPT_DIR/kiro-transcript-to-claude.py"

EVENT="$(cat)"

# Probity discovers probity.config.ts and node_modules from cwd.
cd "$ROOT" 2>/dev/null || true

if [ ! -x "$PROBITY" ]; then
  echo "probity-kiro: probity not installed at $PROBITY (run npm install)" >&2
  exit 0
fi

# --- Transcript: transduce Kiro's session JSONL to the Anthropic shape ----
TRANSCRIPT_TMP=""
if [ -n "${KIRO_SESSION_ID:-}" ]; then
  KIRO_JSONL="$HOME/.kiro/sessions/cli/${KIRO_SESSION_ID}.jsonl"
  if [ -f "$KIRO_JSONL" ] && command -v python3 >/dev/null 2>&1; then
    TRANSCRIPT_TMP="$(mktemp "${TMPDIR:-/tmp}/probity-kiro-transcript.XXXXXX.jsonl")"
    if ! python3 "$TRANSDUCER" "$KIRO_JSONL" >"$TRANSCRIPT_TMP" 2>/dev/null; then
      rm -f "$TRANSCRIPT_TMP"
      TRANSCRIPT_TMP=""
    fi
  fi
fi
export TRANSCRIPT_TMP

cleanup() { [ -n "$TRANSCRIPT_TMP" ] && rm -f "$TRANSCRIPT_TMP"; }
trap cleanup EXIT

# --- Translate the Kiro event to a claude-code payload --------------------
# Empty stdout == non-mutating tool (or unparseable) -> allow, skip probity.
PAYLOAD="$(printf '%s' "$EVENT" | python3 "$TRANSLATE" event)"
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

# --- Invoke Probity and translate its response to Kiro's exit codes -------
RESPONSE="$(printf '%s' "$PAYLOAD" | "$PROBITY" --agent claude-code 2>/dev/null)"
REASON="$(printf '%s' "$RESPONSE" | python3 "$TRANSLATE" reason)"

if [ -n "$REASON" ]; then
  printf '%s\n' "$REASON" >&2
  exit 2
fi

exit 0
