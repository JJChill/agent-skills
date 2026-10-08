#!/usr/bin/env python3
"""End-to-end test: the Kiro shim in a worktree beside the main checkout.

Run: python3 hooks/probity/kiro/probity-kiro-worktree.test.py

A worktree made with `git worktree add ../<name>` carries the committed
`.kiro/hooks/probity-kiro.sh`, but usually no node_modules of its own. The
shim took its root from its own location, found no Probity there, and
allowed every call (issue #90). It must fall back to the main worktree's
install, judging the call with the worktree's own config, and block with an
install hint when Probity is installed nowhere, letting the install command
itself through.

A shell call from the main checkout reaches the sibling by path (issue #92):
the shim runs probity-claude, which also judges a write in the tree that
holds it.
"""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

_HERE = pathlib.Path(__file__).parent
_PACKAGE = _HERE.parent.resolve()
_PACKAGE_MODULES = _PACKAGE / "node_modules"

ALLOW_ALL = """import { defineConfig } from '@nizos/probity'
export default defineConfig({ rules: [] })
"""

SCREEN = f"""import {{ dirname }} from 'node:path'
import {{ fileURLToPath }} from 'node:url'
import {{ defineConfig }} from '@nizos/probity'
import {{ forbidShellWritesToScopedFiles }} from '{_PACKAGE / "rules" / "shell-writes.ts"}'
const ROOT = dirname(fileURLToPath(import.meta.url))
export default defineConfig({{ rules: [forbidShellWritesToScopedFiles({{ root: ROOT, scopes: [['src/**']] }})] }})
"""

CONFIG = """import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@nizos/probity'
const ROOT = dirname(fileURLToPath(import.meta.url))
export default defineConfig({ rules: [function whereAmI() { return { kind: 'violation', reason: 'root=' + ROOT } }] })
"""

failures = []


def check(name, condition, detail=""):
    print(f"  {'ok' if condition else 'FAIL'}: {name}")
    if not condition:
        failures.append(name)
        if detail:
            print(f"    {detail}")


def git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=cwd, check=True, capture_output=True,
    )


def install(tree):
    """A node_modules holding Probity and this package's probity-claude bin."""
    modules = tree / "node_modules"
    (modules / ".bin").mkdir(parents=True)
    (modules / "@nizos").symlink_to(_PACKAGE_MODULES / "@nizos", target_is_directory=True)
    (modules / ".bin" / "probity").symlink_to(_PACKAGE_MODULES / "@nizos" / "probity" / "dist" / "bin.js")
    (modules / ".bin" / "probity-claude").symlink_to(_PACKAGE / "scripts" / "probity-claude.mjs")


def shim(tree, command):
    event = {"hook_event_name": "preToolUse", "cwd": str(tree), "tool_name": "shell", "tool_input": {"command": command}}
    env = {k: v for k, v in os.environ.items() if k not in ("KIRO_SESSION_ID", "NODE_PATH")}
    return subprocess.run(
        ["bash", str(tree / ".kiro" / "hooks" / "probity-kiro.sh")],
        input=json.dumps(event), capture_output=True, text=True, cwd=str(tree), env=env,
    )


with tempfile.TemporaryDirectory() as tmp:
    base = pathlib.Path(tmp).resolve()
    main = base / "project"
    sibling = base / "project-wt"
    hooks = main / ".kiro" / "hooks"
    hooks.mkdir(parents=True)
    for name in ("probity-kiro.sh", "probity-kiro-translate.py", "kiro-transcript-to-claude.py"):
        shutil.copy(_HERE / name, hooks / name)
    (main / "probity.config.ts").write_text(CONFIG)
    (main / ".gitignore").write_text("node_modules\n")
    git(main, "init", "-q", "-b", "main")
    git(main, "add", ".")
    git(main, "commit", "-q", "-m", "init")
    git(main, "worktree", "add", "-q", str(sibling), "-b", "wt")
    install(main)

    res = shim(sibling, "sed -i s/a/b/ src/A.kt")
    check("sibling worktree without node_modules: the call is judged (exit 2)", res.returncode == 2, res.stderr)
    check("...by the sibling's own config", f"root={sibling}" in res.stderr, res.stderr)

    res = shim(main, "sed -i s/a/b/ src/A.kt")
    check("main checkout: judged by its own config", res.returncode == 2 and f"root={main}" in res.stderr, res.stderr)

    (main / "probity.config.ts").write_text(ALLOW_ALL)
    (sibling / "probity.config.ts").write_text(SCREEN)
    (sibling / "src").mkdir()
    res = shim(main, f"sed -i s/a/b/ {sibling}/src/A.kt")
    check("main checkout writing into the sibling: judged by the sibling's config", res.returncode == 2 and "writes src/A.kt" in res.stderr, res.stderr)
    res = shim(main, "sed -i s/a/b/ ../project-wt/src/A.kt")
    check("...by a relative path from the main checkout too", res.returncode == 2 and "writes src/A.kt" in res.stderr, res.stderr)
    res = shim(main, f"sed -i s/a/b/ {sibling}/docs/notes.md")
    check("...and an unscoped sibling path passes", res.returncode == 0, res.stderr)

    shutil.rmtree(main / "node_modules")
    res = shim(sibling, "sed -i s/a/b/ src/A.kt")
    check("Probity installed nowhere: the call is blocked (exit 2)", res.returncode == 2, res.stderr)
    check("...with an npm ci hint", "npm ci" in res.stderr, res.stderr)

    res = shim(sibling, "npm ci")
    check("Probity installed nowhere: the install command goes through", res.returncode == 0, res.stderr)

if failures:
    raise SystemExit(f"{len(failures)} check(s) failed")
print("all checks passed")
