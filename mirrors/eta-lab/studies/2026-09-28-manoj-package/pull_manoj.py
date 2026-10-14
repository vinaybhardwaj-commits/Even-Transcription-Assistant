"""W52-A (Fable 11:5x, due 12:45): encounters.csv + Rx for a doctor_uid, whole date range, via direct
doctor-scoped Metabase pulls (routing->>'DOCTOR_UID' on queue_token_steps) - no cap_link audio-matching
needed since doctor identity is already known directly from PQM.
Usage: python3 pull_manoj.py <doctor_uid> <label> <d0> <d1_exclusive>
"""
import collections, csv, datetime as dt, json, os, sys
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab-linker/studies/2026-09-24-surgery-30"))
import mb

HOME = os.path.expanduser("~/eta-data/manoj-package/")
IST = "+05:30"


def q(sql):
    cols, rows, trunc = mb.query(sql)
    assert not trunc, f"TRUNCATED at {len(rows)} rows - need to chunk this query further"
    return cols, rows


def inl(vals):
    vals = [v for v in vals if v]
    bad = [v for v in vals if not all(ch.isalnum() or ch in "_-" for ch in v)]
    if bad:
        raise SystemExit(f"refused: {len(bad)} id(s) outside [A-Za-z0-9_-]")
    return ",".join(f"'{v}'" for v in vals)


def parse(v):
    """queue_token_steps' called_at/completed_at are '... +0530' text (space-separated, not ISO8601);
    individuals-prescriptions' timestamp IS ISO8601. Try both, matching cap_day_pull.py's own parse()."""
    if not v:
        return None
    v = str(v).strip()
    for f in (None, "%Y-%m-%d %H:%M:%S %z"):
        try:
            return dt.datetime.fromisoformat(v) if f is None else dt.datetime.strptime(v, f)
        except ValueError:
            pass
    return None


def pull(doctor_uid, label, d0s, d1s):
    d0, d1 = dt.date.fromisoformat(d0s), dt.date.fromisoformat(d1s)
    print(f"=== {label} ({doctor_uid}) {d0s}..{d1s} ===")
    scols, steps = q("SELECT uid, token_uid, station, status, gate, priority, called_at, completed_at, no_show_at, cancelled_at, completed_by, "
                      "routing->>'DOCTOR_UID' AS routing_doctor_uid, routing->>'STATION_UID' AS routing_station_uid, display__name "
                      f"FROM queue_token_steps WHERE routing->>'DOCTOR_UID' = '{doctor_uid}' AND station='CONSULTATION' "
                      f"AND called_at >= '{d0}' AND called_at < '{d1}' ORDER BY called_at, uid")
    steps = [dict(zip(scols, r)) for r in steps]
    print(f"  steps: {len(steps)}")
    if not steps:
        return dict(label=label, doctor_uid=doctor_uid, steps=0, rows=0, rx=0)

    tcols, toks = q("SELECT uid, display_id, sequence_number, status, target_uid, cycle_bucket, created_at, completed_at, cancelled_at, "
                     "metadata->>'INDIVIDUAL_UID' AS patient_uid, metadata->>'DOCTOR_NAME' AS meta_doctor_name, metadata->>'ARRIVAL_KIND' AS arrival_kind "
                     "FROM queue_tokens WHERE uid IN (" + inl(sorted({s["token_uid"] for s in steps})) + ")")
    tok = {r[0]: dict(zip(tcols, r)) for r in toks}
    pats = sorted({t["patient_uid"] for t in tok.values() if t.get("patient_uid")})

    # Fable 12:15 update / individuals is the AUTHORITATIVE identity table (name/dob/gender/kx_uhid), _id = patient_uid.
    # Corrects my earlier "no UHID column exists" claim - that was checking the wrong (dpipe_prescription_pipeline) table.
    ind_by_pat = {}
    for i in range(0, len(pats), 200):
        icols, ir = q(f"SELECT _id, first_name, last_name, dob, gender, kx_uhid FROM individuals WHERE _id IN ({inl(pats[i:i + 200])})")
        for r in ir:
            d = dict(zip(icols, r)); ind_by_pat[d["_id"]] = d

    rx = []
    for i in range(0, len(pats), 100):
        _, rr = q("SELECT uid, _parent_id AS patient_uid, doctor_uid, consult_uid, type_of_prescription, is_draft, timestamp, updated_at "
                   f"FROM \"individuals-prescriptions\" WHERE _parent_id IN ({inl(pats[i:i + 100])}) "
                   f"AND timestamp >= '{d0}T00:00:00{IST}' AND timestamp < '{d1}T06:00:00{IST}'")
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

    cand = {}
    for s in steps:
        pat, called = tok.get(s["token_uid"], {}).get("patient_uid"), parse(s.get("called_at"))
        strict, loose = [], []
        for r in by_pat.get(pat, []):
            if within(r, s):
                dist = abs((parse(r["timestamp"]) - called).total_seconds())
                (strict if r.get("doctor_uid") == doctor_uid else loose).append((dist, r["uid"]))
        cand[s["uid"]] = (sorted(strict), sorted(loose))
    owner = {}
    for s in sorted(steps, key=lambda x: (x["token_uid"], x["uid"])):
        for dist, u in cand[s["uid"]][0]:
            if owner.get(u) is None:
                owner[u] = (dist, "doctor+time", s["uid"])
    for s in sorted(steps, key=lambda x: (x["token_uid"], x["uid"])):
        for dist, u in cand[s["uid"]][1]:
            if owner.get(u) is None:
                owner[u] = (dist, "time_only", s["uid"])
    by_step = collections.defaultdict(lambda: {"doctor+time": [], "time_only": []})
    for u, (dist, kind, su) in owner.items():
        by_step[su][kind].append(u)

    rx_list = sorted({u for su in by_step for u in by_step[su]["doctor+time"]})
    main_rows, mc = [], None
    mcols = ["_id", "uid", "presc_uid", "individual_uid", "membership_id", "member_uid", "name", "presc_type", "presc_is_draft",
              "doctor_start_time", "timestamp AS ts", "presenting_complaint", "follow_up_type", "follow_up_date", "age", "gender"]
    for i in range(0, len(rx_list), 150):
        mc, rr = q(f"SELECT {', '.join(mcols)} FROM dpipe_prescription_pipeline WHERE presc_uid IN ({inl(rx_list[i:i + 150])})")
        main_rows += rr
    main_by_presc = {dict(zip(mc, r))["presc_uid"]: dict(zip(mc, r)) for r in main_rows} if mc else {}

    ids = [dict(zip(mc, r))["_id"] for r in main_rows] if mc else []
    child = {"medicines": "name, strength, dosage, frequency, duration, uid",
              "plan_of_management": "diagnosis__general_advice, diagnosis__treatment_plan, management_plan"}
    child_rows = {}
    for tbl, sel in child.items():
        allr, cc = [], None
        for i in range(0, len(ids), 100):
            cc, rr = q(f"SELECT _parent_id, {sel} FROM dpipe_prescription_pipeline__{tbl} WHERE _parent_id IN ({inl(ids[i:i + 100])})")
            allr += rr
        child_rows[tbl] = [dict(zip(cc, r)) for r in allr] if cc else []

    med_by_parent = collections.defaultdict(list)
    for m in child_rows.get("medicines", []):
        med_by_parent[m["_parent_id"]].append(m)
    advice_by_parent = collections.defaultdict(list)
    for a in child_rows.get("plan_of_management", []):
        advice_by_parent[a["_parent_id"]].append(a)

    enc_cols = ["date", "token_uid", "step_uid", "display_id", "cycle_bucket", "doctor_uid", "patient_uid", "patient_name",
                "patient_dob", "patient_gender", "patient_kx_uhid", "token_created_at", "called_at", "completed_at", "no_show_at",
                "cancelled_at", "status", "rx_link"]
    enc_rows = []
    for s in steps:
        t = tok.get(s["token_uid"], {}); pat = t.get("patient_uid")
        st = by_step[s["uid"]]["doctor+time"]
        idn = ind_by_pat.get(pat, {})
        pname = " ".join(x for x in (idn.get("first_name"), idn.get("last_name")) if x) or None
        enc_rows.append([str(s.get("called_at") or "")[:10], s["token_uid"], s["uid"], t.get("display_id"), t.get("cycle_bucket"),
                          doctor_uid, pat, pname, idn.get("dob"), idn.get("gender"), idn.get("kx_uhid"), t.get("created_at"),
                          s.get("called_at"), s.get("completed_at"), s.get("no_show_at"), s.get("cancelled_at"), s.get("status"),
                          "doctor+time" if st else "none"])

    rx_by_uid = {r["uid"]: r for r in rx}   # for consult_uid, the Fable 12:15 join key (kept for downstream cross-ref, not used to join here - format doesn't match token_uid)
    rx_out_cols = ["step_uid", "token_uid", "date", "presc_uid", "consult_uid", "rx_created_at", "patient_name_individuals",
                    "presenting_complaint", "drug", "strength", "dosage", "frequency", "duration", "advice"]
    rx_out_rows = []
    for s in steps:
        st = by_step[s["uid"]]["doctor+time"]
        pat = tok.get(s["token_uid"], {}).get("patient_uid")
        idn = ind_by_pat.get(pat, {})
        pname = " ".join(x for x in (idn.get("first_name"), idn.get("last_name")) if x) or None
        for u in st:
            mr = main_by_presc.get(u, {})
            cuid = rx_by_uid.get(u, {}).get("consult_uid")
            meds = med_by_parent.get(mr.get("_id"), [])
            adv = "; ".join(x.get("diagnosis__general_advice") or x.get("management_plan") or "" for x in advice_by_parent.get(mr.get("_id"), [])).strip("; ")
            if not meds:
                rx_out_rows.append([s["uid"], s["token_uid"], str(s.get("called_at") or "")[:10], u, cuid, mr.get("ts"), pname,
                                      mr.get("presenting_complaint"), None, None, None, None, None, adv])
            for m in meds:
                rx_out_rows.append([s["uid"], s["token_uid"], str(s.get("called_at") or "")[:10], u, cuid, mr.get("ts"), pname,
                                      mr.get("presenting_complaint"), m.get("name"), m.get("strength"), m.get("dosage"), m.get("frequency"),
                                      m.get("duration"), adv])

    p1 = HOME + f"encounters_{label}.csv"
    with open(p1, "w", newline="") as f:
        w = csv.writer(f); w.writerow(enc_cols); w.writerows(enc_rows)
    os.chmod(p1, 0o600)
    p2 = HOME + f"rx_{label}.csv"
    with open(p2, "w", newline="") as f:
        w = csv.writer(f); w.writerow(rx_out_cols); w.writerows(rx_out_rows)
    os.chmod(p2, 0o600)

    by_day = collections.Counter(r[0] for r in enc_rows)
    linked = sum(1 for r in enc_rows if r[-1] == "doctor+time")
    print(f"  encounters: {len(enc_rows)} ({linked} with Rx linked) across {len(by_day)} days -> {p1}")
    print(f"  rx lines: {len(rx_out_rows)} -> {p2}")
    return dict(label=label, doctor_uid=doctor_uid, steps=len(steps), rows=len(enc_rows), linked=linked, rx_lines=len(rx_out_rows), by_day=dict(sorted(by_day.items())))


if __name__ == "__main__":
    os.makedirs(HOME, mode=0o700, exist_ok=True); os.chmod(HOME, 0o700)
    doctor_uid, label, d0s, d1s = sys.argv[1:5]
    summary = pull(doctor_uid, label, d0s, d1s)
    print(json.dumps(summary))
