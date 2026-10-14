#!/usr/bin/env python3
"""337c arm A (runs on eta-lab-l4): re-transcribe cut segments with faster-whisper large-v3, language FORCED to the
manifest's force_lang (None = auto-detect). Writes results.jsonl beside the wavs; never touches the old text.
The output holds patient text: 0600, stays on the L4 and the box, never in git, logs or chat."""
import argparse, json, os, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--model", default="large-v3")
ap.add_argument("--beam", type=int, default=5)
ap.add_argument("--fallback", action="store_true", help="enable whisper temperature fallback (default OFF: one decode at temperature 0; fallback made some segments take 80 s+ each and is not needed for a lab re-run)")
a = ap.parse_args()

from faster_whisper import WhisperModel
m = WhisperModel(a.model, device="cuda", compute_type="float16")
out = os.path.join(a.dir, "results_whisper_" + a.model.replace("/", "_") + ".jsonl")
done = set()
if os.path.exists(out):
    done = {json.loads(l)["id"] for l in open(out)}
n = 0
with open(out, "a") as fo:
    os.chmod(out, 0o600)
    for line in open(os.path.join(a.dir, "manifest.jsonl")):
        mf = json.loads(line)
        if mf["id"] in done:
            continue
        t0 = time.time()
        segs, info = m.transcribe(os.path.join(a.dir, mf["id"] + ".wav"), language=mf.get("force_lang"), beam_size=a.beam,
                                  condition_on_previous_text=False, vad_filter=False,
                                  temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0) if a.fallback else 0.0)
        segs = list(segs)
        text = " ".join(x.text.strip() for x in segs).strip()
        fo.write(json.dumps({
            "id": mf["id"], "engine": "faster-whisper/" + a.model + f" beam{a.beam} fallback{'on' if a.fallback else 'off'}", "forced": mf.get("force_lang"),
            "detected": info.language, "detected_p": round(info.language_probability, 3), "text": text,
            "avg_logprob": round(sum(x.avg_logprob for x in segs) / len(segs), 3) if segs else None,
            "no_speech_prob": round(max((x.no_speech_prob for x in segs), default=0), 3),
            "compression_ratio": round(max((x.compression_ratio for x in segs), default=0), 2),
            "elapsed_s": round(time.time() - t0, 2)}, ensure_ascii=False) + "\n")
        fo.flush(); n += 1
print(json.dumps({"segments": n, "out": out}))
