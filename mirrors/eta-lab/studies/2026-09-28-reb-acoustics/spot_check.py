#!/usr/bin/env python3
"""20-window spot-check: compare acoustics_layer.py's dry-run tracks against the existing
chunk_metrics.jsonl profiles for the same chunk id (the room-profile ground truth these tracks are
built from). Numbers only.
"""
import argparse
import json
import os
import random

CM = os.path.expanduser("~/eta-data/acoustics/work/chunk_metrics.jsonl")


def load_ground_truth():
    gt = {}
    with open(CM) as f:
        for line in f:
            r = json.loads(line)
            gt[r["id"]] = r
    return gt


def metric(track, name):
    for s in track.get("segments", []):
        if s.get("extras", {}).get("metric") == name:
            return s["value"]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dryrun_files", nargs="+")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tol-db", type=float, default=0.05)
    a = ap.parse_args()

    rows = []
    for fp in a.dryrun_files:
        with open(fp) as f:
            for line in f:
                rows.append(json.loads(line))

    gt = load_ground_truth()
    candidates = [r for r in rows if r["rec_id"] in gt and r["track"]["status"] == "ok"]
    random.Random(a.seed).shuffle(candidates)
    sample = candidates[: a.n]

    n_pass = n_fail = 0
    for r in sample:
        t = r["track"]
        g = gt[r["rec_id"]]
        checks = []
        # clip_share_999 must match exactly (same threshold, same samples)
        checks.append(("clip_share", metric(t, "clip_share"), g.get("clip_share_999"),
                        lambda a, b: a is not None and b is not None and abs(a - b) < 1e-9))
        # noise_floor_dbfs vs ground truth's noise_p10 (same VAD split, same percentile)
        checks.append(("noise_floor_dbfs", metric(t, "noise_floor_dbfs"), g.get("noise_p10"),
                        lambda a, b: (a is None) == (b is None) and (a is None or abs(a - b) < a_tol)))
        # zero_sample_share implied by mute spans' total duration vs ground truth's zero_sample_share
        mute_ms = sum(s["value"] * 1000 for s in t.get("segments", [])
                      if s.get("extras", {}).get("metric") == "mute_span")
        implied_zero_share = mute_ms / t["segments"][0]["t1_ms"] if t.get("segments") else 0
        checks.append(("zero_share(>=200ms spans)", round(implied_zero_share, 4),
                        round(g.get("zero_sample_share", 0), 4), lambda a, b: True))  # informational only
        ok = all(f(x, y) for _, x, y, f in checks[:2])
        n_pass += ok
        n_fail += not ok
        print(r["rec_id"], "PASS" if ok else "FAIL", checks)

    print(f"\nspot-check: {n_pass}/{len(sample)} pass, {n_fail} fail (n={len(sample)} of "
          f"{len(candidates)} eligible)")


a_tol = 0.05  # dB tolerance for noise-floor match (same computation path; should be ~exact)

if __name__ == "__main__":
    main()
