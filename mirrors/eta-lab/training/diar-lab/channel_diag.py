#!/usr/bin/env python3
"""No-training diagnostic: WHERE do speakers go after a fine-tune? For each 16 kHz window, run base and a fine-tuned .nemo (offline 30.4 s config) with the raw
speaker-activity probabilities and print, per output channel (arrival order), speech seconds at p>0.5, peak probability and segment count.
usage: channel_diag.py <ft.nemo> <audio_dir> [window_id ...]   (NeMo venv)"""
import glob, os, sys
import numpy as np, torch
from nemo.collections.asr.models import SortformerEncLabelModel
ft, adir = sys.argv[1], sys.argv[2]; only = sys.argv[3:]
def load(path=None):
    m = (SortformerEncLabelModel.restore_from(path, map_location="cuda") if path else SortformerEncLabelModel.from_pretrained("nvidia/Nemotron-3-Diarization", map_location="cuda")).eval()
    sm = m.sortformer_modules; sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300
    m._check_streaming_parameters(); return m
def chans(m, wav):
    segs, probs = m.diarize(audio=[wav], batch_size=1, include_tensor_outputs=True, verbose=False)
    p = probs[0].float().cpu().numpy().reshape(-1, probs[0].shape[-1])   # [T, 8] (diarize returns [1, T, 8])
    dt = os.path.getsize(wav) / 32000.0 / p.shape[0]       # seconds per output frame
    return [(round(float((p[:, k] > 0.5).sum() * dt), 1), round(float(p[:, k].max()), 2)) for k in range(p.shape[1])]
wavs = sorted(glob.glob(os.path.join(adir, "*.wav"))); wavs = [w for w in wavs if not only or any(o in w for o in only)]
base, tuned = load(None), load(ft)
for w in wavs:
    b, t = chans(base, w), chans(tuned, w)
    print(os.path.basename(w)[3:11])
    print("  ch | base sec / peak | tuned sec / peak")
    for k in range(8):
        if b[k][0] > 0 or t[k][0] > 0 or b[k][1] > 0.3 or t[k][1] > 0.3: print(f"  {k}  | {b[k][0]:7.1f} / {b[k][1]:.2f} | {t[k][0]:7.1f} / {t[k][1]:.2f}")
