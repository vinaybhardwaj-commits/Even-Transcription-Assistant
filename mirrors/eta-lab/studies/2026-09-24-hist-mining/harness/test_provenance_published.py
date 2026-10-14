#!/usr/bin/env python3
"""Offline test (no ssh): the published-stack-versions path of run_window.make_provenance (ruling 184). Synthetic files only."""
import hashlib, json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import provenance, run_window as rw

live = {"router_url_port": ":30100", "node": "hist-cpu-1", "router_version": "3.1-sravaani", "whisper_model": "large-v3-turbo", "indicconformer_id": "600M", "sravaani_version": "SraVaani-1.0", "collected_at": "t", "missing": [],
        "units": {"router": {"active_since": "a", "config_sha256": "c" * 64, "files": {"router_server.py": {"sha256_16": "400710eeb45cf095", "mtime": 1}}, "guards": {"router_server_sha256": "400710eeb45cf095" + "0" * 48, "english_hallucination_guard_refs": 1}},
                  "indic": {"active_since": "b", "files": {"indic_server.py": {"sha256_16": "333c687c277f7629", "mtime": 1}}, "hf_snapshots": [{"model": "m", "revision": "e9b71b36"}]},
                  "sravaani": {"active_since": "c", "files": {"sravaani_server.py": {"sha256_16": "907b7d8180557b56", "mtime": 1}}, "hf_snapshots": [{"model": "s", "revision": "f5dd5358"}]}},
        "whisper": {"node": "hist-gpu-1", "units": {"whisper-shim-vpc.service": {"files": {"whisper-shim.py": "c24fd097"}}}, "server_flags": {"no_speech_thold": 0.7, "suppress_nst": True, "vad_flag_in_argv": False, "temperature_inc_in_argv": None}, "shim_max_context_default": 0}}
doc = {"stack_id": "0b12949986df", "source": "lab-mover", "stack": {"whisper": {"model": "ggml-large-v3-turbo sha256 1fc70f77", "flags": {"vad": "off", "temperature_inc": "0.2 (whisper.cpp default)", "no_speech_thold": "0.7", "suppress_nst": "true", "max_context": "0"}},
       "indic_conformer": {"model_id": "ai4bharat/indic-conformer-600m-multilingual@e9b71b3", "git_head": "643e4e1; indic_server.py sha256 333c687c..."}, "sravaani": {"version": "SraVaani-1.0@f5dd5358; sravaani_server.py sha256 907b7d81..."},
       "router": {"commit": "5e841f0; router_server.py sha256 400710ee...", "config_sha256": "b002c617791f"}},
       "guards": {"shim_anti_loop": "sha", "english_hallucination_guard": "router file sha 400710ee", "transcript_guard": "source only", "loop_guard_number_rule": "not deployed"}}
rec = rw.build_record({"ok": True, "elapsed_s": 1.0, "router": "r", "result": {"state": "done", "dominant_language": "en", "transcript_native": "hello", "language_timeline": []}}, {"cut": {"chunk_keys": ["k"]}})
with tempfile.TemporaryDirectory() as d:
    provenance.STACK_DIR = d; provenance._CACHE[":30100"] = live
    body = json.dumps(doc).encode(); sha = hashlib.sha256(body).hexdigest(); open(f"{d}/stack_versions.json", "wb").write(body)
    # 1. a file whose sha is NOT published is ignored (same stack_id, different bytes = the overwrite case)
    provenance.PUBLISHED_STACK_SHAS = ("0" * 64,)
    pv = rw.make_provenance(":30100", rec, "hist-miner-20260924T1900-abc1234")
    assert pv["notes"].get("gaps") and any("PUBLISHED" in g for g in pv["notes"]["gaps"]), pv["notes"]
    assert pv["stack"]["router"]["commit"].startswith("router_server.py sha256:"), "fallback = my live-read block"
    # 2. published: source of truth, sha embedded, cross-check passes
    provenance.PUBLISHED_STACK_SHAS = (sha,)
    pv = rw.make_provenance(":30100", rec, "hist-miner-20260924T1900-abc1234")
    assert {k: v for k, v in pv["stack"].items() if k != "whisper"} == {k: v for k, v in doc["stack"].items() if k != "whisper"} and pv["guards"] == doc["guards"] and pv["stack_versions_sha256"] == sha and pv["stack_id"] == "0b12949986df", "stack + guards come from lab-mover's file verbatim"
    assert pv["provenance_complete"] is True and all(pv["notes"]["cross_check_against_running_system"].values()), pv.get("missing")
    assert pv["temperature_fallback"] == "on" and pv["stack"]["whisper"]["flags"]["temperature_fallback"] == "on", "also on the published-stack path"
    assert pv["stack"] != doc["stack"] and pv["stack_versions_sha256"] == sha, "the embedded stack gained one flag; the hash is still the unmodified file's"
    assert pv["served_by"] == {"node": "hist-cpu-1", "router_port": ":30100"} and pv["live_check"]["unit_active_since"]["router"] == "a"
    # 3. drift: the running router script is NOT the one in the published file -> incomplete, says so
    drift = json.loads(json.dumps(live)); drift["units"]["router"]["files"]["router_server.py"]["sha256_16"] = "deadbeefdeadbeef"; provenance._CACHE[":30100"] = drift
    pv = rw.make_provenance(":30100", rec, "hist-miner-20260924T1900-abc1234")
    assert pv["provenance_complete"] is False and any("stack drift" in m for m in pv["missing"]), pv.get("missing")
    # 4. a tampered published file (bytes changed, sha no longer matches) is refused
    provenance._CACHE[":30100"] = live; open(f"{d}/stack_versions.json", "wb").write(body + b" ")
    pv = rw.make_provenance(":30100", rec, "hist-miner-20260924T1900-abc1234"); assert pv["stack_versions_sha256"] != sha
provenance._CACHE.pop(":30100", None)
print("published-stack test OK: unpublished bytes ignored (fallback stated), published file used verbatim with its sha + stack_id, drift flips provenance_complete, tampered file refused")

# 5. the trust anchor is the GIT BLOB: a stack_versions.*.json committed on the ref is trusted without any hard-coded sha (eta-refuter-2 #775)
import subprocess
with tempfile.TemporaryDirectory() as g, tempfile.TemporaryDirectory() as d2:
    subprocess.run(["git", "init", "-q", "-b", "main", g], check=True); os.makedirs(f"{g}/studies/2026-09-24-stt-parity")
    body2 = json.dumps({**doc, "stack_id": "feedfacecafe"}).encode(); open(f"{g}/studies/2026-09-24-stt-parity/stack_versions.feedfacecafe.json", "wb").write(body2)
    subprocess.run(["git", "-C", g, "add", "-A"], check=True); subprocess.run(["git", "-C", g, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"], check=True)
    os.environ["HIST_STACK_GIT_REPO"] = g; os.environ["HIST_STACK_GIT_REF"] = "main"
    assert hashlib.sha256(body2).hexdigest() in provenance.git_published_shas()
    provenance.STACK_DIR = d2; provenance.PUBLISHED_STACK_SHAS = ("0" * 64,)
    open(f"{d2}/stack_versions.json", "wb").write(body2)                       # on-disk copy == the committed blob: trusted
    got = provenance.published_stack_versions(); assert got and got[1] == hashlib.sha256(body2).hexdigest() and got[0]["stack_id"] == "feedfacecafe"
    open(f"{d2}/stack_versions.json", "wb").write(body2 + b" ")               # same stack_id, different bytes: NOT trusted
    assert provenance.published_stack_versions() is None
    for k in ("HIST_STACK_GIT_REPO", "HIST_STACK_GIT_REF"): os.environ.pop(k, None)
print("git-blob anchor test OK: a committed stack_versions blob is trusted with no hard-coded sha; same stack_id with different bytes is refused")
