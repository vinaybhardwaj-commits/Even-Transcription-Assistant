"""W27.2 (linker): Pulse prescription history for CAP-2 vocabularies. Read-only Metabase (studies/2026-09-24-surgery-30/mb.py; key never printed).
Window: prescriptions with timestamp >= 2026-06-26 (IST), EXCLUDING 2026-09-25 and 2026-09-26 (leakage rule). Drafts excluded (as in CAP-1).
Output (box only, 0600): ~/eta-data/cap2/rx_history.jsonl, one item per line:
  {rx (sha1[:12] of presc_uid, no patient id), date, doctor_uid, doctor_name, specialty (dpipe doctor_type), cls, text, + class fields}
cls in drug | dose | diagnosis | investigation | referral. No patient identity, no advice/plan free text, no complaint text is pulled.
Run:  python3 rx_history_extract.py --count   (counts only, no text)   |   python3 rx_history_extract.py   (pull)
"""
import datetime, hashlib, json, os, sys, collections
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-surgery-30"))
import mb

START = datetime.date(2026, 6, 26)
END = datetime.date(2026, 9, 27)          # exclusive; 25 and 26 Sep are skipped below
EXCLUDE = {datetime.date(2026, 9, 25), datetime.date(2026, 9, 26)}
OUT = os.path.expanduser("~/eta-data/cap2/")
CAP = 1900                                  # Metabase returns at most 2,000 rows per query


def norm(s):
    return " ".join(str(s or "").split())


def chunked(sql_for, lo, hi):
    """Run sql_for(lo_ts, hi_ts); split the interval in two while it hits the row cap."""
    cols, rows, trunc = mb.query(sql_for(lo, hi))
    if trunc or len(rows) >= CAP:
        mid = lo + (hi - lo) / 2
        if hi - lo < datetime.timedelta(minutes=1):
            raise SystemExit("cap: interval too small to split")
        c1, r1 = chunked(sql_for, lo, mid); c2, r2 = chunked(sql_for, mid, hi)
        return c1, r1 + r2
    return cols, rows


def ts(d):
    return datetime.datetime.combine(d, datetime.time(0, 0))


def day_windows():
    d = START
    while d < END:
        if d not in EXCLUDE:
            yield d
        d += datetime.timedelta(days=1)


def q_main(lo, hi):
    return (f"SELECT p._id, p.presc_uid, p.timestamp, p.doctor_email, p.doctor_type, d.uid AS doctor_uid, d.name_with_prefix AS doctor_name FROM "
            f"dpipe_prescription_pipeline p LEFT JOIN doctors d ON d.email = p.doctor_email "
            f"WHERE p.presc_is_draft IS NOT TRUE AND p.timestamp >= '{lo.isoformat()}+05:30' AND p.timestamp < '{hi.isoformat()}+05:30' ORDER BY p.timestamp, p._id")


CHILD = {
    "medicines": "name, strength, dosage, frequency, duration, uid",
    "diagnosis": "diagnosis, icd_code, speciality",
    "further_investigation": "name, lab_type",
    "referral": "referral_specialist",
    "plan_of_management": "diagnosis__diagnosis_or_impression, diagnosis__icd_code",
}


def q_child(tbl, lo, hi):
    return (f"SELECT c._parent_id, {', '.join('c.' + x.strip() for x in CHILD[tbl].split(','))} FROM dpipe_prescription_pipeline__{tbl} c "
            f"JOIN dpipe_prescription_pipeline p ON p._id = c._parent_id WHERE p.presc_is_draft IS NOT TRUE "
            f"AND p.timestamp >= '{lo.isoformat()}+05:30' AND p.timestamp < '{hi.isoformat()}+05:30'")


def main():
    count_only = "--count" in sys.argv
    if count_only:
        cols, rows, _ = mb.query("SELECT date(timestamp), count(*) FROM dpipe_prescription_pipeline WHERE presc_is_draft IS NOT TRUE "
                                 f"AND timestamp >= '{START}' GROUP BY 1 ORDER BY 1")
        keep = [r for r in rows if datetime.date.fromisoformat(r[0][:10]) not in EXCLUDE]
        print("days", len(keep), "prescriptions", sum(r[1] for r in keep), "excluded days rows", sum(r[1] for r in rows) - sum(r[1] for r in keep))
        return
    os.makedirs(OUT, exist_ok=True); os.chmod(OUT, 0o700)
    seen, n = set(), collections.Counter()
    tmp = OUT + "rx_history.jsonl.tmp"
    buf = []
    if True:
        def emit(rec, cls, text, **kw):
            text = norm(text)
            if not text:
                return
            key = (rec["rx"], cls, text.lower())
            if key in seen:
                return
            seen.add(key); n[cls] += 1
            buf.append(dict(rx=rec["rx"], date=rec["date"], doctor_uid=rec["doctor_uid"], doctor_name=rec["doctor_name"], specialty=rec["specialty"], cls=cls, text=text, **kw))
        for d in day_windows():
            lo, hi = ts(d), ts(d + datetime.timedelta(days=1))
            cols, rows = chunked(q_main, lo, hi)
            main_ = {}
            for r in rows:
                m = dict(zip(cols, r))
                main_[m["_id"]] = dict(rx=hashlib.sha1(str(m["presc_uid"]).encode()).hexdigest()[:12], date=str(m["timestamp"])[:10], doctor_uid=m["doctor_uid"], doctor_name=m["doctor_name"], specialty=m["doctor_type"])
            for tbl in CHILD:
                cols, rows = chunked(lambda a, b, t=tbl: q_child(t, a, b), lo, hi)
                for r in rows:
                    x = dict(zip(cols, r)); rec = main_.get(x["_parent_id"])
                    if not rec:
                        continue
                    if tbl == "medicines":
                        emit(rec, "drug", x.get("name"), strength=x.get("strength"), drug_uid=x.get("uid"))
                        dose = " ".join(str(v) for v in (x.get("strength"), x.get("dosage"), x.get("frequency"), x.get("duration")) if v)
                        if dose:
                            emit(rec, "dose", f"{norm(x.get('name'))}: {dose}", drug=norm(x.get("name")), dosage=x.get("dosage"), frequency=x.get("frequency"), duration=x.get("duration"))
                    elif tbl == "diagnosis":
                        emit(rec, "diagnosis", x.get("diagnosis"), icd=x.get("icd_code"))
                    elif tbl == "plan_of_management":
                        emit(rec, "diagnosis", x.get("diagnosis__diagnosis_or_impression"), icd=x.get("diagnosis__icd_code"))
                    elif tbl == "further_investigation":
                        emit(rec, "investigation", x.get("name"), lab_type=x.get("lab_type"))
                    elif tbl == "referral":
                        emit(rec, "referral", x.get("referral_specialist"))
            print(d, len(main_), flush=True)
    # brand + generic names from the drug master (table `medicines`), for the drug uids seen
    uids = sorted({b["drug_uid"] for b in buf if b["cls"] == "drug" and b.get("drug_uid")})
    master = {}
    for i in range(0, len(uids), 300):
        part = ",".join("'" + u.replace("'", "") + "'" for u in uids[i:i + 300])
        _, rr, _ = mb.query(f"SELECT uid, brand_name, generic_name FROM medicines WHERE uid IN ({part})")
        for u, b, g in rr:
            master[u] = (norm(b), norm(g))
    for b in buf:
        if b["cls"] == "drug":
            m = master.get(b.get("drug_uid"), ("", ""))
            b["brand"], b["generic"] = m
    with open(tmp, "w") as f:
        os.chmod(tmp, 0o600)
        for b in buf:
            f.write(json.dumps(b, ensure_ascii=False) + "\n")
    os.replace(tmp, OUT + "rx_history.jsonl")
    os.chmod(OUT + "rx_history.jsonl", 0o600)
    print("items", sum(n.values()), dict(n))


if __name__ == "__main__":
    main()
