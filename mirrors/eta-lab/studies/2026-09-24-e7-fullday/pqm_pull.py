"""PQM consult pull for one IST date: Metabase database 13 (queue_token_steps x queue_tokens), the query in
orders/E7-PQM-TRUTH.md, date by the CALL time's IST date (Fable's ruling), not cycle_bucket.

Usage: pqm_pull.py <YYYY-MM-DD> <out.csv>     env: METABASE_URL, METABASE_API_KEY (never printed)
Writes the same columns as ~/eta-data/pqm-consults-23sep.csv. Prints counts only.
INFERRED (not run against db 13 from this box yet): the Metabase REST form POST /api/dataset with an
x-api-key header, the 2000-row cap on ad-hoc results, and the column types. It fails loudly on each.
"""
import csv, json, os, sys, urllib.request
from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
day = sys.argv[1]; out = sys.argv[2]
d = date.fromisoformat(day)
buckets = [(d + timedelta(days=k)).isoformat() for k in (-1, 0, 1)]  # a step can complete a day later
SQL = f"""
SELECT qts.token_uid,
       qts.routing->>'DOCTOR_UID'   AS doctor_uid,
       qts.metadata->>'DOCTOR_NAME' AS doctor_name,
       qt.created_at                AS token_created_at,
       nullif(qts.called_at,'')::timestamptz    AS called_at,
       nullif(qts.completed_at,'')::timestamptz AS completed_at,
       qts.cycle_bucket
FROM queue_token_steps qts
JOIN queue_tokens qt ON qt.uid = qts.token_uid
WHERE qts.station = 'CONSULTATION'
  AND qts.cycle_bucket IN ('{buckets[0]}', '{buckets[1]}', '{buckets[2]}')
ORDER BY 2, 5
"""
url = os.environ.get("METABASE_URL", "").rstrip("/"); key = os.environ.get("METABASE_API_KEY", "")
if not url or not key:
    print("STAGE_FAIL pqm missing METABASE_URL or METABASE_API_KEY"); sys.exit(4)
req = urllib.request.Request(f"{url}/api/dataset", method="POST",
    data=json.dumps({"database": 13, "type": "native", "native": {"query": SQL}}).encode(),
    headers={"Content-Type": "application/json", "x-api-key": key})
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.load(r)
except Exception as e:  # the body is not printed: it can echo the query
    print(f"STAGE_FAIL pqm http {type(e).__name__} {getattr(e, 'code', '')}"); sys.exit(5)
if res.get("status") not in (None, "completed") or "data" not in res:
    print(f"STAGE_FAIL pqm status={res.get('status')} error_present={bool(res.get('error'))}"); sys.exit(5)
cols = [c["name"] for c in res["data"]["cols"]]
rows = [dict(zip(cols, r)) for r in res["data"]["rows"]]
if len(rows) >= 2000:
    print(f"STAGE_FAIL pqm rows={len(rows)} hit the ad-hoc cap; results would be truncated"); sys.exit(6)
want = ["token_uid", "doctor_uid", "doctor_name", "token_created_at", "called_at", "completed_at", "cycle_bucket"]
missing = [c for c in want if c not in cols]
if missing:
    print(f"STAGE_FAIL pqm missing columns {missing}"); sys.exit(6)

def ist(v):
    if not v: return ""
    t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if t.tzinfo is None:
        print("STAGE_FAIL pqm naive timestamp from db 13; refusing to guess its zone"); sys.exit(6)
    return t.astimezone(IST).isoformat()

kept = 0
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=want); w.writeheader()
    for r in rows:
        rec = {c: r.get(c) or "" for c in want}
        for c in ("token_created_at", "called_at", "completed_at"): rec[c] = ist(rec[c])
        if rec["called_at"][:10] != day: continue
        w.writerow(rec); kept += 1
print(f"PQM_DONE fetched={len(rows)} called_on_{day}={kept}")
