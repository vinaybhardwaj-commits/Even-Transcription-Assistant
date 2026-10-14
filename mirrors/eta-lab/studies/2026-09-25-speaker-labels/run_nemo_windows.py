#!/usr/bin/env python3
"""337e (ruling 350, option B): Nemotron-3-Diarization (base, offline 30.4 s) over whole-window wavs; writes TURNS only (wall-clock seconds from the window start, speaker id) as JSONL, one line per window
(resumable). No audio or text in the output. usage (NeMo venv, GPU): run_nemo_windows.py <wav_dir> <out.jsonl> [--delete-audio]"""
import glob, json, os, sys, time
import torch
from nemo.collections.asr.models import SortformerEncLabelModel
d, out = sys.argv[1], sys.argv[2]; delete = "--delete-audio" in sys.argv
done = set()
if os.path.exists(out):
    for l in open(out): done.add(json.loads(l)["window_id"])
m = SortformerEncLabelModel.from_pretrained("nvidia/Nemotron-3-Diarization", map_location="cuda").eval()
sm = m.sortformer_modules; sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300; m._check_streaming_parameters()
parse = lambda s: (float(s.split()[0]), float(s.split()[1]), s.split()[2]) if isinstance(s, str) else (float(s[0]), float(s[1]), str(s[2]))
files = sorted(glob.glob(os.path.join(d, "*.wav"))); t0 = time.time(); n = 0
for p in files:
    wid = os.path.basename(p)[:-4]
    if wid in done: continue
    segs = [parse(s) for s in m.diarize(audio=[p], batch_size=1, verbose=False)[0]]
    with open(out, "a") as f: f.write(json.dumps(dict(window_id=wid, engine="nemotron-3", turns=[[round(a, 3), round(b, 3), s] for a, b, s in segs])) + "\n")
    n += 1
    if delete: os.unlink(p)
    if n % 20 == 0: print(f"{n} windows {time.time() - t0:.0f}s", flush=True)
print(f"done {n} windows in {time.time() - t0:.0f}s on {torch.cuda.get_device_name(0)}")
