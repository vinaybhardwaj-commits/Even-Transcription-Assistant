#!/usr/bin/env python3
"""Run nvidia/Nemotron-3-Diarization (NeMo, offline 30.4 s config) over a dir of 16 kHz mono wavs.
Output matches diar_run20.py so eval5/eval20 score it unchanged. No audio or text is printed.
usage: nemo_run.py --audio-dir DIR --out out.json [--device cuda] [--precision fp32|bf16]"""
import argparse, glob, json, os, time
import torch
from nemo.collections.asr.models import SortformerEncLabelModel

ap = argparse.ArgumentParser()
ap.add_argument("--audio-dir", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--device", default="cuda"); ap.add_argument("--model", default="nvidia/Nemotron-3-Diarization")
a = ap.parse_args()

t0 = time.time()
m = SortformerEncLabelModel.from_pretrained(a.model, map_location=a.device).eval()
sm = m.sortformer_modules
sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300
m._check_streaming_parameters()
load_sec = time.time() - t0

def parse(seg):
    if isinstance(seg, str):
        p = seg.split(); return float(p[0]), float(p[1]), p[2]
    return float(seg[0]), float(seg[1]), str(seg[2])

results, total_audio, total_wall = {}, 0.0, 0.0
wavs = sorted(glob.glob(os.path.join(a.audio_dir, "*.wav")))
for i, w in enumerate(wavs):
    wid = os.path.basename(w)[:-4]
    dur = os.path.getsize(w) / 32000.0
    if a.device == "cuda": torch.cuda.synchronize()
    t = time.time()
    segs = m.diarize(audio=[w], batch_size=1)[0]
    if a.device == "cuda": torch.cuda.synchronize()
    el = time.time() - t
    turns = []
    for s in segs:
        b, e, spk = parse(s)
        turns.append({"start_ms": round(b * 1000), "end_ms": round(e * 1000), "speaker": spk})
    results[wid] = {"turns": turns, "n_speakers": len({t["speaker"] for t in turns}), "elapsed_sec": round(el, 2), "audio_sec": round(dur, 1)}
    if i > 0: total_audio += dur; total_wall += el      # exclude first (warm-up) from the speed figure
    print(f"{wid}: n_speakers={results[wid]['n_speakers']} elapsed={el:.1f}s audio={dur:.0f}s", flush=True)
speed = {"wall_sec_per_audio_hour": round(total_wall / total_audio * 3600, 1) if total_audio else None,
         "gpu": torch.cuda.get_device_name(0) if a.device == "cuda" else "cpu", "torch": torch.__version__}
json.dump({"model": a.model, "config": "offline 30.4s: spkcache 264 fifo 40 chunk 340 rc 40 upd 300", "load_sec": round(load_sec, 1),
           "speed": speed, "windows": results}, open(a.out, "w"))
print("# speed", speed, flush=True)
