#!/usr/bin/env python3
"""vj-link (box, venv-gpu): the 'two places at once' flag (vj-refuter P1; ruling 289: NOT adopted for batch 2, recorded as a batch-3 candidate). For every group: for each pair of member voices on the SAME date in DIFFERENT rooms,
the seconds of SIMULTANEOUS core speech (core turns of the two voices overlapping in wall-clock time). Flag = >= 30 s. Counts only; applies to nothing.
Data: dtree_ext (70 room-days, complete linkage). Out: dtree_ext/overnight/two-places.json."""
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
E = os.path.expanduser("~/eta-data/voice-linkage/dtree_ext")
g = {x["gid"]: x for x in json.load(open(f"{E}/overnight/glinks-complete.json"))}; A = {a["gid"] for a in json.load(open(f"{E}/overnight/anchored-groups.json"))}
rds = sorted({m[0] for x in g.values() for m in x["members"]}); L = T.load(rds, E); turns = {rd: json.load(open(f"{E}/turns-{rd}.json"))["turns"] for rd in rds}
def spans(rd, c): return sorted((int(turns[rd][i]["s_ms"]), int(turns[rd][i]["e_ms"])) for i in L[rd]["core_turn_idx"][str(c)])
def overlap_s(a, b):
    i = j = 0; tot = 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo: tot += hi - lo
        if a[i][1] < b[j][1]: i += 1
        else: j += 1
    return tot / 1000
out = {}; cache = {}
for gid, x in g.items():
    mem = [tuple(m) for m in x["members"]]; worst = 0.0; pairs = 0; flagged = 0
    for i, a in enumerate(mem):
        for b in mem[i + 1:]:
            if a[0] == b[0] or L[a[0]]["date"] != L[b[0]]["date"] or turns[a[0]][0].get("source_ref") is None: continue
            ra, rb = json.load(open(f"{E}/turns-{a[0]}.json"))["room"]["room_id"] if False else None, None
            for k in (a, b): cache.setdefault(k, spans(*k))
            s = overlap_s(cache[a], cache[b]); pairs += 1; worst = max(worst, s); flagged += s >= 30
    out[gid] = {"same_day_pairs": pairs, "max_simultaneous_core_s": round(worst, 1), "flagged_pairs": flagged, "anchored": gid in A, "n_room_days": x["n_room_days"]}
json.dump(out, open(f"{E}/overnight/two-places.json", "w"), indent=1)
multi = {k: v for k, v in out.items() if v["same_day_pairs"]}
print("groups", len(out), "| with a same-day pair in 2 rooms:", len(multi), "| flagged (>= 30 s):", sum(1 for v in multi.values() if v["flagged_pairs"]))
print("anchored groups:", [(k, v["same_day_pairs"], v["max_simultaneous_core_s"]) for k, v in out.items() if v["anchored"]])
print("non-anchored flagged:", sum(1 for k, v in multi.items() if v["flagged_pairs"] and not v["anchored"]), "of", sum(1 for k, v in multi.items() if not v["anchored"]))
