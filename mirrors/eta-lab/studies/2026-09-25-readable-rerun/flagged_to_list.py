#!/usr/bin/env python3
"""Map split-speaker's flagged_ids.jsonl (id = window_id#segment_index, ids only) to hist record paths for cut_segments.py list.
A window can appear in several records (re-runs): pick the record whose segment idx has the same start_s/end_s/lang as the flagged row.
  flagged_to_list.py FLAGGED.jsonl OUT.jsonl [--engine sravaani --lang und]     (filters optional, repeatable via comma lists)"""
import argparse, glob, json, os, sys
H = os.path.expanduser("~/eta-data/hist")
ap = argparse.ArgumentParser(); ap.add_argument("flagged"); ap.add_argument("out")
ap.add_argument("--engine"); ap.add_argument("--lang")
a = ap.parse_args()
eng = set(a.engine.split(",")) if a.engine else None; lg = set(a.lang.split(",")) if a.lang else None
by = {}
for f in glob.glob(H + "/runs/*/*/*/*.json") + glob.glob(H + "/out/*/*.json"):
    if ".attempt" in f: continue
    by.setdefault(os.path.basename(f)[:-5], []).append(f)
n_ok = n_miss = 0
with open(a.out, "w") as fo:
    for line in open(a.flagged):
        r = json.loads(line)
        if eng and r["engine"] not in eng: continue
        if lg and r["lang"] not in lg: continue
        wid, idx = r["id"].rsplit("#", 1); idx = int(idx); hit = None
        for f in sorted(by.get(wid, []), reverse=True):
            try: segs = json.load(open(f)).get("segments") or []
            except Exception: continue
            if idx < len(segs) and abs(segs[idx]["start_s"] - r["start_s"]) < 0.06 and abs(segs[idx]["end_s"] - r["end_s"]) < 0.06:
                hit = f; break
        if not hit: n_miss += 1; continue
        n_ok += 1
        fo.write(json.dumps({"record": os.path.relpath(hit, H), "idx": idx, "id": r["id"], "forced_language": r.get("forced_language"),
                             "forced_language_source": r.get("forced_language_source"), "score": r.get("score")}) + "\n")
os.chmod(a.out, 0o600)
print(json.dumps({"mapped": n_ok, "unmapped": n_miss}))
