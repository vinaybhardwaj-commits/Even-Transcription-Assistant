#!/usr/bin/env python3
"""Score engines against the HUMAN speaker counts from the 30-window page (V35 benchmark, ruling 94/133).
usage: score_count_page.py --raters raters.json --key ~/eta-data/speaker-count-30/key.json --engine NAME=engine_counts.json [--engine ...] [--min-rated 20]
  raters.json : list of {"rater": id, "w": {<opaque window id>: {"n": 0-8, "plus": bool?, "conf": "sure"|"unsure"}}}   (the page's counts/<rater> docs)
  key.json    : opaque id -> {id (sc30-NN), teacher_count, nemotron_count, pyannote_count, ...}   (staff only; never given to raters)
  engine json : {<opaque window id> or <sc30-NN>: count}, or a nemo_run.py output (run it on ~/eta-data/speaker-count-30/.wav16k with --nemo-path <checkpoint>).  pyannote.ai (teacher) and stock Nemotron come from the key.
Reports: rater agreement (exact / within one / mean abs diff), then per engine the mean abs count error vs (a) each rater, (b) the consensus on windows where
the raters AGREE (a clean-truth subset), (c) the mean of raters on all windows rated by all. Nothing is printed per window text; ids and counts only.
A rating with n=8 and plus=true means 8+; it is treated as 8 (engines are capped at 8 by the head)."""
import argparse, json, os, statistics as st, sys
ap = argparse.ArgumentParser(); ap.add_argument("--raters", required=True); ap.add_argument("--key", required=True)
ap.add_argument("--engine", action="append", default=[]); ap.add_argument("--min-rated", type=int, default=20)
a = ap.parse_args()
raters = json.load(open(a.raters)); key = json.load(open(a.key))
sc2op = {v["id"]: k for k, v in key.items()}
def done(x): return isinstance(x, dict) and isinstance(x.get("n"), int) and x.get("conf") in ("sure", "unsure")
R = {r["rater"]: {w: x["n"] for w, x in r.get("w", {}).items() if done(x) and w in key} for r in raters}
engines = {"pyannote.ai(teacher)": {w: v["teacher_count"] for w, v in key.items()}, "nemotron_base": {w: v["nemotron_count"] for w, v in key.items()}}
for spec in a.engine:
    name, path = spec.split("=", 1); d = json.load(open(path))
    if isinstance(d, dict) and "windows" in d: d = {k: v["n_speakers"] for k, v in d["windows"].items()}      # nemo_run.py output
    engines[name] = {(sc2op.get(k, k)): v for k, v in d.items()}
rated_any = set().union(*[set(v) for v in R.values()]) if R else set()
print(f"raters: { {r: len(v) for r, v in R.items()} }  windows rated by anyone: {len(rated_any)}  (threshold for scoring: {a.min_rated})")
if len(rated_any) < a.min_rated: print("BELOW THRESHOLD: report as provisional only"); 
names = sorted(R)
if len(names) >= 2:
    both = sorted(set.intersection(*[set(R[n]) for n in names]))
    if both:
        d = [abs(R[names[0]][w] - R[names[1]][w]) for w in both]
        print(f"agreement {names[0]} vs {names[1]} on {len(both)} windows: exact {sum(x == 0 for x in d) / len(d):.2f}, within one {sum(x <= 1 for x in d) / len(d):.2f}, mean abs diff {st.mean(d):.2f}")
    agreed = [w for w in (both if len(names) >= 2 else []) if len({R[n][w] for n in names}) == 1]
else: both, agreed = [], []
def mae(eng, truth): 
    ws = [w for w in truth if w in eng]; return (st.mean(abs(eng[w] - truth[w]) for w in ws), len(ws)) if ws else (None, 0)
print(f"{'engine':28} " + " ".join(f"vs {n[:10]:>10}" for n in names) + f" | agreed-subset (n={len(agreed)}) | mean-of-raters (n={len(both)})")
for en, ec in engines.items():
    cols = []
    for n in names:
        m, k = mae(ec, R[n]); cols.append(f"{m:.2f} (n={k})".rjust(13) if m is not None else "-".rjust(13))
    m1, k1 = mae(ec, {w: R[names[0]][w] for w in agreed}) if agreed else (None, 0)
    mm = {w: sum(R[n][w] for n in names) / len(names) for w in both}; m2, k2 = mae(ec, mm) if both else (None, 0)
    print(f"{en:28} " + " ".join(cols) + f" | {('%.2f' % m1) if m1 is not None else '-':>10} | {('%.2f' % m2) if m2 is not None else '-':>10}")
print("Multiplicity: several variants scored on the same 30 windows raise the chance of a lucky pass; report all, pick none on this page.")
