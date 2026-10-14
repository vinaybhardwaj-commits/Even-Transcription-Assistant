"""P1 chain builder, links 1 and 2 (P1-PREREG.md v1). Deterministic: no transcripts, no scoring.
Read-only Metabase db 13 through ../../2026-09-24-surgery-review-v2/mb.py (SELECT-only guard, key never printed).
Row-level output goes to ~/eta-data/surgical-chain/p1/ (0700, ids); stdout and REPORT.json carry counts only.

  python3 build_chains.py A     visits -> Rx (link 1 tiers, route KEY/HEUR)
  python3 build_chains.py B     advised flags, done evidence, classes (link 2)
  python3 build_chains.py C     negatives frame + counts -> REPORT.json
"""
import collections, json, os, re, sys, time
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "2026-09-24-surgery-review-v2"))
import mb  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
BOX = os.path.expanduser("~/eta-data/surgical-chain/")
OUT = BOX + "p1/"
os.makedirs(OUT, mode=0o700, exist_ok=True)
os.chmod(OUT, 0o700)
D0, D1 = date(2026, 8, 1), date(2026, 9, 25)            # [1 Aug, 25 Sep) IST
MATURE_30, MATURE_14 = date(2026, 8, 22), date(2026, 9, 7)  # P1-PREREG section 1
OVERHEAD = re.compile(r"theat|\bot\b|o\.t\.|anaesth|anesth|assistant|surgeon\s*fee|charges", re.I)


def P(s):
    if s is None or s == "":
        return None
    if isinstance(s, datetime):
        return s
    s = s.strip().replace(" ", "T", 1)
    s = re.sub(r"\s*([+-]\d{2})(:?)(\d{2})$", r"\1:\3", s)
    s = re.sub(r"Z$", "+00:00", s)
    return datetime.fromisoformat(s)


def pull(sql):
    _, rows, tr = mb.query(sql)
    assert not tr and len(rows) < 2000, ("truncated or capped result", len(rows), tr)
    return rows


def q(v):
    return "'" + str(v).replace("'", "") + "'"


def chunks(xs, n):
    xs = sorted(xs)
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def days(a, b, step=1):
    d = a
    while d < b:
        e = min(d + timedelta(days=step), b)
        yield d, e
        d = e


def ist_date(dt):
    return dt.astimezone(IST).date()


def save(name, obj):
    """Write a stage output and stamp it in MANIFEST.json (P1 inputs are frozen: downstream stages read only these files)."""
    p = OUT + name
    json.dump(obj, open(p, "w"), default=str)
    os.chmod(p, 0o600)
    mp = OUT + "MANIFEST.json"
    man = json.load(open(mp)) if os.path.exists(mp) else {}
    man[name] = dict(written_at=datetime.now(IST).isoformat(timespec="seconds"), bytes=os.path.getsize(p), source="stage output")
    json.dump(man, open(mp, "w"), indent=1)
    os.chmod(mp, 0o600)


def load(name):
    return json.load(open(OUT + name))


# ---------------------------------------------------------------- stage A
def stage_a():
    t = time.time()
    visits = []
    for a, b in days(D0, D1):
        visits += pull(f"""SELECT s.uid, s.metadata->>'INDIVIDUAL_UID', s.routing->>'DOCTOR_UID', s.metadata->>'SERVICE_REQUEST_UID',
              nullif(s.called_at,''), nullif(s.completed_at,'') FROM queue_token_steps s
            WHERE s.station='CONSULTATION' AND s.status='COMPLETE'
              AND nullif(s.called_at,'')::timestamptz >= '{a}T00:00:00+05:30' AND nullif(s.called_at,'')::timestamptz < '{b}T00:00:00+05:30'""")
    V = {}
    dropped_short = 0
    for uid, ind, doc, sr, called, done in visits:
        c, d = P(called), P(done)
        if not (c and d and ind and doc):
            dropped_short += 1
            continue
        if (d - c).total_seconds() < 60:
            dropped_short += 1
            continue
        V[uid] = dict(uid=uid, ind=ind, doc=doc, sr=sr, called=str(c), done=str(d), day=str(ist_date(c)))
    print(f"A: visits {len(visits)}; kept {len(V)}; dropped (missing fields or under 1 min) {dropped_short}  [{time.time()-t:.0f}s]")

    # service request -> consult id
    sr_ids = {v["sr"] for v in V.values() if v["sr"]}
    SR = {}
    for ch in chunks(sr_ids, 150):
        for uid, ind, doc, cu in pull(f"SELECT uid, individual_uid, service_metadata__doctor_uid, service_metadata__consult_uid FROM chart_service_request WHERE uid IN ({','.join(map(q, ch))})"):
            SR[uid] = (ind, doc, cu)
    print(f"A: service requests resolved {len(SR)} of {len(sr_ids)}  [{time.time()-t:.0f}s]")

    # Rx by consult id
    consult_ids = {SR[v["sr"]][2] for v in V.values() if v["sr"] in SR and SR[v["sr"]][2]}
    RXBY = collections.defaultdict(list)
    RX = {}
    def add_rx(r):
        uid, ind, doc, cu, ts, upd, draft = r
        RX[uid] = dict(uid=uid, ind=ind, doc=doc, cu=cu, ts=str(P(ts)), upd=str(P(upd)) if upd else None, draft=bool(draft))
    for ch in chunks(consult_ids, 150):
        for r in pull(f"""SELECT uid, _parent_doc_id, doctor_uid, consult_uid, "timestamp", updated_at, is_draft FROM "individuals-prescriptions" WHERE consult_uid IN ({','.join(map(q, ch))})"""):
            add_rx(r)
            RXBY[r[3]].append(r[0])
    print(f"A: Rx by consult id {sum(len(v) for v in RXBY.values())}  [{time.time()-t:.0f}s]")

    # heuristic pool: patients of visits that have no KEY Rx
    need_heur = [v for v in V.values() if not (v["sr"] in SR and SR[v["sr"]][2] and RXBY.get(SR[v["sr"]][2]))]
    pats = {v["ind"] for v in need_heur}
    HEUR = collections.defaultdict(list)   # (ind, doc, day) -> [rx uid]
    for ch in chunks(pats, 60):
        for r in pull(f"""SELECT uid, _parent_doc_id, doctor_uid, consult_uid, "timestamp", updated_at, is_draft FROM "individuals-prescriptions"
             WHERE "timestamp" >= '{D0}T00:00:00+05:30' AND "timestamp" < '{D1}T00:00:00+05:30' AND _parent_doc_id IN ({','.join(map(q, ch))})"""):
            add_rx(r)
            HEUR[(r[1], r[2], str(ist_date(P(r[4]))))].append(r[0])
    print(f"A: heuristic pool for {len(need_heur)} visits, {len(pats)} patients  [{time.time()-t:.0f}s]")

    visits_per_key = collections.Counter((v["ind"], v["doc"], v["day"]) for v in V.values())
    def choose(rxs):
        cand = [RX[u] for u in rxs]
        nd = [c for c in cand if not c["draft"]] or cand
        return max(nd, key=lambda c: c["upd"] or c["ts"])["uid"]

    rows = []
    for v in V.values():
        cu = SR[v["sr"]][2] if v["sr"] in SR else None
        key_rx = RXBY.get(cu, []) if cu else []
        row = dict(v)
        row["sr_resolved"] = v["sr"] in SR
        if key_rx:
            mism = [u for u in key_rx if RX[u]["ind"] != v["ind"] or RX[u]["doc"] != v["doc"]]
            row.update(route="KEY", n_cand=len(key_rx), n_mismatch=len(mism))
            if mism:
                row.update(tier="X", rx=None)
            else:
                row.update(tier="A" if len(key_rx) == 1 else "B", rx=choose(key_rx))
        else:
            cand = HEUR.get((v["ind"], v["doc"], v["day"]), [])
            row.update(route="HEUR", n_cand=len(cand), n_mismatch=0, n_visits_same_key=visits_per_key[(v["ind"], v["doc"], v["day"])])
            if not cand:
                row.update(tier="NONE", rx=None)
            elif len(cand) == 1 and row["n_visits_same_key"] == 1:
                row.update(tier="B", rx=cand[0])
            else:
                row.update(tier="C", rx=None)
        rows.append(row)
    save("visits_links.json", rows)
    save("rx.json", RX)
    c = collections.Counter((r["route"], r["tier"]) for r in rows)
    print("A: route/tier counts:", dict(sorted(c.items())))
    print(f"A: done  [{time.time()-t:.0f}s]")



# ---------------------------------------------------------------- stage B
def stage_b():
    """Advised flags (S structured, P model-read), doctors, done evidence (NOTE / BILL / ADM / MANUAL_CASE), classes."""
    t = time.time()
    # S: structured flag rows by child _create_time; keep the advised names (kept for offered_in_house, stage D)
    S, NAMES = set(), {}
    for a, b in days(D0, D1, 7):
        for uid, arr in pull(f"""SELECT p.presc_uid, m.surgery_or_procedure_recommendation FROM dpipe_prescription_pipeline__plan_of_management m
              JOIN dpipe_prescription_pipeline p ON p._id = m._parent_id
              WHERE m.requires_surgery_or_procedure = true AND m._create_time >= '{a}T00:00:00+05:30' AND m._create_time < '{b}T00:00:00+05:30'"""):
            if not uid:
                continue
            S.add(uid)
            if isinstance(arr, str):
                try:
                    arr = json.loads(arr)
                except Exception:
                    arr = []
            names = []
            for e in (arr or []):
                sp = e.get("surgery_or_procedure") if isinstance(e, dict) else None
                if isinstance(sp, dict):
                    nm = str(sp.get("name") or "").strip()
                elif sp:
                    nm = str(sp).strip()
                else:
                    nm = ""
                if nm:
                    names.append(nm)
            NAMES[uid] = names
    print(f"B: structured flag Rx {len(S)}; with >=1 named entry {sum(bool(v) for v in NAMES.values())}  [{time.time()-t:.0f}s]")
    # PSR rows in window (all values), kept minimal
    PSR = {}
    for a, b in days(D0, D1, 5):
        for uid, uhid, d, rec, spec in pull(f"""SELECT prescription_uid, patient_uhid, left(prescription_date,10), surgery_recommended, speciality FROM prescription_surgery_recommendation
              WHERE prescription_date ~ '^[0-9]{{4}}-' AND left(prescription_date,10) >= '{a}' AND left(prescription_date,10) < '{b}'"""):
            if uid:
                PSR[uid] = (uhid, d, rec, spec)
    P_YES = {u for u, v in PSR.items() if v[2] == "yes"}
    print(f"B: PSR rows {len(PSR)}; yes {len(P_YES)}; explicit no {sum(v[2]=='no' for v in PSR.values())}  [{time.time()-t:.0f}s]")
    adv = S | P_YES
    # Rx facts for advised Rx
    RXA = {}
    for ch in chunks(adv, 150):
        for uid, ind, doc, ts in pull(f"""SELECT uid, _parent_doc_id, doctor_uid, "timestamp" FROM "individuals-prescriptions" WHERE uid IN ({','.join(map(q, ch))})"""):
            RXA[uid] = dict(uid=uid, ind=ind, doc=doc, ts=str(P(ts)))
    print(f"B: advised Rx resolved {len(RXA)} of {len(adv)}  [{time.time()-t:.0f}s]")
    per_doc = collections.Counter(r["doc"] for r in RXA.values())
    surgical_docs = sorted(d for d, n in per_doc.items() if n >= 10)
    print(f"B: doctors with advised Rx {len(per_doc)}; surgical-clinic doctors (>=10) {len(surgical_docs)}")
    # uhid for the patients
    uhid = {}
    for ch in chunks({r["ind"] for r in RXA.values()}, 300):
        for uid, u in pull(f"SELECT uid, kx_uhid FROM individuals WHERE uid IN ({','.join(map(q, ch))})"):
            if u:
                uhid[uid] = u
    # outcome tables (window)
    notes = collections.defaultdict(list)
    for a, b in days(D0, D1, 14):
        for u, e, c in pull(f"SELECT uhid, encounter_id, created_at FROM kx_clinical_template_ot_notes WHERE created_at >= '{a}T00:00:00+05:30' AND created_at < '{b}T00:00:00+05:30'"):
            notes[u].append((e, P(c)))
    adms = collections.defaultdict(list)
    for a, b in days(D0, D1, 14):
        for e, u, c in pull(f"SELECT encounter_id, uhid, admission_date_time FROM kx_ip_admissions WHERE admission_date_time >= '{a}T00:00:00+05:30' AND admission_date_time < '{b}T00:00:00+05:30'"):
            adms[u].append((e, P(c)))
    bills = collections.defaultdict(list)
    for a, b in days(D0, D1 + timedelta(days=0), 7):
        for u, e, st, nm, adm in pull(f"""SELECT uhid, visit_id_admission_id, service_type, service_item_name, admission_date_time FROM kx_billing_records
              WHERE service_type IN ('Surgery','IP Package') AND order_date_time >= '{a}T00:00:00+05:30' AND order_date_time < '{b}T00:00:00+05:30'"""):
            if st == "Surgery" and OVERHEAD.search(nm or ""):
                continue
            bills[u].append((e, P(adm)))
    cases = collections.defaultdict(list)
    for uid, ind, c, st, src in pull(f"SELECT uid, individual_uid, created_at, status, source FROM surgery_cases WHERE created_at >= '{D0}T00:00:00+05:30' AND created_at < '{D1}T00:00:00+05:30'"):
        if st != "CANCELLED":
            cases[ind].append((P(c), src))
    print(f"B: outcome tables: notes {sum(map(len,notes.values()))}, admissions {sum(map(len,adms.values()))}, procedure billing lines {sum(map(len,bills.values()))}, cases {sum(map(len,cases.values()))}  [{time.time()-t:.0f}s]")
    # visits: rx -> visit route / tier
    vl = load("visits_links.json")
    rx_visit = {}
    for v in vl:
        if v.get("rx"):
            rx_visit[v["rx"]] = (v["route"], v["tier"])
    rows = []
    for uid, r in RXA.items():
        ts = P(r["ts"])
        u = uhid.get(r["ind"])
        cls = "BOTH" if uid in S and uid in P_YES else ("S_ONLY" if uid in S else "P_ONLY")
        row = dict(rx=uid, ind=r["ind"], doc=r["doc"], ts=r["ts"], day=str(ist_date(ts)), flag_class=cls, uhid_resolved=bool(u),
                   names=NAMES.get(uid, []), route_tier=rx_visit.get(uid), surgical_doc=r["doc"] in surgical_docs)
        for W, lab in ((30, "30"), (14, "14")):
            lo, hi = ts - timedelta(days=1), ts + timedelta(days=W)
            note = bool(u) and any(ts <= c <= hi for e, c in notes.get(u, []))
            bill = bool(u) and any(a is not None and lo <= a <= hi for e, a in bills.get(u, []))
            adm = bool(u) and any(lo <= c <= hi for e, c in adms.get(u, []))
            man = any(lo <= c <= hi and src == "MANUAL" for c, src in cases.get(r["ind"], []))
            pres = any(lo <= c <= hi and src == "PRESCRIBED" for c, src in cases.get(r["ind"], []))
            row[f"ev{lab}"] = dict(NOTE=note, BILL=bill, ADM=adm, MANUAL_CASE=man, PRESCRIBED_CASE_ignored=pres)
        rows.append(row)
    save("advised_rx.json", rows)
    save("psr_window.json", PSR)
    save("surgical_docs.json", surgical_docs)
    def klass(ev):
        if ev["NOTE"] or ev["BILL"]:
            return "DONE_STRONG"
        if ev["ADM"]:
            return "ADM_ONLY"
        if ev["MANUAL_CASE"]:
            return "BOOKED_MANUAL_ONLY"
        return "NONE"
    for W, cut in (("30", MATURE_30), ("14", MATURE_14)):
        c = collections.Counter()
        for r in rows:
            mature = date.fromisoformat(r["day"]) <= cut
            c[(r["flag_class"], "mature" if mature else "immature", klass(r[f"ev{W}"]))] += 1
        print(f"B: {W}-day outcomes by (flag class, maturity, class):")
        for k in sorted(c):
            print("   ", k, c[k])
    print(f"B: done  [{time.time()-t:.0f}s]")


# ---------------------------------------------------------------- stage D (ruling 163)
CORE = re.compile(r"([a-z]*(?:ectomy|otomy|ostomy|plasty|oscopy|opexy|pexy|rrhaphy|desis|ectomies|centesis|lysis|ablation|biopsy))")
STOP = set("laparoscopic laproscopic laparoscopy surgery surgical unilateral bilateral package procedure under with without removal excision repair release injection insertion management minor major local general anaesthesia spinal complete partial total left right clinic session and for the of in by to operation resection reconstruction decompression drainage incision".split())


def stems(name):
    return {w[:6] for w in norm(name).split() if len(w) >= 6 and w not in STOP and not w.startswith("uid")}


KEYWORDS = ["endometriosis", "mirena", "circumcis", "meniscus", "arthroscop", "turp", "holep", "rirs", "evlt", "varicocele", "keloid", "pilonidal", "flap", "acl", "carpal", "curettage", "hernia", "piles", "haemorrhoid", "hemorrhoid", "fistula", "fissure", "lscs", "caesarean", "cesarean", "cataract", "phaco", "delivery",
            "angioplasty", "angiography", "angiogram", "bypass", "cabg", "stent", "pacemaker", "dialysis", "lithotripsy", "circumcision", "varicose",
            "cystoscopy", "lipoma", "cyst", "abscess", "tonsil", "adenoid", "septoplasty", "arthroplasty", "replacement", "fixation", "fusion", "discectomy"]
ABBR = [(r"\blap\b", "laparoscopic"), (r"\bc\.?\s*t\.?\b", "ct"), (r"\bt\.?k\.?r\b", "knee replacement"), (r"\bt\.?h\.?r\b", "hip replacement")]


def norm(name):
    n = (name or "").lower()
    for a, b in ABBR:
        n = re.sub(a, b, n)
    return re.sub(r"[^a-z0-9 ]+", " ", n)


def ptype(name):
    """Procedure type key from a free-text name: CT angiography first, else a procedure-suffix term, else a keyword, else UNTYPED."""
    n = norm(name)
    if re.search(r"\bct\b.*angio|angio.*\bct\b|\bcta\b", n):
        return "CT_ANGIOGRAPHY"
    m = CORE.search(n)
    if m and len(m.group(1)) > 5:
        return m.group(1)
    for k in KEYWORDS:
        if k in n:
            return k
    return "UNTYPED"


def stage_d():
    t = time.time()
    SIX = date(2026, 3, 24)
    corpus = collections.defaultdict(collections.Counter)   # type -> {source: n}
    stemcount = collections.Counter()
    cover = {"OT_NOTE": collections.Counter(), "BILL": collections.Counter()}
    for a, b in days(SIX, D1, 14):
        for (nm, c) in pull(f"SELECT surgery_name, created_at FROM kx_clinical_template_ot_notes WHERE created_at >= '{a}T00:00:00+05:30' AND created_at < '{b}T00:00:00+05:30'"):
            corpus[ptype(nm)]["OT_NOTE"] += 1
            stemcount.update(stems(nm))
            cover["OT_NOTE"][str(P(c))[:7]] += 1
        for (st, nm, c) in pull(f"""SELECT service_type, service_item_name, order_date_time FROM kx_billing_records WHERE service_type IN ('Surgery','IP Package')
              AND order_date_time >= '{a}T00:00:00+05:30' AND order_date_time < '{b}T00:00:00+05:30'"""):
            if st == "Surgery" and OVERHEAD.search(nm or ""):
                continue
            corpus[ptype(nm)]["BILL"] += 1
            stemcount.update(stems(nm))
            cover["BILL"][str(P(c))[:7]] += 1
    print("D: in-house corpus coverage by month (rows):", {k: dict(sorted(v.items())) for k, v in cover.items()})
    print(f"D: in-house types {len(corpus)}  [{time.time()-t:.0f}s]")
    rows = load("advised_rx.json")
    # name-level evidence: an advised name is IN-HOUSE-EVIDENCED if any distinctive stem occurs in the 6-month in-house corpus
    name_rx = collections.Counter()
    for r in rows:
        for n in set(x.strip().lower() for x in r["names"]):
            name_rx[n] += 1
    def evidence(n):
        st = stems(n)
        hits = {x: stemcount[x] for x in st}
        return dict(strict_type=ptype(n), strict_n=sum(sum(v.values()) for k, v in corpus.items() if k == ptype(n) and k != "UNTYPED"),
                    stems=len(st), lenient_n=max(hits.values(), default=0))
    ev = {n: evidence(n) for n in name_rx}
    def status_name(n):
        if ptype(n) == "CT_ANGIOGRAPHY":
            return "REFERRED_OUT"                     # V, ruling 163
        e = ev[n]
        if e["stems"] == 0:
            return "UNJUDGED"                         # no distinctive term to look up
        return "REFERRED_OUT" if e["lenient_n"] == 0 else "IN_HOUSE"
    st = {n: status_name(n) for n in name_rx}
    ref_names = sorted(n for n, v in st.items() if v == "REFERRED_OUT")
    print(f"D: distinct advised names {len(name_rx)}; IN_HOUSE {sum(v=='IN_HOUSE' for v in st.values())}; REFERRED_OUT {len(ref_names)}; UNJUDGED {sum(v=='UNJUDGED' for v in st.values())}")
    print("D: REFERRED-OUT advised names (Rx count | strict type-key occurrences in 6 months | best distinctive-stem occurrences):")
    for n in sorted(ref_names, key=lambda x: -name_rx[x]):
        print(f"   {name_rx[n]:3d} | {ev[n]['strict_n']:4d} | {ev[n]['lenient_n']:4d} | {n[:70]}")
    strict_zero = sorted(n for n in name_rx if ev[n]["strict_type"] not in ("UNTYPED", "CT_ANGIOGRAPHY") and ev[n]["strict_n"] == 0)
    print(f"D: names with 0 under the strict type-key but >0 under the stem check (so NOT referred out): {sum(1 for n in strict_zero if st[n]=='IN_HOUSE')} of {len(strict_zero)}")
    save("offered_in_house.json", dict(status=st, evidence=ev, advised_rx_per_name=name_rx, referred_out=ref_names))
    for r in rows:
        ns = sorted(set(x.strip().lower() for x in r["names"]))
        stt = [st[n] for n in ns]
        r["types"] = sorted({ptype(n) for n in ns})
        if not ns:
            r["type_status"] = "UNNAMED"
        elif all(x == "REFERRED_OUT" for x in stt):
            r["type_status"] = "REFERRED_OUT_ONLY"
        elif any(x == "IN_HOUSE" for x in stt):
            r["type_status"] = "IN_HOUSE"
        else:
            r["type_status"] = "UNJUDGED"
    save("advised_rx_typed.json", rows)
    def klass(ev):
        return "DONE_STRONG" if (ev["NOTE"] or ev["BILL"]) else ("ADM_ONLY" if ev["ADM"] else ("BOOKED_MANUAL_ONLY" if ev["MANUAL_CASE"] else "NONE"))
    for W, cut in (("30", MATURE_30), ("14", MATURE_14)):
        print(f"D: recount of the candidate-negative pool, {W}-day follow-up (structured-flag Rx, mature, no NOTE/BILL/ADM/MANUAL_CASE):")
        base = [r for r in rows if r["flag_class"] in ("S_ONLY", "BOTH") and date.fromisoformat(r["day"]) <= cut and klass(r[f"ev{W}"]) == "NONE"]
        c = collections.Counter((r["flag_class"], r["type_status"]) for r in base)
        print(f"    before drop: {len(base)}; by (flag class, type status): {dict(sorted(c.items()))}")
        print(f"    AFTER dropping REFERRED_OUT_ONLY: {sum(r['type_status']!='REFERRED_OUT_ONLY' for r in base)}  (unnamed {sum(r['type_status']=='UNNAMED' for r in base)}, unjudged {sum(r['type_status']=='UNJUDGED' for r in base)})")
    allS = [r for r in rows if r["flag_class"] in ("S_ONLY", "BOTH")]
    print("D: all structured-flag Rx (517 basis):", len(allS), dict(collections.Counter(r["type_status"] for r in allS)))
    print(f"D: done  [{time.time()-t:.0f}s]")



# ---------------------------------------------------------------- stage C (P1-PREREG section 6)
def stage_c():
    """Matched negatives frame from the box files (no Metabase). Seed 24. Counts to REPORT.json; rows to the box."""
    import random
    rows = load("advised_rx_typed.json")
    visits = load("visits_links.json")
    PSR = load("psr_window.json")
    surg = set(load("surgical_docs.json"))
    cta = set(load("cta_rx_uids.json")) if os.path.exists(OUT + "cta_rx_uids.json") else set()
    rx = load("rx.json")
    def klass(ev):
        return "DONE_STRONG" if (ev["NOTE"] or ev["BILL"]) else ("ADM_ONLY" if ev["ADM"] else ("BOOKED_MANUAL_ONLY" if ev["MANUAL_CASE"] else "NONE"))
    def wk(dstr):
        y, w, _ = date.fromisoformat(dstr).isocalendar()
        return f"{y}-W{w:02d}"
    out = {}
    for W, cut in (("30", MATURE_30), ("14", MATURE_14)):
        pos, n1 = [], []
        for r in rows:
            if date.fromisoformat(r["day"]) > cut:
                continue
            k = klass(r[f"ev{W}"])
            tier = (r["route_tier"] or [None, None])[1]
            item = dict(rx=r["rx"], doc=r["doc"], week=wk(r["day"]), flag_class=r["flag_class"], route=(r["route_tier"] or [None])[0], tier=tier, type_status=r["type_status"], cta=r["rx"] in cta)
            if k == "DONE_STRONG" and not item["cta"]:
                pos.append(item)
            elif k == "NONE" and r["flag_class"] in ("S_ONLY", "BOTH") and r["type_status"] != "REFERRED_OUT_ONLY" and not item["cta"]:
                n1.append(item)
        # N2: visits by surgical-clinic doctors with an explicit PSR no and no structured flag
        Sset = {r["rx"] for r in rows if r["flag_class"] in ("S_ONLY", "BOTH")}
        n2 = []
        for v in visits:
            if v["tier"] not in ("A", "B") or not v["rx"] or v["doc"] not in surg:
                continue
            if date.fromisoformat(v["day"]) > cut:
                continue
            psr = PSR.get(v["rx"])
            if psr and psr[2] == "no" and v["rx"] not in Sset:
                n2.append(dict(rx=v["rx"], doc=v["doc"], week=wk(v["day"]), route=v["route"], tier=v["tier"]))
        pos_v = [x for x in pos if x["tier"] in ("A", "B")]
        n1_v = [x for x in n1 if x["tier"] in ("A", "B")]
        by1, by2 = collections.defaultdict(list), collections.defaultdict(list)
        for x in n1_v: by1[(x["doc"], x["week"])].append(x)
        for x in n2: by2[(x["doc"], x["week"])].append(x)
        rnd = random.Random(24)
        frame, short1, short2 = [], 0, 0
        for x in sorted(pos_v, key=lambda z: z["rx"]):
            g1 = sorted(by1.get((x["doc"], x["week"]), []), key=lambda z: z["rx"]); g2 = sorted(by2.get((x["doc"], x["week"]), []), key=lambda z: z["rx"])
            c1 = rnd.choice(g1) if g1 else None
            c2 = rnd.choice(g2) if g2 else None
            short1 += c1 is None; short2 += c2 is None
            frame.append(dict(positive=x["rx"], n1=c1["rx"] if c1 else None, n2=c2["rx"] if c2 else None))
        cnt = collections.Counter
        out[W] = dict(mature_cutoff=str(cut), positives_done_strong=len(pos), positives_with_visit_AB=len(pos_v),
                      positives_by_flag_class=dict(cnt(x["flag_class"] for x in pos)), positives_by_route=dict(cnt(str(x["route"]) for x in pos_v)),
                      N1_pool=len(n1), N1_pool_with_visit_AB=len(n1_v), N1_by_flag_class=dict(cnt(x["flag_class"] for x in n1)), N1_by_type_status=dict(cnt(x["type_status"] for x in n1)),
                      N2_pool_visits=len(n2), N2_doctor_weeks=len(by2), positives_with_no_same_doctor_week_N1=short1, positives_with_no_same_doctor_week_N2=short2)
        save(f"neg_frame_{W}d.json", frame)
    save("REPORT_C.json", out)
    print(json.dumps(out, indent=1))



# ---------------------------------------------------------------- drift check (refuter-2 #588)
def stage_drift():
    """Re-resolve a seeded sample of stored visits against live Metabase and compare with the frozen pull. Read-only."""
    import random
    rows = load("visits_links.json")
    rnd = random.Random(24)
    sample = rnd.sample(rows, 300)
    sr_ids = sorted({v["sr"] for v in sample if v["sr"]})
    SR = {}
    for ch in chunks(sr_ids, 150):
        for uid, cu in pull(f"SELECT uid, service_metadata__consult_uid FROM chart_service_request WHERE uid IN ({','.join(map(q, ch))})"):
            SR[uid] = cu
    cus = sorted({SR[v["sr"]] for v in sample if v["sr"] in SR and SR[v["sr"]]})
    RXN = collections.Counter()
    for ch in chunks(cus, 150):
        for (cu,) in pull(f"""SELECT consult_uid FROM "individuals-prescriptions" WHERE consult_uid IN ({','.join(map(q, ch))})"""):
            RXN[cu] += 1
    diff = collections.Counter()
    for v in sample:
        cu = SR.get(v["sr"]) if v["sr"] else None
        now_key = bool(cu) and RXN.get(cu, 0) > 0
        was_key = v["route"] == "KEY"
        diff[("KEY" if was_key else "HEUR", "KEY" if now_key else "not-KEY")] += 1
        if was_key and now_key and RXN[cu] != v["n_cand"]:
            diff["n_cand changed"] += 1
    stamp = datetime.now(IST).isoformat(timespec="seconds")
    man = json.load(open(OUT + "MANIFEST.json"))
    man["DRIFT_CHECK"] = dict(checked_at=stamp, sample=len(sample), result={str(k): v for k, v in diff.items()})
    json.dump(man, open(OUT + "MANIFEST.json", "w"), indent=1)
    print(f"drift check at {stamp} on {len(sample)} stored visits (seed 24): (stored route, live route) counts:", dict(diff))



# ---------------------------------------------------------------- stage F: proc_match stage 1 (P1-PREREG-v4.md)
def stage_f():
    """Patient-side procedure agreement for candidates (advised Rx + NOTE/BILL). Done-side names from NOTE/BILL only (MANUAL case names
    are kept as a separate flag, never a match source). Pulls its own name data and stamps it. No transcripts, no link score."""
    import random
    from procmatch import proc_match
    t = time.time()
    rows = load("advised_rx_typed.json")
    cand = [r for r in rows if r["ev30"]["NOTE"] or r["ev30"]["BILL"] or r["ev14"]["NOTE"] or r["ev14"]["BILL"]]
    inds = sorted({r["ind"] for r in cand})
    uhid = {}
    for ch in chunks(inds, 300):
        for uid, u in pull(f"SELECT uid, kx_uhid FROM individuals WHERE uid IN ({','.join(map(q, ch))})"):
            if u:
                uhid[uid] = u
    notes = collections.defaultdict(list); bills = collections.defaultdict(list)
    for a, b in days(D0, D1, 14):
        for u, nm, c in pull(f"SELECT uhid, surgery_name, created_at FROM kx_clinical_template_ot_notes WHERE created_at >= '{a}T00:00:00+05:30' AND created_at < '{b}T00:00:00+05:30'"):
            notes[u].append((nm or "", P(c)))
    for a, b in days(D0, D1, 7):
        for u, st, nm, adm in pull(f"""SELECT uhid, service_type, service_item_name, admission_date_time FROM kx_billing_records WHERE service_type IN ('Surgery','IP Package')
              AND order_date_time >= '{a}T00:00:00+05:30' AND order_date_time < '{b}T00:00:00+05:30'"""):
            if st == "Surgery" and OVERHEAD.search(nm or ""):
                continue
            bills[u].append((nm or "", P(adm)))
    mcase = collections.defaultdict(list)
    for ind, c, st, src, nm in pull(f"SELECT individual_uid, created_at, status, source, procedure_name FROM surgery_cases WHERE created_at >= '{D0}T00:00:00+05:30' AND created_at < '{D1}T00:00:00+05:30'"):
        if st != "CANCELLED" and src == "MANUAL":
            mcase[ind].append((nm or "", P(c)))
    psr_type = {}
    p_only = [r["rx"] for r in cand if r["flag_class"] == "P_ONLY"]
    for ch in chunks(p_only, 150):
        for uid, ty in pull(f"SELECT prescription_uid, surgery_type FROM prescription_surgery_recommendation WHERE prescription_uid IN ({','.join(map(q, ch))})"):
            psr_type[uid] = ty or ""
    stamp = datetime.now(IST).isoformat(timespec="seconds")
    save("done_names_stamp.json", dict(pulled_at=stamp, notes=sum(map(len, notes.values())), bills=sum(map(len, bills.values())), manual_cases=sum(map(len, mcase.values()))))
    out, pairs_match = [], []
    for r in cand:
        ts = P(r["ts"]); u = uhid.get(r["ind"])
        res = {}
        for W in (30, 14):
            lo, hi = ts - timedelta(days=1), ts + timedelta(days=W)
            dn = sorted({nm.strip().lower() for nm, c in notes.get(u, []) if ts <= c <= hi and nm.strip()} |
                        {nm.strip().lower() for nm, a in bills.get(u, []) if a is not None and lo <= a <= hi and nm.strip()})
            adv = sorted({x.strip().lower() for x in r["names"]} | ({psr_type[r["rx"]].strip().lower()} if psr_type.get(r["rx"]) else set()))
            adv = [x for x in adv if x]
            results = [(a_, d_, proc_match(a_, d_)) for a_ in adv for d_ in dn]
            if not adv or not dn:
                verdict = "unknown"
            elif any(x[2] == "match" for x in results):
                verdict = "match"
            elif any(x[2] == "technique_changed" for x in results):
                verdict = "technique_changed"
            elif all(x[2] == "mismatch" for x in results):
                verdict = "mismatch"
            else:
                verdict = "unknown"
            mname = sorted({nm.strip().lower() for nm, c in mcase.get(r["ind"], []) if lo <= c <= hi and nm.strip()})
            manual_would_match = any(proc_match(a_, m_) == "match" for a_ in adv for m_ in mname)
            res[str(W)] = dict(verdict=verdict, n_adv=len(adv), n_done=len(dn), manual_case_name_would_match=manual_would_match)
            if W == 30 and verdict == "match":
                pairs_match.append((r["ind"], *next((x[0], x[1]) for x in results if x[2] == "match")))
        out.append(dict(rx=r["rx"], flag_class=r["flag_class"], day=r["day"], res=res, done_30=bool(r["ev30"]["NOTE"] or r["ev30"]["BILL"]), done_14=bool(r["ev14"]["NOTE"] or r["ev14"]["BILL"])))
    save("proc_match_stage1.json", out)
    # v5: units are (patient, advised name); pairs already graded in the v4 sample (which shaped the v5 rule) are excluded; seed 25
    prev = {tuple(x) for x in load("proc_match_sample20.json")}
    seen, units = set(), []
    for ind, a_, d_ in sorted(pairs_match):
        if (ind, a_) in seen or (a_, d_) in prev:
            continue
        seen.add((ind, a_)); units.append((a_, d_))
    rnd = random.Random(25)
    sample = rnd.sample(units, min(20, len(units)))
    save("proc_match_sample20_v5.json", sample)   # names only, no identity
    print(f"F: distinct (patient, advised name) match units, excluding the v4 graded pairs: {len(units)}; all match pairs before dedupe: {len(pairs_match)}")
    def tab(W, cut):
        c = collections.Counter()
        for o in out:
            if not (o["done_30"] if W == "30" else o["done_14"]) or date.fromisoformat(o["day"]) > cut:
                continue
            c[(o["flag_class"], o["res"][W]["verdict"])] += 1
        return dict(sorted(c.items()))
    print(f"F: pulled at {stamp}; candidates (any window) {len(cand)}  [{time.time()-t:.0f}s]")
    print("F: mature 30-day candidates by (flag class, proc_match stage 1):", tab("30", MATURE_30))
    print("F: mature 14-day candidates by (flag class, proc_match stage 1):", tab("14", MATURE_14))
    allm = [o for o in out if o["done_30"] and date.fromisoformat(o["day"]) <= MATURE_30]
    print("F: manual-case name would have matched (30 d, mature candidates; NOT used):", sum(o["res"]["30"]["manual_case_name_would_match"] for o in allm), "of", len(allm))
    print(f"F: sample of {len(sample)} stage-1 MATCH pairs written to the box (names only)")



# ---------------------------------------------------------------- stage E: plain CT (ruling 164, P1-PREREG-v3 A7)
CT_NAME = re.compile(r"(^|[^a-z])(ct|c\s?t|hrct)([^a-z]|$)|ct scan|computed tomo", re.I)
CT_EXCLUDE = re.compile(r"angio|calcium|\bcta\b|ctpa|\bpet\b|\bmri\b|\bmr\b", re.I)


def is_plain_ct(name):
    return bool(name) and bool(CT_NAME.search(name)) and not CT_EXCLUDE.search(name)


def stage_e():
    """Plain-CT orders on Rx and RAD done evidence for the same patient within [-1, +30] d (and 14 d): a COMPLETED plain-CT service
    request (occurrence time) or a HIS plain-CT bill line (uhid -> individual; IP/ER). Positives-only (A7): no negatives are made from this."""
    t = time.time()
    orders = {}
    for a, b in days(D0, D1, 7):
        for rx, iuid, nm in pull(f"""SELECT _parent_id, investigation__uid, investigation__name FROM "individuals-prescriptions__further_investigation"
              WHERE _create_time >= '{a}T00:00:00+05:30' AND _create_time < '{b}T00:00:00+05:30'
                AND investigation__name ~* '(^|[^a-z])(ct|c ?t|hrct)([^a-z]|$)|ct scan|computed tomo'"""):
            if is_plain_ct(nm):
                orders[rx] = (iuid, nm)
    print(f"E: plain-CT order rows on distinct Rx {len(orders)}  [{time.time()-t:.0f}s]")
    RXA = {}
    for ch in chunks(orders, 150):
        for uid, ind, doc, ts, upd in pull(f"""SELECT uid, _parent_doc_id, doctor_uid, "timestamp", updated_at FROM "individuals-prescriptions" WHERE uid IN ({','.join(map(q, ch))})"""):
            RXA[uid] = dict(rx=uid, ind=ind, doc=doc, ts=P(ts), upd=P(upd))
    RXA = {u: r for u, r in RXA.items() if D0 <= ist_date(r["ts"]) < D1}
    print(f"E: plain-CT Rx with a prescription date in window {len(RXA)}; patients {len({r['ind'] for r in RXA.values()})}")
    # platform service requests: CT modality
    sr = collections.defaultdict(list)
    for a, b in days(D0 - timedelta(days=2), D1, 7):
        for ind, stt, nm, m1, m2, occ, cr in pull(f"""SELECT individual_uid, status, service__name, service_metadata__modality, service__modality, occurrence_period__start, created_at FROM chart_service_request
              WHERE created_at >= '{a}T00:00:00+05:30' AND created_at < '{b}T00:00:00+05:30' AND (service_metadata__modality ~* 'CT' OR service__modality ~* 'CT')"""):
            if CT_EXCLUDE.search(nm or ""):
                continue
            when = P(occ) or P(cr)
            sr[ind].append((stt, when))
    # HIS plain-CT bill lines (uhid)
    uh = {}
    for ch in chunks({r["ind"] for r in RXA.values()}, 300):
        for uid, u in pull(f"SELECT uid, kx_uhid FROM individuals WHERE uid IN ({','.join(map(q, ch))})"):
            if u:
                uh[uid] = u
    bill = collections.defaultdict(list)
    for a, b in days(D0 - timedelta(days=2), D1, 7):
        for u, nm, od in pull(f"""SELECT uhid, service_item_name, order_date_time FROM kx_billing_records WHERE service_type = 'Radiology'
              AND order_date_time >= '{a}T00:00:00+05:30' AND order_date_time < '{b}T00:00:00+05:30' AND service_item_name ~* 'CT'"""):
            if is_plain_ct(nm):
                bill[u].append(P(od))
    vl = load("visits_links.json")
    rx_visit = {v["rx"]: (v["route"], v["tier"]) for v in vl if v.get("rx")}
    out = []
    for r in RXA.values():
        ts = r["ts"]; u = uh.get(r["ind"])
        rec = dict(rx=r["rx"], ind=r["ind"], doc=r["doc"], day=str(ist_date(ts)), visit=rx_visit.get(r["rx"]))
        for W in (30, 14):
            lo, hi = ts - timedelta(days=1), ts + timedelta(days=W)
            done_sr = any(st == "COMPLETED" and w and lo <= w <= hi for st, w in sr.get(r["ind"], []))
            prog = any(st in ("REQUESTED", "BOOKED", "PENDING_CHECKIN", "IN_PROGRESS") and w and lo <= w <= hi for st, w in sr.get(r["ind"], []))
            done_bill = bool(u) and any(w and lo <= w <= hi for w in bill.get(u, []))
            rec[f"ev{W}"] = dict(SR_COMPLETED=done_sr, HIS_BILL=done_bill, RAD_DONE=done_sr or done_bill, RAD_IN_PROGRESS=(prog and not (done_sr or done_bill)))
        out.append(rec)
    save("plain_ct_rx.json", out)
    for W, cut in (("30", MATURE_30), ("14", MATURE_14)):
        c = collections.Counter()
        for o in out:
            mat = date.fromisoformat(o["day"]) <= cut
            e = o[f"ev{W}"]
            c[("mature" if mat else "immature", "RAD_DONE" if e["RAD_DONE"] else ("RAD_IN_PROGRESS" if e["RAD_IN_PROGRESS"] else "no record"))] += 1
        print(f"E: {W}-day plain-CT outcome:", dict(sorted(c.items())))
    print("E: done source split (30 d, all Rx): platform SR completed", sum(o["ev30"]["SR_COMPLETED"] for o in out), "| HIS bill", sum(o["ev30"]["HIS_BILL"] for o in out), "| either", sum(o["ev30"]["RAD_DONE"] for o in out), "of", len(out))
    print("E: queue visit for the plain-CT Rx (route, tier):", dict(collections.Counter(str(o["visit"]) for o in out)))
    print(f"E: done  [{time.time()-t:.0f}s]")



# ---------------------------------------------------------------- stage R: RXWIN visits into the frame (P1-PREREG-v2 A4)
RXWIN_DEFAULT = timedelta(minutes=8)


def stage_r():
    """Adds route RXWIN (visit window = the Rx's own [timestamp, updated_at]) for advised Rx and explicit-no Rx that have no queue visit,
    then rebuilds the matched negatives frame counts with KEY and RXWIN reported apart. Seed 24, box files only plus one Rx pull."""
    import random
    t = time.time()
    rows = load("advised_rx_typed.json"); visits = load("visits_links.json"); PSR = load("psr_window.json"); surg = set(load("surgical_docs.json"))
    cta = set(load("cta_rx_uids.json")) if os.path.exists(OUT + "cta_rx_uids.json") else set()
    queue_rx = {v["rx"] for v in visits if v.get("rx")}
    Sset = {r["rx"] for r in rows if r["flag_class"] in ("S_ONLY", "BOTH")}
    no_rx = [u for u, v in PSR.items() if v[2] == "no" and u not in queue_rx and u not in Sset]
    want = {r["rx"] for r in rows if not (r["route_tier"] and r["route_tier"][1] in ("A", "B"))} | set(no_rx)
    RX = {}
    for ch in chunks(want, 150):
        for uid, ind, doc, ts, upd in pull(f"""SELECT uid, _parent_doc_id, doctor_uid, "timestamp", updated_at FROM "individuals-prescriptions" WHERE uid IN ({','.join(map(q, ch))})"""):
            RX[uid] = dict(rx=uid, ind=ind, doc=doc, ts=P(ts), upd=P(upd))
    win = {}
    for u, r in RX.items():
        end = r["upd"] if r["upd"] and r["upd"] > r["ts"] else r["ts"] + RXWIN_DEFAULT
        win[u] = dict(start=str(r["ts"]), end=str(end), minutes=round((end - r["ts"]).total_seconds() / 60, 1), used_default=not (r["upd"] and r["upd"] > r["ts"]))
    save("rxwin.json", win)
    mins = sorted(w["minutes"] for w in win.values())
    print(f"R: RXWIN windows {len(win)}; median {mins[len(mins)//2]} min; p90 {mins[int(len(mins)*.9)]} min; default (no updated_at) {sum(w['used_default'] for w in win.values())}  [{time.time()-t:.0f}s]")
    def klass(ev):
        return "DONE_STRONG" if (ev["NOTE"] or ev["BILL"]) else ("ADM_ONLY" if ev["ADM"] else ("BOOKED_MANUAL_ONLY" if ev["MANUAL_CASE"] else "NONE"))
    def wk(dstr):
        y, w, _ = date.fromisoformat(dstr).isocalendar(); return f"{y}-W{w:02d}"
    out = {}
    for W, cut in (("30", MATURE_30), ("14", MATURE_14)):
        pos, n1 = [], []
        for r in rows:
            if date.fromisoformat(r["day"]) > cut or r["rx"] in cta:
                continue
            rt = r["route_tier"]; route = rt[0] if rt and rt[1] in ("A", "B") else ("RXWIN" if r["rx"] in win else None)
            item = dict(rx=r["rx"], doc=r["doc"], week=wk(r["day"]), flag_class=r["flag_class"], route=route)
            k = klass(r[f"ev{W}"])
            if k == "DONE_STRONG":
                pos.append(item)
            elif k == "NONE" and r["flag_class"] in ("S_ONLY", "BOTH") and r["type_status"] != "REFERRED_OUT_ONLY":
                n1.append(item)
        n2 = []
        for v in visits:
            if v["tier"] in ("A", "B") and v["rx"] and v["doc"] in surg and date.fromisoformat(v["day"]) <= cut:
                p_ = PSR.get(v["rx"])
                if p_ and p_[2] == "no" and v["rx"] not in Sset:
                    n2.append(dict(rx=v["rx"], doc=v["doc"], week=wk(v["day"]), route=v["route"]))
        for u in no_rx:
            r = RX.get(u)
            if r and r["doc"] in surg and ist_date(r["ts"]) <= cut:
                n2.append(dict(rx=u, doc=r["doc"], week=wk(str(ist_date(r["ts"]))), route="RXWIN"))
        pos_v = [x for x in pos if x["route"]]; n1_v = [x for x in n1 if x["route"]]
        by1, by2 = collections.defaultdict(list), collections.defaultdict(list)
        for x in n1_v: by1[(x["doc"], x["week"])].append(x)
        for x in n2: by2[(x["doc"], x["week"])].append(x)
        short1 = short2 = 0
        for x in pos_v:
            short1 += not by1.get((x["doc"], x["week"])); short2 += not by2.get((x["doc"], x["week"]))
        cnt = collections.Counter
        out[W] = dict(candidates_done_strong=len(pos), with_a_visit=len(pos_v), by_route=dict(cnt(x["route"] for x in pos_v)),
                      N1_pool=len(n1), N1_with_a_visit=len(n1_v), N1_by_route=dict(cnt(x["route"] for x in n1_v)),
                      N2_pool_visits=len(n2), N2_by_route=dict(cnt(x["route"] for x in n2)), N2_doctor_weeks=len(by2),
                      candidates_with_no_same_doctor_week_N1=short1, candidates_with_no_same_doctor_week_N2=short2)
    save("REPORT_R.json", out)
    print(json.dumps(out, indent=1))
    print(f"R: done  [{time.time()-t:.0f}s]")


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else ""
    {"A": stage_a, "B": stage_b, "C": stage_c, "D": stage_d, "drift": stage_drift, "F": stage_f, "E": stage_e, "R": stage_r}.get(stage, lambda: sys.exit(__doc__))()
