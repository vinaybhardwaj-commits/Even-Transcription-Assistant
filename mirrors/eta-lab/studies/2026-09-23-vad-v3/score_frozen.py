#!/usr/bin/env python3
"""
Re-score cached VAD intervals with eta-refuter-2's M1-M3 rules (METHOD-REVIEW-eta-refuter-2.md):

 M1  regime: a window counts toward the % bar only if teacher speech >= 60 s; below that the bar is an
     absolute <= 2 s cut. Report how many windows fall in each regime.
 M2  dropped segments: teacher (unmerged) segments >= 0.3 s that are >= 80% cut.
 M3  boundary collar: score with teacher segments shrunk by 0.25 s each side, and without; report both.

Inputs are the cached kept-intervals written by run_ensembles.py (intervals only, no audio/text).
Configs here are the FROZEN candidates listed in PREREGISTRATION.md. Nothing is tuned in this script.
"""
import argparse, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_ensembles import merge, union, vote, pad  # noqa: E402

FROZEN = {
    "B (energy-only)":            lambda A, d: A["B"],
    "S_all3 (Silero+preproc)":    lambda A, d: A["S_all3"],
    "W0 (WebRTC agg0)":           lambda A, d: A["W0"],
    "U(S_all3,B)":                lambda A, d: union(A["S_all3"], A["B"]),
    "U(S_all3,W0) no pad": lambda A, d: union(A["S_all3"], A["W0"]),
    "U(S_all3,W0)+pad1.0s":       lambda A, d: pad(union(A["S_all3"], A["W0"]), 1.0, d),
    "U(S_all3,W0)+pad2.0s":       lambda A, d: pad(union(A["S_all3"], A["W0"]), 2.0, d),
}


def covered(a, b, keep):
    c = 0.0
    for s, e in keep:
        if e <= a:
            continue
        if s >= b:
            break
        c += max(0.0, min(b, e) - max(a, s))
    return c


def shrink(segs, collar):
    return [(s + collar, e - collar) for s, e in segs if e - s > 2 * collar]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--exclude", default=None, help="json list of window ids to leave out (sensitivity only)")
    a = ap.parse_args()
    wids = sorted(f[:-5] for f in os.listdir(a.cache_dir) if f.endswith(".json"))
    if a.exclude:
        ex = set(json.load(open(a.exclude)))
        wids = [w for w in wids if w not in ex]
    out = {"label": a.label, "n_windows": len(wids), "configs": {}}
    for name, fn in FROZEN.items():
        rows = []
        for wid in wids:
            c = json.load(open(os.path.join(a.cache_dir, wid + ".json")))
            A = {k: [tuple(x) for x in v] for k, v in c["arms"].items()}
            keep = merge(fn(A, c["dur"]))
            segs = [(s["start"], s["end"]) for s in json.load(open(os.path.join(a.ref_dir, wid + "_pyannote.json")))["output"]["diarization"]]
            merged = merge(segs)
            tot = sum(e - s for s, e in merged)
            cut = sum((e - s) - covered(s, e, keep) for s, e in merged)
            col = shrink(merged, 0.25)
            ctot = sum(e - s for s, e in col)
            ccut = sum((e - s) - covered(s, e, keep) for s, e in col)
            dropped = sum(1 for s, e in segs if e - s >= 0.3 and covered(s, e, keep) / (e - s) <= 0.2)
            rows.append({"wid": wid, "teacher_s": tot, "cut_s": cut, "cut_pct": cut / tot * 100 if tot else 0.0,
                         "collar_cut_s": ccut, "collar_cut_pct": ccut / ctot * 100 if ctot else 0.0,
                         "dropped_segments": dropped, "sent_s": sum(e - s for s, e in keep), "dur": c["dur"]})
        big = [r for r in rows if r["teacher_s"] >= 60]
        small = [r for r in rows if r["teacher_s"] < 60]
        pct = lambda k: np.array([r[k] for r in big]) if big else np.array([0.0])
        out["configs"][name] = {
            "regime_pct_bar_windows": len(big), "regime_abs_bar_windows": len(small),
            "pct_bar_fail_uncollared": int((pct("cut_pct") > 2).sum()),
            "pct_bar_fail_collared": int((pct("collar_cut_pct") > 2).sum()),
            "pct_bar_worst_uncollared": round(float(pct("cut_pct").max()), 2),
            "pct_bar_worst_collared": round(float(pct("collar_cut_pct").max()), 2),
            "pct_bar_p95_collared": round(float(np.percentile(pct("collar_cut_pct"), 95)), 2),
            "abs_bar_fail_gt2s": int(sum(1 for r in small if r["cut_s"] > 2.0)),
            "abs_bar_worst_s": round(max([r["cut_s"] for r in small], default=0.0), 2),
            "windows_with_dropped_segments": int(sum(1 for r in rows if r["dropped_segments"] > 0)),
            "total_dropped_segments": int(sum(r["dropped_segments"] for r in rows)),
            "audio_sent_pct": round(sum(r["sent_s"] for r in rows) / sum(r["dur"] for r in rows) * 100, 1),
        }
    json.dump(out, open(a.out, "w"), indent=2)
    print(f"{a.label}: {len(wids)} windows")
    for n, v in out["configs"].items():
        print(f"  {n:24s} pct-bar n={v['regime_pct_bar_windows']} fail(uncol/col)={v['pct_bar_fail_uncollared']}/{v['pct_bar_fail_collared']} "
              f"worst col={v['pct_bar_worst_collared']}% | abs-bar n={v['regime_abs_bar_windows']} fail={v['abs_bar_fail_gt2s']} "
              f"| dropped segs={v['total_dropped_segments']} in {v['windows_with_dropped_segments']} windows | sent={v['audio_sent_pct']}%")


if __name__ == "__main__":
    main()
