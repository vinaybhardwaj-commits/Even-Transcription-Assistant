"""vj-refuter descriptor spot-check: librosa pYIN (independent of Praat AC) on 5 random test turns >= 2 s; compare 10th/50th/90th pct; plot contours."""
import json, sys, os
import numpy as np, soundfile as sf, librosa
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
S = json.load(open(sys.argv[1])); H = os.path.expanduser("~/vj/data/audio"); SR = 16000
fig, ax = plt.subplots(5, 1, figsize=(8, 11)); out = []
for i, (w, k, s, e, lo, hi, med) in enumerate(S):
    x, _ = sf.read(f"{H}/{w}.wav", dtype="float32"); seg = x[int(s * SR):int(e * SR)]
    f0, vf, _ = librosa.pyin(seg, fmin=75, fmax=500, sr=SR, frame_length=1024, hop_length=160)
    v = f0[vf & ~np.isnan(f0)]
    m = [round(float(np.percentile(v, p))) for p in (10, 50, 90)] if len(v) >= 5 else [None] * 3
    out.append({"turn": k[-26:], "dur": round(e - s, 1), "praat_10_50_90": [lo, med, hi], "pyin_10_50_90": m, "median_ratio": round(m[1] / med, 2) if m[1] else None})
    t = np.arange(len(f0)) * 160 / SR; ax[i].plot(t, f0, ".", ms=2, label="pYIN"); ax[i].axhline(med, color="r", lw=1, label=f"Praat median {med}")
    ax[i].axhspan(lo, hi, color="r", alpha=0.1, label="Praat 10-90%"); ax[i].set_ylim(50, 520); ax[i].set_ylabel("Hz"); ax[i].legend(fontsize=6, loc="upper right"); ax[i].set_title(f"turn {i+1} ({e-s:.1f} s)", fontsize=8)
plt.tight_layout(); plt.savefig(os.path.expanduser("~/vj/refute/pitch_spotcheck.png"), dpi=90)
for o in out: print(json.dumps(o))
