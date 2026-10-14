#!/usr/bin/env python3
"""vj-link (voice-lab-1, CPU): one ECAPA embedding for up to 2 turns per minute (the longest, >= 1.5 s, first 5 s) of a room-day. Same model and preprocessing as the ruling 182 controls (studies/2026-09-24-voice-jev/data/embed_ecapa.py):
speechbrain/spkrec-ecapa-voxceleb 192-d, 16 kHz mono float32 wav, whole turn (>= 1.0 s, cropped to its first 8 s), L2-normalised, cosine.
A turn maps to the bench window that contains its start; offset = (turn start ms - window start ms)/1000 (vj-data's mapping).
Usage: embed_link.py <room_day_id>   in: ~/vj/link/turns-<rd>.json, ~/vj/link/audio/<window>.wav   out: ~/vj/link/emb-<rd>.npz (+ .json index; PHI-free: ids and times only)"""
import json, os, sys, time
os.environ["HF_HUB_CACHE"] = os.path.expanduser("~/vj/models/pyannote")
import numpy as np, soundfile as sf, torch
torch.set_num_threads(int(os.environ.get("NT", "3")))
from speechbrain.inference.speaker import EncoderClassifier
H = os.path.expanduser("~/vj/link"); rd = sys.argv[1]
d = json.load(open(f"{H}/turns-{rd}.json"))
wins = sorted((int(w["start_ms"]), int(w["end_ms"]), w["window_id"]) for w in d["windows"] if os.path.exists(f"{H}/audio/{w['window_id']}.wav"))
ecapa = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=os.path.expanduser("~/vj/models/ecapa"), run_opts={"device": "cpu"})
SR, MIN, MAX, PER_MIN = 16000, 1.5, 5.0, 2   # CPU budget on a shared box: at most 2 turns per minute (the longest ones), each >= 1.5 s, cropped to 5 s
import bisect
starts = [w[0] for w in wins]
by = {}
for i, t in enumerate(d["turns"]):
    if not t.get("s_ms") or not t.get("e_ms"): continue
    s, e = int(t["s_ms"]), int(t["e_ms"])
    j = bisect.bisect_right(starts, s) - 1
    if j < 0 or s >= wins[j][1] or (e - s) / 1000 < MIN: continue
    by.setdefault(wins[j][2], []).append((i, (s - wins[j][0]) / 1000.0, min(e - s, MAX * 1000) / 1000.0))
for w in by:   # keep the PER_MIN longest turns of each minute of the room-day
    keep, cnt = [], {}
    for r in sorted(by[w], key=lambda r: -r[2]):
        m = int(r[1] // 60)
        if cnt.get(m, 0) < PER_MIN: keep.append(r + (cnt.get(m, 0),)); cnt[m] = cnt.get(m, 0) + 1
    by[w] = sorted(keep)
idx, embs, meta = [], [], []
t0 = time.time()
for pas in range(PER_MIN):   # pass 0 = the longest turn of every minute across the WHOLE day, pass 1 = the second longest: a partial result still covers the whole day
    for w, rows in sorted(by.items()):
        rows = [r for r in rows if r[3] == pas]
        if not rows: continue
        x, sr = sf.read(f"{H}/audio/{w}.wav", dtype="float32"); assert sr == SR
        for i, s, dur, _ in rows:
            seg = x[int(s * SR): int((s + dur) * SR)]
            if len(seg) < SR * MIN * 0.9: continue
            v = ecapa.encode_batch(torch.from_numpy(seg)[None, :]).reshape(-1).numpy().astype(np.float64)
            embs.append(v / (np.linalg.norm(v) + 1e-12)); idx.append(i); meta.append({"i": i, "window_id": w, "off_s": round(s, 2), "dur_s": round(dur, 2)})
        print(rd, pas, w, len(embs), f"{time.time() - t0:.0f}s", flush=True)
    np.savez(f"{H}/emb-{rd}.npz", idx=np.array(idx), emb=np.array(embs, dtype=np.float32)); json.dump(meta, open(f"{H}/emb-{rd}.json", "w"))
    print("PASS_DONE", rd, pas, len(idx), flush=True)
np.savez(f"{H}/emb-{rd}.npz", idx=np.array(idx), emb=np.array(embs, dtype=np.float32))
json.dump(meta, open(f"{H}/emb-{rd}.json", "w"))
print("EMBED_DONE", rd, "turns", len(idx), f"{time.time() - t0:.0f}s")
