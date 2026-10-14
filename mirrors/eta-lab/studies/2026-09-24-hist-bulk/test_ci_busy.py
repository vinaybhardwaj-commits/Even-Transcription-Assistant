#!/usr/bin/env python3
"""Tests for runner.ci_busy (refuter-2 #3374): a stub `ssh` first on PATH answers FREE / BUSY / garbage / nonzero exit / hangs; the real command string is also run through bash against a real lock file.
Run: python3 -B test_ci_busy.py"""
import importlib.util, os, subprocess, sys, tempfile, time
os.environ["HIST_RUN_ID"] = "t"
spec = importlib.util.spec_from_file_location("runner", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runner.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
d = tempfile.mkdtemp(); real_run = subprocess.run
def stub(body):
    open(d + "/ssh", "w").write("#!/bin/sh\n" + body + "\n"); os.chmod(d + "/ssh", 0o755)
os.environ["PATH"] = d + ":" + os.environ["PATH"]
def fast(*a, **k): k["timeout"] = 2; return real_run(*a, **k)   # the hang case must not take 40 s
m.subprocess.run = fast
cases = [("FREE", "echo FREE", False), ("BUSY", "echo BUSY", True), ("garbage", "echo hello", True), ("empty output", "true", True), ("ssh error rc=255", "echo 'ssh: connect timed out' >&2; exit 255", True), ("FREE but rc!=0", "echo FREE; exit 3", True), ("hang", "sleep 30", True)]
bad = []
for name, body, want in cases:
    stub(body); t = time.time(); got = m.ci_busy("h", "/tmp/a b;rm -rf x")   # a hostile path must only be quoted, never executed
    if got is not want: bad.append((name, got, want))
    if time.time() - t > 5: bad.append((name, "took too long", None))
# the quoted command really runs under a shell: missing file = FREE, unheld = FREE, held = BUSY
p = d + "/lock file"; import shlex; q = shlex.quote(p); cmd = f"if [ -e {q} ]; then flock -n {q} true && echo FREE || echo BUSY; else echo FREE; fi"
sh = lambda: real_run(["bash", "-c", cmd], capture_output=True, text=True).stdout.strip()
if sh() != "FREE": bad.append(("real missing", sh(), "FREE"))
open(p, "w").close()
if sh() != "FREE": bad.append(("real unheld", sh(), "FREE"))
h = subprocess.Popen(["flock", p, "sleep", "3"]); time.sleep(0.5)
if sh() != "BUSY": bad.append(("real held", sh(), "BUSY"))
h.wait()
# NODES must equal the c3 stack file's PORTS block (refuter-2 #3374/#3380): read from the file, no literals. STACK_C3=/path overrides the default (lab-mover's studies/2026-09-24-stt-parity/stack_versions.c3.json).
import json
sf = os.environ.get("STACK_C3") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-stt-parity", "stack_versions.c3.json")
n_ports = 0
if not os.path.exists(sf): bad.append(("stack file missing", sf, "set STACK_C3=<path to stack_versions.c3.json>"))
else:
    ports = json.load(open(sf)).get("ports") or {}
    for nm, key in ((":c3s0", "stack0"), (":c3s1", "stack1")):
        want = ("e2e-ci", (ports.get(key) or {}).get("router")); got = m.NODES.get(nm); n_ports += 1
        if got != want: bad.append((f"NODES[{nm}] vs stack file ports.{key}.router", got, want))
total = len(cases) + 3 + n_ports
for b in bad: print("FAIL", *b)
print(f"{total - len(bad)}/{total} passed"); sys.exit(1 if bad else 0)
