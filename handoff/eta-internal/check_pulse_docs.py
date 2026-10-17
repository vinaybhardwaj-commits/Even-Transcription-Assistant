#!/usr/bin/env python3
"""ETA-internal. S7/S8 tests on the Pulse-facing docs: README claims are validator rules or marked generator
guarantees, role-voter engines are not named, DESIGN-RATIONALE is not in the Pulse folder. Exit 1 on any failure."""
import os, re, sys

B = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eta-freescript-v1.0")
readme = open(os.path.join(B, "README-FOR-PULSE.md"), encoding="utf-8").read()
fails = []
MARK = "generator guarantee (not checked by validator)"
if os.path.exists(os.path.join(B, "DESIGN-RATIONALE.md")):
    fails.append("S8 DESIGN-RATIONALE.md is in the Pulse folder")
if re.search(r"(?<![a-z_])role_track\b|\bclef\b|\bjev\b", readme, re.I):
    fails.append("S8 README names a role-voter engine")
if "three independent role voters" not in readme:
    fails.append("S8 README does not describe the role voters neutrally")
for rule in ["V%d" % i for i in range(1, 19)]:
    if not re.search(r"^\| %s \|" % rule, readme, re.M):
        fails.append("S7 README guarantee table lacks %s" % rule)
for ln, line in enumerate(readme.split("\n"), 1):
    low = line.lower()
    if re.search(r"read back|zero-data-retention|never guesses|verbatim stt|measured|emits a record|never reworded", low) and MARK not in line:
        fails.append("S7 README line %d makes a generator claim without the marker" % ln)
if "Only the treating doctor's voice can support an order" not in readme:
    fails.append("S7 README lacks the A5 claim")
for f in fails:
    print("FAIL " + f)
print("doc checks: %d failure(s)" % len(fails))
sys.exit(1 if fails else 0)
