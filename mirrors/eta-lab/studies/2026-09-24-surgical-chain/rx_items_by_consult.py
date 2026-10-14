"""Calendar-event uid (= Rx.consult_uid) -> Rx items (drugs / doses / tests / referrals / advice).
Read-only Metabase db 13 via studies/2026-09-24-surgery-30/mb.py (single SELECT only, key never printed).
Owner: mb-rx (voice-linkage ruling 183). No patient data in this file; OUTPUT holds PHI, so it is refused unless written under ~/eta-data/.

  python3 rx_items_by_consult.py IN.txt ~/eta-data/voice-linkage/rx_items.json [--since 2026-08-01]
IN.txt = one calendar event uid per line (the consult_uid of the matched consult).
Importable: rx_items(consult_uids, since) -> {consult_uid: [rx, ...]}.

Join: individuals-prescriptions.consult_uid = accounts-members-calendar_events.uid  (300/300 sampled)
      child tables join on child._parent_id = individuals-prescriptions.uid
Notes:
 - Several Rx can share a consult_uid (a dietician / physio Rx, drafts, follow-ups): keep `type_of_prescription` and
   `is_draft`; the doctor's consult Rx is GENERAL_PRACTITIONER or HOSPITAL_GP.
 - Rx.timestamp = consult START, Rx.updated_at = last save (~ consult end), so [timestamp, updated_at] is the Rx-editing window.
 - Metabase caps a result at 2,000 rows: chunks are sized to stay under it.
"""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-surgery-30"))
import mb

_OK = re.compile(r"[A-Za-z0-9_\-]+")
CONSULT_TYPES = ("GENERAL_PRACTITIONER", "HOSPITAL_GP")


def _in(vals):
    vals = [v for v in vals if v and _OK.fullmatch(v)]
    return ",".join(f"'{v}'" for v in vals)


def _rows(sql):
    cols, rows, trunc = mb.query(sql)
    if trunc:
        raise SystemExit("mb: rows_truncated (2,000 cap): use a smaller chunk")
    return [dict(zip(cols, r)) for r in rows]


def rx_items(consult_uids, since="2026-08-01", consult_types_only=True):
    """consult_uid -> list of Rx dicts, each with meds / tests / referrals / advice."""
    out = {u: [] for u in consult_uids}
    uids = sorted({u for u in consult_uids if u and _OK.fullmatch(u)})
    rx_all = []
    for i in range(0, len(uids), 200):
        tcond = f"and type_of_prescription in ({_in(CONSULT_TYPES)})" if consult_types_only else ""
        rx_all += _rows(f"""select uid, consult_uid, _parent_id as patient_uid, doctor_uid, type_of_prescription, is_draft,
            "timestamp" as rx_start, updated_at as rx_updated_at
          from "individuals-prescriptions"
          where "timestamp" >= '{since}' and consult_uid in ({_in(uids[i:i+200])}) {tcond}""")
    by_rx = {r["uid"]: dict(r, meds=[], tests=[], referrals=[], advice=[]) for r in rx_all}
    rxu = sorted(by_rx)
    for i in range(0, len(rxu), 60):   # 60 Rx x ~3 drugs stays well under 2,000 rows
        chunk = _in(rxu[i:i+60])
        for m in _rows(f"""select _parent_id rx, brand_name, generic_name, strength, dosage, frequency, duration,
              route_of_administration as route, instruction_to_patient as instruction
            from "individuals-prescriptions__medications" where _parent_id in ({chunk})"""):
            by_rx[m.pop("rx")]["meds"].append(m)
        for t in _rows(f"""select _parent_id rx, investigation__uid as inv_uid, investigation__name as name, investigation__type as type,
              instruction, urgent, fasting, included_tests, not_recommended
            from "individuals-prescriptions__further_investigation" where _parent_id in ({chunk})"""):
            by_rx[t.pop("rx")]["tests"].append(t)
        for t in _rows(f"""select _parent_id rx, specialist_type__name as specialist, specialist_type__is_in_house as in_house, notes
            from "individuals-prescriptions__refer_to" where _parent_id in ({chunk})"""):
            by_rx[t.pop("rx")]["referrals"].append(t)
        for t in _rows(f"""select _parent_id rx, general_advice as text
            from "individuals-prescriptions__structured_general_advice" where _parent_id in ({chunk})"""):
            by_rx[t.pop("rx")]["advice"].append(t)
    for r in by_rx.values():
        out.setdefault(r["consult_uid"], []).append(r)
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    since = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else "2026-08-01"
    if len(args) < 2:
        raise SystemExit(__doc__)
    inp, outp = args[0], os.path.expanduser(args[1])
    home_data = os.path.expanduser("~/eta-data/")
    if not os.path.abspath(outp).startswith(home_data):
        raise SystemExit("refusing to write PHI outside ~/eta-data/")
    uids = [l.strip() for l in open(os.path.expanduser(inp)) if l.strip()]
    res = rx_items(uids, since)
    os.makedirs(os.path.dirname(os.path.abspath(outp)), exist_ok=True)
    json.dump(res, open(outp, "w"), default=str)
    os.chmod(outp, 0o600)
    n_rx = sum(len(v) for v in res.values())
    print(f"consults {len(uids)}; with an Rx {sum(1 for v in res.values() if v)}; Rx {n_rx}; "
          f"with >=1 drug {sum(1 for v in res.values() for r in v if r['meds'])}; "
          f"with >=1 test {sum(1 for v in res.values() for r in v if r['tests'])}")
