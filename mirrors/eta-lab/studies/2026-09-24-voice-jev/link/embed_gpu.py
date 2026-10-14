#!/usr/bin/env python3
"""vj-link DENSE embedding on the box T4 (ruling 219 B). Same model and preprocessing as embed_link.py / the ruling 182 controls (speechbrain/spkrec-ecapa-voxceleb 192-d, 16 kHz mono float32,
turn start mapped to its bench window by vj-data's mapping, whole turn >= 1.5 s cropped to its first 5 s, L2-normalised) but EVERY qualifying turn, not 2 per minute. Turns are batched by length
(padding + relative lengths, speechbrain's own masking) so batching changes an embedding by ~1e-3; check_equiv() compares against the CPU embeddings of the sparse run.
Usage: embed_gpu.py rd_id [rd_id ...]    in: ~/eta-data/voice-linkage/pilot/{turns-<rd>.json, audio/<window>.wav}    out: ~/eta-data/voice-linkage/dense/emb-<rd>.npz + .json (ids and times only)"""
import bisect, json, os, sys, time
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier
PD = os.path.expanduser("~/eta-data/voice-linkage/pilot"); OUT = os.path.expanduser("~/eta-data/voice-linkage/dense"); os.makedirs(OUT, exist_ok=True)
MD = os.path.expanduser("~/eta-data/voice-linkage/models/ecapa"); SR, MIN, MAX, BATCH = 16000, 1.5, 5.0, int(os.environ.get("BATCH", "16"))   # T4 shares memory with the Nemotron server (~8 GB free)
ecapa = EncoderClassifier.from_hparams(source=MD, savedir=MD, run_opts={"device": "cuda"}); ecapa.eval()
for rd in sys.argv[1:]:
    if os.path.exists(f"{OUT}/emb-{rd}.npz"): continue   # resumable
    t0 = time.time(); d = json.load(open(f"{PD}/turns-{rd}.json"))
    wins = sorted((int(w["start_ms"]), int(w["end_ms"]), w["window_id"]) for w in d["windows"] if os.path.exists(f"{PD}/audio/{w['window_id']}.wav")); starts = [w[0] for w in wins]
    by = {}
    for i, t in enumerate(d["turns"]):
        if not t.get("s_ms") or not t.get("e_ms"): continue
        s, e = int(t["s_ms"]), int(t["e_ms"]); j = bisect.bisect_right(starts, s) - 1
        if j < 0 or s >= wins[j][1] or (e - s) / 1000 < MIN: continue
        by.setdefault(wins[j][2], []).append((i, (s - wins[j][0]) / 1000.0, min(e - s, MAX * 1000) / 1000.0))
    items = []                                    # (i, window, off, dur, samples)
    for w, rows in by.items():
        x, sr = sf.read(f"{PD}/audio/{w}.wav", dtype="float32"); assert sr == SR
        for i, s, dur in rows:
            seg = x[int(s * SR): int((s + dur) * SR)]
            if len(seg) >= SR * MIN * 0.9: items.append((i, w, s, dur, seg))
    items.sort(key=lambda r: len(r[4])); idx, embs, meta = [], [], []
    with torch.no_grad():
        for k in range(0, len(items), BATCH):
            b = items[k:k + BATCH]; L = max(len(r[4]) for r in b)
            wav = torch.zeros(len(b), L); lens = torch.tensor([len(r[4]) / L for r in b])
            for n, r in enumerate(b): wav[n, :len(r[4])] = torch.from_numpy(r[4])
            torch.cuda.empty_cache()
            e = ecapa.encode_batch(wav.cuda(), lens.cuda()).reshape(len(b), -1).cpu().numpy().astype(np.float64)
            e /= np.linalg.norm(e, axis=1, keepdims=True) + 1e-12
            for n, r in enumerate(b): idx.append(r[0]); embs.append(e[n]); meta.append({"i": r[0], "window_id": r[1], "off_s": round(r[2], 2), "dur_s": round(r[3], 2)})
    o = np.argsort(idx); idx = np.array(idx)[o]; embs = np.array(embs, dtype=np.float32)[o]; meta = [meta[k] for k in o]
    np.savez(f"{OUT}/emb-{rd}.npz", idx=idx, emb=embs); json.dump(meta, open(f"{OUT}/emb-{rd}.json", "w"))
    print("DENSE_DONE", rd, "turns", len(idx), f"{time.time() - t0:.0f}s", flush=True)
