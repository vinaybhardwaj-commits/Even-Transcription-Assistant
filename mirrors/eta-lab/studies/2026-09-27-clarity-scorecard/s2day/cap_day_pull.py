"""W33.4(b) step 1: the Pulse + PQM pulls for ONE day (default 2026-09-26), the same sources CAP-1 used for 25 Sep, into ~/eta-data/cap/raw-<day>/ and ~/eta-data/cap/<day>/rows.csv (box only, 0600/0700).
Read-only Metabase via studies/2026-09-24-surgery-30/mb.py (the key is never printed). Reproduces J-001 (encounter-truth pull_steps/pull_tokens/pull_rx/build_rows) for one day, and the dpipe pulls CAP-1 made
(dpipe_main, its child tables, drug master, names: names are PHI and used only for linking, as in CAP-1). No row text is printed; only counts.
  rows.csv columns = encounter-truth rows.csv (same names; rx_uids ';'-joined) so cap_extract/cap_link read it unchanged.
Usage: CAP_DAY=2026-09-26 python3 cap_day_pull.py"""
import collections, csv, datetime as dt, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "2026-09-24-surgery-30"))
import mb
DAY = os.environ.get("CAP_DAY", "2026-09-26")
HOME = os.path.expanduser("~/eta-data/")
TAG = os.environ.get("CAP_TAG", "")             # a non-empty tag writes cap/raw-<day><tag>/ and cap/<day><tag>/ (regression check on 25 Sep); a frozen bundle dir is never written
RAW, OUT = HOME + f"cap/raw-{DAY}{TAG}/", HOME + f"cap/{DAY}{TAG}/"
if not TAG and os.path.exists(OUT + "MANIFEST.sha256"):                                    # eta-refuter-2 #4680: generic, not hardcoded to 25 Sep - any bundled+frozen day (26 Sep included) refuses an untagged overwrite
    raise SystemExit(f"refused: {OUT} already has a MANIFEST.sha256 (a frozen bundle); set CAP_TAG for a check run")
d0 = dt.date.fromisoformat(DAY); d1 = d0 + dt.timedelta(days=1)
IST = "+05:30"


def q(sql):
    cols, rows, trunc = mb.query(sql)
    assert not trunc and len(rows) < 1900, f"row cap hit: {len(rows)}"
    return cols, rows


def inl(vals):
    vals = [v for v in vals if v]
    bad = [v for v in vals if not all(ch.isalnum() or ch in "_-" for ch in v)]
    if bad:
        raise SystemExit(f"refused: {len(bad)} id(s) outside [A-Za-z0-9_-] (would be silently dropped)")          # eta-refuter-2 cond 2: no silent filtering
    return ",".join(f"'{v}'" for v in vals)


def save(name, cols, rows):
    p = RAW + name + ".json"
    with open(p, "w") as f:
        json.dump(dict(cols=cols, rows=[list(r) for r in rows]), f, default=str)
    os.chmod(p, 0o600)


def parse(v):
    if not v:
        return None
    v = str(v).strip()
    for f in (None, "%Y-%m-%d %H:%M:%S %z"):
        try:
            return dt.datetime.fromisoformat(v) if f is None else dt.datetime.strptime(v, f)
        except ValueError:
            pass
    return None


def main():
    os.makedirs(RAW, mode=0o700, exist_ok=True); os.makedirs(OUT, mode=0o700, exist_ok=True); os.chmod(RAW, 0o700); os.chmod(OUT, 0o700)   # cond 3: private until cap_bundle sets the bundle mode (0750/0640 group eta, Fable's named exception)
    # steps (CONSULTATION) called on the day
    scols, steps = q("SELECT uid, token_uid, station, status, gate, priority, called_at, completed_at, no_show_at, cancelled_at, completed_by, routing->>'DOCTOR_UID' AS routing_doctor_uid, "
                     f"routing->>'STATION_UID' AS routing_station_uid, display__name FROM queue_token_steps WHERE called_at >= '{d0}' AND called_at < '{d1}' AND station='CONSULTATION' ORDER BY called_at, uid")
    steps = [dict(zip(scols, r)) for r in steps]
    for st_ in steps:                                                     # eta-refuter-2 cond 2: called_at/completed_at are '... +0530' text; a different offset would make the day filter wrong
        for k_ in ("called_at", "completed_at"):
            assert not st_.get(k_) or str(st_[k_]).strip().endswith("+0530"), f"{k_} without +0530"
    tcols, toks = q("SELECT uid, display_id, sequence_number, status, target_uid, cycle_bucket, created_at, completed_at, cancelled_at, previous_effective_at, consumer, metadata->>'INDIVIDUAL_UID' AS patient_uid, "
                    "metadata->>'DOCTOR_NAME' AS meta_doctor_name, metadata->>'ARRIVAL_KIND' AS arrival_kind, metadata->>'SCHEDULED_AT' AS scheduled_at FROM queue_tokens WHERE uid IN (" + inl(sorted({s['token_uid'] for s in steps})) + ")")
    tok = {r[0]: dict(zip(tcols, r)) for r in toks}
    pats = sorted({t["patient_uid"] for t in tok.values() if t.get("patient_uid")})
    rx = []
    for i in range(0, len(pats), 100):
        _, rr = q("SELECT uid, _parent_id AS patient_uid, doctor_uid, consult_uid, type_of_prescription, is_draft, timestamp, updated_at FROM \"individuals-prescriptions\" "
                  f"WHERE _parent_id IN ({inl(pats[i:i + 100])}) AND timestamp >= '{d0}T00:00:00{IST}' AND timestamp < '{d1}T06:00:00{IST}'")
        rx += [dict(zip(["uid", "patient_uid", "doctor_uid", "consult_uid", "type_of_prescription", "is_draft", "timestamp", "updated_at"], r)) for r in rr]
    by_pat = collections.defaultdict(list)
    for r in rx:
        by_pat[r["patient_uid"]].append(r)

    def within(r, s):
        t, c, e = parse(r.get("timestamp")), parse(s.get("called_at")), parse(s.get("completed_at"))
        if not t or not c:
            return False
        if not e or e < c:
            e = c + dt.timedelta(hours=6)
        return c - dt.timedelta(minutes=90) <= t <= e + dt.timedelta(hours=6)
    # build_rows.py: strict (doctor+time) / loose (time only) candidates; nearest called_at wins a contended Rx
    cand = {}
    for s in steps:
        pat, doc, called = tok.get(s["token_uid"], {}).get("patient_uid"), s.get("routing_doctor_uid"), parse(s.get("called_at"))
        strict, loose = [], []
        for r in by_pat.get(pat, []):
            if within(r, s):
                dist = abs((parse(r["timestamp"]) - called).total_seconds())
                (strict if (not doc or r.get("doctor_uid") == doc) else loose).append((dist, r["uid"]))
        cand[s["uid"]] = (sorted(strict), sorted(loose))
    owner = {}
    for s in sorted(steps, key=lambda x: (x["token_uid"], x["uid"])):
        for dist, u in cand[s["uid"]][0]:
            cur = owner.get(u)
            if cur is None or dist < cur[0] or (cur[1] != "doctor+time" and dist < cur[0]):
                owner[u] = (dist, "doctor+time", s["uid"])
    for s in sorted(steps, key=lambda x: (x["token_uid"], x["uid"])):
        for dist, u in cand[s["uid"]][1]:
            if owner.get(u) is None:
                owner[u] = (dist, "time_only", s["uid"])
    by_step = collections.defaultdict(lambda: {"doctor+time": [], "time_only": []})
    for u, (dist, kind, su) in owner.items():
        by_step[su][kind].append(u)
    cols = ["day", "token_uid", "step_uid", "display_id", "sequence", "patient_uid", "doctor_uid", "doctor_name_completed_by", "meta_doctor_name", "called_at", "completed_at", "no_show_at", "cancelled_at",
            "status", "arrival_kind", "scheduled_at", "rx_uids", "rx_uids_other_doctor", "consult_uids", "rx_link"]
    rows_out, rx_all = [], set()
    for s in steps:
        t = tok.get(s["token_uid"], {}); pat = t.get("patient_uid")
        st, lo = by_step[s["uid"]]["doctor+time"], by_step[s["uid"]]["time_only"]
        rxmap = {r["uid"]: r for r in by_pat.get(pat, [])}
        rows_out.append([str(s.get("called_at") or "")[:10], s["token_uid"], s["uid"], t.get("display_id"), t.get("sequence_number"), pat, s.get("routing_doctor_uid"), s.get("completed_by") or "",
                         t.get("meta_doctor_name"), s.get("called_at"), s.get("completed_at"), s.get("no_show_at"), s.get("cancelled_at"), s.get("status"), t.get("arrival_kind"), t.get("scheduled_at"),
                         ";".join(st), ";".join(lo), ";".join(sorted({rxmap[u]["consult_uid"] for u in st + lo if rxmap.get(u, {}).get("consult_uid")})), "doctor+time" if st else ("time_only" if lo else "none")])
        rx_all |= set(st)
    p = OUT + "rows.csv"
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(cols); w.writerows(rows_out)
    os.chmod(p, 0o600)
    # dpipe pulls for the linked Rx (strict doctor+time: the same Rx set cap_extract uses)
    rx_list = sorted(rx_all)
    mcols = ["_id", "uid", "presc_uid", "presc_type", "presc_is_draft", "doctor_start_time", "timestamp AS ts", "presenting_complaint", "follow_up_type", "follow_up_date", "patient_start_time", "age", "gender"]
    main_rows, mc = [], None
    for i in range(0, len(rx_list), 150):
        mc, rr = q(f"SELECT {', '.join(mcols)} FROM dpipe_prescription_pipeline WHERE presc_uid IN ({inl(rx_list[i:i + 150])})")
        main_rows += rr
    save("dpipe_main", mc, main_rows)
    ids = [r[mc.index("_id")] for r in main_rows]
    child = {"medicines": "name, strength, dosage, frequency, duration, uid", "diagnosis": "diagnosis, duration, location, speciality, icd_code, acute_chronic",
             "further_investigation": "name, lab_type, recommended", "referral": "referral_specialist, referral_is_in_house, referral_recommended",
             "plan_of_management": "diagnosis__diagnosis_or_impression, diagnosis__general_advice, diagnosis__treatment_plan, management_plan, diagnosis__location_or_notes, diagnosis__icd_code"}
    counts = {}
    for tbl, sel in child.items():
        allr, cc = [], None
        for i in range(0, len(ids), 100):
            cc, rr = q(f"SELECT _parent_id, {sel} FROM dpipe_prescription_pipeline__{tbl} WHERE _parent_id IN ({inl(ids[i:i + 100])})")
            allr += rr
        save(f"dpipe_prescription_pipeline__{tbl}", cc, allr); counts[tbl] = len(allr)
    mm = json.load(open(RAW + "dpipe_prescription_pipeline__medicines.json"))
    duids = sorted({r[mm["cols"].index("uid")] for r in mm["rows"] if r[mm["cols"].index("uid")]})
    dm, mcc = [], None
    for i in range(0, len(duids), 300):
        mcc, rr = q(f"SELECT uid, brand_name, generic_name, strength FROM medicines WHERE uid IN ({inl(duids[i:i + 300])})")
        dm += rr
    save("drug_master", mcc, dm)
    nm, nc = [], None
    for i in range(0, len(rx_list), 150):
        nc, rr = q(f"SELECT presc_uid, name, doctor_name FROM dpipe_prescription_pipeline WHERE presc_uid IN ({inl(rx_list[i:i + 150])})")
        nm += rr
    save("dpipe_names", nc, nm)
    print(json.dumps(dict(day=DAY, steps=len(steps), completed=sum(1 for s in steps if s.get("completed_at")), tokens=len(tok), patients=len(pats), rx_pulled=len(rx), rows=len(rows_out),
                          rx_linked_doctor_time=sum(1 for r in rows_out if r[-1] == "doctor+time"), rx_uids_linked=len(rx_list), dpipe_main=len(main_rows), children=counts, drug_uids=len(duids), drug_master=len(dm), names=len(nm))))


if __name__ == "__main__":
    main()
