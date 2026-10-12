"""Post one eta2freescript artifact to the app. No database credential, no transcript text.

``python -m tools.eta2freescript.store post --artifact FILE --url https://<app>/api/freescript/ingest``

HMAC matches lib/freescript/auth.ts: header ``x-freescript-signature`` = hex HMAC-SHA256(secret, ``f"{ts}.{body}"``),
secret ``FREESCRIPT_INGEST_SECRET``.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.request
from typing import Any

PAYLOAD_VERSION = "freescript-store-v1"
_DROP = {
    "segments", "english_segments", "native_segments", "transcript_text", "audio", "audio_path", "clip_url",
    "r2_key", "presigned_url", "patient_name", "patient_label",
}
_TRANSCRIPT_KEEP = ("segment_count", "diarised", "english_source", "speaker_source", "role_track")


def sign(body: str, secret: str, ts: int) -> str:
    return hmac.new(secret.encode(), f"{ts}.".encode() + body.encode(), hashlib.sha256).hexdigest()


def sign_get(path_and_query: str, secret: str, ts: int) -> str:
    return hmac.new(secret.encode(), f"{ts}.GET {path_and_query}".encode(), hashlib.sha256).hexdigest()


def redact(obj: Any) -> Any:
    """Drop transcript-shaped keys. The rendered note and provenance labels stay."""
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    if not isinstance(obj, dict):
        return obj
    out = {}
    for k, v in obj.items():
        if k in _DROP:
            continue
        out[k] = redact(v)
    tr = out.get("transcript")
    if isinstance(tr, dict):
        out["transcript"] = {k: tr[k] for k in _TRANSCRIPT_KEEP if k in tr}
    return out


def _sha(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def _clip_errors(errors: list) -> list[str]:
    out = []
    for e in errors or []:
        s = str(e).replace("\n", " ")
        if s:
            out.append(s[:240])
        if len(out) == 30:
            break
    return out


def payload_from_artifact(art: dict, *, errors: list | None = None, cost_usd: float | None = None,
                          job_id: str | None = None, room_slug: str | None = None, room_id: str | None = None,
                          ist_date: str | None = None, doctor_uid8: str | None = None) -> dict:
    """The ingest body. ``errors`` empty means the validator passed."""
    red = redact(art)
    link = red.get("pulse_link") if isinstance(red.get("pulse_link"), dict) else {}
    enc = red.get("encounter") if isinstance(red.get("encounter"), dict) else {}
    gen = red.get("generator") if isinstance(red.get("generator"), dict) else {}
    uid = link.get("consult_uid") or enc.get("eta_encounter_id")
    rx = link.get("prescription_uid")
    if not isinstance(rx, str) or not rx:
        rx = None
    uid8 = doctor_uid8 if isinstance(doctor_uid8, str) and len(doctor_uid8) == 8 else None
    errs = _clip_errors(list(errors or []))
    body = {
        "version": PAYLOAD_VERSION,
        "consult_uid": uid,
        "prescription_uid": rx,
        "schema_version": red.get("schema_version"),
        "room_slug": room_slug or enc.get("room"),
        "room_id": room_id,
        "ist_date": ist_date,
        "doctor_uid8": uid8,
        "artifact": red,
        "completion_required": red.get("completion_required") or [],
        "validator": {"ok": not errs, "errors": errs},
        "generator": {
            "code_sha256": gen.get("code_sha256"),
            "prompt_sha256": gen.get("prompt_sha256"),
            "model": gen.get("model"),
        },
        "cost_usd": cost_usd,
        "input_sha256": _sha(red),
        "job_id": job_id,
    }
    return {k: v for k, v in body.items() if v is not None}


def post_payload(payload: dict, url: str, secret: str, timeout_s: int = 60) -> dict:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    ts = int(time.time())
    req = urllib.request.Request(url, data=raw.encode(), method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-freescript-ts", str(ts))
    req.add_header("x-freescript-signature", sign(raw, secret, ts))
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode())


def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="python -m tools.eta2freescript.store")
    sub = p.add_subparsers(dest="cmd", required=True)
    post = sub.add_parser("post")
    post.add_argument("--artifact", required=True)
    post.add_argument("--url", required=True)
    post.add_argument("--ist-date", required=True)
    post.add_argument("--job-id")
    a = p.parse_args(argv)
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    if not secret:
        print("FREESCRIPT_INGEST_SECRET is unset")
        return 2
    art = json.loads(open(a.artifact, encoding="utf-8").read())
    body = payload_from_artifact(art, ist_date=a.ist_date, job_id=a.job_id)
    out = post_payload(body, a.url, secret)
    print(json.dumps({"ok": out.get("ok"), "run_id": out.get("run_id"), "inserted": out.get("inserted")}))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
