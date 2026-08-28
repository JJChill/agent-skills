#!/usr/bin/env python3
"""
Kiro session transcript -> Anthropic (Claude Code) transcript transducer.

Probity's claude-code vendor reconstructs conversation history from a
JSONL transcript in Anthropic's persisted message shape (see
node_modules/@nizos/probity/dist/vendors/claude-code/transcript.js):

    {"type":"assistant","message":{"content":[
        {"type":"tool_use","id":<id>,"name":<ClaudeToolName>,"input":{...}}]}}
    {"type":"user","message":{"content":[
        {"type":"tool_result","tool_use_id":<id>,"content":<string|blocks>}]}}
    {"type":"user","message":{"content":[{"type":"text","text":<prompt>}]}}

Kiro persists a different, versioned event stream at
~/.kiro/sessions/cli/<KIRO_SESSION_ID>.jsonl:

    {"kind":"Prompt","data":{"content":[{"kind":"text","data":<str>}]}}
    {"kind":"AssistantMessage","data":{"content":[
        {"kind":"toolUse","data":{"toolUseId","name","input"}},
        {"kind":"text","data":<str>}, {"kind":"thinking",...}]}}
    {"kind":"ToolResults","data":{"content":[
        {"kind":"toolResult","data":{"toolUseId","content":[{"kind":"text","data"}],"status"}}]}}

This script maps the former onto the latter so Probity's history-based
rules (the commit green-gate `requireGreenTestRun`, the TDD RED-before-GREEN
judge, characterization/probe resolution) can see prior tool calls and their
output when running under Kiro.

Tool-name mapping matters: Probity's history `toCanonical` only treats a
Claude `Bash` action as a shell command and `Write`/`Edit` as a file write.
So Kiro's `shell` must become `Bash` (or the green-gate never sees the
`xcodebuild ... test` output), and Kiro's `write` becomes `Write`/`Edit`.

Reads Kiro JSONL from argv[1] (or stdin) and writes Claude JSONL to stdout.
Malformed lines are skipped, mirroring Probity's own tolerant reader.
"""
import json
import sys


def _text_blocks(content):
    """Join the text payloads of a Kiro content array into one string."""
    out = []
    for item in content or []:
        if not isinstance(item, dict):
            continue
        if item.get("kind") == "text":
            data = item.get("data")
            if isinstance(data, str):
                out.append(data)
    return "\n".join(out)


def _map_tool(name, tool_input):
    """Map a Kiro tool name+input to a Claude (tool_name, input) pair.

    Only the shapes Probity's history reader interprets need to be exact:
      - shell   -> Bash  {command}
      - write   -> Write {file_path, content} / Edit {file_path, new_string}
    Everything else is passed through under its own name and read by
    Probity as an inert `other` action (no rule matches it).
    """
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if name in ("shell", "execute_bash", "execute_cmd"):
        return "Bash", {"command": tool_input.get("command", "")}
    if name in ("write", "fs_write", "fsWrite"):
        op = tool_input.get("command")
        path = tool_input.get("path", "")
        if op == "strReplace":
            return "Edit", {
                "file_path": path,
                "old_string": tool_input.get("oldStr", ""),
                "new_string": tool_input.get("newStr", ""),
                "replace_all": bool(tool_input.get("replaceAll", False)),
            }
        # create / insert / append: the introduced text is `content`.
        return "Write", {
            "file_path": path,
            "content": tool_input.get("content", ""),
        }
    return name or "Unknown", tool_input


def transduce_line(raw, emit):
    line = raw.strip()
    if not line:
        return
    try:
        entry = json.loads(line)
    except (ValueError, TypeError):
        return
    if not isinstance(entry, dict):
        return
    kind = entry.get("kind")
    data = entry.get("data") or {}
    content = data.get("content") if isinstance(data, dict) else None

    if kind == "Prompt":
        text = _text_blocks(content)
        if text:
            emit({"type": "user",
                  "message": {"content": [{"type": "text", "text": text}]}})
        return

    if kind == "AssistantMessage":
        blocks = []
        for item in content or []:
            if not isinstance(item, dict):
                continue
            ikind = item.get("kind")
            idata = item.get("data") or {}
            if ikind == "toolUse" and isinstance(idata, dict):
                cname, cinput = _map_tool(idata.get("name"), idata.get("input"))
                blocks.append({
                    "type": "tool_use",
                    "id": idata.get("toolUseId", ""),
                    "name": cname,
                    "input": cinput,
                })
            elif ikind == "text" and isinstance(idata, str):
                blocks.append({"type": "text", "text": idata})
        if blocks:
            emit({"type": "assistant", "message": {"content": blocks}})
        return

    if kind == "ToolResults":
        for item in content or []:
            if not isinstance(item, dict) or item.get("kind") != "toolResult":
                continue
            idata = item.get("data") or {}
            if not isinstance(idata, dict):
                continue
            emit({
                "type": "user",
                "message": {"content": [{
                    "type": "tool_result",
                    "tool_use_id": idata.get("toolUseId", ""),
                    "content": _text_blocks(idata.get("content")),
                }]},
            })
        return
    # Unknown top-level kinds are ignored.


def main(argv):
    src = open(argv[1], "r", encoding="utf-8") if len(argv) > 1 else sys.stdin
    out = sys.stdout

    def emit(obj):
        out.write(json.dumps(obj))
        out.write("\n")

    try:
        for raw in src:
            transduce_line(raw, emit)
    finally:
        if src is not sys.stdin:
            src.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
