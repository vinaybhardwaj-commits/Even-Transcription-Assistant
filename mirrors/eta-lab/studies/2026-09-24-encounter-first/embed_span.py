"""embed_span.py — speaker embeddings for ONE time span of a room-day, from R2 chunk audio (lx, 24 Sep).
For items on days with no diarizer labels or level log. Same model as embed_local.py (the box diarize twin's ECAPA,
CPU, nice 10). Usage (twin venv): embed_span.py <room_day_id> <start_ms> <end_ms> <out.npz>
The twin's venv has no boto3 (and is left untouched), so the chunks must already be in the r2audio cache: run
`~/.venv-r2/bin/python r2audio.py fetch <room_day_id> <start_ms> <end_ms>` first.
Energy-gated inside the span itself (a window is embedded when its RMS > 1.5 x the span's 20th-percentile RMS)."""
import json, os, subprocess, sys
import numpy as np, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-encounter-first"))
from speechbrain.inference.speaker import EncoderClassifier
rd, a, b, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
q = (f"SELECT c.r2_key, (extract(epoch from c.started_at)*1000)::bigint AS s, c.duration_ms FROM bench_chunk c "
     f"WHERE c.session_id IN (SELECT DISTINCT session_id FROM bench_window WHERE room_day_id = '{rd}') "
     f"AND coalesce(c.source,'primary')='primary' AND c.upload_state='verified' ORDER BY c.started_at")
ch = json.loads(subprocess.run(["node", os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"), q], cwd=os.path.expanduser("~/dev/Even-Transcription-Assistant"), capture_output=True, text=True).stdout)
ch = [c for c in ch if int(c["s"]) < b and int(c["s"]) + int(c["duration_ms"]) > a]
CACHE = os.path.expanduser("~/eta-data/encounter-first/audio")
paths = {c["r2_key"]: os.path.join(CACHE, c["r2_key"].replace("/", "__")) for c in ch}
missing = [k for k, p in paths.items() if not os.path.exists(p)]
if missing: sys.exit(f"STAGE_FAIL {len(missing)} chunks not cached: run r2audio.py fetch first")
print(f"chunks {len(ch)}", flush=True)
torch.set_num_threads(8)
ecapa = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=os.path.expanduser("~/eta-diarize/.cache/ecapa"), run_opts={"device": "cpu"})
n = int(1.5 * 16000); wins = []
for c in ch:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", paths[c["r2_key"]], "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True)
    x = np.frombuffer(r.stdout, dtype=np.float32)
    for i in range(0, len(x) - n + 1, n):
        t = int(c["s"]) + int(i / 16)
        if a <= t < b: wins.append((t, x[i:i + n]))
rms = np.array([np.sqrt(np.mean(w ** 2)) for _, w in wins]); thr = 1.5 * np.percentile(rms, 20)
keep = [(t, w) for (t, w), r_ in zip(wins, rms) if r_ > thr]; print(f"windows {len(wins)} active {len(keep)}", flush=True)
embs = []
for i in range(0, len(keep), 64):
    with torch.no_grad(): embs.append(ecapa.encode_batch(torch.from_numpy(np.stack([w for _, w in keep[i:i + 64]]))).squeeze(1).cpu().numpy())
np.savez(out, t_ms=np.array([t for t, _ in keep], dtype=np.int64), emb=np.concatenate(embs).astype(np.float32))
print("EMB_SPAN_DONE")
