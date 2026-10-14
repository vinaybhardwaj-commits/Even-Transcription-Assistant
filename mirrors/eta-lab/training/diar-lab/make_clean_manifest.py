#!/usr/bin/env python3
"""Clean training manifest (refuter T1): drop EVERY window on a room-day that contains a permanent-test window, then assign an explicit
train/val split BY ROOM-DAY (deterministic: room-days ordered by sha256(room_day_id); the first ones become val until val has >= VAL_MIN_WINDOWS windows).
Every split decision and exclusion is recorded in the manifest, so the refuter (or anyone) can check it without running code.
usage: make_clean_manifest.py <merged_manifest.json> [--val-min-windows 24]   -> prints the written path"""
import argparse, hashlib, json, os, time
ap = argparse.ArgumentParser(); ap.add_argument("merged"); ap.add_argument("--val-min-windows", type=int, default=24)
ap.add_argument("--val-strategy", choices=["hash", "count-match"], default="hash")
ap.add_argument("--val-target", choices=["bench20", "production"], default="bench20", help="count-match target histogram: bench20 (test shape, ruling 103 as written) or production (all teacher-labelled production windows; refuter recommendation)")
a = ap.parse_args()
DS = os.path.expanduser("~/dev/eta-lab/datasets")
test_rds = set(json.load(open(f"{DS}/permanent-test-room-days.json"))["room_day_ids"])
src = json.load(open(a.merged))
kept = [w for w in src["windows"] if w["room_day_id"] not in test_rds]
dropped = [{"window_id": w["window_id"], "room_day_id": w["room_day_id"]} for w in src["windows"] if w["room_day_id"] in test_rds]
by_rd = {}
for w in kept: by_rd.setdefault(w["room_day_id"], []).append(w)
import glob, itertools
from collections import Counter
def teacher_count(w):
    p = glob.glob(os.path.expanduser(f"~/eta-data/diar-train/*/{w['window_id']}.rttm"))[0]
    return len({l.split()[7] for l in open(p) if l.startswith("SPEAKER")})
for w in kept: w["teacher_count"] = teacher_count(w)
val_selection = None
if a.val_strategy == "hash":
    order = sorted(by_rd, key=lambda r: hashlib.sha256(r.encode()).hexdigest())
    val_rds, n_val = [], 0
    for r in order:
        if n_val >= a.val_min_windows: break
        val_rds.append(r); n_val += len(by_rd[r])
else:   # ruling 103: val must look like the TEST count distribution (bench20 teacher counts, <= 8 speakers), still disjoint BY ROOM-DAY
    B = lambda c: min(c, 6)
    bench = []
    for p in sorted(glob.glob(os.path.expanduser("~/eta-data/diar-lab/data/bake20-ref/*_pyannote.json"))):
        n = len({s["speaker"] for s in json.load(open(p))["output"]["diarization"]})
        if n <= 8: bench.append(n)
    tgt = Counter(B(c) for c in bench); T = [tgt[k] / len(bench) for k in range(1, 7)]
    if a.val_target == "production":
        ph = json.load(open(f"{DS}/production-count-hist-2026-09-24.json")); tt = sum(ph["hist_1_to_6plus"].values())
        T = [ph["hist_1_to_6plus"][str(k)] / tt for k in range(1, 7)]; bench = [round(ph["mean"])] * ph["n"]     # only n and mean are recorded below
    cnts = {r: [w["teacher_count"] for w in ws if w["teacher_count"] <= 8] for r, ws in by_rd.items()}   # >8-speaker windows are skipped by the trainer
    cands = []
    for k in range(2, 6):
        for sub in itertools.combinations(sorted(by_rd), k):
            cs = [c for r in sub for c in cnts[r]]
            if not 20 <= len(cs) <= 40: continue
            h = Counter(B(c) for c in cs); cands.append((round(sum(abs(h[j] / len(cs) - T[j - 1]) for j in range(1, 7)), 6), sub, len(cs), sum(cs) / len(cs)))
    cands.sort(); val_rds = list(cands[0][1]); n_val = sum(len(by_rd[r]) for r in val_rds)
    val_selection = {"target": a.val_target, "target_hist_1_to_6plus": [round(x, 3) for x in T], "target_n": len(bench), "target_mean": (round(ph["mean"], 2) if a.val_target == "production" else round(sum(bench) / len(bench), 2)),
                     "chosen": {"room_days": val_rds, "L1": cands[0][0], "n_windows_le8": cands[0][2], "mean": round(cands[0][3], 2)},
                     "next_best": [{"room_days": list(c[1]), "L1": c[0], "n": c[2], "mean": round(c[3], 2)} for c in cands[1:4]],
                     "rule": "exhaustive over 2-5 room-day subsets with 20-40 windows (<=8 speakers): minimise L1 between val teacher-count histogram (1..6+) and the bench20 histogram; ties -> lexicographic room-day ids",
                     "caveat": "room-day granularity and a clean pool with no high-count room-days: best val mean is below the test mean (bench20 mean incl. >8 windows is 5.0)"}
windows = [{**w, "split": "val" if w["room_day_id"] in val_rds else "train"} for w in kept]
h = hashlib.sha256("\n".join(sorted(w["label_id"] + w["split"] for w in windows)).encode()).hexdigest()[:8]
dataset_id = f"diar-train-clean-{time.strftime('%Y-%m-%d')}-{h}"
m = {"dataset_id": dataset_id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "derived_from": src["dataset_id"],
     "rule": ("drop all windows on permanent-test room-days (datasets/permanent-test-room-days.json); val = first room-days by sha256(room_day_id) until >= %d windows" % a.val_min_windows if a.val_strategy == "hash" else "drop all windows on permanent-test room-days; val = count-matched room-days to the %s count histogram (see val_selection)" % a.val_target + "; rest train") + "; no window-level splitting",
     "val_selection": val_selection,
     "excluded_test_room_days": sorted(test_rds), "excluded_windows_on_test_room_days": dropped,
     "excluded_test_windows_with_rooms": json.load(open(f"{DS}/permanent-test-room-days.json")).get("test_window_rooms"),
     "val_room_days": val_rds, "train_room_days": sorted(r for r in by_rd if r not in val_rds),
     "counts": {"source": len(src["windows"]), "excluded": len(dropped), "train": sum(w["split"] == "train" for w in windows), "val": n_val},
     "excluded_unverified": src.get("excluded_unverified", []), "windows": windows}
out = f"{DS}/{dataset_id}.json"; json.dump(m, open(out, "w"), indent=1); print(out)
