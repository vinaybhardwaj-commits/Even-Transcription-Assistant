#!/usr/bin/env python3
"""GPU worker (eta-diarize venv, run under flock ~/gpu.lock by run.py): pyannote 3.1 diarization + ECAPA embeddings, the box's existing pipeline unchanged
(<diarize module>.local_diarize / embedding_for_cluster / embedding_for_window; the module and its directory come from env CONSULT_DIARIZE_MODULE and CONSULT_DIARIZE_PKG_DIR). stdin JSON {"jobs": [{"id", "audio", "out"}]}; per job writes JSON to "out":
{"segments": [{start, end, speaker}], "clusters": {spk: {sec, emb_b64}}, "turn_embs": [b64 | null] aligned with segments (null = under 0.5 s), "engine": str}."""
import base64, json, os, sys
import numpy as np
E = os.path.expanduser("~/eta-data")
_PKG_DIR, _MODULE = os.environ.get("CONSULT_DIARIZE_PKG_DIR"), os.environ.get("CONSULT_DIARIZE_MODULE")
if not _PKG_DIR or not _MODULE:
    sys.stderr.write("diar_worker: set CONSULT_DIARIZE_PKG_DIR (directory holding the diarize package) and CONSULT_DIARIZE_MODULE (its module name)\n"); sys.exit(78)      # EX_CONFIG: the cutter treats 78 as an error + ALERT, never as "deferred"
sys.path.insert(0, os.path.expanduser(_PKG_DIR))
os.environ.setdefault("DIAR_DEVICE", "cuda")
import importlib
md = importlib.import_module(_MODULE)

b64 = lambda v: base64.b64encode(np.asarray(v, dtype=np.float32).tobytes()).decode()

def cluster_embedding(md, wav, sr, segs):
    """m3-06 (M1): the cluster average of the diarize module's embedding_for_cluster (up to N of the longest segments, >= MIN_SEGMENT_S, else the single longest), but guarded PER SEGMENT: one bad segment no longer nulls the cluster. -> (mean or None, n_scored, n_failed)."""
    long_segs = [x for x in sorted(segs, key=lambda x: -(x[1] - x[0])) if x[1] - x[0] >= md.MIN_SEGMENT_S][:md.N_SEGMENTS_SCORED]
    if not long_segs: long_segs = [max(segs, key=lambda x: x[1] - x[0])]
    embs = [e for e in (safe(md.embedding_for_window, wav, sr, a, b) for a, b in long_segs) if e is not None]
    return (np.mean(embs, axis=0) if embs else None), len(embs), len(long_segs) - len(embs)

def safe(fn, *a):
    """m3-05: a segment the ECAPA front end cannot embed (tiny input: 'Padding size ... input [1, 80, 1]') gives None instead of failing the whole job."""
    try: return fn(*a)
    except RuntimeError: return None

def ecapa_to_gpu(md):
    """m3-12: the diarize module loads ECAPA with device 'cpu' (shared module, unchanged); the worker runs it on the T4 it already holds (same model, same weights, same windows: encode_batch moves the input to the module's device). -> device string; stays on CPU if cuda is off or fails."""
    if os.environ.get("DIAR_DEVICE") != "cuda": return "cpu"
    try:
        import torch
        if not torch.cuda.is_available(): return "cpu"
        from speechbrain.inference.speaker import EncoderClassifier
        md._ecapa = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=os.path.expanduser("~/services/eta-diarize/.cache/ecapa"), run_opts={"device": "cuda"})
        return "cuda"
    except Exception as e:
        print(f"[worker] ECAPA stays on CPU: {type(e).__name__}: {str(e)[:120]}", flush=True); md._ecapa = None; return "cpu"

def main():
    import time
    jobs = json.load(sys.stdin)["jobs"]
    if "--hard-stop" in sys.argv:                                                                           # N3: the 22:50 hard stop counts from the clock, not from when the lock was won
        import signal
        hs = float(sys.argv[sys.argv.index("--hard-stop") + 1]); signal.signal(signal.SIGALRM, lambda *_: os._exit(124)); signal.alarm(max(1, int(hs - time.time())))
    if "--not-after" in sys.argv and time.time() > float(sys.argv[sys.argv.index("--not-after") + 1]):      # the lock was acquired too late (R1): do not touch the GPU
        print("DEFERRED: past the latest start", flush=True); sys.exit(75)
    for j in jobs:
        try:
            t0 = time.time(); segs = md.local_diarize(j["audio"]); t1 = time.time(); ecapa_dev = ecapa_to_gpu(md) if getattr(md, "_ecapa", None) is None else "preloaded"; t2 = time.time(); wav, sr = md.load_audio(j["audio"]); by = {}
            for s in segs: by.setdefault(s["speaker"], []).append(s)
            clusters = {}
            for spk, ss in by.items():
                emb, n_ok, n_bad = cluster_embedding(md, wav, sr, [(s["start"], s["end"]) for s in ss])
                clusters[spk] = dict(sec=round(sum(s["end"] - s["start"] for s in ss), 2), emb_b64=None if emb is None else b64(emb), segments_scored=n_ok, segments_failed=n_bad)
            turn_embs = []
            for s in segs:
                e = safe(md.embedding_for_window, wav, sr, s["start"], s["end"]); turn_embs.append(None if e is None else b64(e))
            res = dict(segments=segs, clusters=clusters, turn_embs=turn_embs, engine=getattr(md, "_diarize_engine_id", None),
                       timing=dict(diarize_s=round(t1 - t0, 1), ecapa_load_s=round(t2 - t1, 1), embed_s=round(time.time() - t2, 1), n_segments=len(segs), ecapa_device=ecapa_dev))      # m3-12: phase wall times for the next measurement
        except Exception as e:
            res = dict(error=f"{type(e).__name__}: {str(e)[:200]}")
        fd = os.open(j["out"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh: json.dump(res, fh)
        print("DONE", j["id"], "error" if "error" in res else len(res["segments"]), flush=True)

if __name__ == "__main__": main()
