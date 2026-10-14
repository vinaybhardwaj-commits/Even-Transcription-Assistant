#!/usr/bin/env python3
"""Mutate out fut.cancel(), run only H9CancelPinned, confirm it FAILS, then restore the file."""
import subprocess, sys

PATH = "/Users/vinaybhardwaj/eta-router-pools/router_server.py"
LINE = '        fut.cancel()  # a call still queued at its deadline never starts (ETA-Refuter H9)\n'
MUTATED = '        pass  # H9 MUTATION: cancel() dropped for verification\n'

with open(PATH) as fh:
    src = fh.read()
assert src.count(LINE) == 1, f"expected exactly 1 occurrence, found {src.count(LINE)}"
mutated_src = src.replace(LINE, MUTATED)

with open(PATH, "w") as fh:
    fh.write(mutated_src)

try:
    r = subprocess.run(
        ["/Users/vinaybhardwaj/eta-router/.venv/bin/python", "-m", "unittest",
         "test_translate.H9CancelPinned", "-v"],
        cwd="/Users/vinaybhardwaj/eta-router-pools",
        capture_output=True, text=True, timeout=30)
    print(r.stdout)
    print(r.stderr)
    print("MUTATED_EXIT_CODE=", r.returncode)
finally:
    with open(PATH, "w") as fh:
        fh.write(src)
    with open(PATH) as fh:
        restored = fh.read()
    assert restored == src, "RESTORE FAILED — file does not match original!"
    print("RESTORED OK")
