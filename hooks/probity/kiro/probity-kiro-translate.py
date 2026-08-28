#!/usr/bin/env python3
"""
Translation helper for the Probity <-> Kiro PreToolUse shim.

Two subcommands, both stdin -> stdout so the shim can pipe cleanly
(the earlier inline `python3 - <<'PY'` form clashed the heredoc with the
piped payload on stdin, silently producing empty output = allow):

  event   Read a Kiro preToolUse event JSON on stdin, write the
          equivalent claude-code payload JSON on stdout. Emits NOTHING
          (and exits 0) for non-mutating tools, so the shim can fast-allow.
          A transcript path, if provided via $TRANSCRIPT_TMP, is attached
          so Probity's history-based rules work under Kiro.

  reason  Read a Probity claude-code response JSON on stdin. If it is a
          deny, write the permissionDecisionReason on stdout; otherwise
          write nothing. The shim turns a non-empty reason into `exit 2`.
"""
import json
import os
import sys

WRITE_TOOLS = {"fs_write", "write", "fsWrite"}
SHELL_TOOLS = {"shell", "execute_bash", "execute_cmd", "executeBash", "executeCmd"}


def _insert_result(path, cwd, content, insert_line):
    """Reconstruct a file's content after a Kiro `insert`, so content-based
    Probity rules (e.g. the glossary guard) see the true result rather than
    only the introduced text. The pending write hasn't run yet, so the file on
    disk is the pre-write state; fall back to the introduced text alone if it
    cannot be read."""
    full = path if os.path.isabs(path) else os.path.join(cwd, path)
    try:
        with open(full, "r", encoding="utf-8") as handle:
            existing = handle.read()
    except OSError:
        return content
    if isinstance(insert_line, int) and not isinstance(insert_line, bool):
        lines = existing.splitlines(keepends=True)
        idx = max(0, min(insert_line, len(lines)))
        block = content if content.endswith("\n") else content + "\n"
        return "".join(lines[:idx]) + block + "".join(lines[idx:])
    separator = "" if existing == "" or existing.endswith("\n") else "\n"
    return existing + separator + content


def cmd_event():
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0  # unparseable -> emit nothing -> shim allows
    if not isinstance(event, dict):
        return 0

    tool = event.get("tool_name") or ""
    ti = event.get("tool_input")
    ti = ti if isinstance(ti, dict) else {}
    cwd = event.get("cwd") or os.getcwd()

    if tool in SHELL_TOOLS:
        payload = {"tool_name": "Bash", "tool_input": {"command": ti.get("command", "")}}
    elif tool in WRITE_TOOLS:
        path = ti.get("path", "")
        if ti.get("command") == "strReplace":
            payload = {
                "tool_name": "Edit",
                "tool_input": {
                    "file_path": path,
                    "old_string": ti.get("oldStr", ""),
                    "new_string": ti.get("newStr", ""),
                    "replace_all": bool(ti.get("replaceAll", False)),
                },
                "cwd": cwd,
            }
        elif ti.get("command") == "insert":
            # insert ADDS to an existing file; a Write of only the introduced
            # text would tell Probity the whole file became that text. Rebuild
            # the true resulting content from the pre-write file on disk.
            payload = {
                "tool_name": "Write",
                "tool_input": {
                    "file_path": path,
                    "content": _insert_result(path, cwd, ti.get("content", ""), ti.get("insertLine")),
                },
                "cwd": cwd,
            }
        else:  # create -> Write of the whole-file content
            payload = {
                "tool_name": "Write",
                "tool_input": {"file_path": path, "content": ti.get("content", "")},
                "cwd": cwd,
            }
    else:
        return 0  # not a mutating tool -> allow without invoking probity

    transcript = os.environ.get("TRANSCRIPT_TMP") or ""
    if transcript:
        payload["transcript_path"] = transcript

    sys.stdout.write(json.dumps(payload))
    return 0


def cmd_reason():
    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        obj = json.loads(raw)
    except Exception:
        return 0
    if not isinstance(obj, dict):
        return 0
    out = obj.get("hookSpecificOutput", {})
    if isinstance(out, dict) and out.get("permissionDecision") == "deny":
        sys.stdout.write(out.get("permissionDecisionReason", "blocked by Probity"))
    return 0


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    if mode == "event":
        return cmd_event()
    if mode == "reason":
        return cmd_reason()
    sys.stderr.write("usage: probity-kiro-translate.py {event|reason}\n")
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
