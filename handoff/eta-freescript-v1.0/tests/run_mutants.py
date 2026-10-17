#!/usr/bin/env python3
"""Runs validate_artifact.py on every mutant in tests/expected.tsv. A row matches when the exit code gives the expected
verdict and, for 'fail' rows, a failure line names the expected V-rule. Exit 1 on any mismatch.
Usage: run_mutants.py [MUTANT_DIR]   (default: tests/mutants; expected.tsv is read from MUTANT_DIR/..)."""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
VALIDATOR = os.path.join(os.path.dirname(HERE), "validate_artifact.py")


def main(mdir):
    rows = open(os.path.join(os.path.dirname(mdir.rstrip("/")), "expected.tsv"), encoding="utf-8").read().splitlines()[1:]
    bad = 0
    for row in rows:
        name, _base, exp, rule = row.split("\t")
        r = subprocess.run([sys.executable, VALIDATOR, os.path.join(mdir, name + ".json")], capture_output=True, text=True)
        got = "pass" if r.returncode == 0 else "fail"
        rules = {l.split()[0] for l in r.stdout.splitlines()[1:] if l.strip()}
        ok = got == exp and (exp == "pass" or rule in rules)
        bad += not ok
        print("%s %-48s expected=%s/%s got=%s/%s" % ("MATCH   " if ok else "MISMATCH", name, exp, rule, got, ",".join(sorted(rules)) or "-"))
    print("%d/%d rows match" % (len(rows) - bad, len(rows)))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "mutants"))
