#!/usr/bin/env python3
"""r414.2 answer merger: per-batch Jev answers -> {id:{label,conf,probs,version}}.
Every key of every batch file must be answered exactly once; a dropped answer is
REAL (observed in trials) -> abort naming the key, so the caller re-asks that item.
  merge_answers.py --batches <dir> --answers <dir> --out <file>
Answer files: <set>_bNN.answers.json = {"answers": {K: {"choice":..,"confidence":..,"probabilities":{..}}}}
"""
import argparse, json, os, sys

ap = argparse.ArgumentParser()
ap.add_argument("--batches", required=True)
ap.add_argument("--answers", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()

out = {}
seen = set()
for bf in sorted(os.listdir(a.batches)):
    if not bf.endswith(".json") or ".answers." in bf:
        continue
    bdoc = json.load(open(os.path.join(a.batches, bf)))
    af = bf[:-5] + ".answers.json"
    p = os.path.join(a.answers, af)
    if not os.path.exists(p):
        sys.exit(f"missing answer file {af}")
    ans = json.load(open(p)).get("answers", {})
    for k in bdoc["questions"]:
        if k in seen:
            sys.exit(f"duplicate key {k}")
        if k not in ans:
            sys.exit(f"dropped answer for {k} in {af}")
        v = ans[k]
        for f in ("choice", "confidence", "probabilities"):
            if f not in v:
                sys.exit(f"answer {k} lacks {f}")
        if v["choice"] not in bdoc["questions"][k]["criteria"]:
            sys.exit(f"answer {k}: choice {v['choice']} not in frozen criteria")
        seen.add(k)
        out[k] = {"label": v["choice"], "conf": v["confidence"],
                  "probs": v["probabilities"], "version": bdoc["version"],
                  "batch": bf}
n_expected = {"label200": 200, "ba106": 106, "rate20": 20}
setname = sorted({json.load(open(os.path.join(a.batches, b)))["set"]
                  for b in os.listdir(a.batches) if b.endswith(".json")
                  and ".answers." not in b})
if len(setname) != 1:
    sys.exit(f"mixed sets in batches dir: {setname}")
if len(out) != n_expected[setname[0]]:
    sys.exit(f"{setname[0]}: merged {len(out)}, expected {n_expected[setname[0]]}")
os.makedirs(os.path.dirname(a.out), mode=0o700, exist_ok=True)
with open(a.out, "w", 0o600) as f:
    json.dump(out, f, ensure_ascii=False, sort_keys=True)
print(f"{setname[0]}: {len(out)} labels merged -> {a.out}")
