#!/usr/bin/env python3
"""T-ACOUSTICS-20 step 1: per-chunk DSP metrics for the 7-day IST window from a FROZEN tape manifest.
Reuses chunk_metrics.process (W34.2, same code) and already-computed rows by chunk id. Skips every chunk
whose IST start day or end-1s day is an R3/W51 blind room-day. DSP only: no transcription/embeddings/listening.
Usage: run7d.py --frozen MANIFEST --out-dir DIR [--workers 2]
"""
import argparse, hashlib, json, os, sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from multiprocessing import Pool

sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-27-room-acoustics"))
sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import chunk_metrics as cm  # noqa: E402
import heldout  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
WINDOW = [f"2026-09-{d}" for d in range(22, 29)]
HOME_OFFICE = "room_2qe955hy"
OLD = os.path.expanduser("~/eta-data/acoustics/work/chunk_metrics.jsonl")


def ist_day(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(IST).date().isoformat()


def days_of(rec):
    t0 = datetime.fromisoformat(rec["started_at"].replace("Z", "+00:00"))
    t1 = t0 + timedelta(milliseconds=rec["duration_ms"]) - timedelta(seconds=1)
    return t0.astimezone(IST).date().isoformat(), t1.astimezone(IST).date().isoformat()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frozen", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)
    union, union_sha = heldout.load_union()
    recs = [json.loads(l) for l in open(a.frozen)]
    sel, skipped, skipped_ids = [], Counter(), []
    for r in recs:
        d0, d1 = days_of(r)
        if r["room_id"] != HOME_OFFICE and d0 not in WINDOW:
            continue
        if any(heldout.is_held_out(union, d, r["room_id"]) for d in {d0, d1}):
            skipped[f"{d0} {r['room_id']}"] += 1
            skipped_ids.append(r["id"])
            continue
        sel.append(r)
    out = os.path.join(a.out_dir, "chunk_metrics_7d.jsonl")
    done = set()
    if os.path.exists(out):
        done = {json.loads(l)["id"] for l in open(out) if l.strip().startswith("{")}
    old = {}
    for l in open(OLD):
        try:
            row = json.loads(l)
            old[row["id"]] = row
        except Exception:
            pass
    reuse = [old[r["id"]] for r in sel if r["id"] in old and r["id"] not in done]
    with open(out, "a") as fo:
        for row in reuse:
            fo.write(json.dumps(row) + "\n")
    done |= {row["id"] for row in reuse}
    todo = [r for r in sel if r["id"] not in done and os.path.exists(os.path.join(cm.TAPES, r["path"]))]
    meta = {"frozen_manifest": a.frozen, "frozen_manifest_sha256": hashlib.sha256(open(a.frozen, "rb").read()).hexdigest(),
            "union_sha16": union_sha, "window_ist_days": WINDOW, "selected": len(sel), "reused": len(reuse),
            "to_compute": len(todo), "blind_skipped_total": sum(skipped.values()),
            "blind_skipped_by_day_room": dict(sorted(skipped.items())), "blind_skipped_ids": skipped_ids}
    json.dump(meta, open(os.path.join(a.out_dir, "selection_meta.json"), "w"), indent=1)
    print("selected", len(sel), "reused", len(reuse), "to_compute", len(todo), "blind_skipped", sum(skipped.values()), flush=True)
    with open(out, "a") as fo, Pool(a.workers) as pool:
        for i, row in enumerate(pool.imap_unordered(cm.process, todo, chunksize=2)):
            fo.write(json.dumps(row) + "\n")
            fo.flush()
            if i % 100 == 0:
                print("progress", i + 1, "of", len(todo), flush=True)
    os.chmod(out, 0o640)
    print("COMPUTE_DONE", flush=True)


if __name__ == "__main__":
    main()
