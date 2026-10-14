#!/usr/bin/env python3
"""vj-link step 3 input (box, Metabase read-only): every consult-type Rx of an IST date with its drugs and tests, via mb-rx's join (rx_items_by_consult.rx_items:
Rx.consult_uid = calendar event uid, children on _parent_id = Rx uid). The Rx list itself is taken by date and time (Rx.timestamp = consult start to ~1 s, mb-rx section 4), so a consult
is found without the queue token. Output ~/eta-data/voice-linkage/pilot/rx-<date>.json (0600, PHI: drugs per patient consult; never in git). Console: counts only.
Usage: rx_pull.py 2026-09-22"""
import json, os, sys
from datetime import datetime
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgical-chain"))   # mb-rx's helper (imports surgery-30/mb.py)
import rx_items_by_consult as R
mb = R.mb

def ts(v):
    v = str(v).strip()
    for f in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S.%f %z"):
        try: return datetime.strptime(v, f)
        except ValueError: pass
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


date = sys.argv[1]
d0, d1 = f"{date} 00:00:00+05:30", f"{date} 23:59:59+05:30"
rows = R._rows(f"""select uid, consult_uid, doctor_uid, type_of_prescription, is_draft, "timestamp" as rx_start, updated_at as rx_updated_at
   from "individuals-prescriptions"
   where "timestamp"::timestamptz >= '{d0}'::timestamptz and "timestamp"::timestamptz <= '{d1}'::timestamptz
     and type_of_prescription in ('GENERAL_PRACTITIONER','HOSPITAL_GP')""")
uids = sorted({r["consult_uid"] for r in rows if r["consult_uid"]})
items = R.rx_items(uids, since=f"{date[:8]}01", consult_types_only=True)
out = []
for cu, rxs in items.items():
    for rx in rxs:
        if not rx["rx_start"]: continue
        st = ts(rx["rx_start"]); en = ts(rx["rx_updated_at"]) if rx.get("rx_updated_at") else None
        out.append({"rx_uid": rx["uid"], "consult_uid": cu, "doctor_uid": rx["doctor_uid"], "is_draft": rx["is_draft"],
                    "start_ms": int(st.timestamp() * 1000), "end_ms": int(en.timestamp() * 1000) if en else None,
                    "meds": [{k: m.get(k) for k in ("brand_name", "generic_name", "strength", "dosage", "frequency", "duration")} for m in rx["meds"]],
                    "tests": [{"name": t.get("name"), "type": t.get("type")} for t in rx["tests"]],
                    "referrals": [r.get("specialist") for r in rx["referrals"]]})
p = os.path.expanduser(f"~/eta-data/voice-linkage/pilot/rx-{date}.json")
json.dump(out, open(p, "w")); os.chmod(p, 0o600)
n_m = sum(len(r["meds"]) for r in out); n_t = sum(len(r["tests"]) for r in out)
print(f"RX_DONE {date} rx={len(out)} doctors={len({r['doctor_uid'] for r in out})} with_meds={sum(1 for r in out if r['meds'])} med_rows={n_m} test_rows={n_t} with_end={sum(1 for r in out if r['end_ms'])}")
