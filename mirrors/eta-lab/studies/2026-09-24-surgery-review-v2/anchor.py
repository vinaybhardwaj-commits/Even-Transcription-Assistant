#!/usr/bin/env python3
"""anchor.py — SURGERY-REVIEW-V3 step 1, the TRUTH ANCHOR (orders/SURGERY-REVIEW-V3.md): consults whose patient has an OT/procedure booking within 30 days AFTER an
OPD consult with the SAME doctor. Read-only Metabase (mb.py). Prints counts; writes ids and procedure names (no transcript) to ~/eta-data/surgery-review-v3/anchors.json (0600).

Booking sources (all with a procedure name, so a spoken-synonym check is possible):
  surgery_case : surgery_cases (individual_uid, treating_doctor_uid, procedure_name / financial__procedure_name, created_at, planned_surgery_date, status)
  ot_note      : kx_clinical_template_ot_notes (uhid -> individuals.kx_uhid -> individual_uid; surgeon NAME, surgery_name, created_at): a completed OT procedure
Same doctor = doctor uid equality for surgery cases; a normalised NAME match for OT notes (they carry a surgeon name, not a uid).
NOT used as an anchor (no procedure name to check the transcript against): kx_ip_admissions (592 since 1 Sep, mostly 'Elective' with no procedure). Interventions booked into a
procedure room (angiography, endoscopy, biopsy, injections) have no booking table found yet: a GAP, reported.
"""
import json, os, re, sys
from datetime import date, datetime, timedelta, timezone
import mb

IST = timezone(timedelta(hours=5, minutes=30))
OUT = os.path.expanduser("~/eta-data/surgery-review-v3")
FROM, TO = "2026-09-18", "2026-09-24"  # consult call dates (IST) that can have a transcript
WINDOW_DAYS = 30
CAP = 1999


def ts(s):
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (d if d.tzinfo else d.replace(tzinfo=IST)).astimezone(IST)


def norm(n):
    n = (n or "").lower()
    n = re.sub(r"\b(dr|doctor|prof|mr|mrs|ms)\b\.?", " ", n)
    return re.sub(r"[^a-z ]", " ", n).split()


def same_doctor_name(a, b):
    ta, tb = set(norm(a)), set(norm(b))
    ta = {t for t in ta if len(t) > 2}; tb = {t for t in tb if len(t) > 2}
    return len(ta & tb) >= 2 or (len(ta) == 1 and ta <= tb) or (len(tb) == 1 and tb <= ta)


def consults():
    out, d = [], date.fromisoformat(FROM)
    while d <= date.fromisoformat(TO):
        b = ",".join(f"'{(d + timedelta(days=k)).isoformat()}'" for k in (-1, 0, 1))
        cols, rows, tr = mb.query(f"""SELECT qts.token_uid, qt.metadata->>'INDIVIDUAL_UID' AS individual_uid, qts.routing->>'DOCTOR_UID' AS doctor_uid,
            qts.metadata->>'DOCTOR_NAME' AS doctor_name, nullif(qts.called_at,'')::timestamptz AS called_at, nullif(qts.completed_at,'')::timestamptz AS completed_at
            FROM queue_token_steps qts JOIN queue_tokens qt ON qt.uid = qts.token_uid
            WHERE qts.station='CONSULTATION' AND qts.status='COMPLETE' AND qts.cycle_bucket IN ({b})""")
        assert not tr and len(rows) < CAP, f"row cap on {d}"
        ix = {c: i for i, c in enumerate(cols)}
        for r in rows:
            if not (r[ix["called_at"]] and r[ix["completed_at"]] and r[ix["individual_uid"]]):
                continue
            c, e = ts(r[ix["called_at"]]), ts(r[ix["completed_at"]])
            if c.date() != d or e <= c:
                continue
            out.append({"token_uid": r[ix["token_uid"]], "individual_uid": r[ix["individual_uid"]], "doctor_uid": r[ix["doctor_uid"]], "doctor_name": r[ix["doctor_name"]],
                        "called": c, "done": e})
        d += timedelta(days=1)
    return out


def bookings():
    since = (date.fromisoformat(FROM)).isoformat()
    _, rows, tr = mb.query(f"""SELECT individual_uid, treating_doctor_uid, coalesce(nullif(procedure_name,''), nullif(financial__procedure_name,'')) AS proc, created_at, planned_surgery_date, status
        FROM surgery_cases WHERE created_at >= '{since}'""")
    assert not tr and len(rows) < CAP
    sc = [{"src": "surgery_case", "individual_uid": r[0], "doctor_uid": r[1], "doctor_name": None, "procedure": r[2], "at": ts(r[3]), "status": r[5]} for r in rows if r[0] and r[2]]
    _, rows, tr = mb.query(f"""SELECT i.uid, n.surgeon, n.surgery_name, n.created_at FROM kx_clinical_template_ot_notes n JOIN individuals i ON i.kx_uhid = n.uhid
        WHERE n.created_at >= '{since}' AND n.surgery_name IS NOT NULL AND n.surgery_name <> ''""")
    assert not tr and len(rows) < CAP
    ot = [{"src": "ot_note", "individual_uid": r[0], "doctor_uid": None, "doctor_name": r[1], "procedure": r[2], "at": ts(r[3]), "status": "DONE"} for r in rows]
    return sc + ot


def match(cons, books):
    by = {}
    for b in books:
        by.setdefault(b["individual_uid"], []).append(b)
    out = []
    for c in cons:
        for b in by.get(c["individual_uid"], []):
            gap = (b["at"] - c["called"]).total_seconds() / 86400.0
            if not (-0.05 <= gap <= WINDOW_DAYS):  # booked from the consult on (a few minutes of clock slack), up to 30 days after
                continue
            same = (b["doctor_uid"] and b["doctor_uid"] == c["doctor_uid"]) or (b["doctor_name"] and same_doctor_name(b["doctor_name"], c["doctor_name"]))
            if same:
                out.append({**c, "booked_procedure": b["procedure"], "booked_source": b["src"], "booking_status": b["status"], "days_after": round(gap, 2)})
    return out


def main():
    cons = consults()
    books = bookings()
    print("consults", len(cons), "| by day:", {d: sum(1 for c in cons if c["called"].date().isoformat() == d) for d in sorted({c["called"].date().isoformat() for c in cons})})
    print("bookings with a procedure name since", FROM, ":", {s: sum(1 for b in books if b["src"] == s) for s in ("surgery_case", "ot_note")})
    hits = match(cons, books)
    ded = {}
    for h in hits:
        ded.setdefault(h["token_uid"], h)  # one anchor per consult (earliest booking listed first is not guaranteed: keep the first)
    print("anchored consults (booking <=30d after, same doctor):", len(ded), "| by source:", {s: sum(1 for h in ded.values() if h["booked_source"] == s) for s in ("surgery_case", "ot_note")},
          "| cancelled cases among them:", sum(1 for h in ded.values() if str(h["booking_status"]).upper() == "CANCELLED"))
    print("by consult day:", {d: sum(1 for h in ded.values() if h["called"].date().isoformat() == d) for d in sorted({h["called"].date().isoformat() for h in ded.values()})})
    os.makedirs(OUT, exist_ok=True); os.chmod(OUT, 0o700)
    p = f"{OUT}/anchors.json"
    json.dump([{**h, "called": h["called"].isoformat(), "done": h["done"].isoformat()} for h in ded.values()], open(p, "w"), indent=1); os.chmod(p, 0o600)
    print("written", p)


if __name__ == "__main__":
    main()
