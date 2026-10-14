#!/usr/bin/env python3
"""vj-link tiering under rulings 201/202 (voice-lab-1, numpy). One function, used for the pilot re-tier, the placebo arm and the overnight run.
 VOICE  = a top cluster (>= 25 core turns) of one room-day (voicelink.py).  GROUP = voices of DIFFERENT room-days joined when their centroid cosine >= 0.85 (union-find): 'the same voice'.
 A LINK is (room-day, doctor, voice).  Ruling 201, HIGH needs ALL of:
   xday   the voice's group spans >= 2 room-days
   excl   mutual exclusivity: every member voice of the group has the SAME best doctor (max voice-timing excess, valid pair); a voice whose members name different doctors is a STAFF CANDIDATE, never HIGH (K1);
          and within its own room-day no other proposed link uses the same voice for another doctor (competing).
   n5     >= 5 of the voice's core turns fall inside the doctor's consults
   rxlq   >= 1 Rx drug/test word said by this voice (rx_hit_by_voice >= 1) OR Jev LQ yes (noul >= 0.5 and the paired control < 0.5)
   stable ruling 202 Reading A: the doctor's edge alignment in this room-day holds at >= 2 of lx's 3 tolerances (after per-tolerance mutual exclusivity)
 MED = xday + excl (+ n5) with rxlq or stable missing.  Everything else LOW.  Timing (PQM edge) is a REPORT field and gates nothing except 'stable' inside HIGH (ruling 201/202).
 Reading of the ruling (flagged): 'MED = xday + exclusivity with either of the last two missing' is taken as xday AND excl AND n5, with at least one of rxlq/stable missing; n5 is required for MED too.
API: tier_links(rds, links, H, edge, jev) -> {link_key: {...}}; link_key = 'rd|doctor|cluster'."""
import json, os
import numpy as np

XDAY_COS = 0.85


def load(rds, H, suffix=""):
    return {rd: json.load(open(f"{H}/link-{rd}{suffix}.json")) for rd in rds}


def voices(L):
    """(rd, cluster) -> {centroid, best doctor, pairs}"""
    V = {}
    for rd, d in L.items():
        for c, cent in d["centroids"].items():
            pairs = [p for p in d["pairs"] if str(p["cluster"]) == c]
            V[(rd, c)] = {"centroid": np.array(cent), "best": (max(pairs, key=lambda p: p["excess"])["doctor_uid"] if pairs else None), "pairs": pairs}
    return V


def groups(V):
    keys = list(V); parent = {k: k for k in keys}
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            if a[0] != b[0] and float(V[a]["centroid"] @ V[b]["centroid"]) >= XDAY_COS: parent[find(a)] = find(b)
    G = {}
    for k in keys: G.setdefault(find(k), []).append(k)
    return {k: G[find(k)] for k in keys}


def tier_links(rds, links, H, edge, jev, suffix=""):
    """links: [{rd, doctor_uid, cluster}]; edge[(date)][rd][doctor] from edge.py; jev[link_key] -> jev result or None."""
    L = load(rds, H, suffix); V = voices(L); G = groups(V); out = {}
    by_rd_voice = {}
    for l in links: by_rd_voice.setdefault((l["rd"], str(l["cluster"])), set()).add(l["doctor_uid"])
    for l in links:
        rd, D, c = l["rd"], l["doctor_uid"], str(l["cluster"]); key = f"{rd}|{D}|{c}"
        pair = next(p for p in L[rd]["pairs"] if p["doctor_uid"] == D and str(p["cluster"]) == c)
        grp = G[(rd, c)]; days = {m[0] for m in grp}
        xday = len(days) >= 2
        members_best = {V[m]["best"] for m in grp}
        competing = len(by_rd_voice.get((rd, c), set())) > 1
        excl = (members_best == {D}) and not competing
        staff_candidate = len(members_best) > 1 or competing
        n5 = pair.get("core_turns_in_consults", 0) >= 5
        j = jev.get(key)
        lq_yes = bool(j and j["lq_noul"] >= 0.5 and not j["lq_void"])
        rxlq = pair["rx_hit_by_voice"] >= 1 or lq_yes
        date = L[rd]["date"]; e = edge.get(date, {}).get(rd, {}).get(D, {})
        stable = (e.get("stable_tolerances") or 0) >= 2
        tier = "HIGH" if (xday and excl and n5 and rxlq and stable) else "MED" if (xday and excl and n5) else "LOW"
        out[key] = {"tier": tier, "xday": xday, "n_room_days_same_voice": len(days), "excl": excl, "staff_candidate": staff_candidate, "n5": n5, "core_turns_in_consults": pair.get("core_turns_in_consults"),
                    "rx_hit_by_voice": pair["rx_hit_by_voice"], "lq_yes": lq_yes, "rxlq": rxlq, "stable_tolerances": e.get("stable_tolerances"), "stable_readingA": stable,
                    "doctors_named_by_group": sorted(x for x in members_best if x), "group_size": len(grp), "edge_reading_B_crit1": bool(e.get("crit1"))}
    return out
