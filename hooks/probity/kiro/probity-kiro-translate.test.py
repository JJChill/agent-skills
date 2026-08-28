#!/usr/bin/env python3
"""Tests for the Probity<->Kiro pending-action translator (`event` mode).

Run: python3 hooks/probity/kiro/probity-kiro-translate.test.py

The invariant: a Kiro `insert` adds text to an *existing* file, so translating
it to a Claude `Write` of only the introduced text tells Probity the whole
file became that text — content rules (e.g. the glossary guard) then read
every existing term as "removed". The pending write hasn't run yet, so the
file on disk is the pre-write state and the true result is reconstructable.
"""
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile

_HERE = pathlib.Path(__file__).parent
_spec = importlib.util.spec_from_file_location(
    "kiro_translate", _HERE / "probity-kiro-translate.py"
)
translate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(translate)

failures = []


def check(name, condition):
    print(f"  {'ok' if condition else 'FAIL'}: {name}")
    if not condition:
        failures.append(name)


def run_event(event):
    old_in, old_out = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(json.dumps(event)), io.StringIO()
    try:
        translate.cmd_event()
        return sys.stdout.getvalue()
    finally:
        sys.stdin, sys.stdout = old_in, old_out


with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "GLOSSARY.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("# Glossary\n\n## Existing Term\n\nA definition.\n")

    # An insert that appends a new term.
    out = run_event({
        "tool_name": "fs_write",
        "tool_input": {"command": "insert", "path": path,
                       "content": "\n## New Term\n\nAnother definition.\n"},
        "cwd": d,
    })
    payload = json.loads(out) if out.strip() else {}
    content = payload.get("tool_input", {}).get("content", "")
    check("insert translates to a Write", payload.get("tool_name") == "Write")
    check("reconstructed content keeps the existing term", "## Existing Term" in content)
    check("reconstructed content includes the inserted term", "## New Term" in content)

    # insert with an explicit line index keeps everything too.
    out = run_event({
        "tool_name": "fs_write",
        "tool_input": {"command": "insert", "path": path, "insertLine": 1,
                       "content": "inserted-line\n"},
        "cwd": d,
    })
    content = json.loads(out)["tool_input"]["content"] if out.strip() else ""
    check("line-indexed insert keeps existing content", "## Existing Term" in content and "inserted-line" in content)

    # create still carries the whole-file content through unchanged.
    out = run_event({
        "tool_name": "fs_write",
        "tool_input": {"command": "create", "path": os.path.join(d, "new.txt"),
                       "content": "whole file"},
        "cwd": d,
    })
    check("create passes full content as a Write",
          json.loads(out)["tool_input"]["content"] == "whole file")

    # strReplace still maps to an Edit (unchanged).
    out = run_event({
        "tool_name": "fs_write",
        "tool_input": {"command": "strReplace", "path": path, "oldStr": "a", "newStr": "b"},
        "cwd": d,
    })
    check("strReplace maps to Edit", json.loads(out)["tool_name"] == "Edit")

if failures:
    print(f"\n{len(failures)} check(s) failed")
    raise SystemExit(1)
print("\nall checks passed")
