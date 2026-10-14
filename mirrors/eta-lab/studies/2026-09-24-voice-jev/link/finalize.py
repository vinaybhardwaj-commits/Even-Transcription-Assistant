#!/usr/bin/env python3
"""vj-link finalize (box): merge Jev (jev_link.py) into the tier key and the card evidence; write the PHI-free key summary.
Inputs: ~/eta-data/voice-linkage/pilot/{cards/ (from voice-lab-1: links/*.json, audio/, key.json, clips.json), jev/<card>.json}.
Jev criterion (frozen LQ rule 7) = Q1 doctor confidence >= 0.70 AND LQ noul >= 0.5 AND the paired control noul < 0.5. Cross-day stays 'pending' (K4: no agreed link yet).
Tier (order + ruling 194): HIGH = all five criteria (crit 1 incl. stable at 3 tolerances, mutual exclusivity, n >= 5); MED = >= 3 criteria and >= 2 of them other than crit 1; else LOW.
Writes cards/links/<id>.json (surg-page contract only; evidence text updated), cards/key.json (tiers, numbers; NOT for the page), key-public.json (no names, no PHI)."""
import json, os, glob
PD = os.path.expanduser("~/eta-data/voice-linkage/pilot"); C = f"{PD}/cards"
key = json.load(open(f"{C}/key.json")); out = []
def tier2(c1, others): return "HIGH" if (c1 and others == 4) else "MED" if (c1 + others >= 3 and others >= 2) else "LOW"
for k in key:
    cid = k["card_id"]
    if not cid: out.append(k); continue
    jf = f"{PD}/jev/{cid}.json"; j = json.load(open(jf)) if os.path.exists(jf) else None
    cr = k["criteria"]; c1 = bool(cr["timing_edge_ruling194"]); c2 = bool(cr["recurring"]); c3 = bool(cr["rx_ge1"]); jt = bool(j and j["jev_term"])
    k["jev"] = j; cr["jev"] = ("met" if jt else "void (control said yes)" if j and j["lq_void"] else "not met") if j else "not run"
    others = int(c2) + int(c3) + int(jt)
    k["tier_now"] = tier2(c1, others); k["tier_if_xday_passes"] = tier2(c1, others + 1)
    k["tier_strict_rx_now"] = tier2(c1, int(c2) + int(cr["rx_strict_share"]) + int(jt))
    k["criteria_met"] = {"timing_edge_ruling194": c1, "recurring": c2, "rx_ge1": c3, "jev": jt, "cross_day": False}
    cf = f"{C}/links/{cid}.json"; card = json.load(open(cf)); ev = card["evidence"]
    if j:
        lq = ("it also finds the doctor's instructions or the listed drugs in these words" if not j["lq_void"] and j["lq_noul"] >= 0.5 else
              "its check for the doctor's instructions or the listed drugs is not usable here (it also said yes for another doctor's drug list)" if j["lq_void"] else
              "it does not find the doctor's instructions or the listed drugs in these words")
        p = j["q1_p_doctor"]
        ev[[i for i, e in enumerate(ev) if e.startswith("Jev")][0]] = f"Jev (a text model) reads only this voice's words: {'it says this is the doctor' if j['q1_choice'] == 'doctor' else 'it says this is ' + j['q1_choice'].replace('_', ' ')} ({round((j['q1_confidence'] or 0) * 100)}% confident); {lq}."
    xs = k["xday_summary"]; a = k["anchors_ge_0.3"]; own = max(a["own_doctor"].values()) if a.get("own_doctor") else None
    xi = [i for i, e in enumerate(ev) if e.startswith("Cross-day")][0]
    parts = []
    if xs["other_doctor_max"] is not None and xs["other_doctor_max"] >= 0.70:
        parts.append(f"Cross-day: WARNING, this voice is almost the same (cos {xs['other_doctor_max']:.2f}) as the voice linked to a DIFFERENT doctor on another day, so at least one of the two links is wrong (it may be a nurse or attendant who stays in the room).")
    elif xs["same_max"] is not None:
        parts.append(f"Cross-day: this voice matches the voice linked to the same doctor on another day (cos {xs['same_max']:.2f}).")
    else: parts.append("Cross-day: no other pilot day with this doctor to compare.")
    if own is not None: parts.append(f"It also matches this doctor's stored room-microphone voiceprint (cos {own:.2f}; stored voiceprints are known to match poorly, so this is a bonus only).")
    ev[xi] = " ".join(parts)
    k["xday_note"] = {"conflict_with_other_doctor": bool(xs["other_doctor_max"] is not None and xs["other_doctor_max"] >= 0.70), "same_doctor_other_day_cos": xs["same_max"], "stored_voiceprint_cos": own}
    json.dump(card, open(cf, "w"), indent=1); out.append(k)
json.dump(out, open(f"{C}/key.json", "w"), indent=1)
pub = [{"card_id": k["card_id"], "room_day": k.get("room_day"), "rank_in_room": k.get("rank_in_room"), "doctor_uid": k.get("doctor_uid"), "tier_now": k.get("tier_now"), "tier_if_xday_passes": k.get("tier_if_xday_passes"),
        "criteria_met": k.get("criteria_met"), "xday_note": k.get("xday_note"), "jev": {x: k["jev"][x] for x in ("q1_choice", "q1_confidence", "lq_noul", "control_noul", "lq_void", "jev_term")} if k.get("jev") else None,
        "metrics": k.get("metrics"), "edge": k.get("edge"), "xday_summary": k.get("xday_summary"), "n_clip_consults": k.get("n_clip_consults"), "n_eligible": k.get("n_eligible")} for k in out if k.get("card_id")]
json.dump(pub, open(f"{C}/key-public.json", "w"), indent=1)
import collections
print("tiers now", dict(collections.Counter(k["tier_now"] for k in out if k.get("card_id"))), "if xday passes", dict(collections.Counter(k["tier_if_xday_passes"] for k in out if k.get("card_id"))))
