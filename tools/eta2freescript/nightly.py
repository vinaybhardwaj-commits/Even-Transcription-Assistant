"""Nightly FreeScript run. On unless ETA_FREESCRIPT is 0 (unset stays on; any other value is an error).

    python -m tools.eta2freescript.nightly plan [--date YYYY-MM-DD] [--data DIR]
    python -m tools.eta2freescript.nightly run  [--date YYYY-MM-DD] [--data DIR] [--dry-run]
    python -m tools.eta2freescript.nightly drain [--data DIR]
    python -m tools.eta2freescript.nightly run [--date today] [--skip-existing] [--max-consults N]
    python -m tools.eta2freescript.nightly hourly
    python -m tools.eta2freescript.nightly backfill --from YYYY-MM-DD --to YYYY-MM-DD [--max-consults N]

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
import contextlib
import errno
import fcntl
import json
import os
import re
import shutil
import signal
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


class LedgerWriteError(NightlyError):
    pass


BUNDLE_TIMEOUT_S = 120
_STDERR_CAP = 500
_STDERR_READ = 64 * 1024
_SAFE_UID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_PLACEHOLDER = re.compile(r"\{[^{}]*\}")


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
    if not cmd[0].strip():
        raise NightlyError("FREESCRIPT_BUNDLE_CMD has an empty program")
    if "{" in cmd[0]:
        raise NightlyError("FREESCRIPT_BUNDLE_CMD program must be a literal, not a placeholder")
    for ph in ("{uid}", "{out}"):
        if not any(ph in a for a in cmd):
            raise NightlyError(f"FREESCRIPT_BUNDLE_CMD has no {ph} placeholder")
    for a in cmd:
        if any(m not in ("{uid}", "{out}") for m in _PLACEHOLDER.findall(a)):
            raise NightlyError("FREESCRIPT_BUNDLE_CMD has a placeholder other than {uid} and {out}")
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


def current_ist_day(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.astimezone(IST).date().isoformat()


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


def fetch_day(app_url: str, secret: str, day: str, timeout_s: int = 30) -> tuple[list[dict], bool]:
    """GET /api/freescript/day?ist_date= (same HMAC as the pending read). (stored rows, partial); an HTTP or body failure raises.

    ``partial`` is true when the read was truncated (50-row cap) or withheld blind room-days: the rows are then a subset,
    and the ledger is what covers the rest.
    """
    path = f"/api/freescript/day?ist_date={day}"
    ts = int(datetime.now(timezone.utc).timestamp())
    req = urllib.request.Request(app_url.rstrip("/") + path, method="GET")
    req.add_header("x-freescript-ts", str(ts))
    req.add_header("x-freescript-signature", sign_get(path, secret, ts))
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        body = json.loads(resp.read().decode())
    rows = body.get("rows") if isinstance(body, dict) else None
    if not isinstance(body, dict) or body.get("ok") is not True or not isinstance(rows, list):
        raise NightlyError("day read returned no rows list")
    withheld = body.get("withheld_blind")
    partial = bool(body.get("truncated")) or (isinstance(withheld, (int, float)) and withheld > 0)
    return [r for r in rows if isinstance(r, dict)], partial


def current_code_sha() -> str:
    """sha256 over the package sources, the same value the pipeline stamps as generator.code_sha256."""
    from .prompts import code_paths, sha
    return sha(*code_paths())


def read_ledger(out_root: str) -> dict[str, dict] | None:
    """Last <out>/consult-state.jsonl line per uid. A missing file is an empty ledger; an unreadable one is None."""
    last: dict[str, dict] = {}
    try:
        with open(Path(out_root) / "consult-state.jsonl", encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict) and isinstance(row.get("consult_uid"), str):
                    last[row["consult_uid"]] = row
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError):
        return None
    return last


def existing_uids(rows: list[dict]) -> dict[str, str | None]:
    """Uid -> stored run id, for uids with a stored artifact whose state is not ``rejected``."""
    out: dict[str, str | None] = {}
    for r in rows:
        if isinstance(r.get("consult_uid"), str) and r.get("state") != "rejected":
            rid = r.get("run_id")
            out[r["consult_uid"]] = str(rid) if isinstance(rid, (int, str)) and not isinstance(rid, bool) else None
    return out


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


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


def _killpg_quiet(proc: subprocess.Popen) -> None:
    """SIGKILL the command's process group; a group that is already gone is fine."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _communicate_bounded(proc: subprocess.Popen, timeout: float) -> tuple[bytes, bytes]:
    """Wait for ``proc``; keep at most _STDERR_READ bytes of stderr and drain the rest, so a noisy child cannot fill memory."""
    import threading
    buf = bytearray()

    def drain():
        for chunk in iter(lambda: proc.stderr.read(8192), b""):
            if len(buf) < _STDERR_READ:
                buf.extend(chunk[: _STDERR_READ - len(buf)])
    t = threading.Thread(target=drain, daemon=True)
    t.start()
    try:
        proc.wait(timeout=timeout)
    finally:
        _killpg_quiet(proc)  # no grandchild outlives the command, and none keeps stderr open
        t.join(timeout=5)
    return b"", bytes(buf)


def fetch_bundle(cmd: list[str], cwd: str, uid: str, tmp: Path) -> dict:
    """Run the bundle command for one uid (no shell, 120 s) into a file under ``tmp``; return the parsed bundle.

    stdout is discarded (untrusted). stderr is logged as one line, 500 chars at most. Any failure raises.
    """
    if not isinstance(uid, str) or not _SAFE_UID.fullmatch(uid):
        raise NightlyError("uid is not a safe argv value")
    out = tmp / "bundle.json"
    argv = [a.replace("{uid}", uid).replace("{out}", str(out)) for a in cmd]
    proc = subprocess.Popen(argv, cwd=cwd, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, start_new_session=True)
    try:
        try:
            _, err_bytes = _communicate_bounded(proc, BUNDLE_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            proc.wait()
            raise NightlyError("bundle command timed out") from None
    finally:
        _killpg_quiet(proc)
        if proc.stderr:
            proc.stderr.close()
    if proc.returncode != 0:
        err = " ".join(err_bytes.decode("utf-8", "replace").split())[:_STDERR_CAP]
        if err:
            print(repr(uid)[:40], "bundle-stderr", err, flush=True)
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


def bundle_rows(uids: list[tuple[str, str | None, bool]], day: str, cfg: dict, tmp: Path, fetch=None, outcomes: dict | None = None, dates: dict | None = None) -> tuple[list[dict], dict, dict]:
    """(rows, consults by uid, counts). Eligibility is spec section 2.5: a translate or stt layer, a role layer, a clip start on ``day``.

    A pending job is an explicit request: it skips the day check. A consult that fails is counted once and never fetched again. ids and counts only; the Consults stay in memory.
    """
    from .ingest import ROLE_SLOTS, _slot_track, bundle_window, load_bundle
    fetch = fetch or (lambda uid: fetch_bundle(cfg["bundle_cmd"], cfg["bundle_cwd"], uid, tmp))
    counts = {"bundle_failed": 0, "missing_layers": 0, "not_this_day": 0}
    outcomes = outcomes if outcomes is not None else {}  # uid -> ledger state for every uid that is not eligible
    dates = dates if dates is not None else {}  # uid -> the consult's own IST date, once its bundle is read
    rows, consults, seen = [], {}, set()
    for uid, job_id, check_day in uids:
        if uid in seen:
            continue
        seen.add(uid)
        try:
            b = fetch(uid)
            tracks = b.get("tracks") if isinstance(b.get("tracks"), dict) else {}
            if (_slot_track(tracks.get("translate")) is None and _slot_track(tracks.get("stt")) is None) \
                    or not any(_slot_track(tracks.get(k)) is not None for k in ROLE_SLOTS):
                counts["missing_layers"] += 1
                outcomes[uid] = "not_eligible:missing_layers"
                continue
            t0, _t1, room = bundle_window(b)
            dates[uid] = ist_date_of_ms(t0)
            if check_day and ist_date_of_ms(t0) != day:
                counts["not_this_day"] += 1
                outcomes[uid] = "not_eligible:not_this_day"
                continue
            c = load_bundle(b)
        except Exception as e:
            counts["bundle_failed"] += 1
            outcomes[uid] = "bundle_failed"
            print(repr(uid)[:40], "bundle-failed", type(e).__name__, flush=True)
            continue
        if not c.role_track:
            counts["missing_layers"] += 1
            outcomes[uid] = "not_eligible:missing_layers"
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


def execute(rows: list[dict], cfg: dict, *, dry_run: bool, run_one, post, on_result=None, on_start=None) -> dict:
    """Run and post. ``run_one(uid) -> pipeline log``. ``post(payload) -> response``. Prints counts only.

    ``on_result`` is called as soon as each consult's state is known. If it raises LedgerWriteError the loop stops and the
    summary carries ``ledger_write_failed``. ``on_start(uid)`` is called immediately before each run_one, outside its try: if it
    raises LedgerWriteError no Bedrock call is made and the loop stops.
    """
    cap = int(cfg.get("max_consults") or 40)
    chosen, overflow = rows[:cap], rows[cap:]
    note = on_result or (lambda uid, state, artifact_id=None, **kw: None)
    posted, rejected, failed, skipped, spent, cost_unknown = 0, 0, 0, len(overflow), 0.0, 0
    if dry_run:
        for r in chosen:
            print(r["uid"], r.get("ist_date"), "dry-run")
        return {"dry_run": True, "n": len(chosen), "skipped": skipped, "posted": 0, "rejected": 0, "failed": 0, "cost_usd": 0.0}
    data, out = Path(cfg["data"]), Path(cfg.get("out") or str(Path(cfg["data"]) / "_eta2freescript"))
    out.mkdir(parents=True, exist_ok=True)
    ledger_failed = False
    try:
        for r in chosen:
            if on_start:
                on_start(r["uid"])
            try:
                log = (run_one or (lambda uid: _default_run(data, out, uid)))(r["uid"])
            except Exception as e:
                failed += 1
                c = getattr(e, "cost_usd", None)  # what the consult spent before it raised, from its usage lines
                if isinstance(c, (int, float)) and not isinstance(c, bool):
                    spent += c
                else:
                    cost_unknown += 1
                note(r["uid"], "failed:" + type(e).__name__)
                print(r["uid"], "ERROR", type(e).__name__, flush=True)
                continue
            art = log.get("artifact") if isinstance(log, dict) else None
            rp = {"reposted": True} if isinstance(log, dict) and log.get("reposted") else {}
            if not isinstance(art, dict):
                failed += 1
                c = log.get("cost_usd") if isinstance(log, dict) else None
                if isinstance(c, (int, float)) and not isinstance(c, bool):
                    spent += c
                note(r["uid"], "failed:NoArtifact")
                print(r["uid"], "not-valid", flush=True)
                continue
            valid = bool(log.get("final_valid"))
            cost = log.get("cost_usd")
            if isinstance(cost, (int, float)) and not isinstance(cost, bool) and not log.get("reposted"):
                spent += cost  # a re-post of a kept artifact spends nothing new
            body = payload_from_artifact(
                art, errors=log.get("final_errors") or [],
                cost_usd=cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None,
                job_id=r.get("job_id"), room_slug=r.get("room_slug"), ist_date=r.get("ist_date"), doctor_uid8=r.get("doctor_uid8"),
            )
            try:
                res = post(body)
            except Exception as e:
                failed += 1
                note(r["uid"], "post_failed", **rp)  # the artifact exists; the next run at this code sha re-posts it
                print(r["uid"], "POST", type(e).__name__, flush=True)
                continue
            ok = isinstance(res, dict) and res.get("ok")
            rid = res.get("run_id") if isinstance(res, dict) else None
            rid = str(rid) if isinstance(rid, (int, str)) and not isinstance(rid, bool) else None
            if ok and valid:
                note(r["uid"], "written", rid, **rp)
                posted += 1
                print(r["uid"], "posted", "inserted=" + str(res.get("inserted")), flush=True)
            elif ok:
                note(r["uid"], "rejected", rid, **rp)
                rejected += 1
                print(r["uid"], "rejected", flush=True)
            else:
                note(r["uid"], "post_failed", **rp)
                failed += 1
                print(r["uid"], "post-rejected", "inserted=" + str((res or {}).get("inserted")), flush=True)
    except LedgerWriteError:
        ledger_failed = True
    summary = {"dry_run": False, "n": len(chosen), "skipped": skipped, "posted": posted, "rejected": rejected, "failed": failed,
               "cost_usd": round(spent, 6)}
    if ledger_failed:
        summary["ledger_write_failed"] = True
    if cost_unknown:
        summary["cost_unknown"] = cost_unknown
    return summary


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


def _skip_map(cfg: dict, day: str, secret: str, day_read, code_sha: str) -> tuple[dict[str, tuple[str, str | None]], dict] | None:
    """uid -> (ledger state to record, artifact id) for every uid to skip, plus {day_read_partial, day_read_failed}.

    The box's ledger comes first: a last line of ``written`` or ``skipped_existing`` skips, and so does ``rejected`` with this
    run's code sha (a rejected uid is retried only when the code changed). The day read adds every uid it lists with a state other
    than ``rejected``. A truncated or blind-withholding read is partial, a failed read is ledger-only. None only when the ledger is
    unreadable AND the day read fails: the caller aborts.
    """
    ledger = read_ledger(cfg["out"])
    skips: dict[str, tuple[str, str | None]] = {}
    for uid, row in (ledger or {}).items():
        aid = row.get("artifact_id") if isinstance(row.get("artifact_id"), str) else None
        st = row.get("state")
        if st in ("written", "skipped_existing"):
            skips[uid] = ("skipped_existing", aid)
        elif st == "rejected" and row.get("code_sha256") == code_sha:
            skips[uid] = ("rejected", aid)  # still rejected at this code: the line keeps saying so, so a code change retries it
    info = {"day_read_partial": False, "day_read_failed": False}
    try:
        if not cfg.get("app_url") or not secret:
            raise NightlyError("no app url or secret for the day read")
        got = day_read(cfg["app_url"], secret, day) if day_read else fetch_day(cfg["app_url"], secret, day)
        rows, partial = got if isinstance(got, tuple) else (got, False)
        info["day_read_partial"] = bool(partial)
        for uid, aid in existing_uids(rows).items():
            skips[uid] = ("skipped_existing", aid)
    except Exception as e:
        print("day-read", type(e).__name__, flush=True)
        info["day_read_failed"] = True
        if ledger is None:
            return None
    return skips, info


def _abort_summary(dry_run: bool, day: str, out: dict | None) -> None:
    print(json.dumps({"date": day, "dry_run": dry_run, "n": 0, "posted": 0, "rejected": 0, "failed": 0, "skipped": 0, "missing": 0,
                      "skipped_existing": 0, "mode": "bundle", "bundle_failed": 0, "missing_layers": 0, "not_this_day": 0,
                      "day_read_failed": True, "ledger_unreadable": True}))
    if out is not None:
        out.update(fatal=True)


STATE_FILE = "consult-state.jsonl"
LOCK_FILE = ".nightly.lock"
MAX_ATTEMPTS_PER_SHA = 2  # Bedrock runs per (uid, code_sha256); a re-post of a kept artifact is not one
_ATTEMPT_STATES = ("written", "rejected", "post_failed")


def _scan_ledger(out_root: str):
    """Yield every ledger row as a dict; a missing file yields nothing; an unreadable one raises OSError/UnicodeDecodeError."""
    try:
        with open(Path(out_root) / STATE_FILE, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict) and isinstance(row.get("consult_uid"), str):
                    yield row
    except FileNotFoundError:
        return


def count_attempts(out_root: str, code_sha: str) -> dict[str, int] | None:
    """uid -> Bedrock attempts at ``code_sha``, counted from every ledger line (not only the last).

    One attempt per ``started`` line, written before the spend. A legacy terminal line (written, rejected, post_failed or
    failed:<Class>, not marked ``reposted``) counts only when no started line is still open for that uid before it; a terminal line
    that follows a started line closes it and adds nothing. So a started line with no terminal line (a crash) is one attempt, a
    started/terminal pair is one, and a pre-fix terminal line alone is one. A re-post line and seed lines (another sha) never count.
    A missing file is {}; an unreadable one is None.
    """
    n: dict[str, int] = {}
    open_: set[str] = set()
    try:
        for row in _scan_ledger(out_root):
            uid, st = row["consult_uid"], row.get("state")
            if row.get("code_sha256") != code_sha or not isinstance(st, str) or row.get("reposted"):
                continue
            if st == "started":
                n[uid] = n.get(uid, 0) + 1
                open_.add(uid)
            elif st in _ATTEMPT_STATES or st.startswith("failed:"):
                if uid in open_:
                    open_.discard(uid)
                else:
                    n[uid] = n.get(uid, 0) + 1
    except (OSError, UnicodeDecodeError):
        return None
    return n


def _parse_ts(v) -> float | None:
    """Epoch seconds from an ISO run_ts, or None when it is missing or unparseable."""
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v).timestamp()
    except ValueError:
        return None


def repost_pending(out_root: str, code_sha: str) -> dict[str, tuple[str | None, float | None]]:
    """uid -> (job id or None, since) for uids owed a re-post at ``code_sha``.

    Owed: a post_failed line with no later written or rejected line, or an open ``started`` (a crash inside the POST) with no
    terminal line after it. Lines in between (bundle_failed, attempts_exhausted, ...) do not matter. ``since`` is the run_ts of the
    attempt's last ``started`` line (None if unknown): a kept artifact.json older than it belongs to an earlier attempt and must not
    be posted. Unreadable ledger: {}.
    """
    pend: dict[str, tuple[str | None, float | None]] = {}
    last_start: dict[str, float | None] = {}
    try:
        for row in _scan_ledger(out_root):
            if row.get("code_sha256") != code_sha:
                continue
            uid, st = row["consult_uid"], row.get("state")
            jid = row.get("job_id") if isinstance(row.get("job_id"), str) else None
            if st == "started":
                last_start[uid] = _parse_ts(row.get("run_ts"))
                pend[uid] = (jid or pend.get(uid, (None, None))[0], last_start[uid])
            elif st == "post_failed":
                pend[uid] = (jid or pend.get(uid, (None, None))[0], last_start.get(uid))
            elif st in ("written", "rejected") or (isinstance(st, str) and st.startswith("failed:")):
                pend.pop(uid, None)
    except (OSError, UnicodeDecodeError):
        return {}
    return pend


def append_states(out_root: str, lines: list[dict]) -> None:
    """Append the stage-ledger lines to <out_root>/consult-state.jsonl (0600, directory 0700). Ids, states and times only."""
    if not lines:
        return
    root = Path(out_root)
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    path = root / STATE_FILE
    created = not path.exists()
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        size = os.fstat(fd).st_size
        lead = b""
        if size and os.pread(fd, 1, size - 1) != b"\n":
            lead = b"\n"  # a file that does not end in a newline would merge the next line into its last
        buf = memoryview(lead + "".join(json.dumps(x) + "\n" for x in lines).encode())
        while buf:  # write(2) may store less than asked on a nearly full disk; a 0 return can never finish
            n = os.write(fd, buf)
            if n <= 0:
                raise OSError(errno.ENOSPC, "short write to the ledger")
            buf = buf[n:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)
    if created:  # the file's directory entry must survive a power loss too
        dfd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


_HELD_LOCKS: set[str] = set()


@contextlib.contextmanager
def nightly_lock(out_root: str):
    """One non-blocking flock on <out_root>/.nightly.lock. Yields "ok", "locked" (another process holds it) or "error".

    Re-entrant inside one process (hourly and backfill call run). Released when the block exits.
    """
    key = os.path.realpath(out_root)
    if key in _HELD_LOCKS:
        yield "ok"
        return
    try:
        root = Path(out_root)
        root.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o700)
        fd = os.open(root / LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        yield "error"
        return
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield "locked"
            return
        _HELD_LOCKS.add(key)
        try:
            yield "ok"
        finally:
            _HELD_LOCKS.discard(key)
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _locked(cfg: dict, dry_run: bool, label: str, fn, day: str | None = None, out: dict | None = None) -> int:
    """Run ``fn()`` under the nightly lock. A held lock prints one {"locked": true} line and exits 0 without running anything."""
    if not cfg.get("enabled") or dry_run or not cfg.get("out"):
        return fn()
    with nightly_lock(cfg["out"]) as st:
        if st == "locked":
            line = {"locked": True, "cmd": label}
            if day:
                line["date"] = day
            print(json.dumps(line))
            return 0
        if st == "error":
            print("config error: cannot open the lock file under out")
            if out is not None:
                out.update(fatal=True)
            return 1
        return fn()


def _repost_log(out_root: str, uid: str) -> dict | None:
    """A run log rebuilt from the kept <out>/<uid>/artifact.json (+ validation file, + cost from runs.jsonl). None if nothing usable is kept."""
    if not isinstance(uid, str) or not _SAFE_UID.fullmatch(uid):
        return None
    art = _read(Path(out_root) / uid / "artifact.json")
    if not art:
        return None
    val = _read(Path(out_root) / uid / "artifact.validation.json") or {}
    errs = val.get("final_errors") if isinstance(val.get("final_errors"), list) else []
    cost = val.get("cost_usd")
    if not isinstance(cost, (int, float)) or isinstance(cost, bool):
        cost = None
        try:
            with open(Path(out_root) / "runs.jsonl", encoding="utf-8") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(r, dict) and r.get("uid") == uid and isinstance(r.get("cost_usd"), (int, float)) \
                            and not isinstance(r.get("cost_usd"), bool):
                        cost = r["cost_usd"]
        except OSError:
            pass
    valid = bool(val["final_valid"]) if "final_valid" in val else not errs
    return {"artifact": art, "final_errors": errs, "final_valid": valid, "cost_usd": cost, "reposted": True}


def _run_bundle(cfg: dict, day: str, *, dry_run, run_one, post, pending, sealed, secret: str, reb_token: str,
                skip_existing: bool = False, day_read=None, out: dict | None = None) -> int:
    """Bundle mode: uids = the sealed feed + pending jobs; every bundle lives in one TemporaryDirectory that is gone when this returns.

    Each consult's ledger line is appended the moment its state is known, so a crash keeps what was done.
    """
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
    skipped_existing = 0
    flags: dict = {}
    code_sha = current_code_sha()
    job_of = {u: j for u, j, _ in uids}
    dates: dict[str, str] = {}  # uid -> the consult's own IST date (bundle read); sealed uids fall back to the run day
    day_of = {u: day for u, _j, chk in uids if chk}
    ledger_failed = False
    clock_src: dict = {}  # uid -> Consult, once its bundle is read (for the clock counts)

    def emit(uid: str, state: str, aid: str | None = None, reposted: bool = False) -> None:
        line = {"consult_uid": uid, "ist_date": dates.get(uid) or day_of.get(uid), "state": state, "artifact_id": aid,
                "run_ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "code_sha256": code_sha}
        if job_of.get(uid):
            line["job_id"] = job_of[uid]
        if reposted:
            line["reposted"] = True  # not a Bedrock attempt: count_attempts ignores it
        line.update({k: v for k, v in _clock_of(clock_src.get(uid)).items() if v})  # only when non-zero
        if not cfg.get("out") or dry_run:
            return
        try:
            append_states(cfg["out"], [line])
        except OSError:
            raise LedgerWriteError("ledger write failed") from None

    have: dict[str, tuple[str, str | None]] = {}
    if skip_existing:
        got = _skip_map(cfg, day, secret, day_read, code_sha)
        if got is None:
            _abort_summary(dry_run, day, out)
            return 1
        have, flags = got
    # re-post comes first, on every path and before the cap: a uid with a post_failed at this code sha and no later written or
    # rejected, whose artifact.json is kept, goes out again with no Bedrock call
    kept_logs: dict[str, dict] = {}
    if not dry_run and cfg.get("out"):
        for u, (jid, since) in repost_pending(cfg["out"], code_sha).items():
            if u not in job_of:
                continue
            if since is not None:  # an artifact older than the attempt's started line is a stale earlier one: fall through to the cap
                try:
                    if (Path(cfg["out"]) / u / "artifact.json").stat().st_mtime < since:
                        continue
                except OSError:
                    continue
            lg = _repost_log(cfg["out"], u)
            if lg:
                kept_logs[u] = lg
                if not job_of.get(u) and jid:  # a pending job no longer listed is served under the ledger's job id
                    job_of[u] = jid
        uids = [(u, job_of.get(u) if u in kept_logs else j, chk) for u, j, chk in uids]
    # an explicit pending scribe_freescript job is a deliberate rerun request: it bypasses skip-existing, but not the attempt cap
    kept = [t for t in uids if not t[2] or t[0] not in have]
    exhausted: list[str] = []
    prior = read_ledger(cfg["out"]) or {} if cfg.get("out") else {}
    if cfg.get("out"):
        attempts = count_attempts(cfg["out"], code_sha)
        if attempts is None:
            _abort_summary(dry_run, day, out)
            return 1
        exhausted = [t[0] for t in kept if t[0] not in kept_logs and attempts.get(t[0], 0) >= MAX_ATTEMPTS_PER_SHA]
        kept = [t for t in kept if t[0] not in exhausted]
        for u in exhausted:
            if isinstance(prior.get(u, {}).get("ist_date"), str):
                dates.setdefault(u, prior[u]["ist_date"])
    cap = int(cfg.get("max_consults") or 40)
    overflow, kept_capped = len(kept) - cap if len(kept) > cap else 0, kept[:cap]
    skipped = [t for t in uids if t[2] and t[0] in have]
    skipped_existing = len(skipped)
    uids = kept_capped
    sender = post or (_post_factory(cfg, secret) if (not dry_run and secret and cfg.get("app_url")) else None)
    if sender is None and not dry_run:
        print("no ingest target")
        _config_error_summary(dry_run)
        if out is not None:
            out.update(fatal=True)
        return 1
    rows: list[dict] = []
    counts = {"bundle_failed": 0, "missing_layers": 0, "not_this_day": 0}
    summary: dict = {}
    nothing = False
    try:
        for t in skipped:
            emit(t[0], *have[t[0]])
        for u in exhausted:
            emit(u, "attempts_exhausted")
        with tempfile.TemporaryDirectory(prefix="freescript-bundle-") as td:
            tmp = Path(td)
            (tmp / "bundles").mkdir()
            outcomes: dict[str, str] = {}
            rows, consults, counts = bundle_rows(uids, day, cfg, tmp / "bundles", outcomes=outcomes, dates=dates)
            clock_src.update(consults)
            for u, st in outcomes.items():
                emit(u, st)
            nothing = not rows and not counts["bundle_failed"] and not counts["missing_layers"] and not unexpanded
            if nothing:
                print("nothing", day)
                summary = {"dry_run": dry_run, "n": 0, "skipped": 0, "posted": 0, "rejected": 0, "failed": 0, "cost_usd": 0.0}
            else:
                # every pipeline output goes inside the temp dir; _bundle_runner copies out only derived files
                bcfg = dict(cfg, data=str(tmp), out=str(tmp / "out"))
                base = run_one or _bundle_runner(consults, tmp / "out", cfg.get("out"))
                summary = execute(rows, bcfg, dry_run=dry_run, run_one=lambda u: kept_logs[u] if u in kept_logs else base(u),
                                  post=sender or (lambda _p: {"ok": True, "inserted": 0}),
                                  on_result=emit, on_start=lambda u: None if u in kept_logs else emit(u, "started"))
    except LedgerWriteError:
        ledger_failed = True
        summary = {"dry_run": dry_run, "n": 0, "skipped": 0, "posted": 0, "rejected": 0, "failed": 0, "cost_usd": 0.0}
    if summary.get("ledger_write_failed"):
        ledger_failed = True
    for k in (n for n, _ in CLOCK_FIELDS):
        summary[k] = sum(_clock_of(c)[k] for c in clock_src.values())
    summary.update(counts, **flags, mode="bundle", skipped_existing=skipped_existing, date=day, eligible=len(rows),
                   attempts_exhausted=len(exhausted))
    summary["skipped"] = summary.get("skipped", 0) + overflow
    summary["missing"] = counts["missing_layers"] + unexpanded
    if ledger_failed:
        summary["ledger_write_failed"] = True
        _finish(summary, dry_run, extra_failed=counts["bundle_failed"], out=out)
        if out is not None:
            out.update(fatal=True)
        return 1
    rc = _finish(summary, dry_run, extra_failed=counts["bundle_failed"], out=out)
    return 0 if nothing else rc


def _config_error_summary(dry_run: bool) -> None:
    print(json.dumps({"dry_run": dry_run, "n": 0, "posted": 0, "rejected": 0, "failed": 0, "skipped": 0, "missing": 0,
                      "mode": "bundle", "bundle_failed": 0, "missing_layers": 0, "not_this_day": 0, "config_error": True}))


def _keep_derived(tmp_out: Path, keep_root: str | None, uid: str, log: dict, usage_from: int, error_type: str | None = None) -> int:
    """Copy artifact.json, artifact.validation.json, one run-log line and the new usage lines to <keep_root>. Nothing else persists.

    Files 0600, directories 0700. Returns the new offset into the temp usage ledger.
    """
    ledger = tmp_out / "usage.jsonl"
    size = ledger.stat().st_size if ledger.exists() else usage_from
    if not keep_root:
        return size
    root = Path(keep_root)
    dest = root / uid
    for d in (root, dest):
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)
    for name in (() if error_type else ("artifact.json", "artifact.validation.json")):
        src = tmp_out / uid / name
        if src.is_file():
            shutil.copyfile(src, dest / name)
            os.chmod(dest / name, 0o600)
    if error_type:  # the class name only, never the message
        line = {"uid": uid, "final_valid": False, "error_type": error_type}
    else:
        line = {"uid": uid, "final_valid": bool(log.get("final_valid")), "n_final_errors": len(log.get("final_errors") or []),
                "cost_usd": log.get("cost_usd"), "secs_total": log.get("secs_total")}
    for path, data in ((root / "runs.jsonl", (json.dumps(line) + "\n").encode()),
                       (root / "usage.jsonl", _read_from(ledger, usage_from, size))):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        os.chmod(path, 0o600)
    return size


def _read_from(path: Path, start: int, end: int) -> bytes:
    if end <= start or not path.exists():
        return b""
    with path.open("rb") as f:
        f.seek(start)
        return f.read(end - start)


def _usd_between(ledger: Path, start: int) -> float | None:
    """USD in the usage lines appended after ``start`` bytes. 0.0 when nothing was written; None when a line cannot be read."""
    try:
        size = ledger.stat().st_size if ledger.exists() else start
        total = 0.0
        for line in _read_from(ledger, start, size).decode("utf-8").splitlines():
            if line.strip():
                total += float(json.loads(line)["usd"])
        return total
    except (OSError, ValueError, KeyError, TypeError):
        return None


CLOCK_FIELDS = (("clock_absolute", "segments_absolute"), ("clock_relative", "segments_relative"),
                ("clock_dropped_outside", "dropped_outside_clip"), ("clock_malformed_dropped", "malformed_dropped"))


def _clock_of(consult) -> dict:
    """The four segment-clock counts of one Consult as ledger/summary names; zero where the Consult carries none. Counts only."""
    cc = getattr(consult, "clock_counts", None)
    cc = cc if isinstance(cc, dict) else {}
    return {name: int(cc.get(src) or 0) for name, src in CLOCK_FIELDS}


def _bundle_runner(consults: dict, out: Path, keep_root: str | None = None):
    """run_one for bundle mode. The pipeline writes under ``out`` (inside the TemporaryDirectory); only derived outputs reach ``keep_root``."""
    state: dict = {"offset": 0}

    def run_one(uid: str) -> dict:
        from .models import UsageLedger, make_client
        from .phi_guard import assert_phi_safe
        from .pipeline import Options, run_consult
        if "client" not in state:
            out.mkdir(parents=True, exist_ok=True)
            state["client"] = make_client("bedrock", UsageLedger(out / "usage.jsonl"), None)
            assert_phi_safe(*state["client"].resolve("sonnet"))
        try:
            log = run_consult(consults[uid], state["client"], out, Options())
        except Exception as e:
            # a consult that raised still keeps what it spent, and reports it to execute() so the summary's cost_usd includes it
            e.cost_usd = _usd_between(out / "usage.jsonl", state["offset"])
            state["offset"] = _keep_derived(out, keep_root, uid, {}, state["offset"], error_type=type(e).__name__)
            raise
        state["offset"] = _keep_derived(out, keep_root, uid, log, state["offset"])
        return log

    return run_one


def _finish(summary: dict, dry_run: bool, extra_failed: int = 0, out: dict | None = None) -> int:
    summary.setdefault("mode", "folder")
    for k in ("bundle_failed", "missing_layers", "not_this_day", "skipped_existing", "attempts_exhausted"):
        summary.setdefault(k, 0)
    summary.setdefault("cost_usd", 0.0)
    summary.setdefault("eligible", summary.get("n", 0) + summary.get("skipped", 0))
    keys = ("dry_run", "n", "posted", "rejected", "failed", "skipped", "missing", "mode", "bundle_failed", "missing_layers", "not_this_day",
            "skipped_existing", "attempts_exhausted", "cost_usd")
    line = {k: summary[k] for k in keys}
    line.update({k: summary[k] for k, _ in CLOCK_FIELDS if k in summary})
    if summary.get("cost_unknown"):
        line["cost_unknown"] = summary["cost_unknown"]
    line.update({k: True for k in ("day_read_partial", "day_read_failed", "ledger_write_failed") if summary.get(k)})
    if summary.get("date"):
        line = {"date": summary["date"], **line}
    print(json.dumps(line))
    if out is not None:
        out.update(summary)
    stored = summary["posted"] + summary.get("rejected", 0)
    if summary["failed"] or extra_failed or summary["missing"]:
        return 1 if stored == 0 and not dry_run else 2
    if summary.get("rejected") or summary["skipped"]:
        return 2
    return 0


def run(cfg: dict, day: str, *, dry_run: bool = False, out: dict | None = None, **kw) -> int:
    """One day's run, under the nightly lock (see ``nightly_lock``)."""
    return _locked(cfg, dry_run, "run", lambda: _run_day(cfg, day, dry_run=dry_run, out=out, **kw), day=day, out=out)


def _run_day(cfg: dict, day: str, *, dry_run: bool = False, run_one=None, post=None, pending=None, sealed=None, roles=None,
             skip_existing: bool = False, day_read=None, out: dict | None = None) -> int:
    if not cfg.get("enabled"):
        print("disabled")
        return 0
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    reb_token = os.environ.get("REB_INDEX_READ_TOKEN", "").strip()
    if skip_existing and not cfg.get("out"):
        print("config error: --skip-existing needs out (the ledger directory)")
        if out is not None:
            out.update(fatal=True)
        return 1
    if cfg.get("bundle_cmd"):
        return _run_bundle(cfg, day, dry_run=dry_run, run_one=run_one, post=post, pending=pending, sealed=sealed, secret=secret,
                           reb_token=reb_token, skip_existing=skip_existing, day_read=day_read, out=out)
    data = Path(cfg["data"]) if cfg.get("data") else None
    if data is None:
        print("no data dir")
        if out is not None:
            out.update(fatal=True)
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
    skipped_existing = 0
    flags: dict = {}
    if skip_existing:
        got = _skip_map(cfg, day, secret, day_read, current_code_sha())
        if got is None:
            print(json.dumps({"date": day, "mode": "folder", "day_read_failed": True, "ledger_unreadable": True}))
            if out is not None:
                out.update(fatal=True)
            return 1
        have, flags = got
        kept = [r for r in rows if r["uid"] not in have]
        skipped_existing, rows = len(rows) - len(kept), kept
    if not rows and not missing and not sealed_missing:
        print("nothing", day)
        return 0
    sender = post or (_post_factory(cfg, secret) if (not dry_run and secret and cfg.get("app_url")) else None)
    if sender is None and not dry_run:
        print("no ingest target")
        if out is not None:
            out.update(fatal=True)
        return 1
    summary = execute(rows, cfg, dry_run=dry_run, run_one=run_one, post=sender or (lambda _p: {"ok": True, "inserted": 0}))
    summary["missing"] = len(missing) + len(sealed_missing)
    summary["skipped_existing"] = skipped_existing
    summary.update(flags)
    return _finish(summary, dry_run, out=out)


_EXIT_RANK = {0: 0, 2: 1, 1: 2}


def _worse(a: int, b: int) -> int:
    return a if _EXIT_RANK.get(a, 2) >= _EXIT_RANK.get(b, 2) else b


def hourly(cfg: dict, *, now: datetime | None = None, dry_run: bool = False, **kw) -> int:
    return _locked(cfg, dry_run, "hourly", lambda: _hourly(cfg, now=now, dry_run=dry_run, **kw))


def _hourly(cfg: dict, *, now: datetime | None = None, dry_run: bool = False, **kw) -> int:
    """run --skip-existing for today (IST), and for yesterday too while the IST hour is < 2. Pending jobs are drained once (the first day)."""
    now = now or datetime.now(timezone.utc)
    days = [current_ist_day(now)]
    if now.astimezone(IST).hour < 2:
        days.append(previous_ist_day(now))
    rc = 0
    for i, day in enumerate(days):
        sub = dict(kw)
        if i:
            sub["pending"] = False
        rc = _worse(rc, run(cfg, day, dry_run=dry_run, skip_existing=True, **sub))
    return rc


MAX_BACKFILL_DAYS = 120
MIN_INDEX_MINUTES = 2


def load_index(path: str, date_from: str, date_to: str) -> tuple[dict[str, list[str]], int]:
    """Cutter clip index (JSONL) -> ({ist_date: [uid]}, malformed line count).

    The last row per consult_uid wins. Kept: ist_date in [from, to] and minutes >= 2. Only consult_uid, ist_date and minutes are read.
    """
    last: dict[str, tuple[str, float]] = {}
    bad = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                uid, day, mins = row["consult_uid"], row["ist_date"], row["minutes"]
                if not isinstance(uid, str) or not uid or isinstance(mins, bool) or not isinstance(mins, (int, float)):
                    raise ValueError
                datetime.fromisoformat(day)
                if len(day) != 10:
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                bad += 1
                continue
            last[uid] = (day, float(mins))
    by_day: dict[str, list[str]] = {}
    for uid, (day, mins) in last.items():
        if date_from <= day <= date_to and mins >= MIN_INDEX_MINUTES:
            by_day.setdefault(day, []).append(uid)
    return by_day, bad

_TOTAL_KEYS = ("eligible", "written", "skipped_existing", "rejected", "failed", "missing_layers", "bundle_failed", "attempts_exhausted",
               "cost_unknown")
_TOTAL_SOURCE = {"written": "posted"}  # the per-day summary still says posted; the total line says written


def backfill(cfg: dict, date_from: str, date_to: str, *, dry_run: bool = False, uids_from_index: str | None = None, **kw) -> int:
    return _locked(cfg, dry_run, "backfill", lambda: _backfill(cfg, date_from, date_to, dry_run=dry_run, uids_from_index=uids_from_index, **kw))


def _backfill(cfg: dict, date_from: str, date_to: str, *, dry_run: bool = False, uids_from_index: str | None = None, **kw) -> int:
    """run --skip-existing for each day from ``date_to`` back to ``date_from``. Stops on a config or day-read failure; partial continues."""
    try:
        d0, d1 = datetime.fromisoformat(date_from).date(), datetime.fromisoformat(date_to).date()
    except ValueError:
        print("config error: backfill dates must be YYYY-MM-DD")
        return 1
    if d1 < d0:
        print("config error: --to is before --from")
        return 1
    if (d1 - d0).days + 1 > MAX_BACKFILL_DAYS:
        print(f"config error: backfill range is over {MAX_BACKFILL_DAYS} days")
        return 1
    kw.setdefault("pending", False)  # historical days: pending jobs are not drained here
    by_day, bad = {}, 0
    if uids_from_index:
        try:
            by_day, bad = load_index(uids_from_index, date_from, date_to)
        except OSError:
            print("config error: --uids-from-index file is not readable")
            return 1
        print(json.dumps({"index": True, "malformed": bad, "uids": sum(len(v) for v in by_day.values())}))
    total = {k: 0 for k in _TOTAL_KEYS}
    total["cost_usd"] = 0.0
    days, rc, d = 0, 0, d1
    while d >= d0:
        out: dict = {}
        day_kw = dict(kw, sealed=sorted(by_day.get(d.isoformat(), []))) if uids_from_index else kw
        code = run(cfg, d.isoformat(), dry_run=dry_run, skip_existing=True, out=out, **day_kw)
        days += 1
        rc = _worse(rc, code)
        for k in _TOTAL_KEYS:
            total[k] += int(out.get(_TOTAL_SOURCE.get(k, k)) or 0)
        total["cost_usd"] += float(out.get("cost_usd") or 0.0)
        if code == 1 and out.get("fatal"):
            break
        d -= timedelta(days=1)
    print(json.dumps({"total": True, "days": days, **total, "cost_usd": round(total["cost_usd"], 6)}))
    return rc


def main(argv: list[str] | None = None, now: datetime | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m tools.eta2freescript.nightly")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "run", "drain"):
        s = sub.add_parser(name)
        s.add_argument("--date")
        s.add_argument("--data", type=Path)
        s.add_argument("--config")
        s.add_argument("--dry-run", action="store_true")
    for name in ("hourly", "backfill"):
        s = sub.add_parser(name)
        s.add_argument("--data", type=Path)
        s.add_argument("--config")
        s.add_argument("--dry-run", action="store_true")
    sub.choices["run"].add_argument("--skip-existing", action="store_true")
    for name in ("run", "backfill"):
        sub.choices[name].add_argument("--max-consults", type=int)
    sub.choices["backfill"].add_argument("--uids-from-index", dest="index_path")
    sub.choices["backfill"].add_argument("--from", dest="date_from", required=True)
    sub.choices["backfill"].add_argument("--to", dest="date_to", required=True)
    a = p.parse_args(argv)
    try:
        cfg = load_config(a.config)
    except NightlyError as e:
        print("config error:", e)
        return 1
    if a.data:
        cfg["data"] = str(a.data)
    if getattr(a, "max_consults", None) is not None:
        if a.max_consults < 1:
            print("config error: --max-consults must be at least 1")
            return 1
        cfg["max_consults"] = a.max_consults
    if a.cmd in ("hourly", "backfill"):
        if not cfg.get("bundle_cmd"):
            print("config error: hourly/backfill need bundle mode")
            return 1
        if a.cmd == "hourly":
            return hourly(cfg, now=now, dry_run=a.dry_run)
        return backfill(cfg, a.date_from, a.date_to, dry_run=a.dry_run, uids_from_index=a.index_path)
    day = current_ist_day(now) if a.date == "today" else (a.date or previous_ist_day())
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
    return run(cfg, day, dry_run=a.dry_run, skip_existing=getattr(a, "skip_existing", False))


def _drain(cfg: dict, dry_run: bool) -> int:
    """Pending jobs only (no day scan)."""
    if not cfg.get("enabled"):
        print("disabled")
        return 0
    secret = os.environ.get("FREESCRIPT_INGEST_SECRET", "").strip()
    if cfg.get("bundle_cmd"):
        if not cfg.get("app_url") or not secret:
            print("no ingest target")
            _config_error_summary(dry_run)
            return 1
        return _locked(cfg, dry_run, "drain", lambda: _run_bundle(cfg, previous_ist_day(), dry_run=dry_run, run_one=None, post=None, pending=None,
                                                                  sealed=False, secret=secret, reb_token=""))
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
