#!/usr/bin/env python3
"""W52-B: pull Dr Manoj Kumar S's full PQM consult history (Metabase db 13, read-only, SELECT
only). Writes kumars-pqm.json: [[called_at, completed_at, token_uid, cycle_bucket], ...].
Opaque token_uids only; no name, no transcript. Usage: python3 pqm_pull.py <out.json>
"""
import json, os, sys, urllib.request

DOCTOR_UID = "Tbvyk1V5ijpcD194ZOWi"  # Dr Manoj Kumar S; NEVER the name, per vj-refuter #5296/#5297


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "kumars-pqm.json"
    sec = os.path.expanduser("~/.claude/secrets")
    url = open(f"{sec}/metabase_url").read().strip().rstrip("/")
    key = open(f"{sec}/metabase_api_key").read().strip()
    sql = f"""SELECT nullif(qts.called_at,'')::timestamptz AS called_at,
                     nullif(qts.completed_at,'')::timestamptz AS completed_at,
                     qts.token_uid, qts.cycle_bucket
              FROM queue_token_steps qts
              WHERE qts.station = 'CONSULTATION' AND qts.routing->>'DOCTOR_UID' = '{DOCTOR_UID}'
                    AND qts.cycle_bucket BETWEEN '2026-08-01' AND '2026-09-27'"""
    req = urllib.request.Request(f"{url}/api/dataset", method="POST",
                                  headers={"Content-Type": "application/json", "x-api-key": key},
                                  data=json.dumps({"database": 13, "type": "native", "native": {"query": sql}}).encode())
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.load(r)
    rows = res["data"]["rows"]
    json.dump(rows, open(out, "w"))
    print(f"PQM_PULL doctor_uid={DOCTOR_UID} rows={len(rows)} -> {out}")


if __name__ == "__main__":
    main()
