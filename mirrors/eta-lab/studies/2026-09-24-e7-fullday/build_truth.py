"""E-7 truth for one IST date: PQM consults of each voiceprint-CONFIRMED room-day's doctor, generalised from
2026-09-23-e7-pqm-truth/build_truth_23sep.py (same rules: both times present, 1-60 min, call time's IST date).

Usage: build_truth.py <YYYY-MM-DD> <confirmed.json> <pqm.csv> <out-truth.csv> [attribution.json]
Doctor match: the confirmed clinician's name against PQM doctor_name, "Dr"/"Dr." stripped, case-folded.
Prints counts per room-day; a confirmed room-day with no PQM rows is reported, never silently dropped.

ONE DOCTOR, TWO ROOMS. PQM has no room field. If a doctor is confirmed in more than one room-day on the date,
each of their consults goes to the room-day with the MOST of that doctor's attributed turns in windows
overlapping the consult (attribution.json from the rooms stage). A consult with no attributed voice in any of
them, or a tie, is AMBIGUOUS: counted and left out, never given to every room (that double-counts truth).
Without attribution.json a multi-room doctor's consults are all reported ambiguous.
"""
import csv, json, sys
from datetime import datetime

day, conf_path, pqm_path, out = sys.argv[1:5]
def norm(n):
    n = (n or "").strip().lower()
    for p in ("dr. ", "dr "):
        if n.startswith(p): n = n[len(p):]
    return " ".join(n.split())
conf = [r for r in json.load(open(conf_path))["room_days"] if r["confirmed"]]
attr = json.load(open(sys.argv[5])) if len(sys.argv) > 5 and sys.argv[5] else []
rooms_of_doc = {}
for r in conf: rooms_of_doc.setdefault(r["top_clinician_id"], []).append(r["room_day_id"])
def ms(ts): return int(datetime.fromisoformat(ts).timestamp() * 1000)
def owner(doc, a, b):
    """The room-day where this doctor's voice was during [a, b); None if absent or tied."""
    score = {rd: sum(x["n"] for x in attr if x["room_day_id"] == rd and x["clinician_id"] == doc
                     and min(x["end_ms"], b) > max(x["start_ms"], a)) for rd in rooms_of_doc[doc]}
    best = max(score.values()) if score else 0
    top = [rd for rd, v in score.items() if v == best]
    return top[0] if best > 0 and len(top) == 1 else None
ambiguous_total = 0
pqm = list(csv.DictReader(open(pqm_path)))
cols = ["room", "date", "doctor_name", "token_uid", "doctor_uid", "called_at", "completed_at", "duration_min"]
kept_total = 0
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in conf:
        target = norm(r["top_clinician_name"])
        mine = [p for p in pqm if norm(p["doctor_name"]) == target and p["called_at"][:10] == day]
        no_times = bad = kept = 0
        multi = len(rooms_of_doc[r["top_clinician_id"]]) > 1
        ambiguous = elsewhere = 0
        for p in mine:
            if not p["called_at"] or not p["completed_at"]: no_times += 1; continue
            if multi:
                o = owner(r["top_clinician_id"], ms(p["called_at"]), ms(p["completed_at"]))
                if o is None: ambiguous += 1; continue
                if o != r["room_day_id"]: elsewhere += 1; continue
            dur = (datetime.fromisoformat(p["completed_at"]) - datetime.fromisoformat(p["called_at"])).total_seconds() / 60
            if not (1 <= dur <= 60): bad += 1; continue
            w.writerow({"room": r["room"], "date": day, "doctor_name": p["doctor_name"], "token_uid": p["token_uid"],
                        "doctor_uid": p["doctor_uid"], "called_at": p["called_at"], "completed_at": p["completed_at"],
                        "duration_min": round(dur, 2)})
            kept += 1
        kept_total += kept
        ambiguous_total += ambiguous if r["room_day_id"] == rooms_of_doc[r["top_clinician_id"]][0] else 0  # count once per doctor
        flag = "" if mine else "  NO_PQM_ROWS_FOR_CONFIRMED_DOCTOR"
        extra = f" multi_room_doctor: in_other_room={elsewhere} ambiguous={ambiguous}" if multi else ""
        print(f"TRUTH {r['room_day_id']} {r['room']!r} pqm={len(mine)} kept={kept} excluded_no_times={no_times} excluded_duration={bad}{extra}{flag}")
print(f"TRUTH_DONE confirmed_room_days={len(conf)} truth_rows={kept_total} ambiguous_multi_room_consults={ambiguous_total}")
