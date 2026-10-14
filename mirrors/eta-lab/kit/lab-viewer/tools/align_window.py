#!/usr/bin/env python3
"""Whole-window alignment check for the viewer's mapping (local audio copies, no network, no text printed).

Places every source chunk on the wall clock at its started_at (as the cut does), builds a per-second energy
vector for the window, and a per-second 'transcript covers this second' vector from the segments' start_s/end_s.
Correlates them at lags -40..+40 s. If the viewer's mapping (abs = window start + start_s, offset = abs - chunk start)
is right, the best lag is ~0. A best lag far from 0 means a systematic offset.

  align_window.py [--n 8] [--seed 1]
"""
import argparse, array, glob, json, math, random, subprocess, sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
utc = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def rms_per_second(path):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], capture_output=True).stdout
    a = array.array("h"); a.frombytes(pcm)
    return [math.sqrt(sum(x * x for x in a[i:i + 8000]) / max(1, len(a[i:i + 8000]))) for i in range(0, len(a), 8000)]


def corr(x, y):
    n = len(x); mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else 0.0


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=8); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--audio-dir", default=str(HOME / "eta-data/hist-mining/audio")); a = ap.parse_args()
    random.seed(a.seed)
    files = glob.glob(str(HOME / "eta-data/lab-vault/staged/runs/*/*/*/*.json")); random.shuffle(files)
    done = 0
    for f in files:
        d = json.load(open(f)); chunks = d["provenance"].get("source_chunks") or []
        segs = d.get("segments") or []
        local = {c["r2_key"]: Path(a.audio_dir) / c["r2_key"].replace("/", "__") for c in chunks}
        if len(segs) < 8 or not chunks or not all(v.exists() for v in local.values()):
            continue
        ws = utc(d["start"]); T = int(utc(d["end"]) - ws)
        energy = [0.0] * T
        for c in chunks:
            base = utc(c["started_at"]) - ws
            for i, v in enumerate(rms_per_second(local[c["r2_key"]])):
                t = int(base + i)
                if 0 <= t < T: energy[t] = v
        cover = [0.0] * T
        for s in segs:
            for t in range(int(s["start_s"]), min(T, int(s["end_s"]) + 1)): cover[t] = 1.0
        res = {lag: corr(energy[max(0, lag):T + min(0, lag)], cover[max(0, -lag):T - max(0, lag)]) for lag in range(-40, 41)}
        best = max(res, key=res.get)
        print(f"{Path(f).stem}: {len(segs)} lines, corr at lag 0 = {res[0]:.2f}, best lag {best:+d}s (corr {res[best]:.2f})  {'ALIGNED' if abs(best) <= 3 else 'OFFSET?'}")
        done += 1
        if done >= a.n: break
    if not done: print("no window with all source chunks on local disk"); return 1


if __name__ == "__main__":
    sys.exit(main())
