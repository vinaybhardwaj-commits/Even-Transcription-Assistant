#!/usr/bin/env python3
"""vj-link: real vs placebo (vj-refuter P1-P4). Reads dtree18/overnight/glinks-<mode><suffix>.json (overnight_groups.py, pre-Jev tiers: Rx-or-LQ uses Rx only). 14 placebos: hours +-4,+-5,+-6,+-7 and date offsets 1..6.
For each measure: the real value, the placebo min / median / max and the empirical p = share of placebos with a value >= real (14 placebos: the smallest possible p is 1/15)."""
import json, os, statistics, collections, sys
T = os.path.expanduser(f"~/eta-data/voice-linkage/{os.environ.get('TREE', 'dtree18')}/overnight")
SUF = ["-pl4", "-pl-4", "-pl5", "-pl-5", "-pl6", "-pl-6", "-pl7", "-pl-7", "-pd1", "-pd2", "-pd3", "-pd4", "-pd5", "-pd6"]
def stats(g):
    xd = [x for x in g if x["xday"]]; ex = [x for x in g if x["xday"] and x["excl"] and x["n5"]]
    return {"groups": len(g), "xday": len(xd), "staff_candidates": sum(x["staff_candidate"] for x in xd), "max_room_days_in_a_group": max((x["n_room_days"] for x in g), default=0),
            "xday_excl_n5": len(ex), "HIGH": sum(x["tier_pre_jev"] == "HIGH" for x in g), "MED": sum(x["tier_pre_jev"] == "MED" for x in g),
            "stable_readingA_groups": sum(x["stable"] for x in g), "rx_groups": sum(x["rx"] for x in g),
            "mean_rx_hits_rep": round(statistics.mean(x.get("rx_hits_rep", 0) for x in g), 3) if g else 0,
            "dominant_share_of_xday_excl_n5": (round(sum(bool(x.get("dominant_rep")) for x in ex) / len(ex), 2) if ex else None),
            "median_excess_rep": round(statistics.median(x["excess_rep"] for x in g), 3) if g else None}
out = {}
for mode in ("complete", "single"):
    real = stats(json.load(open(f"{T}/glinks-{mode}.json"))); pl = {s: stats(json.load(open(f"{T}/glinks-{mode}{s}.json"))) for s in SUF}
    m = {}
    for k in real:
        if real[k] is None: continue
        vals = [pl[s][k] for s in SUF if pl[s][k] is not None]
        m[k] = {"real": real[k], "placebo_min": min(vals), "placebo_median": statistics.median(vals), "placebo_max": max(vals), "empirical_p": round((1 + sum(v >= real[k] for v in vals)) / (1 + len(vals)), 3)}
    out[mode] = {"measures": m, "placebo_by_run": pl}
    print(f"== {mode} linkage (real vs {len(SUF)} placebos)")
    for k, v in m.items(): print(f"  {k:32s} real {v['real']!s:8} placebo min/med/max {v['placebo_min']!s:7}/{v['placebo_median']!s:7}/{v['placebo_max']!s:7}  p={v['empirical_p']}")
    hours = [pl[s]["xday_excl_n5"] for s in SUF if s.startswith("-pl")]; dates = [pl[s]["xday_excl_n5"] for s in SUF if s.startswith("-pd")]
    print(f"  xday_excl_n5 under hour-shift placebos {hours} | date-offset placebos {dates}")
json.dump(out, open(f"{T}/placebo-summary.json", "w"), indent=1)
