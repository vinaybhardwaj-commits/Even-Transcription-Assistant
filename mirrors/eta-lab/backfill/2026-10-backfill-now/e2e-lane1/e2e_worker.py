#!/usr/bin/env python3
"""e2e_worker.py — HF-4: ONE process per GPU (CUDA_VISIBLE_DEVICES=i set by run_e2e_lane1.sh) that produces the 3 lane-1 Whisper tracks for windows of a work list, on an E2E node.
The transcription/identity code is vendor/whisper3_hf_job.py, BYTE-IDENTICAL to hf-lane1/whisper3_hf_job.py (sha16 3bec47c98551c29b, asserted below): Engine, decode_to_16k_mono, CONFIGS, is_blind, startup_checks,
the embedded blind list. process_window() below is that job's per-window body (main()), line for line, so the tracks carry the lane hashes e0d31902 / 5a550766 / 2e3b6c81; only track['machine'] and provenance.host differ.
Per window, in this order (fail closed): blind check (embedded list, BEFORE the audio is opened or a claim taken) -> skip if the out file exists -> claim all needed tracks (O_EXCL, job id e2e-<node>-<gpu>; same
claims-dir layout as launch_lane.claim) -> audio_sha256 check against the work list (tampered/missing file refused, nothing written, claims moved to _released) -> transcribe -> write-once out/<win>.json.
Prints counts/ids only, never transcript text. PAUSE file: sleep; STOP file: exit after the current window."""
import argparse, hashlib, json, os, platform, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "vendor"))
import whisper3_hf_job as JM
JOB_SHA16 = "3bec47c98551c29b"      # the lane-1 job file the HF pilot ran (HF-1c-REPORT); vendored copy must match
IST = JM.IST

def sha16(p): return JM.sha256_file(p)[:16]

def claim_path(root, engine, win): return f"{root}/{engine}__{JM.LANE_HASHES[engine]}/{win}"

def claim(root, engine, win, owner):
    d = f"{root}/{engine}__{JM.LANE_HASHES[engine]}"; os.makedirs(d, mode=0o700, exist_ok=True)
    try: fd = os.open(f"{d}/{win}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError: return False
    with os.fdopen(fd, "w") as f: json.dump({"owner": owner, "job": owner, "t": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
    return True

def release(root, engine, win, why):
    """MOVE (never delete) the claim to _released/<ts>/..., only if it still records this process's job id (set at claim time)."""
    src = claim_path(root, engine, win)
    if not os.path.exists(src): return False
    dst = f"{root}/_released/{time.strftime('%Y%m%dT%H%M%S')}-{why}/{engine}__{JM.LANE_HASHES[engine]}"; os.makedirs(dst, mode=0o700, exist_ok=True)
    os.rename(src, f"{dst}/{win}"); return True

def write_once(path, obj):
    """tmp file fsynced, then os.link (atomic create-if-absent). Returns False if the file already exists (never overwritten)."""
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.{os.getpid()}.tmp")
    with open(tmp, "w") as f: json.dump(obj, f, ensure_ascii=False); f.flush(); os.fsync(f.fileno())
    try: os.link(tmp, path); return True
    except FileExistsError: return False
    finally: os.unlink(tmp)

def startup(env):
    if sha16(os.path.join(HERE, "vendor", "whisper3_hf_job.py")) != JOB_SHA16: raise SystemExit("REFUSED: vendored job file sha16 != 3bec47c98551c29b")
    e = dict(env); e["EXPECT_SCRIPT_SHA16"] = JOB_SHA16; e.setdefault("HELDOUT_SHA16", JM.HELDOUT_SHA16)
    e.setdefault("EXPECT_BLIND_SHA16", JM.blind_list_sha16(JM.BLIND)); e.setdefault("MODEL_ID", "openai/whisper-large-v3-turbo"); e.setdefault("MODEL_REVISION", JM.PINNED_REVISION)
    if e.get("EXPECT_BLIND_SHA16") != JM.blind_list_sha16(JM.BLIND): raise SystemExit("REFUSED: EXPECT_BLIND_SHA16 mismatch")
    JM.startup_checks(e, script_path=os.path.join(HERE, "vendor", "whisper3_hf_job.py"))     # pins: heldout, blind list, model, revision, lane hashes != box hashes
    if e["MODEL_ID"] != "openai/whisper-large-v3-turbo" or e["MODEL_REVISION"] != JM.PINNED_REVISION: raise SystemExit("REFUSED: model/revision")
    return e

def host_info(node, gpu, eng):
    import importlib.metadata as md
    t = eng.torch
    try: gname = t.cuda.get_device_name(0) if eng.dev == "cuda" else "cpu"
    except Exception: gname = "unknown"
    return {"node": node, "gpu": gpu, "gpu_name": gname, "torch": t.__version__, "cuda": getattr(t.version, "cuda", None), "transformers": md.version("transformers"),
            "python": platform.python_version(), "worker_sha16": sha16(__file__), "job_sha16": JOB_SHA16}

def process_window(eng, w, ap, machine, prov):
    """The job's per-window body (whisper3_hf_job.main) with only `machine` taken from the caller. Returns (doc, dur) or (None, err)."""
    wid = w["win_id"]; x = JM.decode_to_16k_mono(ap); dur = len(x) / 16000.0
    stub = {"window_id": wid, "room_id": w["room"], "room_slug": w["room"], "ist_date": w["ist_date"], "t0_ms": JM.parse_iso_ms(w["start"]), "t1_ms": JM.parse_iso_ms(w["end"]),
            "audio": {"r2_key": os.path.basename(w["audio"]), "sha256": JM.sha256_file(ap), "sample_rate": 16000, "duration_ms": int(dur * 1000)}}
    chunks = [(c0, min(len(x), c0 + 480000), x[c0:c0 + 480000]) for c0 in range(0, len(x), 480000) if len(x[c0:c0 + 480000]) >= 4000]
    tracks = {}; need = [e for e in w.get("need", list(JM.CONFIGS)) if e in JM.CONFIGS]
    det = eng.detect(x) if (chunks and "whisper-auto" in need) else None
    for e in need:
        c, h = JM.CONFIGS[e]; lang = "en" if e != "whisper-auto" else (det[0] if det else None); segs, err = [], None
        try:
            segs = eng.run(chunks, lang, e == "whisper-cap2") if chunks else []
            if e == "whisper-auto" and segs and det: segs[0]["extras"]["lid"] = {"detected": det[0], "p": det[1], "probs": det[2], "scored_ms": [0, min(30000, int(dur * 1000))]}
        except Exception as ex: err = type(ex).__name__ + ": " + str(ex)[:150]
        tracks[e] = {"schema": "reb.track.v1", "window_id": wid, "layer": "stt", "engine": e, "model": JM.MODEL_NAME, "version": JM.VERSION, "config": c, "config_hash": h, "machine": machine,
                     "status": "failed" if err else ("ok" if segs else "empty"), "reason": err, "segments": segs, "provenance": prov}
    if any(t["status"] == "failed" for t in tracks.values()): return None, "track_failed"
    return {"manifest_stub": stub, "tracks": tracks}, dur

def paused(run_dir):
    return os.path.exists(f"{run_dir}/PAUSE")

def run(a, env=os.environ, engine_cls=None):
    e = startup(env); engine_cls = engine_cls or JM.Engine
    wl = [json.loads(l) for l in open(a.worklist) if l.strip()]
    for d in (a.out, a.claims, a.run_dir, f"{a.run_dir}/logs"): os.makedirs(d, mode=0o700, exist_ok=True)
    owner = f"e2e-{a.node}-{a.gpu}"; machine = f"e2e-node:{a.node}:gpu{a.gpu}"
    eng = engine_cls(e["MODEL_ID"], e["MODEL_REVISION"], False)
    host = host_info(a.node, a.gpu, eng) if hasattr(eng, "torch") else {"node": a.node, "gpu": a.gpu, "worker_sha16": sha16(__file__), "job_sha16": JOB_SHA16}
    prov = {"runtime": {"impl": "transformers-generate", "model_id": e["MODEL_ID"], "model_revision": e["MODEL_REVISION"], "dtype": str(eng.dtype), "device": eng.dev,
                        "differs_from_box": "box tracks = whisper.cpp ggml-large-v3-turbo + --no-speech-thold 0.7 --suppress-nst"},
            "script_sha16": JOB_SHA16, "heldout_sha16": JM.HELDOUT_SHA16, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S+05:30", time.gmtime(time.time() + 19800)), "host": host}
    n = {"done": 0, "blind": 0, "skip_exists": 0, "claim_lost": 0, "tampered": 0, "audio_missing": 0, "failed": 0}
    k = a.gpu_index_offset % max(1, len(wl)); order = wl[k:] + wl[:k]                 # rotate the start so 8 workers do not all fight for the same first claim
    t0 = time.time()
    def log(msg): print(f"[{owner}] {msg}", flush=True)
    def fail(wid, why): open(f"{a.run_dir}/failed.jsonl", "a").write(json.dumps({"win_id": wid, "why": why, "by": owner, "t": time.strftime("%Y-%m-%dT%H:%M:%S")}) + "\n")
    for w in order:
        if os.path.exists(f"{a.run_dir}/STOP"): log("STOP file: exiting"); break
        while paused(a.run_dir) and not os.path.exists(f"{a.run_dir}/STOP"): time.sleep(5)
        wid = w.get("win_id", "?")
        if JM.is_blind(w): n["blind"] += 1; log(f"{wid}: BLIND refused (audio not opened)"); continue                       # fail closed, before any claim or file open
        outp = f"{a.out}/{wid}.json"
        if os.path.exists(outp): n["skip_exists"] += 1; continue
        need = [t for t in w.get("need", list(JM.CONFIGS)) if t in JM.CONFIGS]; got = [t for t in need if claim(a.claims, t, wid, owner)]
        if len(got) != len(need):
            for t in got: release(a.claims, t, wid, "lost-race")
            n["claim_lost"] += 1; continue
        ap = os.path.join(a.audio, w["audio"])                                                 # w['audio'] is the relative <day>/<room>/<file>
        try:
            if not os.path.isfile(ap): n["audio_missing"] += 1; fail(wid, "audio_missing"); [release(a.claims, t, wid, "audio-missing") for t in got]; continue
            if JM.sha256_file(ap) != w.get("audio_sha256"): n["tampered"] += 1; log(f"{wid}: audio sha256 != work list: REFUSED"); fail(wid, "audio_sha256_mismatch"); [release(a.claims, t, wid, "sha-mismatch") for t in got]; continue
            t1 = time.time(); doc, dur = process_window(eng, {**w, "audio": os.path.basename(w["audio"])}, ap, machine, prov)
        except Exception as ex:
            doc, dur = None, type(ex).__name__
        if doc is None: n["failed"] += 1; fail(wid, str(dur)); [release(a.claims, t, wid, "failed") for t in got]; log(f"{wid}: FAILED {dur}"); continue
        if not write_once(outp, doc): n["skip_exists"] += 1; log(f"{wid}: out exists (kept, not overwritten)"); continue
        n["done"] += 1; log(f"{wid}: dur={dur:.0f}s wall={time.time()-t1:.1f}s chars={ {t: sum(len(s['text']) for s in v['segments']) for t, v in doc['tracks'].items()} }")
    log(f"SUMMARY {json.dumps(n)} elapsed_s={time.time()-t0:.0f}"); log("E2E_WORKER_DONE"); return n

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worklist", required=True); ap.add_argument("--audio", required=True); ap.add_argument("--out", required=True); ap.add_argument("--claims", required=True)
    ap.add_argument("--run-dir", required=True); ap.add_argument("--node", required=True); ap.add_argument("--gpu", type=int, required=True)
    ap.add_argument("--gpu-index-offset", type=int, default=0)
    a = ap.parse_args(argv)
    if not __import__("re").fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", a.node): raise SystemExit("REFUSED: --node must be [a-z0-9-]")
    run(a); return 0

if __name__ == "__main__": sys.exit(main())
