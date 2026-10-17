#!/usr/bin/env python3
"""Runs the validator on every mutant in tests/expected.tsv. A row matches when the verdict is the expected one and, for
'fail' rows, a failure line names the expected V-rule. Mutants are checked in-process (validate_artifact.check, the
function the CLI calls); the CLI itself is smoke-tested on the first pass row and the first fail row, exit codes
included. Exit 1 on any mismatch. Usage: run_mutants.py [MUTANT_DIR]   (default: tests/mutants; expected.tsv is read
from MUTANT_DIR/..)."""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VALIDATOR = os.path.join(ROOT, "validate_artifact.py")
sys.path.insert(0, ROOT)
import validate_artifact as V  # noqa: E402


def main(mdir):
    rows = [r.split("\t") for r in open(os.path.join(os.path.dirname(mdir.rstrip("/")), "expected.tsv"), encoding="utf-8").read().splitlines()[1:]]
    bad = 0
    for name, _base, exp, rule in rows:
        errs = V.check(json.load(open(os.path.join(mdir, name + ".json"), encoding="utf-8")))
        got = "fail" if errs else "pass"
        rules = {e.split()[0] for e in errs}
        ok = got == exp and (exp == "pass" or rule in rules)
        bad += not ok
        print("%s %-48s expected=%s/%s got=%s/%s" % ("MATCH   " if ok else "MISMATCH", name, exp, rule, got, ",".join(sorted(rules)) or "-"))
    for want in ("pass", "fail"):
        name = next(r[0] for r in rows if r[2] == want)
        rc = subprocess.run([sys.executable, VALIDATOR, os.path.join(mdir, name + ".json")], capture_output=True, text=True,
                            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1")).returncode
        if (rc == 0) != (want == "pass"):
            bad += 1
            print("MISMATCH CLI exit code %d on %s" % (rc, name))
    print("%d/%d rows match (CLI exit codes smoke-tested)" % (len(rows) - bad, len(rows)))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "mutants"))
