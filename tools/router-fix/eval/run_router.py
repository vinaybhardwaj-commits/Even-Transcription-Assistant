#!/usr/bin/env python3
"""W31.1 eval harness: run one router version over clips on the BOX twin engines, log engine calls.
usage: run_router.py {old|new} {label200|selftest} [id,id,...]
Engine answers are cached on disk (patient text: eval-out is 0700, never commit). Whisper is cached per
router version (each version sends its own request shape); Indic/SraVaani are shared across versions."""
import hashlib, importlib.util, json, os, sys, threading

WHICH, SET = sys.argv[1], sys.argv[2]
ONLY = sys.argv[3].split(",") if len(sys.argv) > 3 else None
OUT = "/home/eta/oc/router-fix/eval-out"
os.environ.setdefault("ETA_JOBS_DIR", OUT + "/jobs")
os.environ["ETA_DEFAULT_CANDIDATES"] = "en,kn,hi,ta,te,ml,mr,bn"
SRC = {"old": "/tmp/wt-router-fix-old/router_server.py",
       "new": "/home/eta/oc/router-fix/repo/router_server.py"}[WHICH]
sys.path.insert(0, os.path.dirname(SRC))
spec = importlib.util.spec_from_file_location("rs_" + WHICH, SRC)
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)

CACHE_F = f"{OUT}/engine-cache.jsonl"
CACHE, LOCK = {}, threading.Lock()
if os.path.exists(CACHE_F):
    for line in open(CACHE_F):
        d = json.loads(line); CACHE[d["k"]] = d["v"]
cf = open(CACHE_F, "a"); os.chmod(CACHE_F, 0o600)
LOG, LLOCK = [], threading.Lock()

def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]

def wrap(name, fn, shared):
    def f(wav, *a, **k):
        key = json.dumps([name if shared else name + ":" + WHICH, sha(wav), [str(x) for x in a], sorted((kk, str(v)) for kk, v in k.items())])
        with LOCK:
            hit = CACHE.get(key)
        if hit is None:
            hit = fn(wav, *a, **k)
            with LOCK:
                CACHE[key] = hit; cf.write(json.dumps({"k": key, "v": hit}) + "\n"); cf.flush()
        with LLOCK:
            LOG.append({"eng": name, "audio": sha(wav), "args": [str(x) for x in a] + [f"{kk}={v}" for kk, v in k.items()],
                        "text": (hit.get("text") or "").strip(), "lang": hit.get("language"),
                        "p_en": (hit.get("language_probabilities") or {}).get("en", hit.get("detected_language_probability") if hit.get("detected_language") == "english" else None),
                        "cached": True})
        return hit
    return f

R.whisper_infer = wrap("whisper", R.whisper_infer, False)
R.indic_infer = wrap("indic", R.indic_infer, True)
R.sravaani_infer = wrap("sravaani", R.sravaani_infer, True)

if SET == "label200":
    d = "/home/eta/eta-data/readability/label200-audio"
    items = [(f[:-4], f"{d}/{f}") for f in sorted(os.listdir(d)) if f.endswith(".wav")]
else:
    d = "/home/eta/eta-data/diag-rig/stimuli"
    items = []
    for suite in ("digital1", "voices1", "voices2"):
        for f in sorted(os.listdir(f"{d}/{suite}")):
            if f.endswith(".wav"):
                items.append((f"{suite}/{f[:-4]}", f"{d}/{suite}/{f}"))
if ONLY:
    items = [x for x in items if x[0] in ONLY]

out_f = f"{OUT}/{WHICH}-{SET}{os.environ.get('RUN_TAG', '')}.jsonl"
if os.environ.get("REVERSE"):
    items = items[::-1]
done = set()
if os.path.exists(out_f):
    done = {json.loads(l)["id"] for l in open(out_f)}
out = open(out_f, "a"); os.chmod(out_f, 0o600)
cands = R.DEFAULT_CANDIDATES.split(",")
for cid, path in items:
    if cid in done:
        continue
    LOG.clear()
    try:
        res = R.transcribe_norm_wav(path, cands, False)
        row = {"id": cid, "segments": res["segments"], "calls": list(LOG)}
    except Exception as e:
        row = {"id": cid, "error": repr(e), "calls": list(LOG)}
    out.write(json.dumps(row, ensure_ascii=False) + "\n"); out.flush()
    print(cid, [(s.get("lang"), s.get("engine")) for s in row.get("segments", [])], row.get("error", ""), flush=True)
