#!/usr/bin/env python3
"""Leave-one-day-out comparison: old print vs a print rebuilt from room audio.

    python3 measure.py --old old_prints.json --mined mined.json --obs obs.json --neg neg.json --out table.tsv

old_prints.json  {clinician_id: embedding_base64}          the stored voice_print centroid
mined.json       mine.py output                            clips per (clinician, day)
obs.json         [{clinician_id, day, embedding_base64}]   what /diarize produced for that day's cluster:
                                                           what production actually scores
neg.json         [{ref, embedding_base64}]                 speakers known NOT to be any of the above
                                                           (negative control), scored against the new print

For each held-out day d of a clinician: the new print is mean_raw of the clip embeddings from every OTHER
day, and it is scored against d's observation, next to the old print scored against the same
observation. A print is never scored against audio it was built from. Prints stay in memory; the table
holds ids, days and scores only.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s2b_lib import mean_raw, cosine, distribution, ROOM_THRESHOLD

ap = argparse.ArgumentParser()
for f in ("old", "mined", "obs", "neg", "out"):
    ap.add_argument(f"--{f}", required=(f != "neg"))
a = ap.parse_args()
old = json.load(open(a.old))
mined = json.load(open(a.mined))
obs = json.load(open(a.obs))
neg = json.load(open(a.neg)) if a.neg else []

rows, old_s, new_s, neg_s = [], [], [], []
for cid in sorted({r["clinician_id"] for r in mined}):
    recs = {r["day"]: r for r in mined if r["clinician_id"] == cid}
    for day in sorted(recs):
        others = [c["embedding_base64"] for d, r in recs.items() if d != day for c in r["clips"]]
        held = [o for o in obs if o["clinician_id"] == cid and o["day"] == day]
        if not others or not held:
            continue
        new_print = mean_raw(others)
        s_new = cosine(new_print, held[0]["embedding_base64"])
        s_old = cosine(old[cid], held[0]["embedding_base64"])
        nmax = max((cosine(new_print, n["embedding_base64"]) for n in neg), default=None)
        rows.append((cid, day, len(others), s_old, s_new, nmax))
        old_s.append(s_old); new_s.append(s_new)
        if nmax is not None:
            neg_s.append(nmax)

with open(a.out, "w") as f:
    f.write("clinician_id\theld_out_day\tclips_in_new_print\told_print_score\tnew_print_score\tdelta\tnegative_control_max\n")
    for cid, day, n, so, sn, nm in rows:
        f.write(f"{cid}\t{day}\t{n}\t{so:.3f}\t{sn:.3f}\t{sn - so:+.3f}\t{'' if nm is None else f'{nm:.3f}'}\n")
res = {"threshold": ROOM_THRESHOLD, "old": distribution(old_s), "new": distribution(new_s),
       "wins_for_new": sum(1 for r in rows if r[4] > r[3]), "held_out_days": len(rows),
       "negative_control_worst": max(neg_s) if neg_s else None,
       "mean_delta": (sum(r[4] - r[3] for r in rows) / len(rows)) if rows else None}
print(json.dumps(res, indent=1))
