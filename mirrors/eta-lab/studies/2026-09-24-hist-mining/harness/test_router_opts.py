#!/usr/bin/env python3
"""Offline test (no ssh): per-router options and the Mini's stack_kind (minibot #929 / ruling 219 B). Default routers must get EXACTLY the commands they always got; the Mini gets its own workdir + python and NEVER the twin stack block."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_window as rw, provenance
import subprocess as _sp
_real_run = _sp.run
def _tripwire(cmd, *a, **k):
    if isinstance(cmd, (list, tuple)) and cmd and cmd[0] == "ssh" and any(str(x) == "mini" for x in cmd): raise AssertionError("TEST TRIED TO SSH TO THE MINI: " + " ".join(map(str, cmd))[:100])
    return _real_run(cmd, *a, **k)
_sp.run = _tripwire      # any test that would really touch the Mini fails loudly

# The tests must NOT depend on the real MINI_READY / PAUSE.:mini files (MINI_READY now exists on this box): point the Mini's gate at a path that does not exist, unless a test opens its own.
rw.ROUTER_OPTS[":mini"]["gate_file"] = "/nonexistent/hist-mining/MINI_READY"; rw.ROUTER_OPTS[":mini"]["pause_file"] = "/nonexistent/hist/PAUSE.:mini"; rw._MINI_LIVE.update(t=0.0, live=None, err=None)

# 1. default (twin) routers: byte-identical to the commands used all night
push, run, pull, clean = rw.remote_cmds(":30100", "w1", 8083, 1800)
assert push == "umask 077; mkdir -p histwork; cat > histwork/w1.webm", push
assert run == "python3 histwork/node_route.py --router http://127.0.0.1:8083 --audio histwork/w1.webm --out histwork/w1.json --timeout 1800", run
assert pull == "cat histwork/w1.json; rm -f histwork/w1.json histwork/w1.webm" and clean == "rm -f histwork/w1.webm histwork/w1.json"
for k in (":38083", ":48083", ":30204"): assert rw.remote_cmds(k, "w", 8083, 5)[1].startswith("python3 histwork/node_route.py"), k
# 2. the Mini: its own workdir and the pyenv python that has requests; still one job, loopback router, no token
push, run, pull, clean = rw.remote_cmds(":mini", "w1", 8083, 1800)
assert push == "umask 077; mkdir -p hist-lab; cat > hist-lab/w1.webm", push
assert run == "/Users/vinaybhardwaj/.pyenv/versions/3.13.9/bin/python3 hist-lab/node_route.py --router http://127.0.0.1:8083 --audio hist-lab/w1.webm --out hist-lab/w1.json --timeout 1800", run
assert "histwork" not in "".join((push, run, pull, clean))
# 3. the Mini's provenance never borrows the twin stack; it is honestly incomplete
provenance._CACHE.clear()
rec = {"cut": {"chunk_keys": ["k1"]}, "versions": {"pinned_prod_sha": "5970852"}}
pv = rw.make_provenance(":mini", rec, "hist-bulk-20260924T2100-abcdef0")
assert pv["provenance_complete"] is False and pv["stack_id"] is None and pv["temperature_fallback"] == "on" and pv["served_by"]["node"] == "mini-production"
assert all(v is None for k, v in rw._flat(pv["stack"]) if k != "whisper.flags.temperature_fallback") and all(v is None for _, v in rw._flat(pv["guards"])), "no twin value may leak into a Mini record"
assert pv["producer"] == "hist-bulk" and pv["source_audio_keys"] == ["k1"] and any("NO usable published stack_versions" in g for g in pv["notes"]["gaps"]) and any("gated" in g for g in pv["notes"]["gaps"])
twin = rw.ROUTER_OPTS.get(":30100", {}).get("stack_kind", "hist-twin"); assert twin == "hist-twin"
print("router-options test OK: twin routers keep their exact commands; the Mini gets hist-lab + the pyenv python; a Mini record carries NO twin stack value and provenance_complete is false, with the gap stated")


# --- translate option (default OFF, changes nothing else) ---
push, run, pull, clean = rw.remote_cmds(":30100", "w1", 8083, 1800, False)
assert run == "python3 histwork/node_route.py --router http://127.0.0.1:8083 --audio histwork/w1.webm --out histwork/w1.json --timeout 1800", "default must be byte-identical"
assert rw.remote_cmds(":30100", "w1", 8083, 1800, True)[1] == run + " --translate" and rw.remote_cmds(":30100", "w1", 8083, 1800, True)[0] == push
assert rw.remote_cmds(":mini", "w1", 8083, 1800, True)[1].endswith("--timeout 1800 --translate") and rw.remote_cmds(":mini", "w1", 8083, 1800, True)[1].startswith("/Users/vinaybhardwaj/.pyenv")
res = {"ok": True, "elapsed_s": 1.0, "router": "r", "result": {"state": "done", "dominant_language": "kn", "transcript_native": "ನಮಸ್ಕಾರ ನಮಸ್ಕಾರ ನಮಸ್ಕಾರ ನಮಸ್ಕಾರ ನಮಸ್ಕಾರ ನಮಸ್ಕಾರ", "transcript_english": "hello hello hello hello hello hello and take the tablet", "language_timeline": []}}
r = rw.build_record(res, {"window_id": "t", "translate": True})
import collapse as _c
_expect = _c.collapse([res["result"]["transcript_english"]])[0][0]["text"]      # whatever the PINNED production function returns: the test does not guess its output
assert r["transcript_english"].startswith("hello") and r["transcript_english_collapsed"] == _expect and _expect != r["transcript_english"] and "take the tablet" in _expect, (r.get("transcript_english_collapsed"), _expect)      # the pinned production collapse also runs on the English, as in production
assert "transcript_english" not in rw.build_record({"ok": True, "result": {"state": "done", "transcript_native": "x", "language_timeline": []}}, {}), "no English key when translate is off"
import provenance as _pv
_pv._CACHE.clear(); _pv._CACHE[":30100"] = {"router_url_port": ":30100", "node": "hist-cpu-1", "router_version": "3.1", "whisper_model": "large-v3-turbo", "collected_at": "t", "missing": [], "units": {}, "whisper": {}}
p1 = rw.make_provenance(":30100", {"translate": True, "cut": {}}, "hist-bulk-20260924T2200-abcdef0"); p0 = rw.make_provenance(":30100", {"cut": {}}, "hist-bulk-20260924T2200-abcdef0")
assert p1["harness"]["request_shape"]["translate"] is True and p0["harness"]["request_shape"]["translate"] is False and any("NOT exposed" in n for n in p1["notes"]["derived"]) and not any("translate=true" in n for n in p0["notes"]["derived"])
pm = rw.make_provenance(":mini", {"translate": True, "cut": {}}, "hist-bulk-20260924T2200-abcdef0"); assert pm["harness"]["request_shape"]["translate"] is True
_pv._CACHE.clear()
print("translate option OK: default commands byte-identical; --translate appended only when asked (also for the Mini); English kept and collapsed by the pinned function; the flag and an honest 'model/prompt not exposed' note are in provenance")
