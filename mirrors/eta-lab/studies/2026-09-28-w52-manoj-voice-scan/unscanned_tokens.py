#!/usr/bin/env python3
"""W52-B: list every Kumar S PQM token that is NOT confidently resolved -- either because a
room-day for its date was never embedded at all (gap.json, vj-refuter #5305), or because a
room-day WAS embedded but had <60s of embedded audio in this specific consult's +-30s window
(voice_scan.py's own "not_scanned" room_found value, vj-refuter #5323 -- dtree84 only embeds a
subset of raw turns, so "0 his-voice turns" can mean "checked, absent" or "never embedded here",
and only the former is a trustworthy NOT-IN). reb marks every row in this file NOT-SCANNED, never
a false FOUND or NOT-IN-OPD4-7.
Usage: python3 room_day_inventory.py && python3 voice_scan.py && python3 unscanned_tokens.py
Output: ~/eta-data/manoj-package/voice/unscanned.csv
"""
import csv
import glob
import json
import os

OUT = os.path.expanduser("~/eta-data/manoj-package")


def main():
    gap = json.load(open("gap.json"))
    gap_rooms_by_date = {}
    for r in gap:
        gap_rooms_by_date.setdefault(r["date"], []).append(r["room"])

    # token -> {"status": "found"|"weak"|"not_scanned"|"none", "rooms_not_scanned": [...]}
    by_token = {}
    for f in glob.glob(f"{OUT}/voice/scan-*.json"):
        d = json.load(open(f))
        for c in d["per_consult"]:
            tok, rf = c["token"], c["room_found"]
            cur = by_token.setdefault(tok, {"status": "none", "rooms_not_scanned": []})
            if rf and rf not in ("weak", "not_scanned"):
                cur["status"] = "found"
            elif rf == "weak" and cur["status"] not in ("found",):
                cur["status"] = "weak"
            elif rf == "not_scanned":
                cur["rooms_not_scanned"].append(d["room"])
                if cur["status"] not in ("found", "weak"):
                    cur["status"] = "not_scanned"

    pqm = json.load(open("kumars-pqm.json"))
    rows = []
    for called, completed, token, bucket in pqm:
        if not called or not completed:
            continue
        gap_rooms = gap_rooms_by_date.get(bucket, [])
        info = by_token.get(token, {"status": "none", "rooms_not_scanned": []})
        if info["status"] in ("found", "weak") or (info["status"] == "none" and not gap_rooms):
            continue  # confidently resolved: found, weak evidence, or a trustworthy NOT-IN
        unscanned_rooms = sorted(set(gap_rooms) | set(info["rooms_not_scanned"]))
        rows.append({"token": token, "date": bucket, "called": called, "completed": completed,
                     "unscanned_rooms": ";".join(unscanned_rooms),
                     "reason": "room_never_embedded" if not info["rooms_not_scanned"] and gap_rooms
                               else ("thin_embedded_coverage" if not gap_rooms else "both")})

    os.makedirs(f"{OUT}/voice", exist_ok=True)
    with open(f"{OUT}/voice/unscanned.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["token", "date", "called", "completed", "unscanned_rooms", "reason"])
        w.writeheader()
        for row in sorted(rows, key=lambda r: (r["date"], r["called"])):
            w.writerow(row)
    print(f"UNSCANNED_TOKENS n={len(rows)} room_days_gap={len(gap)} -> {OUT}/voice/unscanned.csv")


if __name__ == "__main__":
    main()
