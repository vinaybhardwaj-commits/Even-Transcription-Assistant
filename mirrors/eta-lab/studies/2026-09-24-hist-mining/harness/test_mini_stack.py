#!/usr/bin/env python3
"""Offline test (no ssh to the Mini): the Mini's stack lookup + cross-check, and make_provenance for ':mini' (ruling 228). Synthetic docs in a temp git repo."""
import json, os, subprocess, sys, tempfile, time, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import provenance as pv, run_window as rw
import subprocess as _sp
_real_run = _sp.run
def _tripwire(cmd, *a, **k):
    if isinstance(cmd, (list, tuple)) and cmd and cmd[0] == "ssh" and any(str(x) == "mini" for x in cmd): raise AssertionError("TEST TRIED TO SSH TO THE MINI: " + " ".join(map(str, cmd))[:100])
    return _real_run(cmd, *a, **k)
_sp.run = _tripwire
rw.ROUTER_OPTS[":mini"]["gate_file"] = "/nonexistent/hist-mining/MINI_READY"; rw.ROUTER_OPTS[":mini"]["pause_file"] = "/nonexistent/hist/PAUSE.:mini"      # independent of the real files on this box

# --- parse: the stale-file check must really run (a missing `import time` once silently turned it into None) ---
now = int(time.time()); lstart = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(now))
out = f"UNIT|shim|lbl|{'a'*64}|{now-3600}|11|{lstart}\nUNIT|router|lbl2|{'b'*64}|{now+3600}|12|{lstart}\nUNIT|indic|lbl3|{'c'*64}|{now-10}||\nHEALTH|{{\"ok\": true}}\n"
r = pv.parse_mini_output(out)
assert r["units"]["shim"]["older_than_process"] is True and r["units"]["router"]["older_than_process"] is False, "file newer than its process must read False"
assert r["units"]["indic"]["older_than_process"] is None and r["units"]["indic"]["pid"] is None and r["router_healthz"] == {"ok": True}

live = lambda **kw: {"units": {"shim": {"sha256": "a"*64, "older_than_process": True}, "router": {"sha256": "b"*64, "older_than_process": True}, "indic": {"sha256": "c"*64, "older_than_process": True}, "whisper": {"sha256": "d"*64, "older_than_process": True}, **kw}}
doc = {"stack_id": "mini123", "source": "minibot", "stack": {"whisper": {"model": "m", "flags": {"vad": "off", "temperature_inc": "0.2", "no_speech_thold": "0.7", "suppress_nst": "true", "max_context": "0"}}, "indic_conformer": {"model_id": "i", "git_head": "g"}, "sravaani": {"version": "Yoga (lab-mover owns)"}, "router": {"commit": "c", "config_sha256": "x"}},
       "guards": {"shim_anti_loop": "aaaaaaaa shim", "english_hallucination_guard": "bbbbbbbb router", "transcript_guard": "runs in the Vercel app", "loop_guard_number_rule": "not deployed"}, "notes": "cccccccc dddddddd"}
with tempfile.TemporaryDirectory() as g:
    subprocess.run(["git", "init", "-q", "-b", "main", g], check=True); os.makedirs(f"{g}/studies/2026-09-24-redundancy")
    os.environ["HIST_STACK_GIT_REPO"] = g; os.environ["HIST_STACK_GIT_REF"] = "main"
    # 1. nothing committed yet -> not published, reason stated
    open(f"{g}/x", "w").write("x"); subprocess.run(["git", "-C", g, "add", "-A"], check=True); subprocess.run(["git", "-C", g, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "0"], check=True)
    d0, s0, p0, why = pv.published_mini_stack(live()); assert d0 is None and "no stack_versions.mini" in why, why
    # 2. a committed doc that the running Mini agrees with
    open(f"{g}/studies/2026-09-24-redundancy/stack_versions.mini-mini123.json", "w").write(json.dumps(doc))
    subprocess.run(["git", "-C", g, "add", "-A"], check=True); subprocess.run(["git", "-C", g, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "1"], check=True)
    d1, s1, p1, det = pv.published_mini_stack(live()); assert d1 and d1["stack_id"] == "mini123" and all(v["in_doc"] for v in det.values()) and len(s1) == 64
    # 3. drift: the running router script is not the one in the doc -> refused
    d2, _, _, why = pv.published_mini_stack(live(router={"sha256": "e"*64, "older_than_process": True})); assert d2 is None and "drift" in why
    # 4. stale file: a script NEWER than its process -> refused even though the hash is in the doc
    d3, _, _, why = pv.published_mini_stack(live(shim={"sha256": "a"*64, "older_than_process": False})); assert d3 is None
    # 5. a non-Mini file name in the directory is ignored
    open(f"{g}/studies/2026-09-24-redundancy/stack_versions.other.json", "w").write(json.dumps(doc)); assert len(pv.git_docs("studies/2026-09-24-redundancy", r"stack_versions\.mini-[A-Za-z0-9_.\-]+\.json")) == 1
    for k in ("HIST_STACK_GIT_REPO", "HIST_STACK_GIT_REF"): os.environ.pop(k, None)
print("mini-stack test OK: stale-file check really runs, no committed doc / drift / stale file -> refused with a reason, an agreeing committed doc is chosen, non-Mini names ignored")

# --- make_provenance for ':mini' through the harness (collector stubbed, temp git repo) ---
import glob
with tempfile.TemporaryDirectory() as g:
    subprocess.run(["git", "init", "-q", "-b", "main", g], check=True); os.makedirs(f"{g}/studies/2026-09-24-redundancy"); open(f"{g}/x", "w").write("x")
    os.environ["HIST_STACK_GIT_REPO"] = g; os.environ["HIST_STACK_GIT_REF"] = "main"
    def commit(name, body, msg):
        open(f"{g}/studies/2026-09-24-redundancy/{name}", "w").write(body); subprocess.run(["git", "-C", g, "add", "-A"], check=True); subprocess.run(["git", "-C", g, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], check=True)
    subprocess.run(["git", "-C", g, "add", "-A"], check=True); subprocess.run(["git", "-C", g, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "0"], check=True)
    rec = {"cut": {"chunk_keys": ["k1"]}, "versions": {"pinned_prod_sha": "5970852"}}
    RID = "hist-bulk-20260924T2200-abcdef0"
    _gate = tempfile.NamedTemporaryFile(delete=False); _gate.close(); _old_gate = rw.ROUTER_OPTS[":mini"]["gate_file"]; rw.ROUTER_OPTS[":mini"]["gate_file"] = _gate.name      # a temp gate file: the collector below is a STUB, nothing reaches the Mini
    stub = {"live": live(), "n": 0}
    def fake_collect(alias="mini"): stub["n"] += 1; return {**stub["live"], "collected_at": "t"}
    pv.collect_mini = fake_collect
    def fresh(): rw._MINI_LIVE.update(t=0.0, live=None, err=None)
    rw.ROUTER_OPTS[":mini"]["gate_file"] = _gate.name + ".absent"; fresh(); n_before = stub["n"]; g0 = rw.make_provenance(":mini", rec, RID)
    assert stub["n"] == n_before and g0["provenance_complete"] is False and any("gated" in x for x in g0["notes"]["gaps"]), "gate closed: the collector must not even be called"
    rw.ROUTER_OPTS[":mini"]["gate_file"] = _gate.name
    fresh(); a = rw.make_provenance(":mini", rec, RID)      # no committed doc: honest null block, reason stated
    assert a["provenance_complete"] is False and a["stack_id"] is None and any("committed" in x for x in a["notes"]["gaps"]), a["notes"]
    commit("stack_versions.mini-mini123.json", json.dumps(doc), "doc")
    fresh(); b = rw.make_provenance(":mini", rec, RID)      # doc committed + running Mini agrees
    assert b["provenance_complete"] is True and b["stack_id"] == "mini123" and b["stack"]["whisper"]["flags"]["temperature_fallback"] == "on" and b["served_by"]["node"] == "mini-production" and b["producer"] == "hist-bulk"
    assert b["stack"]["sravaani"]["version"].startswith("Yoga") and b["stack_versions_sha256"] == hashlib.sha256(json.dumps(doc).encode()).hexdigest(), "the doc is embedded verbatim (its blob hash is the sha)"
    n0 = stub["n"]; rw.make_provenance(":mini", rec, RID); assert stub["n"] == n0, "the live read is cached (10 min)"
    fresh(); stub["live"] = live(router={"sha256": "9"*64, "older_than_process": True}); c = rw.make_provenance(":mini", rec, RID)      # the running router changed: drift
    assert c["provenance_complete"] is False and c["stack_id"] is None and all(v is None for _, v in rw._flat(c["guards"])), "drift must fall back to the null block, never to a stale doc"
    fresh(); pv.collect_mini = lambda alias="mini": (_ for _ in ()).throw(RuntimeError("ssh down")); d = rw.make_provenance(":mini", rec, RID)
    assert d["provenance_complete"] is False and any("could not be read" in x for x in d["notes"]["gaps"])
    rw.ROUTER_OPTS[":mini"]["gate_file"] = _old_gate; os.unlink(_gate.name)
    for k in ("HIST_STACK_GIT_REPO", "HIST_STACK_GIT_REF"): os.environ.pop(k, None)
print("mini provenance through the harness OK: no doc -> null block + reason; committed + agreeing doc -> used verbatim, complete, hash = blob; drift -> null block; ssh down -> null block; live read cached")


# --- pause file + incomplete_reason (minibot #1061, lab-viewer #1062) ---
import tempfile as _tf
with _tf.TemporaryDirectory() as d:
    gate = f"{d}/MINI_READY"; pause = f"{d}/PAUSE.:mini"; open(gate, "w").close()
    o = rw.ROUTER_OPTS[":mini"]; saved = (o["gate_file"], o["pause_file"]); o["gate_file"] = gate; o["pause_file"] = pause
    try:
        rw._MINI_LIVE.update(t=0.0, live=None, err=None)
        open(pause, "w").close()
        live_, err_ = rw._mini_live(":mini"); assert live_ is None and "paused" in err_, err_          # a PAUSE.:mini file: the collector is not called either
        try: rw.run_window([], None, None, ":mini", None, "wp", room_id="r", files={}); raise AssertionError("PAUSE.:mini must stop a window")
        except RuntimeError as e: assert "PAUSED" in str(e), e
        os.unlink(pause)
        try: rw.run_window([], None, None, ":mini", None, "wp", room_id="r", files={}); 
        except RuntimeError as e: assert "PAUSED" not in str(e) and "GATED" not in str(e), e      # gate open, pause gone: it gets past both checks (and fails later for unrelated reasons)
        except Exception: pass
    finally: o["gate_file"], o["pause_file"] = saved
    rw._MINI_LIVE.update(t=0.0, live=None, err=None)
pv_null = rw.make_provenance(":mini", {"cut": {"chunk_keys": ["k"]}}, "hist-bulk-20260924T2200-abcdef0")      # gate closed here: incomplete, with a reason
assert pv_null["provenance_complete"] is False and pv_null.get("incomplete_reason") and len(pv_null["incomplete_reason"]) > 10, pv_null.get("incomplete_reason")
print("pause + incomplete_reason OK: PAUSE.:mini stops the window and the read, an open gate without pause proceeds, every incomplete Mini record carries a non-empty incomplete_reason")
