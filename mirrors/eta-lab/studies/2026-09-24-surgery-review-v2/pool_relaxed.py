#!/usr/bin/env python3
"""pool_relaxed.py — SURGERY-REVIEW-V3 set B, wider placeable universe (ruling 75: 'every consult transcribed 21-24 Sep'). The strict pool placed a consult only in a voiceprint-confirmed room-day
(>=30 clinician-attributed turns, one clinician >=80%): 5 doctors. RELAXED here: >=8 attributed turns and one clinician >=70% (placement marked 'voiceprint_weak', reported as weaker).
Same other rules as the strict pool: doctor maps to ONE room-day that day (else skipped), unlabelled (token and time), 3-45 min, >=600 chars of transcript, not already in the strict pool.
Writes ~/eta-data/surgery-review-v3/selected_cand2.json (ids R01.., private facts; 0600) and items_cand2.json for encounter_bounds. Prints counts only."""
import json, os
from datetime import date
import select_pilot as sp, select_v3 as sv

V3 = sv.V3


def relaxed_room_days(days):
    ds = ",".join(f"'{d}'" for d in days)
    rows = sp.neon(f"""SELECT rd.ist_date::text AS d, rd.id AS room_day_id, c.legacy_doctor_id AS doctor_uid, c.full_name AS doctor_name,
        count(*) FILTER (WHERE rts.role='clinician')::int AS attributed
        FROM room_day rd JOIN room_turn_speaker rts ON rts.room_day_id = rd.id AND rts.role='clinician'
        JOIN clinician c ON c.id = rts.clinician_id WHERE rd.ist_date IN ({ds}) GROUP BY 1,2,3,4 ORDER BY 1,2,5 DESC""")
    by = {}
    for x in rows:
        by.setdefault(x["room_day_id"], []).append(x)
    out = []
    for rd, xs in by.items():
        tot = sum(x["attributed"] for x in xs)
        if tot >= 8 and xs[0]["attributed"] / tot >= 0.7:
            out.append({"date": xs[0]["d"], "room_day_id": rd, "doctor_uid": xs[0]["doctor_uid"], "doctor_name": xs[0]["doctor_name"], "attributed": tot})
    return out


def main():
    days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]
    rds = relaxed_room_days(days); lab = sv.labelled()
    strict = {o["room_day_id"] for o in json.load(open(f"{V3}/confirmed_room_days.json"))}
    seen = {v["token_uid"] for v in json.load(open(f"{V3}/pool/index.json")).values()}
    out, skipped = {}, {"strict_pool_or_seen": 0, "labelled_leak": 0, "duration": 0, "chars": 0}
    n = 0
    for d in days:
        cons, sk = sp.consults_for(d, [o for o in rds if o["date"] == d])
        for c in cons:
            if c["token_uid"] in seen:
                skipped["strict_pool_or_seen"] += 1; continue
            mins = (c["done"] - c["called"]).total_seconds() / 60
            if not (3 <= mins <= 45):
                skipped["duration"] += 1; continue
            item = {"token_uid": c["token_uid"], "room_day_id": c["room_day_id"], "called": c["called"].isoformat(), "done": c["done"].isoformat()}
            if sv.leaks(item, lab):
                skipped["labelled_leak"] += 1; continue
            turns, chars = sp.transcript_stats(c)
            if chars < 600:
                skipped["chars"] += 1; continue
            n += 1; rid = f"R{n:02d}"
            rd = next(o for o in rds if o["room_day_id"] == c["room_day_id"])
            out[rid] = {**item, "day": d, "source": "voiceprint_weak", "booked_procedure": None, "doctor_uid": rd["doctor_uid"], "doctor_name": rd["doctor_name"], "attributed_turns": rd["attributed"], "turns": turns, "chars": chars}
    print("relaxed room-days:", len(rds), "(of which also strict:", len([o for o in rds if o["room_day_id"] in strict]), ") | new candidate consults:", len(out), "| skipped:", skipped)
    print("by day:", {d: sum(1 for v in out.values() if v["day"] == d) for d in days})
    p = f"{V3}/selected_cand2.json"; json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
    items = [{"item_id": q, "room_day_id": v["room_day_id"], "ist_date": v["day"], "called_at": v["called"], "completed_at": v["done"], "doctor_uid": v["doctor_uid"]} for q, v in out.items()]
    p = f"{V3}/items_cand2.json"; json.dump(items, open(p, "w"), indent=1); os.chmod(p, 0o600)


if __name__ == "__main__":
    main()
