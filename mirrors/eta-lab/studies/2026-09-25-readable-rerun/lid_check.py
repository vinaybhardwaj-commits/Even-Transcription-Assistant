#!/usr/bin/env python3
"""337c(2) (eta-refuter #2111 2c): language ID of a segment by faster-whisper large-v3 WITHOUT forcing, to compare with the forced language. Runs on eta-lab-l4
over a list of segment ids (default: every wav in the shard dirs that has a whisper result), writes lid_<shard>.jsonl {id, forced, detected, p}. GPU: take flock
~/gpu.lock (run it after the whisper workers finish or inside a gap). Only language codes and probabilities are written; no text."""
import json, os, sys
from faster_whisper import WhisperModel
import soundfile as sf
d, ids_file = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
want = set(json.load(open(ids_file))) if ids_file else None
dev = os.environ.get("LID_DEVICE", "cuda"); m = WhisperModel("large-v3", device=dev, compute_type="float16" if dev == "cuda" else "int8")
out = os.path.join(d, "lid.jsonl"); done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
man = [json.loads(l) for l in open(os.path.join(d, "manifest.jsonl"))]
with open(out, "a") as fo:
    os.chmod(out, 0o600)
    for mf in man:
        if mf["id"] in done or (want is not None and mf["id"] not in want): continue
        a, sr = sf.read(os.path.join(d, mf["id"] + ".wav"), dtype="float32")
        lang, p, _ = m.detect_language(a)
        fo.write(json.dumps({"id": mf["id"], "forced": mf.get("force_lang"), "detected": lang, "p": round(float(p), 3)}) + "\n"); fo.flush()
