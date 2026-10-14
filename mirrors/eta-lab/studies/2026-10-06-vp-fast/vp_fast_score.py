#!/usr/bin/env python3
"""vp-fast step 4: score V's answers against the hidden key. Usage: vp_fast_score.py <voicecheck dir> <answers.json | answers.csv>
answers: JSON {"<slug>_<k>": "yes|no|unsure"} or {"<slug>_<k>": {"answer": "...", "comment": "..."}}; CSV with columns clip,answer,comment where clip = "<slug>_<k>" (or the file name).
CONFIRMED = yes to >= 4 of the 5 mint clips AND no to BOTH decoys (unsure or yes on a decoy = REJECTED); anything else = REJECTED. Never guesses: a missing answer is neither yes nor no."""
import csv, json, sys
sd, af = sys.argv[1], sys.argv[2]; key = json.load(open(f"{sd}/KEY-DO-NOT-SHIP.json"))["key"]
norm = lambda c: c.replace("clips/", "").replace(".wav", "")
if af.endswith(".json"): ans = {norm(k): (v["answer"] if isinstance(v, dict) else v) for k, v in json.load(open(af)).items()}
else: ans = {norm(r["clip"]): r["answer"] for r in csv.DictReader(open(af))}
res = {}
for slug, ks in key.items():
    r = res.setdefault(slug, dict(mint_yes=0, mint_n=0, decoy_no=0, decoy_n=0))
    for k, v in ks.items():
        a = (ans.get(f"{slug}_{k}") or "").strip().lower()
        if v["kind"] == "mint": r["mint_n"] += 1; r["mint_yes"] += a == "yes"
        else: r["decoy_n"] += 1; r["decoy_no"] += a == "no"
for s, r in res.items(): r["verdict"] = "CONFIRMED" if r["mint_yes"] >= 4 and r["decoy_n"] >= 2 and r["decoy_no"] == r["decoy_n"] else "REJECTED"
print(json.dumps(res, indent=1))
