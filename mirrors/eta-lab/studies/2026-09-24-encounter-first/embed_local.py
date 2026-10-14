"""embed_local.py — speaker embeddings every 1.5 s for the ENCOUNTER-FIRST embeddings arm (lx, 24 Sep).

The SAME model as the box diarize twin's /embed_speakers (speechbrain/spkrec-ecapa-voxceleb, the twin's own cached
weights, HF_HUB_OFFLINE), batched on CPU in this process instead of calling the service: the service embeds one span
at a time (26 s per 5-min chunk) and serves the daytime bulk pool, which this must not compete with.

Run with the twin's venv:   nice -n 10 /home/eta/services/eta-diarize/venv/bin/python embed_local.py <chunks.json> <levels.json> <rooms.json> <out_dir>
  chunks.json  {room_day_id: [{path, started_ms}]}  (cached R2 audio, see r2audio.py)
Embeds only windows whose 10-s energy bin is active (segmenter.energy_bins on the level log), so silence costs nothing.
Writes <out_dir>/emb-<room_day_id>.npz: t_ms (int64), emb (float32, n x 192). No audio or text is written.
"""
import json, os, subprocess, sys, time
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segmenter as S
from speechbrain.inference.speaker import EncoderClassifier

WIN_S = 1.5
BATCH = 64
chunks = json.load(open(sys.argv[1])); levels = json.load(open(sys.argv[2])); rooms = json.load(open(sys.argv[3])); out = sys.argv[4]
os.makedirs(out, exist_ok=True)
torch.set_num_threads(8)
ecapa = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb",
                                       savedir=os.path.expanduser("~/eta-diarize/.cache/ecapa"), run_opts={"device": "cpu"})

def decode(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.float32) if r.returncode == 0 else np.zeros(0, np.float32)

for rd, cl in chunks.items():
    t0 = time.time()
    lv = [(int(x["t"]), float(x["peak"])) for x in levels if x["room_id"] == rooms[rd]]
    d0, active, _ = S.energy_bins(lv, "2026-09-23"); B = S.BIN_S * 1000
    is_active = lambda t: 0 <= (t - d0) // B < len(active) and active[(t - d0) // B]
    ts, embs, buf, buf_t = [], [], [], []
    def flush():
        if not buf: return
        with torch.no_grad():
            e = ecapa.encode_batch(torch.from_numpy(np.stack(buf))).squeeze(1).cpu().numpy()
        embs.append(e.astype(np.float32)); ts.extend(buf_t); buf.clear(); buf_t.clear()
    n = int(WIN_S * 16000)
    for c in cl:
        a = decode(c["path"])
        for i in range(0, len(a) - n + 1, n):
            t = c["started_ms"] + int(i / 16)
            if not is_active(t): continue
            buf.append(a[i:i + n]); buf_t.append(t)
            if len(buf) >= BATCH: flush()
    flush()
    E = np.concatenate(embs) if embs else np.zeros((0, 192), np.float32)
    np.savez(f"{out}/emb-{rd}.npz", t_ms=np.array(ts, dtype=np.int64), emb=E)
    print(f"EMB {rd} windows={len(ts)} wall={time.time() - t0:.0f}s", flush=True)
print("EMB_DONE")
