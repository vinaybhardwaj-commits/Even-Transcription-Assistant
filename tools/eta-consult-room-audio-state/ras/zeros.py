"""Zero-run analysis of one tape chunk (decoded opus -> 48 kHz mono s16)."""
import subprocess
import numpy as np

SR = 48000


def decode(path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                       capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.int16)


def runs(mask, min_len):
    """(start, length) of True runs in mask with length >= min_len."""
    if not len(mask):
        return []
    m = np.concatenate(([0], mask.view(np.int8), [0]))
    d = np.diff(m)
    s = np.flatnonzero(d == 1)
    e = np.flatnonzero(d == -1)
    return [(int(a), int(b - a)) for a, b in zip(s, e) if b - a >= min_len]


def analyse(a, eps=1, min_run_s=1.0):
    """eps: |sample|<=eps counts as digital zero (opus decode leaves +-1 LSB dither)."""
    n = len(a)
    ex = a == 0
    lo = np.abs(a.astype(np.int32)) <= eps
    ml = int(min_run_s * SR)
    r = runs(lo, ml)
    return {"n": n, "zero_frac": float(ex.mean()) if n else 0.0, "lo_frac": float(lo.mean()) if n else 0.0,
            "clip_frac": float((np.abs(a.astype(np.int32)) >= 32767).mean()) if n else 0.0,
            "max_abs": int(np.abs(a.astype(np.int32)).max()) if n else 0,
            "runs": [(s / SR, l / SR) for s, l in r],
            "max_run_s": max([l for _, l in r], default=0) / SR if r else 0.0}


# ---- voice-isolation signature (audio-13) ---------------------------------------------------------------------
FRAME = 960                   # 20 ms at 48 kHz
FRAMES_PER_BIN = 50           # per-second bins
VI_ZERO_RATIO = 0.95          # frame zero_ratio (|s|<=1 share) at least this ...
VI_GATED_PEAK = 65            # ... and peak below 0.002 of full scale (0.002 * 32768 = 65.5)
VI_SPEECH_PEAK = 328          # speech frame: peak at least 0.01 of full scale (0.01 * 32768 = 327.7)


def vi_bins(a):
    """Per-second counts of voice-isolation frames in one decoded chunk: ([gated], [speech], [frames]) lists, one
    entry per started second. gated = zero_ratio >= 0.95 and peak < 0.002; speech = peak >= 0.01. A trailing partial
    frame is dropped. Counts only; no audio is kept."""
    n = len(a) // FRAME
    if n == 0:
        return [], [], []
    f = np.abs(a[:n * FRAME].astype(np.int32)).reshape(n, FRAME)
    zr = (f <= 1).mean(axis=1)
    pk = f.max(axis=1)
    gated = (zr >= VI_ZERO_RATIO) & (pk <= VI_GATED_PEAK)
    speech = pk >= VI_SPEECH_PEAK
    bins = -(-n // FRAMES_PER_BIN)
    pad = bins * FRAMES_PER_BIN - n
    def agg(m):
        return np.concatenate((m, np.zeros(pad, dtype=bool))).reshape(bins, FRAMES_PER_BIN).sum(axis=1)
    cnt = np.concatenate((np.ones(n, dtype=bool), np.zeros(pad, dtype=bool))).reshape(bins, FRAMES_PER_BIN).sum(axis=1)
    return [int(x) for x in agg(gated)], [int(x) for x in agg(speech)], [int(x) for x in cnt]
