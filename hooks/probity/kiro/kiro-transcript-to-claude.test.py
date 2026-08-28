#!/usr/bin/env python3
"""Tests for the Kiro->Claude transcript transducer.

Run: python3 hooks/probity/kiro/kiro-transcript-to-claude.test.py

Guards the invariant that matters for Probity's history-based rules: tool
RESULTS (shell stdout/stderr) are persisted by Kiro as `json` content blocks,
and must survive translation into the Claude tool_result content — otherwise
the green-gate and characterization gate never see any command output.
"""
import importlib.util
import json
import pathlib

_HERE = pathlib.Path(__file__).parent
_spec = importlib.util.spec_from_file_location(
    "kiro_transducer", _HERE / "kiro-transcript-to-claude.py"
)
transducer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(transducer)

failures = []


def check(name, condition):
    print(f"  {'ok' if condition else 'FAIL'}: {name}")
    if not condition:
        failures.append(name)


# A shell tool result is a `json` block carrying {exit_status, stdout, stderr}.
result_line = json.dumps({
    "kind": "ToolResults",
    "data": {"content": [{
        "kind": "toolResult",
        "data": {
            "toolUseId": "abc",
            "content": [{"kind": "json", "data": {
                "exit_status": "exit status: 65",
                "stdout": "Test Case 'testRestoreSucceeds' failed (0.1 seconds).",
                "stderr": "",
            }}],
        },
    }]},
})

emitted = []
transducer.transduce_line(result_line, emitted.append)

check("a ToolResults line is translated to one user/tool_result message", len(emitted) == 1)
content = emitted[0]["message"]["content"][0]["content"] if emitted else ""
check("the json tool-result payload survives translation (test name)", "testRestoreSucceeds" in content)
check("the failure signal survives translation (/fail/)", "failed" in content)

# Text blocks (prompts, assistant prose) must still work.
check(
    "text blocks are still extracted",
    transducer._text_blocks([{"kind": "text", "data": "hello"}]) == "hello",
)
# A string json payload is passed through as-is.
check(
    "string json payloads pass through",
    "raw" in transducer._text_blocks([{"kind": "json", "data": "raw output"}]),
)

if failures:
    print(f"\n{len(failures)} check(s) failed")
    raise SystemExit(1)
print("\nall checks passed")
