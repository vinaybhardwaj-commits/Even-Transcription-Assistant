"""Nightly FreeScript run. On unless ETA_FREESCRIPT is 0 (unset stays on; any other value is an error).

    python -m tools.eta2freescript.nightly plan [--date YYYY-MM-DD] [--data DIR]
    python -m tools.eta2freescript.nightly run  [--date YYYY-MM-DD] [--data DIR] [--dry-run]
    python -m tools.eta2freescript.nightly drain [--data DIR]

``run`` selects the day's consult folders that have a Sarvam transcript.json and an ok role.json, runs the pipeline
on this box (Bedrock Claude via phi_guard) and POSTs each artifact to <app>/api/freescript/ingest. It then drains
queued ``scribe_freescript`` jobs the same way. ``plan`` lists uids and dates only.

Bundle mode (FREESCRIPT_BUNDLE_CMD set): no folders. Each sealed or pending uid is read from a palimpsest consult bundle
that FREESCRIPT_BUNDLE_CMD writes into a temporary directory; /api/reb/roles is not called. See NIGHTLY.md.

No transcript text is printed. Exit 0 disabled / nothing to do / ok, 2 partial, 1 failed.
See NIGHTLY.md.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .store import payload_from_artifact, post_payload, sign_get

IST = timezone(timedelta(hours=5, minutes=30))
_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"", "0", "false", "no", "off"}

DEFAULTS = {
    "enabled": True,
    "data": "",
    "out": "",
    "app_url": "",
    "workers": 2,
    "max_consults": 40,
}


class NightlyError(RuntimeError):
    pass


BUNDLE_TIMEOUT_S = 120
_STDERR_CAP = 500
_SAFE_UID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def parse_bundle_config(env: dict) -> tuple[list[str], str] | None:
    """FREESCRIPT_BUNDLE_CMD (JSON argv template with {uid} and {out}) + FREESCRIPT_BUNDLE_CWD. None when bundle mode is off.

    A bad template or a missing cwd is a config error: never a quiet fall back to folders.
    """
    raw = env.get("FREESCRIPT_BUNDLE_CMD")
    if raw is None or not raw.strip():
        return None
    try:
        cmd = json.loads(raw)
    except json.JSONDecodeError:
        raise NightlyError("FREESCRIPT_BUNDLE_CMD is not valid JSON") from None
    if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
        raise NightlyError("FREESCRIPT_BUNDLE_CMD must be a JSON array of strings")
    for ph in ("{uid}", "{out}"):
        if not any(ph in a for a in cmd):
            raise NightlyError(f"FREESCRIPT_BUNDLE_CMD has no {ph} placeholder")
    cwd = (env.get("FREESCRIPT_BUNDLE_CWD") or "").strip()
    if not cwd:
        raise NightlyError("FREESCRIPT_BUNDLE_CMD is set but FREESCRIPT_BUNDLE_CWD is not")
    if not Path(cwd).is_dir():
        raise NightlyError("FREESCRIPT_BUNDLE_CWD is not a directory")
    return cmd, cwd


def flag_enabled(env: dict, config_enabled: bool = True) -> bool:
    """Unset is on. 0/false/no/off is the kill switch and beats a config that says on.

    1/true/yes/on beats a config that says off. When the env var is absent, ``config_enabled``
    is used; the nightly default for that is on.
    """
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
    b = parse_bundle_config(env)
    if b:
        cfg["bundle_cmd"], cfg["bundle_cwd"] = b
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


def _role_without_text(doc: dict) -> dict:
    """role.json the pipeline can join. Segment text is dropped before the file is written."""
    segs = []
    for s in doc.get("segments") or []:
        if not isinstance(s, dict):
            continue
        segs.append({k: s[k] for k in ("t0_ms", "t1_ms", "speaker", "role") if k in s})
    out = {k: doc[k] for k in ("layer", "engine", "status", "config_hash", "extras") if k in doc}
    out.setdefault("layer", "role")
    out.setdefault("engine", "llm-roles")
    out.setdefault("status", "ok")
    out["segments"] = segs
    return out


def include_sealed(data: Path, day: str, uids: list[str], role_for=None) -> tuple[list[dict], list[str]]:
    """Every sealed consult whose folder has a transcript. A missing role.json may be filled from role_for.

    role_for(uid) -> a role track dict, or None. Returns (rows, missing uids). Ids only; no segment text.
    """
    from .ingest import valid_role_doc
    rows = select_day(data, day)
    have = {r["uid"] for r in rows}
    missing: list[str] = []
    for uid in uids:
        if not isinstance(uid, str) or not uid or uid in have:
            continue
        folder = data / uid
        role_path = folder / "role.json"
        if role_for and not role_path.exists():
            doc = role_for(uid)
            if isinstance(doc, dict) and valid_role_doc(_role_without_text(doc)):
                folder.mkdir(parents=True, exist_ok=True)
                role_path.write_text(json.dumps(_role_without_text(doc)), encoding="utf-8")
        row = consult_eligible(folder, day) if folder.is_dir() else None
        if row:
            rows.append(row)
            have.add(uid)
        else:
            missing.append(uid)
    return rows, missing


def fetch_sealed_uids(app_url: str, token: str, day: str, timeout_s: int = 30) -> list[str]:
    """GET /api/sarvam/consult-results?ist_date=&sealed=1. Bearer REB_INDEX_READ_TOKEN. Uids only."""
    path = f"/api/sarvam/consult-results?ist_date={day}&sealed=1"
    req = urllib.request.Request(app_url.rstrip("/") + path, method="GET")
    req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        body = json.loads(resp.read().decode())
    rows = body.get("rows") if isinstance(body, dict) else None
    out = []
    if isinstance(rows, list):
        for r in rows:
            uid = r.get("consult_uid") if isinstance(r, dict) else None
            if isinstance(uid, str) and uid:
                out.append(uid)
    return out


def role_doc_from_feed(row: dict) -> dict | None:
    """A /api/reb/roles row -> role.json. Flags become extras. Text is not copied."""
    segs = row.get("segments")
    if not isinstance(segs, list) or not segs:
        return None
    flags = row.get("flags") if isinstance(row.get("flags"), dict) else {}
    extras: dict = {}
    if isinstance(flags.get("attender_present"), bool):
        extras["attender_present"] = flags["attender_present"]
    if isinstance(flags.get("two_consults"), bool):
        extras["two_consults"] = {"flag": flags["two_consults"]}
    if isinstance(flags.get("diar_partial"), bool):
        extras["diar_partial"] = flags["diar_partial"]
    return _role_without_text({
        "layer": "role", "engine": "llm-roles", "status": "ok",
        "config_hash": row.get("config_hash"), "segments": segs, "extras": extras,
    })


def fetch_role_doc(app_url: str, token: str, uid: str, timeout_s: int = 30) -> dict | None:
    path = f"/api/reb/roles?consult_uid={uid}"
    req = urllib.request.Request(app_url.rstrip("/") + path, method="GET")
    req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        body = json.loads(resp.read().decode())
    rows = body.get("rows") if isinstance(body, dict) else None
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return None
    return role_doc_from_feed(rows[0])


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


def fetch_bundle(cmd: list[str], cwd: str, uid: str, tmp: Path) -> dict:
    """Run the bundle command for one uid (no shell, 120 s) into a file under ``tmp``; return the parsed bundle.

    stdout is discarded (untrusted). stderr is logged as one line, 500 chars at most. Any failure raises.
    """
    if not _SAFE_UID.match(uid):
        raise NightlyError("uid is not a safe argv value")
    out = tmp / "bundle.json"
    argv = [a.replace("{uid}", uid).replace("{out}", str(out)) for a in cmd]
    try:
        proc = subprocess.run(argv, cwd=cwd, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, timeout=BUNDLE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise NightlyError("bundle command timed out") from None
    if proc.returncode != 0:
        err = " ".join(proc.stderr.decode("utf-8", "replace").split())[:_STDERR_CAP]
        if err:
            print(uid, "bundle-stderr", err, flush=True)
        raise NightlyError(f"bundle command exited {proc.returncode}")
    try:
        doc = json.loads(out.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise NightlyError("bundle file missing or not JSON") from None
    finally:
        out.unlink(missing_ok=True)
    if not isinstance(doc, dict):
        raise NightlyError("bundle is not an object")
    return doc


def bundle_rows(uids: list[tuple[str, str | None, bool]], day: str, cfg: dict, tmp: Path, fetch=None) -> tuple[list[dict], dict, dict]:
    """(rows, consults by uid, counts). Eligibility is spec section 2.5: a translate or stt layer, a role layer, a clip start on ``day``.

    A pending job is an explicit request: it skips the day check. A consult that fails is counted once and never fetched again. ids and counts only; the Consults stay in memory.
    """
    from .ingest import ROLE_SLOTS, bundle_window, load_bundle
    fetch = fetch or (lambda uid: fetch_bundle(cfg["bundle_cmd"], cfg["bundle_cwd"], uid, tmp))
    counts = {"bundle_failed": 0, "missing_layers": 0, "not_this_day": 0}
    rows, consults, seen = [], {}, set()
    for uid, job_id, check_day in uids:
        if uid in seen:
            continue
        seen.add(uid)
        try:
            b = fetch(uid)
            tracks = b.get("tracks") if isinstance(b.get("tracks"), dict) else {}
            if not (tracks.get("translate") or tracks.get("stt")) or not any(tracks.get(k) for k in ROLE_SLOTS):
                counts["missing_layers"] += 1
                continue
            t0, _t1, room = bundle_window(b)
            if check_day and ist_date_of_ms(t0) != day:
                counts["not_this_day"] += 1
                continue
            c = load_bundle(b)
        except Exception as e:
            counts["bundle_failed"] += 1
            print(uid, "bundle-failed", type(e).__name__, flush=True)
            continue
        if not c.role_track:
            counts["missing_layers"] += 1
            continue
        row = b.get("cutter_row") if isinstance(b.get("cutter_row"), dict) else {}
        d8 = row.get("doctor_uid")
        rows.append({"uid": uid, "ist_date": ist_date_of_ms(t0), "room_slug": room, "job_id": job_id,
                     "doctor_uid8": d8 if isinstance(d8, str) and len(d8) == 8 else None})
        consults[uid] = c
    return rows, consults, counts


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
    posted, rejected, failed, skipped = 0, 0, 0, len(overflow)
    if dry_run:
        for r in chosen:
            print(r["uid"], r.get("ist_date"), "dry-run")
        return {"dry_run": True, "n": len(chosen), "skipped": skipped, "posted": 0, "rejected": 0, "failed": 0}
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
        if not isinstance(art, dict):
            failed += 1
            print(r["uid"], "not-valid", flush=True)
            continue
        valid = bool(log.get("final_valid"))
        cost = log.get("cost_usd")
        body = payload_from_artifact(
            art, errors=log.get("final_errors") or [],
            cost_usd=cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None,
            job_id=r.get("job_id"), room_slug=r.get("room_slug"), ist_date=r.get("ist_date"), doctor_uid8=r.get("doctor_uid8"),
        )
        try:
            res = post(body)
        except Exception as e:
            failed += 1
            print(r["uid"], "POST", type(e).__name__, flush=True)
            continue
        ok = isinstance(res, dict) and res.get("ok")
        if ok and valid:
            posted += 1
            print(r["uid"], "posted", "inserted=" + str(res.get("inserted")), flush=True)
        elif ok:
            rejected += 1
            print(r["uid"], "rejected", flush=True)
        else:
            failed += 1
            print(r["uid"], "post-rejected", "inserted=" + str((res or {}).get("inserted")), flush=True)
    return {"dry_run": False, "n": len(chosen), "skipped": skipped, "posted": posted, "rejected": rejected, "failed": failed}


def _post_factory(cfg: dict, secret: str):
    url = cfg["app_url"].rstrip("/") + "/api/freescript/ingest"

    def post(payload: dict) -> dict:
        return post_payload(payload, url, secret)

    return post


def _sealed_uids(cfg: dict, day: str, sealed, reb_token: str) -> list[str] | None:
    if sealed is False:
        return None
    if callable(sealed):
        return sealed(day)
    if isinstance(sealed, list):
        return sealed
    if reb_token and cfg.get("app_url"):
        try:
            return fetch_sealed_uids(cfg["app_url"], reb_token, day)
        except Exception as e:
            print("sealed", type(e).__name__)
            return []
    return None


def _run_bundle(cfg: dict, day: str, *, dry_run, run_one, post, pending, sealed, secret: str, reb_token: str) -> int:
    """Bundle mode: uids = the sealed feed + pending jobs; every bundle lives in one TemporaryDirectory that is gone when this returns."""
    sealed_uids = [u for u in (_sealed_uids(cfg, day, sealed, reb_token) or []) if isinstance(u, str) and u]
    jobs_by_uid: dict[str, str | None] = {}
    unexpanded = 0
    if cfg.get("app_url") and secret and pending is not False:
        try:
            jobs = pending(cfg["app_url"], secret) if pending else fetch_pending(cfg["app_url"], secret)
        except Exception as e:
            print("pending", type(e).__name__)
            jobs = []
        for j in jobs:
            uid = j.get("consult_uid")
            if isinstance(uid, str) and uid:
                jid = j.get("job_id") if isinstance(j.get("job_id"), str) else None
                jobs_by_uid[uid] = jid
            else:
                unexpanded += 1  # a room+day job needs a folder scan; bundle mode has none
    # explicit pending requests first (they skip the day check), then the sealed feed; the cap applies before any fetch
    uids = [(u, j, False) for u, j in jobs_by_uid.items()] + [(u, None, True) for u in sealed_uids if u not in jobs_by_uid]
    cap = int(cfg.get("max_consults") or 40)
    overflow, uids = len(uids) - cap if len(uids) > cap else 0, uids[:cap]
    sender = post or (_post_factory(cfg, secret) if (not dry_run and secret and cfg.get("app_url")) else None)
    if sender is None and not dry_run:
        print("no ingest target")
        return 1
    with tempfile.TemporaryDirectory(prefix="freescript-bundle-") as td:
        tmp = Path(td)
        (tmp / "bundles").mkdir()
        rows, consults, counts = bundle_rows(uids, day, cfg, tmp / "bundles")
        if not rows and not counts["bundle_failed"] and not counts["missing_layers"] and not unexpanded:
            print("nothing", day)
            return 0
        bcfg = dict(cfg, data=str(tmp), out=cfg.get("out") or str(tmp / "out"))
        summary = execute(rows, bcfg, dry_run=dry_run, run_one=run_one or _bundle_runner(consults, Path(bcfg["out"])),
                          post=sender or (lambda _p: {"ok": True, "inserted": 0}))
    summary.update(counts, mode="bundle")
    summary["skipped"] = summary.get("skipped", 0) + overflow
    summary["missing"] = counts["missing_layers"] + unexpanded
    return _finish(summary, dry_run, extra_failed=counts["bundle_failed"])


def _bundle_runner(consults: dict, out: Path):
    state: dict = {}

    def run_one(uid: str) -> dict:
        from .models import UsageLedger, make_client
        from .phi_guard import assert_phi_safe
        from .pipeline import Options, run_consult
        if "client" not in state:
            out.mkdir(parents=True, exist_ok=True)
            state["client"] = make_client("bedrock", UsageLedger(out / "usage.jsonl"), None)
            assert_phi_safe(*state["client"].resolve("sonnet"))
        return run_consult(consults[uid], state["client"], out, Options())

    return run_one


def _finish(summary: dict, dry_run: bool, extra_failed: int = 0) -> int:
    summary.setdefault("mode", "folder")
    for k in ("bundle_failed", "missing_layers", "not_this_day"):
        summary.setdefault(k, 0)
    keys = ("dry_run", "n", "posted", "rejected", "failed", "skipped", "missing", "mode", "bundle_failed", "missing_layers", "not_this_day")
    print(json.dumps({k: summary[k] for k in keys}))
    stored = summary["posted"] + summary.get("rejected", 0)
    if summary["failed"] or extra_failed or summary["missing"]:
        return 1 if stored == 0 and not dry_run else 2
    if summary.get("rejected") or summary["skipped"]:
        return 2
    return 0


def run(cfg: dict, day: str, *, dry_run: bool = False, run_one=None, post=None, pending=None, sealed=None, roles=None) -> int:
    if not cfg.get("enabled"):
        print("disabled")
        return 0
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    reb_token = os.environ.get("REB_INDEX_READ_TOKEN", "").strip()
    if cfg.get("bundle_cmd"):
        return _run_bundle(cfg, day, dry_run=dry_run, run_one=run_one, post=post, pending=pending, sealed=sealed, secret=secret, reb_token=reb_token)
    data = Path(cfg["data"]) if cfg.get("data") else None
    if data is None:
        print("no data dir")
        return 1
    rows = select_day(data, day)
    sealed_missing: list[str] = []
    if sealed is not False:
        uids = _sealed_uids(cfg, day, sealed, reb_token)
        if uids is not None:
            def role_for(uid: str):
                if callable(roles):
                    return roles(uid)
                if reb_token and cfg.get("app_url"):
                    try:
                        return fetch_role_doc(cfg["app_url"], reb_token, uid)
                    except Exception:
                        return None
                return None
            rows, sealed_missing = include_sealed(data, day, list(uids), role_for)
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
    if not rows and not missing and not sealed_missing:
        print("nothing", day)
        return 0
    sender = post or (_post_factory(cfg, secret) if (not dry_run and secret and cfg.get("app_url")) else None)
    if sender is None and not dry_run:
        print("no ingest target")
        return 1
    summary = execute(rows, cfg, dry_run=dry_run, run_one=run_one, post=sender or (lambda _p: {"ok": True, "inserted": 0}))
    summary["missing"] = len(missing) + len(sealed_missing)
    return _finish(summary, dry_run)


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
    try:
        cfg = load_config(a.config)
    except NightlyError as e:
        print("config error:", e)
        return 1
    if a.data:
        cfg["data"] = str(a.data)
    day = a.date or previous_ist_day()
    if a.cmd == "plan":
        if not cfg.get("data"):
            print("no data dir")
            return 1
        if cfg.get("bundle_cmd"):
            print("plan lists local folders; bundle mode has none")
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
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    if cfg.get("bundle_cmd"):
        if not cfg.get("app_url") or not secret:
            print("no ingest target")
            return 1
        return _run_bundle(cfg, previous_ist_day(), dry_run=dry_run, run_one=None, post=None, pending=None, sealed=False, secret=secret, reb_token="")
    data = Path(cfg["data"]) if cfg.get("data") else None
    if not data or not cfg.get("app_url") or not secret:
        print("no ingest target")
        return 1
    jobs = fetch_pending(cfg["app_url"], secret)
    rows, missing = jobs_to_rows(jobs, data)
    summary = execute(rows, cfg, dry_run=dry_run, run_one=None, post=None if dry_run else _post_factory(cfg, secret))
    summary["missing"] = len(missing)
    print(json.dumps({k: summary[k] for k in ("dry_run", "n", "posted", "rejected", "failed", "skipped") if k in summary} | {"missing": len(missing)}))
    stored = summary.get("posted", 0) + summary.get("rejected", 0)
    if summary.get("failed") or missing:
        return 1 if stored == 0 and not dry_run else 2
    if summary.get("rejected"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
