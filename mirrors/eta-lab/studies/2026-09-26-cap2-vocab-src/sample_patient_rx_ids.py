"""W27.2 (linker): opaque rx ids (same sha1[:12] of presc_uid as rx_history.jsonl) of the prescriptions of the 24 CAP-1 sample patients,
26 Jun-24 Sep 2026 IST, non-draft, for cap's patient-level leakage exclusion (PRIMARY vocab). Ids only: no patient id, no text leaves.
Patients: patient_uid of the 24 linked (confirmed+probable) consults in ~/eta-data/cap/2026-09-25/links.jsonl via encounter-truth/rows.csv.
Out: ~/eta-data/cap2/sample_patient_rx_ids.txt (0640, one id per line, sorted) and prints counts."""
import csv, datetime, hashlib, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-surgery-30"))
import mb
H = os.path.expanduser("~/eta-data/")
linked = {l["consult_id"] for l in map(json.loads, open(H + "cap/2026-09-25/links.jsonl")) if l["status"] in ("confirmed", "probable")}
pats = sorted({r["patient_uid"] for r in csv.DictReader(open(H + "encounter-truth/rows.csv")) if r["day"] == "2026-09-25" and r["token_uid"] in linked and r["patient_uid"]})
ids, per = set(), []
for i in range(0, len(pats), 12):
    part = ",".join("'" + p.replace("'", "") + "'" for p in pats[i:i + 12])
    cols, rows, trunc = mb.query("SELECT presc_uid, timestamp, individual_uid FROM dpipe_prescription_pipeline WHERE presc_is_draft IS NOT TRUE "
                                 f"AND individual_uid IN ({part}) AND timestamp >= '2026-06-26T00:00:00+05:30' AND timestamp < '2026-09-25T00:00:00+05:30'")
    assert not trunc and len(rows) < 1900
    for u, t, ind in rows:
        ids.add(hashlib.sha1(str(u).encode()).hexdigest()[:12]); per.append(ind)
out = H + "cap2/sample_patient_rx_ids.txt"
open(out, "w").write("".join(i + "\n" for i in sorted(ids))); os.chmod(out, 0o640)
print("linked consults", len(linked), "patients", len(pats), "patients with rx", len(set(per)), "rx ids", len(ids))
