#!/usr/bin/env python3
"""Regression test for the Probity<->Kiro transcript temp-file template.

Run: python3 hooks/probity/kiro/probity-kiro-mktemp.test.py

macOS (BSD) `mktemp` only substitutes a run of `X`s when it is at the *end*
of the template. A template like `...transcript.XXXXXX.jsonl` (X's followed by
a `.jsonl` suffix) is therefore taken literally — every invocation tries to
create the same file `...transcript.XXXXXX.jsonl` and the second one fails with
"mkstemp failed: File exists", which blinds Probity to the session transcript
(and it then blocks all production writes as "no observed red"). The template
must end in X's.
"""
import pathlib
import re

_HERE = pathlib.Path(__file__).parent
script = (_HERE / "probity-kiro.sh").read_text(encoding="utf-8")

failures = []


def check(name, condition):
    print(f"  {'ok' if condition else 'FAIL'}: {name}")
    if not condition:
        failures.append(name)


m = re.search(r'mktemp "([^"]*probity-kiro-transcript[^"]*)"', script)
check("transcript mktemp call is present", m is not None)

if m:
    template = m.group(1)
    basename = template.rsplit("/", 1)[-1]
    # The randomised run of X's must be the trailing characters of the name;
    # any suffix after them defeats BSD mktemp's substitution.
    check(
        f"mktemp template ends in trailing X's (got {basename!r})",
        re.search(r"X{3,}$", basename) is not None,
    )

if failures:
    print(f"\n{len(failures)} check(s) failed")
    raise SystemExit(1)
print("\nall checks passed")
