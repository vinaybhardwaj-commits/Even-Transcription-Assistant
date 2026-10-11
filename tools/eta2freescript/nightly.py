"""Nightly FreeScript run. Off unless ETA_FREESCRIPT=1 (unset and 0 both stay off; any other value is an error).

    python -m tools.eta2freescript.nightly plan [--date YYYY-MM-DD] [--data DIR]
    python -m tools.eta2freescript.nightly run  [--date YYYY-MM-DD] [--data DIR] [--dry-run]
    python -m tools.eta2freescript.nightly drain [--data DIR]

``run`` selects the day's consult folders that have a Sarvam transcript.json and an ok role.json, runs the pipeline
on this box (Bedrock Claude via phi_guard) and POSTs each artifact to <app>/api/freescript/ingest. It then drains
queued ``scribe_freescript`` jobs the same way. ``plan`` lists uids and dates only.

No transcript text is printed. Exit 0 disabled / nothing to do / ok, 2 partial, 1 failed.
See NIGHTLY.md.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .store import payload_from_artifact, post_payload, sign_get

IST = timezone(timedelta(hours=5, minutes=30))
_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"", "0", "false", "no", "off"}

DEFAULTS = {
    "enabled": False,
    "data": "",
    "out": "",
    "app_url": "",
    "workers": 2,
    "max_consults": 40,
}


class NightlyError(RuntimeError):
    pass


def flag_enabled(env: dict, config_enabled: bool) -> bool:
    raw = env.get("ETA_FREESCRIPT")
    if raw is None:
        return bool(config_enabled)
    v = raw.strip().lower()
    if v in _TRUTHY:
        return True
    if v in _FALSY:
        return False
    raise NightlyError("ETA_FREESCRIPT has an unrecognised value")


def load_config(path: str | None, env: dict | None = None) -> dict:
    env = os.environ if env is None else env
    cfg = dict(DEFAULTS)
    if path:
        cfg.update(json.loads(Path(path).read_text(encoding="utf-8")))
    if env.get("FREESCRIPT_APP_URL", "").strip():
        cfg["app_url"] = env["FREESCRIPT_APP_URL"].strip()
    if env.get("FREESCRIPT_DATA", "").strip():
        cfg["data"] = env["FREESCRIPT_DATA"].strip()
    cfg["enabled"] = flag_enabled(env, bool(cfg.get("enabled")))
    return cfg


def previous_ist_day(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return (now.astimezone(IST).date() - timedelta(days=1)).isoformat()


def ist_date_of_ms(t0_ms: int) -> str:
    return datetime.fromtimestamp(t0_ms / 1000, tz=timezone.utc).astimezone(IST).date().isoformat()


def _read(path: Path) -> dict | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def consult_eligible(folder: Path, day: str) -> dict | None:
    """A folder counts when it has a Sarvam transcript and an ok role track whose clip starts on ``day``.

    The return value is ids and the clip date only. Segment text is not copied out.
    """
    transcript = _read(folder / "transcript.json")
    role = _read(folder / "role.json")
    if not transcript or not role:
        return None
    if role.get("status") != "ok":
        return None
    segs = role.get("segments")
    if not isinstance(segs, list) or not segs:
        return None
    clip = transcript.get("clip")
    if not isinstance(clip, dict) or not isinstance(clip.get("t0_ms"), (int, float)):
        return None
    ist = ist_date_of_ms(int(clip["t0_ms"]))
    if ist != day:
        return None
    uid = transcript.get("consult_uid") or folder.name
    if not isinstance(uid, str) or not uid:
        return None
    room = clip.get("room_slug") if isinstance(clip.get("room_slug"), str) else None
    meta = _read(folder / "meta.json") or {}
    uid8 = meta.get("doctor_uid8")
    return {
        "uid": uid,
        "ist_date": ist,
        "room_slug": room,
        "doctor_uid8": uid8 if isinstance(uid8, str) and len(uid8) == 8 else None,
        "job_id": None,
    }


def select_day(data: Path, day: str) -> list[dict]:
    if not data.is_dir():
        return []
    found = []
    for folder in sorted(p for p in data.iterdir() if p.is_dir()):
        row = consult_eligible(folder, day)
        if row:
            found.append(row)
    return found


def fetch_pending(app_url: str, secret: str, timeout_s: int = 30) -> list[dict]:
    path = "/api/freescript/pending"
    ts = int(datetime.now(timezone.utc).timestamp())
    req = urllib.request.Request(app_url.rstrip("/") + path, method="GET")
    req.add_header("x-freescript-ts", str(ts))
    req.add_header("x-freescript-signature", sign_get(path, secret, ts))
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        body = json.loads(resp.read().decode())
    jobs = body.get("jobs") if isinstance(body, dict) else None
    return [j for j in jobs if isinstance(j, dict)] if isinstance(jobs, list) else []


def _row_for_uid(uid: str, data: Path, job_id: str | None) -> dict | None:
    folder = data / uid
    transcript = _read(folder / "transcript.json")
    role = _read(folder / "role.json")
    if not transcript or not role or role.get("status") != "ok":
        return None
    segs = role.get("segments")
    if not isinstance(segs, list) or not segs:
        return None
    clip = transcript.get("clip") if isinstance(transcript.get("clip"), dict) else {}
    t0 = clip.get("t0_ms")
    return {
        "uid": uid,
        "ist_date": ist_date_of_ms(int(t0)) if isinstance(t0, (int, float)) else previous_ist_day(),
        "room_slug": clip.get("room_slug") if isinstance(clip.get("room_slug"), str) else None,
        "doctor_uid8": None,
        "job_id": job_id,
    }


def jobs_to_rows(jobs: list[dict], data: Path) -> tuple[list[dict], list[str]]:
    """Pending jobs whose consult folder is on this box. A room+date job expands to that day's folders. Missing ones are counted, not fetched."""
    rows, missing = [], []
    for j in jobs:
        jid = j.get("job_id") if isinstance(j.get("job_id"), str) else None
        uid = j.get("consult_uid")
        if isinstance(uid, str) and uid:
            row = _row_for_uid(uid, data, jid)
            (rows if row else missing).append(row or uid)
            continue
        room, day = j.get("room"), j.get("ist_date")
        if isinstance(room, str) and isinstance(day, str):
            matched = [dict(r, job_id=jid) for r in select_day(data, day) if r.get("room_slug") == room]
            if not matched:
                missing.append(room)
            rows.extend(matched)
    return rows, missing


def _default_run(data: Path, out: Path, uid: str) -> dict:
    from .ingest import load_consult
    from .models import UsageLedger, make_client
    from .phi_guard import assert_phi_safe
    from .pipeline import Options, run_consult
    client = make_client("bedrock", UsageLedger(out / "usage.jsonl"), None)
    assert_phi_safe(*client.resolve("sonnet"))
    c = load_consult(data, uid)
    return run_consult(c, client, out, Options())


def execute(rows: list[dict], cfg: dict, *, dry_run: bool, run_one, post) -> dict:
    """Run and post. ``run_one(uid) -> pipeline log``. ``post(payload) -> response``. Prints counts only."""
    cap = int(cfg.get("max_consults") or 40)
    chosen, overflow = rows[:cap], rows[cap:]
    posted, failed, skipped = 0, 0, len(overflow)
    if dry_run:
        for r in chosen:
            print(r["uid"], r.get("ist_date"), "dry-run")
        return {"dry_run": True, "n": len(chosen), "skipped": skipped, "posted": 0, "failed": 0}
    data, out = Path(cfg["data"]), Path(cfg.get("out") or str(Path(cfg["data"]) / "_eta2freescript"))
    out.mkdir(parents=True, exist_ok=True)
    for r in chosen:
        try:
            log = (run_one or (lambda uid: _default_run(data, out, uid)))(r["uid"])
        except Exception as e:
            failed += 1
            print(r["uid"], "ERROR", type(e).__name__, flush=True)
            continue
        art = log.get("artifact") if isinstance(log, dict) else None
        if not isinstance(art, dict) or not log.get("final_valid"):
            failed += 1
            print(r["uid"], "not-valid", flush=True)
            continue
        body = payload_from_artifact(
            art, errors=log.get("final_errors") or [], cost_usd=None, job_id=r.get("job_id"),
            room_slug=r.get("room_slug"), ist_date=r.get("ist_date"), doctor_uid8=r.get("doctor_uid8"),
        )
        try:
            res = post(body)
        except Exception as e:
            failed += 1
            print(r["uid"], "POST", type(e).__name__, flush=True)
            continue
        posted += 1 if isinstance(res, dict) and res.get("ok") else 0
        failed += 0 if isinstance(res, dict) and res.get("ok") else 1
        print(r["uid"], "posted" if isinstance(res, dict) and res.get("ok") else "post-rejected",
              "inserted=" + str((res or {}).get("inserted")), flush=True)
    return {"dry_run": False, "n": len(chosen), "skipped": skipped, "posted": posted, "failed": failed}


def _post_factory(cfg: dict, secret: str):
    url = cfg["app_url"].rstrip("/") + "/api/freescript/ingest"

    def post(payload: dict) -> dict:
        return post_payload(payload, url, secret)

    return post


def run(cfg: dict, day: str, *, dry_run: bool = False, run_one=None, post=None, pending=None) -> int:
    if not cfg.get("enabled"):
        print("disabled")
        return 0
    data = Path(cfg["data"]) if cfg.get("data") else None
    if data is None:
        print("no data dir")
        return 1
    rows = select_day(data, day)
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    missing: list[str] = []
    if cfg.get("app_url") and secret and pending is not False:
        try:
            jobs = pending(cfg["app_url"], secret) if pending else fetch_pending(cfg["app_url"], secret)
            extra, missing = jobs_to_rows(jobs, data)
        except Exception as e:
            print("pending", type(e).__name__)
            extra = []
        have = {r["uid"] for r in rows}
        for r in extra:
            if r["uid"] not in have:
                rows.append(r)
    if not rows and not missing:
        print("nothing", day)
        return 0
    sender = post or (_post_factory(cfg, secret) if (not dry_run and secret and cfg.get("app_url")) else None)
    if sender is None and not dry_run:
        print("no ingest target")
        return 1
    summary = execute(rows, cfg, dry_run=dry_run, run_one=run_one, post=sender or (lambda _p: {"ok": True, "inserted": 0}))
    summary["missing"] = len(missing)
    print(json.dumps({k: summary[k] for k in ("dry_run", "n", "posted", "failed", "skipped", "missing")}))
    if summary["failed"] or missing:
        return 1 if summary["posted"] == 0 and not dry_run else 2
    if summary["skipped"]:
        return 2
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m tools.eta2freescript.nightly")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "run", "drain"):
        s = sub.add_parser(name)
        s.add_argument("--date")
        s.add_argument("--data", type=Path)
        s.add_argument("--config")
        s.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    cfg = load_config(a.config)
    if a.data:
        cfg["data"] = str(a.data)
    day = a.date or previous_ist_day()
    if a.cmd == "plan":
        if not cfg.get("data"):
            print("no data dir")
            return 1
        rows = select_day(Path(cfg["data"]), day)
        for r in rows:
            print(r["uid"], r["ist_date"])
        print(json.dumps({"n": len(rows), "date": day}))
        return 0
    if a.cmd == "drain":
        return _drain(cfg, a.dry_run)
    return run(cfg, day, dry_run=a.dry_run)


def _drain(cfg: dict, dry_run: bool) -> int:
    """Pending jobs only (no day scan)."""
    if not cfg.get("enabled"):
        print("disabled")
        return 0
    data = Path(cfg["data"]) if cfg.get("data") else None
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    if not data or not cfg.get("app_url") or not secret:
        print("no ingest target")
        return 1
    jobs = fetch_pending(cfg["app_url"], secret)
    rows, missing = jobs_to_rows(jobs, data)
    summary = execute(rows, cfg, dry_run=dry_run, run_one=None, post=None if dry_run else _post_factory(cfg, secret))
    summary["missing"] = len(missing)
    print(json.dumps({k: summary[k] for k in ("dry_run", "n", "posted", "failed", "skipped") if k in summary} | {"missing": len(missing)}))
    if summary.get("failed") or missing:
        return 1 if summary.get("posted", 0) == 0 and not dry_run else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
