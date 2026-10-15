"""Posts a run + items to the ETA API. Off by default: needs STEWARD_POST=1, STEWARD_API_BASE and ENC_STEWARD_TOKEN."""
from __future__ import annotations
import json
import os
import urllib.request


def enabled() -> bool:
    return os.environ.get("STEWARD_POST") == "1" and bool(os.environ.get("ENC_STEWARD_TOKEN")) \
        and bool(os.environ.get("STEWARD_API_BASE"))


def _post(path: str, body: dict, opener=urllib.request.urlopen) -> int:
    base = os.environ["STEWARD_API_BASE"].rstrip("/")
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + os.environ["ENC_STEWARD_TOKEN"]})
    with opener(req, timeout=30) as r:
        return r.status


def post_run(doc: dict, opener=urllib.request.urlopen) -> dict:
    if not enabled():
        return {"posted": False, "reason": "off"}
    s1 = _post("/api/admin/steward/run", doc["run"], opener)
    s2 = _post("/api/admin/steward/items", {"run_id": doc["run"]["id"], "items": doc["items"]}, opener)
    return {"posted": True, "status": [s1, s2]}
