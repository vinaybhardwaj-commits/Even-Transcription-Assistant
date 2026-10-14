#!/usr/bin/env python3
"""Tests for runner.require_parity_389 (refuter-2 #2429/#2458). Run: python3 -B test_parity_gate.py"""
import importlib.util, json, os, tempfile
os.environ["HIST_RUN_ID"] = "t"
spec = importlib.util.spec_from_file_location("runner", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runner.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
d = tempfile.mkdtemp(); FULL = "c85d1e6e" + "0" * 56
def run(pass_body, stack_body):
    m.PARITY_PASS = d + "/p"
    if pass_body is None:
        if os.path.exists(d + "/p"): os.unlink(d + "/p")
    else: open(d + "/p", "w").write(pass_body if isinstance(pass_body, str) else json.dumps(pass_body))
    open(d + "/s", "w").write(stack_body if isinstance(stack_body, str) else json.dumps(stack_body))
    try: m.require_parity_389(d + "/s"); return "ALLOWED"
    except SystemExit: return "REFUSED"
ok = {"bus_id": 1, "manifest_sha": "c85d1e6e"}
cases = [("no PASS file", None, {"manifest_sha": "c85d1e6e"}, "REFUSED"), ("PASS not JSON", "x", {"manifest_sha": "c85d1e6e"}, "REFUSED"), ("PASS without bus_id", {"manifest_sha": "c85d1e6e"}, {"manifest_sha": "c85d1e6e"}, "REFUSED"),
         ("PASS 4-char sha", {"bus_id": 1, "manifest_sha": "c85d"}, {"manifest_sha": "c85d"}, "REFUSED"), ("stack without manifest_sha", ok, {}, "REFUSED"), ("stack other manifest", ok, {"manifest_sha": "8c7a55be"}, "REFUSED"),
         ("stack 4-char prefix", ok, {"manifest_sha": "c85d"}, "REFUSED"), ("stack 1-char prefix", ok, {"manifest_sha": "c"}, "REFUSED"), ("stack 7-char prefix", ok, {"manifest_sha": "c85d1e6"}, "REFUSED"),
         ("stack non-hex", ok, {"manifest_sha": "zzzzzzzz"}, "REFUSED"), ("match 8", ok, {"manifest_sha": "c85d1e6e"}, "ALLOWED"), ("match full vs 8", ok, {"manifest_sha": FULL}, "ALLOWED"),
         ("match full vs full", {"bus_id": 1, "manifest_sha": FULL}, {"manifest_sha": FULL}, "ALLOWED"), ("full mismatch", {"bus_id": 1, "manifest_sha": FULL}, {"manifest_sha": "c85d1e6f" + "0" * 56}, "REFUSED")]
bad = [(n, got, want) for n, pb, sb, want in cases for got in [run(pb, sb)] if got != want]
for n, got, want in bad: print("FAIL", n, "got", got, "want", want)
print(f"{len(cases) - len(bad)}/{len(cases)} passed"); raise SystemExit(1 if bad else 0)
