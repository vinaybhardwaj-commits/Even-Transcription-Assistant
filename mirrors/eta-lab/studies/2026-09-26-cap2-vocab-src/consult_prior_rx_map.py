"""W53-CAP3 (linker, per cap #5388): consult_id -> [subset of the 65-id sample_patient_rx_ids.txt set that
is THIS patient's own prior Rx], for the PRIOR arm. Same source/hash/query as sample_patient_rx_ids.py
(W27.2) - reused byte-for-byte, just grouped per patient this time instead of flattened into one set.
Ids only: no patient id, no text leaves. Out: ~/eta-data/cap2/consult_prior_rx_map.json (0640).
"""
import csv, hashlib, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-surgery-30"))
import mb

H = os.path.expanduser("~/eta-data/")
linked = {l["consult_id"]: l for l in map(json.loads, open(H + "cap/2026-09-25/links.jsonl")) if l["status"] in ("confirmed", "probable")}
rows_csv = [r for r in csv.DictReader(open(H + "encounter-truth/rows.csv")) if r["day"] == "2026-09-25" and r["token_uid"] in linked and r["patient_uid"]]
consult_by_pat = {r["patient_uid"]: r["token_uid"] for r in rows_csv}   # 1 consult per patient in this 24-sample (CAP-1's own de-dup)
pats = sorted(consult_by_pat)

by_pat_ids = {}
for i in range(0, len(pats), 12):
    part = ",".join("'" + p.replace("'", "") + "'" for p in pats[i:i + 12])
    cols, rows, trunc = mb.query("SELECT presc_uid, timestamp, individual_uid FROM dpipe_prescription_pipeline WHERE presc_is_draft IS NOT TRUE "
                                 f"AND individual_uid IN ({part}) AND timestamp >= '2026-06-26T00:00:00+05:30' AND timestamp < '2026-09-25T00:00:00+05:30'")
    assert not trunc and len(rows) < 1900
    for u, t, ind in rows:
        by_pat_ids.setdefault(ind, set()).add(hashlib.sha1(str(u).encode()).hexdigest()[:12])

master = set(open(H + "cap2/sample_patient_rx_ids.txt").read().split())
mapping = {consult_by_pat[pat]: sorted(ids) for pat, ids in by_pat_ids.items()}
union = {i for ids in mapping.values() for i in ids}
no_prior = [c for p, c in consult_by_pat.items() if p not in by_pat_ids]

out = H + "cap2/consult_prior_rx_map.json"
json.dump(mapping, open(out, "w"), indent=1, sort_keys=True)
os.chmod(out, 0o640)
print(json.dumps(dict(consults=len(pats), consults_with_prior_rx=len(mapping), consults_no_prior_rx=len(no_prior),
                       union_size=len(union), master_set_size=len(master), union_subset_of_master=union <= master,
                       master_minus_union=len(master - union))))
