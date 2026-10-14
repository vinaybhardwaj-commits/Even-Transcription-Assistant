#!/usr/bin/env python3
"""vj-link: batch-1 evidence text v3. The cross-day line was computed on 18-24 Sep only; with 9-15 Sep added (audio + diarizer segments, complete linkage) it is false for the HIGH and both MED voices (each recurs on 4-5 room-days
and matches 3-4 different doctors). ALL 60 link cards get the same kind of line from the 70-room-day grouping (uniform, tier-blind); the old cross-day and WARNING lines are replaced. IDs, clips, tiers unchanged.
Also writes batch1-key/key-ext.json (extended group facts per card; NOT for the page).  Usage: fix_evidence_v3.py"""
import glob, json, os
BOX = os.path.expanduser("~/eta-data/voice-linkage"); NAME = os.environ.get("BATCH", "batch1"); B = f"{BOX}/{NAME}"; K = json.load(open(f"{BOX}/{NAME}-key/key.json")); ext = json.load(open(f"{BOX}/dtree_ext/overnight/glinks-complete.json"))
where = {}
for g in ext:
    for m in g["members"]: where[tuple(m)] = g
out = []
for k in K:
    if not k.get("card_id") or k.get("kind") == "pair": continue
    cf = f"{B}/links/{k['card_id']}.json"; card = json.load(open(cf)); g = where.get(tuple(k["rep"]))
    n = g["n_room_days"] if g else 1; docs = len(g["doctors_named"]) if g else 1
    if n <= 1: line = "Cross-day: this voice was not found on any other room-day between 9 and 24 Sep."
    elif docs <= 1: line = f"Cross-day: this voice is also heard on {n - 1} other room-day{'s' if n > 2 else ''} between 9 and 24 Sep, and each time the best timing match is this same doctor."
    else: line = f"Cross-day: this voice is also heard on {n - 1} other room-day{'s' if n > 2 else ''} between 9 and 24 Sep, and across them the best timing match is {docs} different doctors (this one included): it may be a nurse or attendant who stays in the room."
    ev = [e for e in card["evidence"] if not e.startswith(("Cross-day", "WARNING"))]
    i = next((j for j, e in enumerate(ev) if e.startswith("Prescriptions")), len(ev) - 1) + 1; ev.insert(i, line)   # keep the fixed order: timing, recurring, prescriptions, cross-day, caveat, production
    card["evidence"] = ev; json.dump(card, open(cf, "w"), indent=1)
    out.append({"card_id": k["card_id"], "tier_batch1": k["tier"], "ext_group": g["gid"] if g else None, "ext_room_days": n, "ext_doctors_named": docs, "ext_staff_candidate": bool(g and g["staff_candidate"]), "ext_tier_pre_jev": g["tier_pre_jev"] if g else None})
json.dump(out, open(f"{BOX}/{NAME}-key/key-ext.json", "w"), indent=1)
import collections
print("cards", len(out), "| ext staff candidates", sum(o["ext_staff_candidate"] for o in out), "| single-room-day", sum(o["ext_room_days"] <= 1 for o in out), "| batch-1 HIGH/MED now:", [(o["tier_batch1"], o["ext_room_days"], o["ext_doctors_named"], o["ext_tier_pre_jev"]) for o in out if o["tier_batch1"] in ("HIGH", "MED")])
