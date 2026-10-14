#!/usr/bin/env python3
"""bench_summary.py — HF-3: per-engine CPU timing from lane-3 job outputs (<out>/<family>/<win>.json -> timing_s). Numbers only, no text. Runs anywhere (stdlib).
  python3 bench_summary.py /data/lane3/out        -> per-engine median/mean seconds per 15-min window, and the windows/hour projection for the whole 6-track set (indic family + sravaani)"""
import glob, json, statistics as S, sys
root = sys.argv[1] if len(sys.argv) > 1 else "/data/lane3/out"; per, tot = {}, {}
for f in sorted(glob.glob(f"{root}/*/*.json")):
    o = json.load(open(f)); t = o.get("timing_s") or {}; fam = f.split("/")[-2]
    for k, v in t.items():
        if k not in ("audio_s",): per.setdefault(k, []).append(v)
    tot.setdefault(fam, []).append(t.get("total", 0) * (900.0 / t["audio_s"]) if t.get("audio_s") else t.get("total", 0))   # normalised to a 900 s window
for k, v in sorted(per.items()): print(f"{k:22s} n={len(v)} median={S.median(v):.1f}s mean={S.mean(v):.1f}s max={max(v):.1f}s")
fam_med = {fam: S.median(v) for fam, v in tot.items() if v}
if fam_med:
    win_s = sum(fam_med.values()); print(f"per-window total normalised to 900 s (median of the family totals summed): {win_s:.0f}s => {3600 / win_s:.1f} windows/h on this host; 418 windows = {418 * win_s / 3600:.0f} h" if win_s else "no timing")
