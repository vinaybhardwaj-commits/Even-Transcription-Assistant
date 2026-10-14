#!/usr/bin/env python3
"""assemble_inputs.py — pull the three surgery-30 extracts from Metabase db 13 (READ-ONLY, via mb.py) and join
each consult to a voiceprint-confirmed room-day, writing ~/eta-data/surgery-30/inputs/{consults,leads,rxflags}.csv.
Prints COUNTS ONLY. Nothing patient-linked is written anywhere but ~/eta-data (outside git).

  python3 assemble_inputs.py --discover     # schema/value discovery only: names and counts, no rows of data
  python3 assemble_inputs.py                # the full extract

Needs ~/eta-data/surgery-30/room_day_doctor.json (confirmed room-days per IST date, written from the app DB by
the room-day step: >=30 clinician-attributed turns and one clinician >=80% of them, the E-7 thresholds).

All SQL is INFERRED from H-3 (orders/SURGERY-DETECT.md) and Fable's 24 Sep schema note; it fails loudly, never guesses.
"""
import csv, json, os, re, sys
from datetime import date, datetime, timedelta, timezone
import mb

IST = timezone(timedelta(hours=5, minutes=30))
OUT = os.path.expanduser("~/eta-data/surgery-30/inputs")
CAP = 1999  # Metabase ad-hoc results are capped near 2000 rows; a full day at the cap means truncated, so fail loudly


def norm(name):
    n = (name or "").strip().lower()
    for p in ("dr. ", "dr "):
        if n.startswith(p):
            n = n[len(p):]
    return re.sub(r"\s+", " ", n).strip()


def days_of(room_days):
    return sorted({o["date"] for o in room_days if o["confirmed"]})


def q_day(sql_for_day, d):
    cols, rows, truncated = mb.query(sql_for_day(d))
    if truncated or len(rows) >= CAP:
        raise SystemExit(f"a single day's result hit the row cap ({d}); chunk it smaller before trusting any count")
    return cols, rows


def discover():
    print("-- columns (names only)")
    for t in ("prescription_surgery_recommendation", "surgery_cases"):
        _, rows, _ = mb.query(f"SELECT column_name FROM information_schema.columns WHERE table_name='{t}' ORDER BY ordinal_position")
        print(t + ":", ", ".join(r[0] for r in rows))
    print("-- distinct surgery_recommended values (counts, last 30 days)")
    _, rows, _ = mb.query("SELECT surgery_recommended, count(*) FROM prescription_surgery_recommendation WHERE prescription_date >= '2026-08-25' GROUP BY 1 ORDER BY 2 DESC")
    print(rows)
    print("-- tables carrying an individual id AND a uhid (candidates for the uhid->individual map)")
    _, rows, _ = mb.query("""SELECT table_name,
        string_agg(column_name, ', ' ORDER BY column_name) FILTER (WHERE column_name ILIKE '%individual%' OR column_name ILIKE '%uhid%') cols
        FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')
        GROUP BY 1 HAVING bool_or(column_name ILIKE '%individual%') AND bool_or(column_name ILIKE '%uhid%') ORDER BY 1""")
    for r in rows:
        print(r[0] + ":", r[1])


def main():
    if "--discover" in sys.argv:
        return discover()
    rdd = json.load(open(os.path.expanduser("~/eta-data/surgery-30/room_day_doctor.json")))
    conf = [o for o in rdd if o["confirmed"]]
    days = days_of(rdd)
    print("confirmed room-days:", len(conf), "on", len(days), "dates:", days)
    os.makedirs(OUT, exist_ok=True)
    os.chmod(OUT, 0o700)

    # 1. consults, per IST day (cycle_bucket +-1 day, then filter by the IST date of called_at — Fable's ruling)
    def sql(d):
        dd = date.fromisoformat(d)
        b = ",".join(f"'{(dd + timedelta(days=k)).isoformat()}'" for k in (-1, 0, 1))
        return f"""SELECT qts.token_uid, qts.routing->>'DOCTOR_UID' AS doctor_uid, qts.metadata->>'DOCTOR_NAME' AS doctor_name,
                   qt.metadata->>'INDIVIDUAL_UID' AS individual_uid,
                   nullif(qts.called_at,'')::timestamptz AS called_at, nullif(qts.completed_at,'')::timestamptz AS completed_at
                   FROM queue_token_steps qts JOIN queue_tokens qt ON qt.uid = qts.token_uid
                   WHERE qts.station='CONSULTATION' AND qts.status='COMPLETE' AND qts.cycle_bucket IN ({b}) ORDER BY 5"""
    by_date = {}
    for o in conf:
        by_date.setdefault(o["date"], []).append(o)
    rows_out, seen = [], {"consults_that_day": 0, "no_confirmed_doctor": 0, "ambiguous_two_rooms": 0, "no_individual_uid": 0, "kept": 0}
    for d, rds in by_date.items():
        cols, rows = q_day(sql, d)
        ix = {c: i for i, c in enumerate(cols)}
        for r in rows:
            if not r[ix["called_at"]] or not r[ix["completed_at"]]:
                continue
            called = datetime.fromisoformat(r[ix["called_at"]].replace("Z", "+00:00")).astimezone(IST)
            if called.date().isoformat() != d:
                continue
            seen["consults_that_day"] += 1
            match = [o for o in rds if (o["doctor_uid"] and o["doctor_uid"] == r[ix["doctor_uid"]]) or (norm(o["doctor_name"]) and norm(o["doctor_name"]) == norm(r[ix["doctor_name"]]))]
            if not match:
                seen["no_confirmed_doctor"] += 1
                continue
            if len({m["room_day_id"] for m in match}) > 1:
                seen["ambiguous_two_rooms"] += 1  # one doctor confirmed in two rooms the same day: cannot tell which room
                continue
            if not r[ix["individual_uid"]]:
                seen["no_individual_uid"] += 1
                continue
            seen["kept"] += 1
            rows_out.append({"token_uid": r[ix["token_uid"]], "individual_uid": r[ix["individual_uid"]], "room_day_id": match[0]["room_day_id"],
                             "called_at": r[ix["called_at"]], "completed_at": r[ix["completed_at"]]})
    with open(f"{OUT}/consults.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["token_uid", "individual_uid", "room_day_id", "called_at", "completed_at"])
        w.writeheader(); w.writerows(rows_out)
    print("consults:", seen)

    # 2. surgery_cases (~600 rows since June: one query is under the cap)
    cols, rows, tr = mb.query("SELECT individual_uid, created_at, status, prescription_uid FROM surgery_cases WHERE created_at >= '2026-09-01'")
    assert not tr and len(rows) < CAP, "surgery_cases hit the row cap"
    ix = {c: i for i, c in enumerate(cols)}
    with open(f"{OUT}/leads.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["individual_uid", "created_at", "status", "prescription_uid"])
        for r in rows:
            w.writerow([r[ix["individual_uid"]], r[ix["created_at"]], r[ix["status"]], r[ix["prescription_uid"]]])
    rx_to_ind = {r[ix["prescription_uid"]]: r[ix["individual_uid"]] for r in rows if r[ix["prescription_uid"]]}
    print("leads:", len(rows), "| with prescription_uid:", len(rx_to_ind))

    # 3. prescription flags: surgery_recommended='yes' (326 in 30 days; the other values are no / NULL / '' / 'Not provided'),
    #    patient linked via individuals.kx_uhid -> individuals.uid (each flagged uhid resolved to exactly one individual on 24 Sep).
    cols, rows, tr = mb.query("""SELECT i.uid AS individual_uid, p.prescription_date, p.surgery_recommended, p.prescription_uid
        FROM prescription_surgery_recommendation p LEFT JOIN individuals i ON i.kx_uhid = p.patient_uhid
        WHERE p.surgery_recommended = 'yes' AND p.prescription_date >= '2026-09-01' ORDER BY 2""")
    assert not tr and len(rows) < CAP, "rx flags hit the row cap"
    ix = {c: i for i, c in enumerate(cols)}
    unresolved = sum(1 for r in rows if not r[ix["individual_uid"]])
    with open(f"{OUT}/rxflags.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["individual_uid", "prescribed_at", "surgery_recommended", "prescription_uid"])
        for r in rows:
            if r[ix["individual_uid"]]:
                w.writerow([r[ix["individual_uid"]], r[ix["prescription_date"]], r[ix["surgery_recommended"]], r[ix["prescription_uid"]]])
    print("rxflags ('yes' since 1 Sep):", len(rows), "| unresolved to an individual:", unresolved)

    # 4. id-space check: do the consults' individual_uids exist in individuals.uid (the space the rx map lands in)?
    ids = sorted({r["individual_uid"] for r in rows_out})
    found = 0
    for k in range(0, len(ids), 300):
        chunk = ids[k:k + 300]
        if not all(re.match(r"^[A-Za-z0-9_\-]+$", x) for x in chunk):
            raise SystemExit("unexpected characters in an individual_uid; refusing to build a query from it")
        inl = ",".join("'" + x + "'" for x in chunk)
        found += mb.query(f"SELECT count(*) FROM individuals WHERE uid IN ({inl})")[1][0][0]
    print("consult individual_uids:", len(ids), "| present in individuals.uid:", found)
    print("written to", OUT)


if __name__ == "__main__":
    main()
