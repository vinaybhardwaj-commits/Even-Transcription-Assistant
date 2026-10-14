#!/usr/bin/env python3
"""vj-link overnight step 1 (voice-lab-1): voice groups across the 18-24 Sep room-days and the ruling-201 tier of every (group, doctor) link, BEFORE Jev.
 voices = top clusters of every room-day (voicelink.py); group = voices of different room-days with centroid cos >= 0.85 (tiering.py); each voice's best doctor = highest voice-timing excess.
 A LINK = (group, doctor D): the group's members that name D.  Group-level criteria (ruling 201/202):
   xday    group spans >= 2 room-days           excl   every member names the SAME best doctor D (else STAFF CANDIDATE, never HIGH) and no competing link inside a room-day
   n5      >= 5 core turns of the group inside D's consults (summed over members)
   rx      any member has >= 1 Rx drug/test word said by the voice          stable  any member room-day: D's edge alignment stable at >= 2 of 3 tolerances (Reading A)
   lq      Jev LQ yes and control no (filled after the Jev step)
 HIGH = xday+excl+n5+(rx or lq)+stable;  MED = xday+excl+n5 with (rx or lq) or stable missing;  else LOW (staff candidates and single-room-day voices are LOW).
Out: ~/vj/link/overnight/glinks.json (ids and numbers only), jev_in_overnight.json (consult/turn indices, no text), jev targets = every xday+excl+n5 link plus a seeded LOW sample.
Usage: overnight_groups.py [suffix]   ('' real, '-pl4'/'-pl-4' placebo)"""
import json, os, sys, random, collections, glob
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
H = os.path.expanduser(os.environ.get("LINK_H", "~/vj/link")); SUF = sys.argv[1] if len(sys.argv) > 1 else ""; SEED = 24092026
rds = sorted(p.split("link-")[1][:-5] for p in glob.glob(f"{H}/link-rd_*.json") if "-pl" not in p and "-pd" not in p)
L = T.load(rds, H, SUF); V = T.voices(L); G = T.groups(V)
edge = {}
for p in glob.glob(f"{H}/edge-2026-09-??{SUF}.json"):
    if SUF == "" and ("-pl" in p or "-pd" in p): continue
    edge[os.path.basename(p)[5:15]] = json.load(open(p))
seen, glinks = set(), []
for v in V:
    grp = tuple(sorted(G[v]))
    if grp in seen: continue
    seen.add(grp)
    days = {m[0] for m in grp}; best = {m: V[m]["best"] for m in grp}
    docs = collections.Counter(b for b in best.values() if b)
    if not docs: continue
    D = docs.most_common(1)[0][0]
    mem = [m for m in grp if best[m] == D]
    pairs = {m: next(p for p in V[m]["pairs"] if p["doctor_uid"] == D) for m in mem}
    n_core = sum(p.get("core_turns_in_consults", 0) for p in pairs.values())
    rx = sum(p["rx_hit_by_voice"] for p in pairs.values())
    st = max((edge.get(L[m[0]]["date"], {}).get(m[0], {}).get(D, {}).get("stable_tolerances") or 0) for m in mem)
    excl = len(docs) == 1
    rep = max(mem, key=lambda m: pairs[m].get("core_turns_in_consults", 0))
    glinks.append({"gid": f"g{len(glinks):03d}", "doctor_uid": D, "members": [list(m) for m in grp], "members_naming_D": [list(m) for m in mem], "rep": list(rep), "n_room_days": len(days),
                   "xday": len(days) >= 2, "excl": excl, "staff_candidate": not excl, "doctors_named": sorted(docs), "n5": n_core >= 5, "core_turns_in_consults": n_core, "rx_hits": rx, "rx": rx >= 1,
                   "stable_tolerances_max": st, "stable": st >= 2, "lq": None,
                   "excess_rep": pairs[rep]["excess"], "dominance_rank_rep": pairs[rep].get("dominance_rank"), "core_share_rep": pairs[rep].get("core_share_in_consults"), "dominant_rep": pairs[rep].get("dominance_rank") == 1, "rx_hits_rep": pairs[rep]["rx_hit_by_voice"], "present_rep": [pairs[rep]["present"], pairs[rep]["consults_room_active"]]})
def tier(g):
    ok_rl = g["rx"] or bool(g["lq"])
    return "HIGH" if (g["xday"] and g["excl"] and g["n5"] and ok_rl and g["stable"]) else "MED" if (g["xday"] and g["excl"] and g["n5"]) else "LOW"
for g in glinks: g["tier_pre_jev"] = tier(g)
os.makedirs(f"{H}/overnight", exist_ok=True)
json.dump(glinks, open(f"{H}/overnight/glinks{SUF}.json", "w"), indent=1)
c = collections.Counter(g["tier_pre_jev"] for g in glinks)
print("room-days", len(rds), "voices", len(V), "groups", len(glinks), "tiers pre-Jev", dict(c), "| xday", sum(g["xday"] for g in glinks), "staff candidates", sum(g["staff_candidate"] for g in glinks),
      "| xday+excl+n5", sum(g["xday"] and g["excl"] and g["n5"] for g in glinks), "| stable", sum(g["stable"] for g in glinks), "| rx", sum(g["rx"] for g in glinks))
if SUF == "":   # Jev targets: every xday+excl+n5 link, plus a seeded LOW sample (evidence lines for the controls)
    rng = random.Random(SEED); hm = [g for g in glinks if g["xday"] and g["excl"] and g["n5"]]; low = [g for g in glinks if g["tier_pre_jev"] == "LOW" and g["n5"]]; rng.shuffle(low)
    jev = []
    for g in hm + low[:30]:
        cons = []
        for m in g["members_naming_D"]:
            rd = m[0]; p = next(p for p in V[(rd, m[1])]["pairs"] if p["doctor_uid"] == g["doctor_uid"])
            cons.append({"rd": rd, "cluster": m[1], "turns_from": "core"})
        jev.append({"gid": g["gid"], "doctor_uid": g["doctor_uid"], "members": g["members_naming_D"]})
    json.dump(jev, open(f"{H}/overnight/jev_targets.json", "w"), indent=1)
    print("jev targets", len(jev), "(", len(hm), "xday links +", len(jev) - len(hm), "LOW sample )")
