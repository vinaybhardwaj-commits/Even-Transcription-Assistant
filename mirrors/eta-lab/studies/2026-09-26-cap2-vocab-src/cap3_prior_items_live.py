"""W53-CAP3 (linker, per cap #5400): item-level text/strength/brand/generic for ALL 65 ids in
sample_patient_rx_ids.txt (b7965cae), pulled LIVE (not from rx_history.jsonl, which is missing 11/65
in-range rows - eta-refuter-2/vj-refuter #5397/#5398). SAME row shape as rx_history.jsonl (built by
rx_history_extract.py) - same emit()/field logic reused so make_own_swap.py's own_terms() needs no
change: {rx, date, doctor_uid, doctor_name, specialty, cls, text, + class-specific fields}.
Patient-scoped (only the 24 CAP-1 sample patients), not a full day-by-day pipeline scan - reuses
consult_prior_rx_map.py's patient list. Out: ~/eta-data/cap2/cap3_prior_items_live.jsonl (0640).
"""
import csv, hashlib, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-surgery-30"))
import mb

H = os.path.expanduser("~/eta-data/")
TARGET = set(open(H + "cap2/sample_patient_rx_ids.txt").read().split())
assert len(TARGET) == 65, f"expected 65 target ids, got {len(TARGET)}"


def norm(s):
    return " ".join(str(s or "").split())


def q(sql):
    cols, rows, trunc = mb.query(sql)
    assert not trunc and len(rows) < 1900, f"row cap hit: {len(rows)}"
    return cols, rows


def inl(vals):
    vals = [v for v in vals if v]
    bad = [v for v in vals if not all(ch.isalnum() or ch in "_-@." for ch in v)]
    if bad:
        raise SystemExit(f"refused: {len(bad)} id(s) with unexpected chars")
    return ",".join("'" + v.replace("'", "") + "'" for v in vals)


linked = {l["consult_id"] for l in map(json.loads, open(H + "cap/2026-09-25/links.jsonl")) if l["status"] in ("confirmed", "probable")}
rows_csv = [r for r in csv.DictReader(open(H + "encounter-truth/rows.csv")) if r["day"] == "2026-09-25" and r["token_uid"] in linked and r["patient_uid"]]
pats = sorted({r["patient_uid"] for r in rows_csv})

pcols, prows = q("SELECT _id, presc_uid, timestamp, doctor_email, doctor_type, individual_uid FROM dpipe_prescription_pipeline "
                  "WHERE presc_is_draft IS NOT TRUE AND individual_uid IN (" + inl(pats) + ") "
                  "AND timestamp >= '2026-06-26T00:00:00+05:30' AND timestamp < '2026-09-25T00:00:00+05:30'")
main_all = [dict(zip(pcols, r)) for r in prows]
main_ = {}
for m in main_all:
    h = hashlib.sha1(str(m["presc_uid"]).encode()).hexdigest()[:12]
    if h in TARGET:
        main_[m["_id"]] = dict(rx=h, date=str(m["timestamp"])[:10], doctor_email=m["doctor_email"], specialty=m["doctor_type"])
print("prescriptions matching the 65-id target:", len(main_), "of", len(main_all), "pulled for these patients")

emails = sorted({m["doctor_email"] for m in main_.values() if m["doctor_email"]})
doc_by_email = {}
for i in range(0, len(emails), 200):
    dcols, drows = q("SELECT email, uid, name_with_prefix FROM doctors WHERE email IN (" + inl(emails[i:i + 200]) + ")")
    for e, u, n in drows:
        doc_by_email[e] = (u, n)
for m in main_.values():
    u, n = doc_by_email.get(m["doctor_email"], (None, None))
    m["doctor_uid"], m["doctor_name"] = u, n

CHILD = {
    "medicines": "name, strength, dosage, frequency, duration, uid",
    "diagnosis": "diagnosis, icd_code, speciality",
    "further_investigation": "name, lab_type",
    "referral": "referral_specialist",
    "plan_of_management": "diagnosis__diagnosis_or_impression, diagnosis__icd_code",
}
ids = list(main_)
buf, seen, n = [], set(), {}


def emit(rec, cls, text, **kw):
    text = norm(text)
    if not text:
        return
    key = (rec["rx"], cls, text.lower())
    if key in seen:
        return
    seen.add(key); n[cls] = n.get(cls, 0) + 1
    buf.append(dict(rx=rec["rx"], date=rec["date"], doctor_uid=rec["doctor_uid"], doctor_name=rec["doctor_name"], specialty=rec["specialty"], cls=cls, text=text, **kw))


for tbl, sel in CHILD.items():
    allr, cc = [], None
    for i in range(0, len(ids), 100):
        cc, rr = q(f"SELECT _parent_id, {', '.join(sel.split(', '))} FROM dpipe_prescription_pipeline__{tbl} WHERE _parent_id IN ({inl(ids[i:i + 100])})")
        allr += rr
    for r in allr:
        x = dict(zip(cc, r)); rec = main_.get(x["_parent_id"])
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

uids = sorted({b["drug_uid"] for b in buf if b["cls"] == "drug" and b.get("drug_uid")})
master = {}
for i in range(0, len(uids), 300):
    _, rr = q(f"SELECT uid, brand_name, generic_name FROM medicines WHERE uid IN ({inl(uids[i:i + 300])})")
    for u, b, g in rr:
        master[u] = (norm(b), norm(g))
for b in buf:
    if b["cls"] == "drug":
        m = master.get(b.get("drug_uid"), ("", ""))
        b["brand"], b["generic"] = m

out = os.path.expanduser("~/eta-data/cap2/cap3_prior_items_live.jsonl")
with open(out, "w") as f:
    for b in buf:
        f.write(json.dumps(b, ensure_ascii=False) + "\n")
os.chmod(out, 0o640)

ids_covered = {b["rx"] for b in buf}
print(json.dumps(dict(items=len(buf), by_cls=n, prescriptions=len(main_), target_ids=len(TARGET),
                       target_ids_with_at_least_1_item=len(ids_covered & TARGET), missing_from_output=sorted(TARGET - ids_covered))))
