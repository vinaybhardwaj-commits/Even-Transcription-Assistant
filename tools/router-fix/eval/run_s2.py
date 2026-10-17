#!/usr/bin/env python3
"""W33 S2 runner (CAP consult replay, no scoring here; cap scores with efcc9c9): OLD and NEW router in-process on the local engine twins, one
consult at a time, both routers back to back (cache hits for shared engine calls).
usage: run_s2.py AUDIO_DIR OUT_DIR OLD_ROUTER_PY NEW_ROUTER_PY SHARD/NSHARDS
Writes OUT_DIR/{old,new}/<id>.json = full transcribe_norm_wav result. OUT_DIR must be 0700 (not PHI, but tidy)."""
import hashlib, importlib.util, json, os, sys, threading, time
AUDIO, OUT, OLD_PY, NEW_PY, SH = sys.argv[1:6]  # AUDIO: dir of *.mp3/*.wav consults
si, sn = map(int, SH.split("/"))
os.environ["ETA_DEFAULT_CANDIDATES"] = "en,kn,hi,ta,te,ml,mr,bn"
os.environ.setdefault("ETA_JOBS_DIR", OUT + "/jobs")
os.makedirs(OUT + "/jobs", exist_ok=True)

def load(which, path):
    sys.path.insert(0, os.path.dirname(path))
    spec = importlib.util.spec_from_file_location("rs_" + which, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    sys.path.pop(0)
    return m

CACHE_F, CACHE, LOCK, OFF = OUT + "/engine-cache.jsonl", {}, threading.Lock(), [0]
def refresh():
    if os.path.exists(CACHE_F):
        with open(CACHE_F) as f:
            f.seek(OFF[0])
            for line in f:
                if line.endswith("\n"):
                    d = json.loads(line); CACHE[d["k"]] = d["v"]; OFF[0] += len(line.encode())
                else:
                    break
def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
def wrap(which, name, fn, shared):
    def f(wav, *a, **k):
        key = json.dumps([name if shared else name + ":" + which, sha(wav), [str(x) for x in a], sorted((kk, str(v)) for kk, v in k.items())])
        with LOCK:
            hit = CACHE.get(key)
            if hit is None:
                refresh(); hit = CACHE.get(key)
        if hit is None:
            hit = fn(wav, *a, **k)
            with LOCK:
                with open(CACHE_F, "a") as cf:
                    cf.write(json.dumps({"k": key, "v": hit}) + "\n")
                CACHE[key] = hit
        return hit
    return f

R = {}
for which, path in (("old", OLD_PY), ("new", NEW_PY)):
    m = load(which, path)
    m.whisper_infer = wrap(which, "whisper", m.whisper_infer, False)
    m.indic_infer = wrap(which, "indic", m.indic_infer, True)
    m.sravaani_infer = wrap(which, "sravaani", m.sravaani_infer, True)
    R[which] = m
open(CACHE_F, "a").close(); os.chmod(CACHE_F, 0o600)

import subprocess
os.makedirs(OUT + "/wav", exist_ok=True)
for w in ("old", "new"):
    os.makedirs(f"{OUT}/{w}", exist_ok=True)
import csv
from datetime import datetime, timedelta
def load_manifest(audio_dir):
    man = {}
    with open(f"{audio_dir}/MANIFEST.tsv") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            room = r["source_key"].split("/")[1] if "/" in r["source_key"] else "?"
            man[r["consult_id"]] = {"window_id": r["window_id"], "room": room}
    win = {}
    with open(f"{audio_dir}/WINDOWS.tsv") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            win[r["consult_id"]] = r
    return man, win
MANIFEST, WINDOWS = load_manifest(AUDIO)

files = sorted(f for f in os.listdir(AUDIO) if f.endswith((".mp3", ".wav")))
cands = R["old"].DEFAULT_CANDIDATES.split(",")
for n, f in enumerate(files):
    if n % sn != si:
        continue
    cid = f.rsplit(".", 1)[0]
    wav = f"{OUT}/wav/{cid}.wav"
    if not os.path.exists(wav):
        import soundfile as sf, numpy as np
        x, sr = sf.read(f"{AUDIO}/{f}", always_2d=False)
        if x.ndim > 1:
            x = x.mean(axis=1)
        if sr != 16000:
            raise SystemExit(f"{f}: sr={sr}, expected 16000 (no resampler on this box; investigate)")
        sf.write(wav + ".tmp.wav", x, 16000, subtype="PCM_16")
        os.replace(wav + ".tmp.wav", wav)
    for which in ("old", "new"):
        p = f"{OUT}/{which}/{cid}.json"
        if os.path.exists(p):
            continue
        t0 = time.time()
        try:
            r = R[which].transcribe_norm_wav(wav, cands, False)
            res = {"consult_id": cid, "router": which, "ok": True, "latency_s": round(time.time() - t0, 1), "result": r}
        except Exception as e:
            res = {"consult_id": cid, "router": which, "ok": False, "error": repr(e)[:200]}
        with open(p + ".tmp", "w") as fh:
            json.dump(res, fh, ensure_ascii=False)
        os.chmod(p + ".tmp", 0o600); os.replace(p + ".tmp", p)
        print(which, cid, res["ok"], res.get("latency_s"), flush=True)

# Assemble cap's consult_transcripts.jsonl shape once all consults for this shard's router are done.
def assemble(which):
    outp = f"{OUT}/{which}_transcripts.jsonl"
    with open(outp + ".part%s" % SH.replace("/", "_"), "w") as out:
        for f2 in sorted(os.listdir(f"{OUT}/{which}")):
            cid = f2[:-5]
            d = json.load(open(f"{OUT}/{which}/{f2}"))
            m, w = MANIFEST.get(cid, {"window_id": "cw-" + cid, "room": "?"}), WINDOWS.get(cid, {})
            segs = []
            if d.get("ok"):
                start_utc = w.get("audio_start_utc")
                base = datetime.strptime(start_utc, "%Y-%m-%dT%H:%M:%S.%fZ") if start_utc else None
                iso = lambda sec: (base + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%S.%fZ") if base and sec is not None else None
                for i, s in enumerate(d["result"].get("segments", [])):
                    segs.append({"window_id": m["window_id"], "seg_index": i, "t0": iso(s.get("start_s")), "t1": iso(s.get("end_s")),
                                 "lang": s.get("lang"), "engine": s.get("engine"), "refused": bool(s.get("refused", False)),
                                 "refused_reason": s.get("refused_reason"), "text_native": s.get("text") or "",
                                 "text_en": None, "en_q": None})
            out.write(json.dumps({"consult_id": cid, "room": m["room"], "status": w.get("link_status", "unknown"),
                                   "basis": "sample_audio", "span": [w.get("audio_start_utc"), w.get("audio_end_utc")],
                                   "segments": segs}, ensure_ascii=False) + "\n")
    os.chmod(outp + ".part%s" % SH.replace("/", "_"), 0o600)
for which in ("old", "new"):
    assemble(which)
