#!/usr/bin/env python3
"""W33 S1 runner (PREREG-W33-S1.md): OLD and NEW router in-process on the local engine twins, one
clinical1 stimulus at a time, both routers back to back (cache hits for shared engine calls).
usage: run_s1.py SUITE_DIR OUT_DIR OLD_ROUTER_PY NEW_ROUTER_PY SHARD/NSHARDS
Writes OUT_DIR/{old,new}/<sid>.result.json in the diag-rig shape. OUT_DIR must be 0700 (not PHI, but tidy)."""
import hashlib, importlib.util, json, os, sys, threading, time
SUITE, OUT, OLD_PY, NEW_PY, SH = sys.argv[1:6]
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

man = json.load(open(SUITE + "/suite.json"))
items = [it for it in man["items"] if it["kind"] in ("dialogue", "noisy_dialogue", "canary")]
items.sort(key=lambda it: it["stimulus_id"])
for w in ("old", "new"):
    os.makedirs(f"{OUT}/{w}", exist_ok=True)
cands = R["old"].DEFAULT_CANDIDATES.split(",")
for n, it in enumerate(items):
    if n % sn != si:
        continue
    sid = it["stimulus_id"]; wav = f"{SUITE}/{sid}.wav"
    if hashlib.sha256(open(wav, "rb").read()).hexdigest() != it["audio_sha256"]:
        raise SystemExit(f"{sid}: sha mismatch, abort")
    for which in ("old", "new"):
        p = f"{OUT}/{which}/{sid}.result.json"
        if os.path.exists(p):
            continue
        t0 = time.time()
        res = {"stimulus_id": sid, "machine": os.uname().nodename, "ts_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "engines": {}}
        try:
            r = R[which].transcribe_norm_wav(wav, cands, False)
            segs = [{"start_s": s.get("start_s"), "end_s": s.get("end_s"), "text": s.get("text") or "", "lang": s.get("lang"), "engine": s.get("engine")} for s in r["segments"]]
            text = " ".join(s["text"] for s in segs if s["text"])
            import collections
            by_lang = collections.Counter()
            for s in segs:
                if s["text"]:
                    # grapheme-weighted, same rule as router_server's G3-fixed dominant_language --
                    # was segment-count (a tie on 1-vs-1 segments broke arbitrarily, lid-debug #4529).
                    # Uses the NEW module's _grapheme_len for both arms (OLD/400710ee has no such
                    # function; this is a diagnostic field only, not part of the scored metrics).
                    by_lang[s["lang"]] += R["new"]._grapheme_len(s["text"])
            dom = max(by_lang, key=by_lang.get) if by_lang else None
            res["engines"]["stt"] = {"ok": True, "latency_s": round(time.time() - t0, 2), "text": text, "language": dom, "segments": segs}
        except Exception as e:
            res["engines"]["stt"] = {"ok": False, "error": type(e).__name__}
        with open(p, "w") as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
        os.chmod(p, 0o600)
        print(which, sid, [(s["lang"], s["engine"]) for s in res["engines"]["stt"].get("segments", [])], flush=True)
