# Kiro CLI enforcement assets

Run this framework under **Kiro CLI** with the same Probity guardrail the
Claude Code integration gets. Probity has no native Kiro vendor, so these
files translate between Kiro's hook contract and Probity's `claude-code`
contract.

| File | Role |
|------|------|
| `probity-kiro.sh` | preToolUse shim (event translation + deny→exit 2) |
| `probity-kiro-translate.py` | `event` / `reason` translation helpers |
| `kiro-transcript-to-claude.py` | Kiro session JSONL → Anthropic JSONL (for history rules) |
| `skill-activation-forced-eval.sh` | userPromptSubmit skill-activation hook |
| `kiro-agent.template.json` | agent config template (skills + both hooks) |

**Setup:** see [`docs/kiro-setup.md`](../../../docs/kiro-setup.md).

These are copy-in artifacts (like the `probity.config.*.ts` presets): install
them into a project's `.kiro/`. This directory is the single source of truth —
fix Kiro-integration issues here, then re-copy.
