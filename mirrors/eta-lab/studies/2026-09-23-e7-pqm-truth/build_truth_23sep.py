import csv
from datetime import datetime

def norm(name):
    n = name.strip().lower()
    for prefix in ("dr. ", "dr "):
        if n.startswith(prefix):
            n = n[len(prefix):]
    return n.strip()

DATE = "2026-09-23"

# voiceprint-confirmed 23 Sep room-days (see voiceprint-23sep-widened.json), same
# thresholds as the 20-23 Sep run: >=30 attributed turns, one clinician >=80% of them.
CONFIRMED = [
    ("Cardiology OPD", "Dr Dibyendu Majumdar"),
    ("OPD 5", "Dr Poornima Parasuraman"),
    ("OPD 3", "Dr Animesh Banerjee"),
]

rows = []
with open("/home/eta/eta-data/pqm-consults-23sep.csv") as f:
    for row in csv.DictReader(f):
        rows.append(row)

def parse(ts):
    if not ts:
        return None
    return datetime.fromisoformat(ts)

truth_rows = []
excluded_no_times = 0
excluded_bad_duration = 0
covered_by_room_day = {}

for room, doctor in CONFIRMED:
    target = norm(doctor)
    matched = [r for r in rows if norm(r["doctor_name"]) == target]
    day_rows = [r for r in matched if r["called_at"] and r["called_at"][:10] == DATE]
    kept = 0
    for r in day_rows:
        called = parse(r["called_at"])
        completed = parse(r["completed_at"])
        if not called or not completed:
            excluded_no_times += 1
            continue
        dur_min = (completed - called).total_seconds() / 60.0
        if not (1 <= dur_min <= 60):
            excluded_bad_duration += 1
            continue
        truth_rows.append({
            "room": room,
            "date": DATE,
            "doctor_name": doctor,
            "token_uid": r["token_uid"],
            "doctor_uid": r["doctor_uid"],
            "called_at": r["called_at"],
            "completed_at": r["completed_at"],
            "duration_min": round(dur_min, 2),
        })
        kept += 1
    covered_by_room_day[(room, DATE)] = (len(day_rows), kept)

with open("e7-truth-23sep.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["room", "date", "doctor_name", "token_uid", "doctor_uid", "called_at", "completed_at", "duration_min"])
    w.writeheader()
    for r in truth_rows:
        w.writerow(r)

print("TOTAL_TRUTH_ROWS", len(truth_rows))
print("EXCLUDED_NO_TIMES", excluded_no_times)
print("EXCLUDED_BAD_DURATION", excluded_bad_duration)
print("---per room-day (raw_consults_that_day, kept_1_60min_both_times)---")
for (room, date), (raw, kept) in covered_by_room_day.items():
    print(room, date, raw, kept)
