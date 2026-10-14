#!/usr/bin/env python3
"""vj-link overnight finalize (box): add the Jev line to the cards that have a Jev result and record the numbers in key.json (never on the page). Cards already carry only surg-page's fields."""
import json, os
D = os.path.expanduser("~/eta-data/voice-linkage/dtree/overnight"); C = f"{D}/cards"
key = json.load(open(f"{C}/key.json")); n = 0
for k in key:
    if not k.get("card_id") or k.get("kind") == "pair": continue
    jf = f"{D}/jev/{k['gid']}.json"
    if not os.path.exists(jf): continue
    j = json.load(open(jf)); k["jev"] = {x: j[x] for x in ("q1_choice", "q1_confidence", "lq_noul", "control_noul", "lq_void", "jev_term")}; k["criteria"]["lq"] = bool(j["lq_noul"] >= 0.5 and not j["lq_void"])
    cf = f"{C}/links/{k['card_id']}.json"; card = json.load(open(cf)); ev = [e for e in card["evidence"] if not e.startswith("Jev")]
    lq = ("it also finds the doctor's instructions or the listed drugs in these words" if not j["lq_void"] and j["lq_noul"] >= 0.5 else
          "its check for the doctor's instructions or the listed drugs is not usable here (it also said yes for another doctor's drug list)" if j["lq_void"] else
          "it does not find the doctor's instructions or the listed drugs in these words")
    ev.append(f"Jev (a text model) reads only this voice's words: {'it says this is the doctor' if j['q1_choice'] == 'doctor' else 'it says: ' + j['q1_choice'].replace('_', ' ')} ({round((j['q1_confidence'] or 0) * 100)}% confident); {lq}.")
    card["evidence"] = ev; json.dump(card, open(cf, "w"), indent=1); n += 1
json.dump(key, open(f"{C}/key.json", "w"), indent=1)
pub = [{x: k.get(x) for x in ("card_id", "kind", "gid", "tier", "doctor_uid", "members", "rep", "criteria", "n_room_days", "core_turns_in_consults", "rx_hits", "stable_tolerances_max", "excess_rep", "doctors_named", "jev", "clip_consults", "clip_days", "n_eligible", "reason")} for k in key]
json.dump(pub, open(f"{C}/key-public.json", "w"), indent=1)
print("jev lines added", n, "| key entries", len(key))
