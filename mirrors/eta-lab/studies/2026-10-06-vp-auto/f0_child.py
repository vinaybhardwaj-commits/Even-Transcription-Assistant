#!/usr/bin/env python3
"""F0 helper (nemo venv, librosa 1.0.0): stdin JSON [[audio_path, start_s, end_s], ...] -> stdout JSON {"median": Hz|null, "voiced_s": float}.
Same rule as vp_fast_mint.median_f0: mono 16 kHz decode, librosa.pyin fmin 65 fmax 400 sr 16000, voiced frames only (hop 512 = 32 ms), pooled median."""
import json, subprocess, sys
import numpy as np
import librosa
segs = json.load(sys.stdin); f0s = []; cache = {}
for path, a, b in segs:
    if path not in cache:
        p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True)
        cache = {path: np.frombuffer(p.stdout, dtype=np.float32)}
    y = cache[path][int(a * 16000):int(b * 16000)]
    if len(y) < 2048: continue
    f0, vf, _ = librosa.pyin(y, fmin=65, fmax=400, sr=16000); f0s += list(f0[vf & ~np.isnan(f0)])
print(json.dumps(dict(median=float(np.median(f0s)) if f0s else None, voiced_s=len(f0s) * 512 / 16000)))
