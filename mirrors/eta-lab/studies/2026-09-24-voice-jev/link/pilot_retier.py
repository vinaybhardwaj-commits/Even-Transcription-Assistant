#!/usr/bin/env python3
"""vj-link (voice-lab-1): re-tier the 10 pilot links under rulings 201/202 and run the PLACEBO arm (every doctor time shifted by a wrong number of hours; ruling 201 'keep the placebo arm').
Inputs in ~/vj/link: link-<rd>[-pl<H>].json (voicelink.py), edge-<date>[-pl<H>].json (edge.py), cards/key.json (card -> room-day, doctor, voice), jev/<card>.json (jev_link.py).
Out: cards/key.json gains tier_201 and its criteria; retier-report.json (counts, placebo). PHI-free numbers only on the console."""
import json, os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
H = os.path.expanduser("~/vj/link"); RDS = sys.argv[1:] or ["rd_yhh6kexm", "rd_f4hzv5sj", "rd_djmbtzph", "rd_tp4hcf8s", "rd_u6kdhc3b"]
key = json.load(open(f"{H}/cards/key.json"))
def edges(suf): return {d: json.load(open(f"{H}/edge-{d}{suf}.json")) for d in ("2026-09-19", "2026-09-22", "2026-09-23")}
def pick(L):
    out = []
    for rd, d in L.items():
        P = d["pairs"]
        if not P: continue
        first = P[0]; rest = [p for p in P if p["doctor_uid"] != first["doctor_uid"]]
        second = next((p for p in rest if p["cluster"] != first["cluster"]), rest[0] if rest else None)
        out += [{"rd": rd, "doctor_uid": first["doctor_uid"], "cluster": first["cluster"]}] + ([{"rd": rd, "doctor_uid": second["doctor_uid"], "cluster": second["cluster"]}] if second else [])
    return out
# real: the 10 delivered links
links = [{"rd": k["room_day"], "doctor_uid": k["doctor_uid"], "cluster": k["cluster"]} for k in key if k.get("card_id")]
jev = {}
for k in key:
    if k.get("card_id") and os.path.exists(f"{H}/jev/{k['card_id']}.json"): jev[f"{k['room_day']}|{k['doctor_uid']}|{k['cluster']}"] = json.load(open(f"{H}/jev/{k['card_id']}.json"))
real = T.tier_links(RDS, links, H, edges(""), jev)
for k in key:
    if k.get("card_id"):
        r = real[f"{k['room_day']}|{k['doctor_uid']}|{k['cluster']}"]; k["tier_201"] = r["tier"]; k["criteria_201"] = {x: r[x] for x in ("xday", "n_room_days_same_voice", "excl", "staff_candidate", "n5", "core_turns_in_consults", "rx_hit_by_voice", "lq_yes", "rxlq", "stable_tolerances", "stable_readingA", "doctors_named_by_group", "group_size")}
json.dump(key, open(f"{H}/cards/key.json", "w"), indent=1)
rep = {"real": dict(collections.Counter(v["tier"] for v in real.values())), "placebo": {}}
for h in ("4", "-4"):
    suf = f"-pl{h}"
    if not all(os.path.exists(f"{H}/link-{rd}{suf}.json") for rd in RDS): continue
    L = T.load(RDS, H, suf); pl = pick(L); e = edges(suf)
    r = T.tier_links(RDS, pl, H, e, {}, suffix=suf)   # no Jev in the placebo: rxlq = Rx only (a lower bound for the placebo)
    rep["placebo"][h] = {"tiers": dict(collections.Counter(v["tier"] for v in r.values())), "n_links": len(pl), "xday": sum(v["xday"] for v in r.values()), "xday_and_excl": sum(v["xday"] and v["excl"] for v in r.values()),
                         "staff_candidates": sum(v["staff_candidate"] for v in r.values()), "stable_readingA": sum(v["stable_readingA"] for v in r.values())}
rep["real_criteria_counts"] = {x: sum(bool(v[x]) for v in real.values()) for x in ("xday", "excl", "staff_candidate", "n5", "rxlq", "stable_readingA", "lq_yes")}
json.dump(rep, open(f"{H}/retier-report.json", "w"), indent=1)
print(json.dumps(rep))
for k in key:
    if k.get("card_id"): print(k["card_id"], k["room_day"][3:9], k["tier_201"], {x: (v if not isinstance(v, list) else len(v)) for x, v in k["criteria_201"].items() if x in ("xday", "n_room_days_same_voice", "excl", "staff_candidate", "n5", "rxlq", "stable_tolerances")})
