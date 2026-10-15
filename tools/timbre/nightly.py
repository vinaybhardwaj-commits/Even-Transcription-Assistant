"""tools/timbre/nightly.py — the Timbre nightly job (Architecture #79, T-10). GO from Vinay, 11 Oct 2026.

    python -m tools.timbre.nightly run [--date YYYY-MM-DD] [--config tools/timbre/deploy/nightly.json] [--dry-run]
    python -m tools.timbre.nightly plan [--date ...]          # list what would be scored; fetches nothing, scores nothing
    python -m tools.timbre.nightly intraday [--date ...]      # one record-only tick for TODAY (IST); see NIGHTLY.md "Intraday"

Steps, for the previous IST day by default:
  1. GET  <app>/api/timbre/consults?date=D   (HMAC, TIMBRE_INGEST_SECRET). The app reads consult_index (0150) and drops
     held-out room-days (BLIND_ROOM_DAYS) BEFORE anything is returned, so no blind audio is ever fetched.
  2. Budget: estimated Clef cost (~1k input tokens per 10 s window at US$0.15/M) is checked against `budget_usd_daily`;
     consults past the cap (time order) are dropped and the run is stored as state `partial`.
  3. Runs `python -m tools.timbre.pipeline score` (Odyssey arousal, audEERING fallback, Clef-omni valence via Cloudflare
     Workers AI, the saved calibration maps; the text lane stays OFF unless `text_lane` is true). WavLM Aniemore is not used.
  4. Writes run.json + clips.jsonl and POSTs one payload to <app>/api/timbre/ingest (tools/timbre/store.py): one
     transaction per run, idempotent; a re-run is a new run row and readers use affect_consult_latest.
Retention (36 months, every Timbre table) is the app cron /api/cron/timbre-retention, not this job.

SWITCHABLE: nothing runs unless `enabled` is true (config) or TIMBRE_NIGHTLY_ENABLED=1; TIMBRE_NIGHTLY_ENABLED=0 always
wins (the off switch). Compute target `lab_gpu` | `hf_gpu` (both cleared by Vinay) is config / TIMBRE_COMPUTE.
No database credential lives here; no transcript text, names or audio leave the host except as scores.
Exit codes: 0 ok / disabled / nothing to do, 2 partial (budget), 1 failed. A failed or partial run prints `ALERT` lines.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
WINDOW_S = 10.0
TOKENS_PER_WINDOW = 1000
USD_PER_M_TOKENS = 0.15

DEFAULTS: dict = {
    "enabled": False,
    "compute": "lab_gpu",
    "device": "cuda",
    "worker_id": "timbre-nightly",
    "app_url": "",
    "workdir": "/var/lib/timbre-nightly",
    "budget_usd_daily": 2.0,
    "max_consults": 400,
    "speaker": "nemotron",
    "nemotron_dir": None,
    "segments": None,
    "voiceprints": None,
    "embeddings_dir": None,
    "slot_embeddings_dir": None,
    "calibration_arousal": "",
    "calibration_valence": "",
    "calibration_git_sha": "",
    "calibration_fit_on": "gold_batches_1_2",
    "text_lane": False,
    "prepare": True,
    "centroids": "",
    "ecapa_model": "",
    "ecapa_device": "cpu",
    "pipeline_timeout_s": 6 * 3600,
    "pipeline_version": "timbre-v1",
    "arousal_model_id": "odyssey_wavlm_dim.v1",
    "arousal_model_rev": "00d0e12ba9bf957f5aeea36e8663c8c61cb50ac9",
    "fallback_model_id": "audeering_msp_dim.v1",
    "fallback_model_rev": "6eba34a2485ea31cb03600241787c3a5edab8626",
    "valence_model_id": "@cf/cloudflare/clef-omni",
    "valence_model_rev": None,
    "clef_question_set": "timbre-clef-v1",
    "purity_rule_version": "purity-rule-v1",
    "purity_rule_json": {"min_purity": 0.6, "min_pure_s": 3.0, "min_cos_patient_mean": 0.3},
    "nemotron_model_rev": None,
}
ENV_OVERRIDES = {
    "TIMBRE_COMPUTE": "compute",
    "TIMBRE_APP_URL": "app_url",
    "TIMBRE_WORKDIR": "workdir",
    "TIMBRE_BUDGET_USD_DAILY": "budget_usd_daily",
    "TIMBRE_DEVICE": "device",
}


class NightlyError(RuntimeError):
    pass


def load_config(path: str | None, env: dict | None = None) -> dict:
    env = os.environ if env is None else env
    cfg = dict(DEFAULTS)
    if path:
        cfg.update(json.loads(Path(path).read_text(encoding="utf-8")))
    for var, key in ENV_OVERRIDES.items():
        if env.get(var, "").strip():
            cfg[key] = float(env[var]) if key == "budget_usd_daily" else env[var].strip()
    flag = env.get("TIMBRE_NIGHTLY_ENABLED", "").strip().lower()
    if flag in ("0", "false", "off", "no"):
        cfg["enabled"] = False
    elif flag in ("1", "true", "on", "yes"):
        cfg["enabled"] = True
    elif flag:
        raise NightlyError("TIMBRE_NIGHTLY_ENABLED has an unrecognised value")
    if cfg["compute"] not in ("lab_gpu", "hf_gpu", "cpu_dev"):
        raise NightlyError("compute must be lab_gpu, hf_gpu or cpu_dev")
    return cfg


def previous_ist_day(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return (now.astimezone(IST).date() - timedelta(days=1)).isoformat()


def sign_get(path_and_query: str, secret: str, ts: int) -> str:
    """HMAC-SHA256(secret, f"{ts}.GET {path_and_query}") — lib/timbre/auth.ts::checkTimbreGet."""
    return hmac.new(secret.encode(), f"{ts}.GET {path_and_query}".encode(), hashlib.sha256).hexdigest()


def fetch_consults(app_url: str, day: str, secret: str, timeout: float = 60.0) -> dict:
    pq = "/api/timbre/consults?" + urllib.parse.urlencode({"date": day})
    ts = int(time.time())
    req = urllib.request.Request(app_url.rstrip("/") + pq, headers={"x-timbre-ts": str(ts), "x-timbre-signature": sign_get(pq, secret, ts)})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (operator-configured URL)
        body = json.loads(resp.read().decode("utf-8"))
    if not isinstance(body, dict) or not body.get("ok") or not isinstance(body.get("consults"), list):
        raise NightlyError("consults route returned an unexpected body")
    return body


def estimate_usd(duration_s: float) -> float:
    return max(1.0, duration_s / WINDOW_S) * TOKENS_PER_WINDOW * USD_PER_M_TOKENS / 1e6


def plan(consults: list[dict], cfg: dict) -> tuple[list[dict], dict]:
    """Time-ordered; drops clipless rows, and everything past max_consults or the daily budget."""
    rows = sorted((c for c in consults if c.get("clip_r2_key")), key=lambda c: (int(c.get("t0_ms") or 0), c["consult_uid"]))
    kept, spend, cut_budget, cut_max = [], 0.0, 0, 0
    for c in rows:
        dur = max(0.0, (int(c["t1_ms"]) - int(c["t0_ms"])) / 1000.0)
        usd = estimate_usd(dur)
        if len(kept) >= int(cfg["max_consults"]):
            cut_max += 1
            continue
        if spend + usd > float(cfg["budget_usd_daily"]):
            cut_budget += 1
            continue
        kept.append({**c, "duration_s": dur})
        spend += usd
    info = {"eligible": len(rows), "kept": len(kept), "dropped_budget": cut_budget, "dropped_max": cut_max, "skipped_unsealed_or_no_clip": len(consults) - len(rows), "cost_usd_est": round(spend, 4)}
    return kept, info


def write_inputs(kept: list[dict], day: str, work: Path, speaker: str = "nemotron", *, local_audio: bool = False) -> tuple[Path, Path]:
    """kept: consults, or prepared PARTS (clip_id, offset_ms, duration_s; local_audio=True: audio is in the prepare dir)."""
    import csv

    work.mkdir(parents=True, exist_ok=True)
    sessions, clips = work / "sessions.csv", work / "clips.jsonl"
    with sessions.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["clip_id", "room", "date", "duration_s", "lang", "phase", "doctor_uid8", "r2_key"])
        for c in kept:
            w.writerow([c.get("clip_id") or c["consult_uid"], c.get("room_slug") or c.get("room_id") or "", day, f"{c['duration_s']:.3f}", "", "consult", c.get("doctor_uid8") or "", "" if local_audio else c["clip_r2_key"]])
    with clips.open("w", encoding="utf-8") as fh:
        for c in kept:
            fh.write(json.dumps({
                "clip_id": c.get("clip_id") or c["consult_uid"], "consult_uid": c["consult_uid"], "cut_version": c["cut_version"], "t0_ms": int(c["t0_ms"]),
                "offset_ms": int(c.get("offset_ms") or 0), "ist_date": day, "room_id": c.get("room_id"), "room_slug": c.get("room_slug"),
                "session_id": c.get("session_id"), "doctor_uid8": c.get("doctor_uid8"), "diarize_engine": speaker, "diarize_ref": c.get("nemotron_ref"),
            }, sort_keys=True) + "\n")
    return sessions, clips


def pipeline_cmd(cfg: dict, sessions: Path, out: Path, prep: Path | None = None) -> list[str]:
    cmd = [sys.executable, "-m", "tools.timbre.pipeline", "score", "--sessions", str(sessions), "--out", str(out),
           "--device", str(cfg["device"]), "--speaker", str(cfg["speaker"]),
           "--calibration-arousal", str(cfg["calibration_arousal"]), "--calibration-valence", str(cfg["calibration_valence"])]
    for key, flag in (("nemotron_dir", "--nemotron-dir"), ("segments", "--segments"), ("voiceprints", "--voiceprints"),
                      ("embeddings_dir", "--embeddings-dir"), ("slot_embeddings_dir", "--slot-embeddings-dir")):
        if cfg.get(key):
            cmd += [flag, str(cfg[key])]
    if prep is not None:  # nightly_prepare outputs replace the configured dirs
        for flag, sub in (("--audio-dir", "audio"), ("--nemotron-dir", "nlp"), ("--slot-embeddings-dir", "slots"), ("--embeddings-dir", "emb")):
            if flag in cmd:
                i = cmd.index(flag)
                del cmd[i:i + 2]
            cmd += [flag, str(prep / sub)]
        if "--voiceprints" in cmd:
            i = cmd.index("--voiceprints")
            del cmd[i:i + 2]
        cmd += ["--voiceprints", str(prep / "voiceprints.json")]
    else:
        cmd.append("--r2")
    if cfg.get("text_lane"):
        cmd.append("--text-lane")
    return cmd


def git_sha() -> str:
    sha = os.environ.get("TIMBRE_GIT_SHA", "").strip()
    if not sha:
        sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False).stdout.strip()
    if len(sha) != 40:
        raise NightlyError("cannot determine a 40-char git sha (set TIMBRE_GIT_SHA)")
    return sha


def manifest(cfg: dict, day: str, info: dict, *, sha: str, started: str, finished: str, gpu_s: float, state: str, withheld_blind: int, job: str = "timbre-nightly") -> dict:
    keys = ("pipeline_version", "compute", "device", "worker_id", "nemotron_model_rev", "arousal_model_id", "arousal_model_rev",
            "fallback_model_id", "fallback_model_rev", "valence_model_id", "valence_model_rev", "clef_question_set",
            "purity_rule_version", "purity_rule_json", "calibration_git_sha", "calibration_fit_on")
    m = {k: cfg.get(k) for k in keys}
    m.update({
        "git_sha": sha, "speaker_source": cfg["speaker"], "text_lane_on": bool(cfg.get("text_lane")), "state": state,
        "scope_json": {"job": job, "ist_date": day, "withheld_blind_room_days": withheld_blind, **info},
        "timing_json": {"wall_s": round((datetime.fromisoformat(finished) - datetime.fromisoformat(started)).total_seconds(), 1)},
        "gpu_seconds": round(gpu_s, 1), "cost_usd_est": info["cost_usd_est"], "started_at": started, "finished_at": finished,
        "calibration_arousal_path": cfg["calibration_arousal"], "calibration_valence_path": cfg["calibration_valence"],
    })
    m["calibration_git_sha"] = m.get("calibration_git_sha") or sha
    return m


def _score_and_store(day: str, cfg: dict, kept: list[dict], info: dict, withheld: int, started: str, secret: str, *, job: str,
                     runner, post, preparer) -> tuple[int, list[dict]]:
    """Prepare -> pipeline -> manifest -> POST for already-planned consults. Returns (exit code, scored) where `scored` is one
    {consult_uid, windows, cost_usd_est} per consult that has windows in an ok-ingested payload; it is empty on every
    failure, on a nothing-to-score outcome and on a partial-before-store exit."""
    work = Path(cfg["workdir"]) / day / datetime.now(timezone.utc).strftime("%H%M%S")
    prep_dir = None
    t0 = time.monotonic()
    prepared = None
    if cfg.get("prepare") and cfg["speaker"] == "nemotron":
        prep_dir = work / "prep"
        prep_dir.mkdir(parents=True, exist_ok=True)
        if preparer is None:
            from tools.timbre import nightly_prepare

            nightly_prepare.voiceprints_from_centroids(str(cfg["centroids"]), prep_dir / "voiceprints.json")
            embed = nightly_prepare.ecapa_embedder(str(cfg["ecapa_model"]), str(cfg.get("ecapa_device") or "cpu"))
            prepared = nightly_prepare.prepare(kept, prep_dir, embed=embed)
        else:
            prepared = preparer(kept, prep_dir)
        info.update({"prepared_parts": len(prepared.clips), "no_diarization": len(prepared.no_diarization),
                     "audio_errors": len(prepared.audio_errors), "parts_short": prepared.parts_short, "parts_no_nlp": prepared.parts_no_nlp})
        print(f"[{job}] prepared: {len(prepared.clips)} part(s) from {len({c['consult_uid'] for c in prepared.clips})} consult(s); "
              f"no_diarization={len(prepared.no_diarization)} audio_errors={len(prepared.audio_errors)}")
        if not prepared.clips:
            print(f"[{job}] no consult has Nemotron diarization for this day; nothing to score")
            return 0, []
        sessions, clips = write_inputs(prepared.clips, day, work, str(cfg["speaker"]), local_audio=True)
    else:
        sessions, clips = write_inputs(kept, day, work, str(cfg["speaker"]))
    out = work / "out"
    proc = runner(pipeline_cmd(cfg, sessions, out, prep_dir), timeout=int(cfg["pipeline_timeout_s"]), check=False)
    gpu_s = time.monotonic() - t0
    if getattr(proc, "returncode", 1) != 0 or not (out / "windows.parquet").is_file():
        print(f"ALERT [{job}] pipeline failed for {day} (exit {getattr(proc, 'returncode', '?')}); nothing stored")
        return 1, []
    state = "partial" if info["dropped_budget"] or info["dropped_max"] else "ok"
    man = manifest(cfg, day, info, sha=git_sha(), started=started, finished=datetime.now(timezone.utc).isoformat(), gpu_s=gpu_s, state=state, withheld_blind=withheld, job=job)
    man_path = work / "run.json"
    man_path.write_text(json.dumps(man, indent=2, sort_keys=True), encoding="utf-8")
    from tools.timbre import store

    payload = store.build_from_files(str(out / "windows.parquet"), str(man_path), str(clips), str(out / "consults.json") if (out / "consults.json").is_file() else None)
    result = (post or store.post_payload)(payload, cfg["app_url"].rstrip("/") + "/api/timbre/ingest", secret)
    print(f"[{job}] stored: {json.dumps(result, sort_keys=True)}")
    scored: list[dict] = []
    if isinstance(result, dict) and result.get("ok"):
        counts: dict[str, int] = {}
        for w in payload.get("windows") or []:
            uid = w.get("consult_uid")
            if uid:
                counts[uid] = counts.get(uid, 0) + 1
        by_uid = {c["consult_uid"]: c for c in kept}
        scored = [{"consult_uid": uid, "windows": n, "run_id": result.get("run_id"), "cut_version": by_uid[uid].get("cut_version"),
                   "cost_usd_est": round(estimate_usd(by_uid[uid]["duration_s"]), 6)}
                  for uid, n in sorted(counts.items()) if uid in by_uid]
    if state == "partial":
        print(f"ALERT [{job}] {day} is PARTIAL: {info['dropped_budget']} consult(s) over the daily budget, {info['dropped_max']} over max_consults")
        return 2, scored
    return 0, scored


def run(day: str, cfg: dict, *, dry_run: bool = False, runner=subprocess.run, fetch=fetch_consults, post=None, preparer=None) -> int:
    if not cfg["enabled"]:
        print("[timbre-nightly] disabled (TIMBRE_NIGHTLY_ENABLED / config enabled) — nothing to do")
        return 0
    secret = os.environ.get("TIMBRE_INGEST_SECRET", "").strip()
    if not cfg["app_url"] or not secret:
        print("ALERT [timbre-nightly] app_url or TIMBRE_INGEST_SECRET not set")
        return 1
    started = datetime.now(timezone.utc).isoformat()
    body = fetch(cfg["app_url"], day, secret)
    kept, info = plan(body["consults"], cfg)
    withheld = int(body.get("withheld_blind") or 0)
    print(f"[timbre-nightly] {day}: {info} withheld_blind={withheld}")
    if not kept:
        print("[timbre-nightly] nothing to score")
        return 0
    if dry_run:
        return 0
    return _score_and_store(day, cfg, kept, info, withheld, started, secret, job="timbre-nightly", runner=runner, post=post, preparer=preparer)[0]


# ------------------------------------------------------------------------------------------------------------ intraday

JOB_INTRADAY = "timbre-intraday"


def today_ist(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(IST).date().isoformat()


def _versions(cfg: dict) -> dict:
    return {"pipeline_version": cfg.get("pipeline_version"), "valence_model_rev": cfg.get("valence_model_rev"), "arousal_model_rev": cfg.get("arousal_model_rev")}


_LEDGER_VERSION_KEYS = ("pipeline_version", "valence_model_rev", "arousal_model_rev", "cut_version")


def _good_ledger_row(row: object) -> bool:
    """Shape check for one parsed ledger row. cost_usd_est must be a finite number >= 0 (not bool); consult_uid a non-empty str;
    ist_date a str; the version fields a str or null (a missing key reads as null)."""
    if not isinstance(row, dict):
        return False
    uid, day, cost = row.get("consult_uid"), row.get("ist_date"), row.get("cost_usd_est")
    if not (isinstance(uid, str) and uid) or not isinstance(day, str):
        return False
    if isinstance(cost, bool) or not isinstance(cost, (int, float)):
        return False
    try:
        if not (math.isfinite(cost) and cost >= 0):
            return False
    except OverflowError:
        return False
    return all(row.get(k) is None or isinstance(row.get(k), str) for k in _LEDGER_VERSION_KEYS)


def read_ledger(path: Path) -> tuple[list[dict], int]:
    """(usable rows, bad-row count). A row that is not JSON or fails `_good_ledger_row` (bad consult_uid, ist_date, version field, or a
    cost that is not a finite number >= 0), or has invalid UTF-8, is skipped and counted, never fatal; its consult may be re-scored."""
    rows: list[dict] = []
    bad = 0
    if not path.is_file():
        return rows, bad
    for raw in path.read_bytes().split(b"\n"):
        if not raw.strip(b"\x00 \t\r"):
            continue
        try:
            row = json.loads(raw.decode("utf-8", errors="replace"))
        except (ValueError, RecursionError):
            bad += 1
            continue
        if not _good_ledger_row(row):
            bad += 1
            continue
        rows.append(row)
    return rows, bad


def append_ledger(path: Path, scored: list[dict], day: str, cfg: dict) -> None:
    """Append-only, consult_uids and counts only (no text, no doctor id). Called only after an ok ingest."""
    ts = datetime.now(timezone.utc).isoformat()
    torn = False
    if path.is_file() and path.stat().st_size > 0:
        with path.open("rb") as raw:
            raw.seek(-1, os.SEEK_END)
            torn = raw.read(1) != b"\n"
    with path.open("a", encoding="utf-8") as fh:
        if torn:
            fh.write("\n")
        for s in scored:
            fh.write(json.dumps({"consult_uid": s["consult_uid"], "ist_date": day, **_versions(cfg), "run_id": s.get("run_id"), "cut_version": s.get("cut_version"), "windows": s["windows"],
                                 "cost_usd_est": s["cost_usd_est"], "ts": ts}, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def intraday(day: str, cfg: dict, *, dry_run: bool = False, runner=subprocess.run, fetch=fetch_consults, post=None, preparer=None) -> int:
    """One intraday tick for IST date `day`. Record-only; idempotent per (consult_uid, pipeline/valence/arousal versions)."""
    if not cfg["enabled"]:
        print("[timbre-intraday] disabled (TIMBRE_NIGHTLY_ENABLED / config enabled) — nothing to do")
        return 0
    secret = os.environ.get("TIMBRE_INGEST_SECRET", "").strip()
    if not cfg["app_url"] or not secret:
        print("ALERT [timbre-intraday] app_url or TIMBRE_INGEST_SECRET not set")
        return 1
    import fcntl

    workdir = Path(cfg["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    with (workdir / "intraday.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("[timbre-intraday] busy")
            return 0
        started = datetime.now(timezone.utc).isoformat()
        ledger_path = workdir / "intraday-ledger.jsonl"
        rows, bad_rows = read_ledger(ledger_path)
        print(f"[timbre-intraday] ledger_bad_rows={bad_rows}")
        ver = _versions(cfg)
        done = {(r["consult_uid"], r.get("cut_version")) for r in rows if all(r.get(k) == v for k, v in ver.items())}
        spent = sum(float(r.get("cost_usd_est") or 0.0) for r in rows if r.get("ist_date") == day)
        body = fetch(cfg["app_url"], day, secret)
        todo = [c for c in body["consults"] if (c.get("consult_uid"), c.get("cut_version")) not in done]
        remaining = max(0.0, float(cfg["budget_usd_daily"]) - spent)
        kept, info = plan(todo, dict(cfg, budget_usd_daily=remaining))
        info.update({"already_done": len(body["consults"]) - len(todo), "spent_usd_before": round(spent, 4)})
        withheld = int(body.get("withheld_blind") or 0)
        print(f"[timbre-intraday] {day}: {info} withheld_blind={withheld}")
        if not kept:
            if info["dropped_budget"] or info["dropped_max"]:
                print(f"ALERT [timbre-intraday] {day} is PARTIAL: {info['dropped_budget']} consult(s) over the daily budget, {info['dropped_max']} over max_consults")
                return 2
            print("[timbre-intraday] nothing to score")
            return 0
        if dry_run:
            return 0
        rc, scored = _score_and_store(day, cfg, kept, info, withheld, started, secret, job=JOB_INTRADAY, runner=runner, post=post, preparer=preparer)
        if scored:
            append_ledger(ledger_path, scored, day, cfg)
        return rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tools.timbre.nightly")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "plan", "intraday"):
        s = sub.add_parser(name)
        s.add_argument("--date", default=None, help="IST date; default today (IST) for intraday, the previous IST day for run/plan")
        s.add_argument("--config", default=os.environ.get("TIMBRE_NIGHTLY_CONFIG"))
        if name in ("run", "intraday"):
            s.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    day = args.date or (today_ist() if args.cmd == "intraday" else previous_ist_day())
    date.fromisoformat(day)
    try:
        cfg = load_config(args.config)
        if args.cmd == "intraday":
            return intraday(day, cfg, dry_run=bool(args.dry_run))
        return run(day, cfg, dry_run=(args.cmd == "plan" or bool(getattr(args, "dry_run", False))))
    except Exception as exc:  # noqa: BLE001 — every failure is one ALERT line and exit 1
        print(f"ALERT [{'timbre-intraday' if args.cmd == 'intraday' else 'timbre-nightly'}] {day} failed: {type(exc).__name__}: {str(exc)[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
