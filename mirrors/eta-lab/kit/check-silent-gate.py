#!/usr/bin/env python3
"""check-silent-gate.py -- the ONE baseline-diff for `npm run check:silent`, shared by the box CI runner
(yoga-ci-remote.sh) and, by design, .github/workflows/gate.yml (ETA-Refuter #120, eta-refuter-2 #121/#124,
Fable ruling 40). Two implementations drift; this is the single one.

Why it exists: scripts/check-silent-failures.mjs exits 1 on ANY finding, and the tree carries accepted ones, so its
bare exit code cannot tell "the accepted findings" from "a new one" -- and a runner that never ran it cannot
tell either. The gate is: fail on any finding NOT in the REFERENCE baseline (a multiset keyed on
path TAB trimmed line text, no line numbers -- lines shift with unrelated edits).

The baseline is the caller's to supply and MUST be the reference copy (production, origin/vinay/s1-auto-drain),
never the target tree's own file: a builder who can edit the baseline can add their new finding to it.

usage:  npm run -s check:silent 2>&1 | check-silent-gate.py --baseline FILE --rc <check:silent's exit code>
exit:   0  ok (no findings, or every finding is in the baseline; a notice is printed for accepted findings that are gone)
        1  NEW finding(s) not in the baseline           -- the gate FAILS
        2  check:silent failed without a findings list, or its output cannot be trusted (count mismatch, no OK line)
           -- the gate FAILS (never read as clean)
        3  baseline missing, unreadable or not a file    -- the gate FAILS LOUDLY and distinguishably (absent != clean)
"""
import argparse, os, re, sys
from collections import Counter


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--rc", type=int, required=True, help="exit code of `npm run check:silent`")
    a = ap.parse_args()
    out = sys.stdin.read()

    # The baseline is checked FIRST and unconditionally: a missing reference must fail even on a clean tree, or
    # "the check vanished" would be invisible exactly when nothing is wrong.
    if not a.baseline or not os.path.isfile(a.baseline):
        print(f"check:silent REFERENCE BASELINE ABSENT: {a.baseline!r} is not a readable file -- refusing to call this clean")
        return 3
    try:
        with open(a.baseline, encoding="utf-8") as f:
            base = Counter(l.rstrip("\n") for l in f if l.strip() and not l.startswith("#"))
    except OSError as e:
        print(f"check:silent REFERENCE BASELINE UNREADABLE: {a.baseline!r}: {e}")
        return 3

    # Trust the evidence, not the exit code. The findings list is parsed whenever it is present, whatever rc says; and
    # an output with neither a findings list nor the script's own OK line is never read as clean (fail closed).
    found = Counter()
    header = re.search(r"^Found ([0-9]+) silent-failure", out, re.M)
    if header:
        for l in out.splitlines():
            m = re.match(r"^\s+(\S+?):(\d+)\s+(.*?)\s*$", l)
            if m:
                found[f"{m.group(1)}\t{m.group(3).strip()}"] += 1
        # The header says how many findings there are. If fewer lines parsed, a finding line escaped the parser
        # (a path with spaces, a format change): the count would be short and a new finding could hide in the gap.
        if sum(found.values()) != int(header.group(1)):
            print(f"check:silent output says {header.group(1)} findings but {sum(found.values())} lines parsed -- format drift, not diffed")
            return 2
    elif a.rc != 0:
        print("check:silent failed without a findings list (no 'Found N silent-failure' line) -- not clean, not diffed")
        return 2
    elif not re.search(r"^OK\b", out, re.M):
        print("check:silent exited 0 but printed neither a findings list nor its 'OK' line -- not read as clean")
        return 2

    new = found - base
    for k in sorted(new):
        print("NEW silent-failure handler (not in the reference baseline): " + k.replace("\t", "  "))
    for k in sorted(base - found):
        print("notice: accepted finding no longer present (remove it from the baseline): " + k.replace("\t", "  "))
    print(f"check:silent: {sum(found.values())} found, {sum(new.values())} new vs the reference baseline ({sum(base.values())} accepted)")
    return 1 if new else 0


if __name__ == "__main__":
    sys.exit(main())
