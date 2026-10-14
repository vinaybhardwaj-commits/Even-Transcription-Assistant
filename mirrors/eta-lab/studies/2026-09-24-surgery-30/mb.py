"""Read-only Metabase helper (db 13). Key from ~/.claude/secrets/metabase_api_key, never printed.
Refuses anything that is not a single SELECT/WITH. Errors print status only (a body can echo the query)."""
import json, os, re, urllib.request
_HOME = os.path.expanduser("~")
_URL = open(f"{_HOME}/.claude/secrets/metabase_url").read().strip().rstrip("/")
_KEY = open(f"{_HOME}/.claude/secrets/metabase_api_key").read().strip()
_BLOCK = re.compile(r"\b(insert|update|delete|drop|alter|truncate|grant|create|copy|into|call|execute|pg_terminate_backend|pg_cancel_backend|set_config|lo_import|lo_export|dblink)\b", re.I)

def query(sql, database=13):
    s = sql.strip().rstrip(";")
    if not re.match(r"^(select|with)\b", s, re.I) or ";" in s or _BLOCK.search(s):
        raise SystemExit("mb: only a single plain SELECT/WITH is allowed")
    req = urllib.request.Request(f"{_URL}/api/dataset", method="POST",
        data=json.dumps({"database": database, "type": "native", "native": {"query": s}}).encode(),
        headers={"Content-Type": "application/json", "x-api-key": _KEY})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.load(r)
    except Exception as e:
        raise SystemExit(f"mb: http {type(e).__name__} {getattr(e, 'code', '')}")
    if res.get("error") or res.get("status") == "failed":
        raise SystemExit("mb: query failed (message withheld: it can echo the query)")
    cols = [c["name"] for c in res["data"]["cols"]]
    rows = res["data"]["rows"]
    return cols, rows, bool(res["data"].get("rows_truncated"))
