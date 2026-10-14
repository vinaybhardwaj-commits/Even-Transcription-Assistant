#!/usr/bin/env python3
"""vj-link (box, venv-gpu), vj-refuter #1403: the group VOTE rule on the same 14 placebos.  On the 70 room-days (dtree70, complete linkage).
VOTE: a group's doctor = the plurality of its member voices' best timing doctors; STRICT rule = cross-day group, >= 3 of >= 4 voted days name the same doctor, plurality share >= 40%, binomial tail vs 12.5% chance < 0.01.
Groups are voice-only (identical under every placebo); only the doctor labels change. Anchored groups (stored-print truth) come from anchors: anchored-groups.json (real gids mapped to member voices).
Reports real vs placebo: (a) groups passing the strict vote, (b) of those, anchored and correct, (c) anchored groups whose plurality doctor == the anchor doctor (vote precision against the anchors), (d) non-anchored groups passing."""
import collections, json, math, os, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
H = os.path.expanduser(f"~/eta-data/voice-linkage/{os.environ.get('TREE', 'dtree70')}"); P0 = 0.125
SUF = ["", "-pl4", "-pl-4", "-pl5", "-pl-5", "-pl6", "-pl-6", "-pl7", "-pl-7", "-pd1", "-pd2", "-pd3", "-pd4", "-pd5", "-pd6"]
rds = json.load(open(os.path.expanduser(f"~/eta-data/voice-linkage/overnight/{os.environ.get('RDSJSON', 'rds70.json')}")))
real_g = {x["gid"]: x for x in json.load(open(f"{H}/overnight/glinks-complete.json"))}
A = json.load(open(f"{H}/overnight/anchored-groups.json"))
anch_members = {a["gid"]: ({tuple(m) for m in real_g[a["gid"]]["members"]}, a["anchor_doctor_uid"]) for a in A}
tail = lambda k, n: sum(math.comb(n, i) * P0 ** i * (1 - P0) ** (n - i) for i in range(k, n + 1))
rows = {}
for suf in SUF:
    L = T.load(rds, H, suf); V = T.voices(L); G = T.groups(V)
    groups = {frozenset(v) for v in G.values()}; res = {"passing": 0, "passing_anchored_correct": 0, "passing_anchored_wrong": 0, "passing_non_anchored": 0, "anchored_plurality_correct": 0, "anchored_total": 0, "anchored_pass_strict": 0}
    for g in groups:
        mem = list(g); days = {m[0] for m in mem}
        c = collections.Counter(V[m]["best"] for m in mem if V[m]["best"]); n = sum(c.values())
        vote = None
        if n: d, k = c.most_common(1)[0]; vote = (d, k, n, tail(k, n))
        anch = next(((gid, doc) for gid, (ms, doc) in anch_members.items() if ms & set(mem)), None)
        if anch and vote:
            res["anchored_total"] += 1; res["anchored_plurality_correct"] += vote[0] == anch[1]
        if len(days) >= 2 and vote and vote[1] >= 3 and vote[2] >= 4 and vote[3] < 0.01 and vote[1] / vote[2] >= 0.4:
            res["passing"] += 1
            if anch: res["passing_anchored_correct" if vote[0] == anch[1] else "passing_anchored_wrong"] += 1; res["anchored_pass_strict"] += 1
            else: res["passing_non_anchored"] += 1
    rows[suf or "real"] = res
real = rows["real"]; pl = {k: v for k, v in rows.items() if k != "real"}
out = {"real": real, "placebo": pl, "summary": {}}
print("group vote rule, real vs 14 placebos (extended set, complete linkage; tree from TREE env)")
for m in ("passing", "passing_non_anchored", "passing_anchored_correct", "passing_anchored_wrong", "anchored_plurality_correct"):
    vals = [v[m] for v in pl.values()]
    s = {"real": real[m], "placebo_min": min(vals), "placebo_median": statistics.median(vals), "placebo_max": max(vals), "empirical_p_ge_real": round((1 + sum(v >= real[m] for v in vals)) / (1 + len(vals)), 3)}
    out["summary"][m] = s; print(f"  {m:30s} real {s['real']!s:3} placebo min/med/max {s['placebo_min']!s:3}/{s['placebo_median']!s:5}/{s['placebo_max']!s:3} p={s['empirical_p_ge_real']}")
print("  anchored groups with a vote:", real["anchored_total"], "| per-placebo plurality-correct:", [v["anchored_plurality_correct"] for v in pl.values()])
print("  per-placebo strict-vote passers:", [v["passing"] for v in pl.values()], "| of which anchored-correct:", [v["passing_anchored_correct"] for v in pl.values()])
json.dump(out, open(f"{H}/overnight/vote-placebo.json", "w"), indent=1)
