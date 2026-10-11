"""Timbre T-9 writer: load pipeline outputs into the ``affect_*`` tables (migration 0155, Architecture #78).

Inputs (all box/GPU-host private; this module never prints ids or scores, counts only):

* ``windows.parquet``  pipeline per-window table (``python -m tools.timbre.pipeline``)
* ``consults.json``    pipeline per-consult table (used as a cross-check on window counts)
* ``run.json``         run manifest written by the nightly job (``tools/timbre/nightly.py``) or by hand for a backfill
* ``clips.jsonl``      one line per pipeline ``clip_id``: the ETA keys it maps to
                       ``{clip_id, consult_uid, cut_version, t0_ms, ist_date, room_id?, room_slug?, room_label?, session_id?,
                         doctor_uid8?, diarize_engine, diarize_ref?, speaker_idx?, doctor_slot?}``
* the two calibration JSON files named in the manifest

Output: one JSON *payload* ``{version, calibration_arousal, calibration_valence, run, windows, consults}`` whose keys are the
table columns. It is delivered one of two ways, both a single transaction and both idempotent (a second load of the same
inputs finds the run by ``input_manifest_sha256`` + ``git_sha`` + calibration map ids and inserts nothing):

* ``post``  HMAC-signed POST to the app ingest route ``/api/timbre/ingest`` (the nightly path; no DB credential on the GPU host)
* ``psql``  direct, for an operator backfill from the box: the same statement through ``psql`` with ``--dsn-env``

Writer rules (#78/#79):

* ``scorable=True`` with ``arousal_source='none'`` or ``valence_status!='ok'`` -> unscorable / ``model_error``.
* Unscorable rows carry no A/V at all (raw and calibrated NULL); scorable rows carry raw AND calibrated (test 10 ruling:
  raw is the default for trends, calibrated is display-only 1-5). Missing calibrated values are filled from the run's maps.
* Consult rows are recomputed from the mapped windows so the per-reason counts always sum to ``n_windows - n_scorable``.
* No transcript text, names, audio or URLs: the text lane contributes scores and codes only, and only when the run had it on.
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
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

PAYLOAD_VERSION = "timbre-store-v1"
REASONS = (
    "no_voiceprint",
    "no_patient",
    "low_purity",
    "short_pure_speech",
    "low_patient_cosine",
    "overlap",
    "too_short",
    "attender_speaks_for_patient",
    "model_error",
)
LEVELS = ("room", "doctor", "global")
ENGINES = ("nemotron", "segments")
COMPUTE = ("lab_gpu", "hf_gpu", "cpu_dev")
ODYSSEY_COL = "odyssey_wavlm_dim.v1__arousal"
AUDEERING_COL = "audeering_msp_dim.v1__arousal"
CLEF_COL = "clef_omni_valence.v1__valence"
RUN_REQUIRED = (
    "pipeline_version",
    "git_sha",
    "compute",
    "speaker_source",
    "arousal_model_id",
    "arousal_model_rev",
    "fallback_model_id",
    "fallback_model_rev",
    "valence_model_id",
    "clef_question_set",
    "purity_rule_version",
    "purity_rule_json",
    "scope_json",
)
FORBIDDEN_KEYS = ("text", "transcript", "name", "url", "audio", "r2_key", "clip_path", "presigned")


class StoreError(ValueError):
    """Bad input. Messages carry counts and column names only, never ids or values."""


# ---------------------------------------------------------------------------------------------------------------- helpers


def _num(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _str(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    s = str(value).strip()
    return s or None


def canonical_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def window_key(consult_uid: str, start_ms: int) -> str:
    """``<consult_uid>_p<start_ms, 7 digits>`` (tools/timbre/windows.py convention)."""
    return f"{consult_uid}_p{int(start_ms):07d}"


# ---------------------------------------------------------------------------------------------------------------- inputs


def load_clips(path: str | Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        rec = json.loads(line)
        for key in ("clip_id", "consult_uid", "cut_version", "ist_date", "diarize_engine"):
            if not _str(rec.get(key)):
                raise StoreError(f"clips line {n}: {key} is missing")
        if rec["diarize_engine"] not in ENGINES:
            raise StoreError(f"clips line {n}: diarize_engine must be one of {ENGINES}")
        if rec["clip_id"] in out:
            raise StoreError(f"clips line {n}: duplicate clip_id")
        out[rec["clip_id"]] = rec
    return out


def calibration_row(path: str | Path, *, target: str, git_sha: str, fit_on: str) -> dict:
    blob = json.loads(Path(path).read_text(encoding="utf-8"))
    for bad in ("window_id", "window_ids", "labels", "rows"):
        if bad in blob:
            raise StoreError(f"calibration {target}: carries '{bad}'; maps must be aggregates only")
    text = canonical_json(blob)
    return {
        "target": target,
        "score_col": blob.get("score_col") or (ODYSSEY_COL if target == "arousal" else CLEF_COL),
        "calib_version": blob.get("version") or "timbre-calib-v1",
        "min_n": int(blob.get("min_n") or 8),
        "fit_on": fit_on,
        "git_sha": git_sha,
        "sha256": sha256_text(text),
        "payload": blob,
    }


def ensure_calibrated(frame: pd.DataFrame, cal_a: dict | None, cal_v: dict | None) -> pd.DataFrame:
    """Fill calibrated A/V (and level) for scorable rows that came out ``uncalibrated``, using the run's maps."""
    from tools.timbre.calibrate import apply_calibration

    out = frame.copy()
    scorable = out["scorable"].astype(bool)
    for target, calib, src in (("arousal", cal_a, "arousal_raw"), ("valence", cal_v, "valence_raw")):
        cal_col, lvl_col = f"{target}_calibrated", f"{target}_calibration_level"
        if cal_col not in out.columns:
            out[cal_col] = np.nan
        if lvl_col not in out.columns:
            out[lvl_col] = "uncalibrated"
        need = scorable & ~np.isfinite(pd.to_numeric(out[cal_col], errors="coerce").to_numpy(dtype=float))
        if not need.any() or calib is None:
            continue
        part = out.loc[need].copy()
        part["_x"] = pd.to_numeric(part[src], errors="coerce")
        applied = apply_calibration(part, calib, score_col="_x")
        out.loc[need, cal_col] = applied["_x__calibrated"].to_numpy()
        out.loc[need, lvl_col] = applied["_x__calibration_level"].to_numpy()
    return out


# ---------------------------------------------------------------------------------------------------------------- mapping


def map_window(row: dict, clip: dict, *, text_lane_on: bool) -> dict:
    """One pipeline row -> one ``affect_window`` row (column names are the table's)."""
    start_s, end_s = float(row["start_s"]), float(row["end_s"])
    start_ms, end_ms = int(round(start_s * 1000)), int(round(end_s * 1000))
    if end_ms <= start_ms:
        end_ms = start_ms + 1
    t0 = clip.get("t0_ms")
    reason = _str(row.get("reason"))
    scorable = bool(row.get("scorable")) and not reason
    a_raw, v_raw = _num(row.get("arousal_raw")), _num(row.get("valence_raw"))
    a_cal, v_cal = _num(row.get("arousal_calibrated")), _num(row.get("valence_calibrated"))
    a_lvl, v_lvl = _str(row.get("arousal_calibration_level")), _str(row.get("valence_calibration_level"))
    source = _str(row.get("arousal_source")) or "none"
    if scorable:
        broken = (
            source == "none"
            or (_str(row.get("valence_status")) or "") != "ok"
            or a_raw is None
            or v_raw is None
            or not (1.0 <= v_raw <= 5.0)
            or a_cal is None
            or v_cal is None
            or a_lvl not in LEVELS
            or v_lvl not in LEVELS
        )
        if broken:
            scorable, reason = False, "model_error"
    if not scorable:
        reason = reason if reason in REASONS else ("model_error" if reason is None else _reason_or_fail(reason))
    out = {
        "consult_uid": clip["consult_uid"],
        "cut_version": clip["cut_version"],
        "window_key": window_key(clip["consult_uid"], start_ms),
        "start_ms": start_ms,
        "end_ms": end_ms,
        "abs_start_ms": int(t0) + start_ms if t0 is not None else None,
        "abs_end_ms": int(t0) + end_ms if t0 is not None else None,
        "room_day_id": _str(clip.get("room_day_id")),
        "bench_window_id": _str(clip.get("bench_window_id")),
        "session_id": _str(clip.get("session_id")),
        "diarize_engine": clip["diarize_engine"],
        "diarize_ref": _str(clip.get("diarize_ref")),
        "speaker_idx": _int_or_none(row.get("patient_slot", clip.get("speaker_idx"))),
        "doctor_slot": _int_or_none(row.get("doctor_slot", clip.get("doctor_slot"))),
        "phase": _str(row.get("phase")),
        "lang": _str(row.get("lang")),
        "purity": _unit(row.get("purity")),
        "purity_embedding": _unit(row.get("purity_embedding")),
        "purity_probs": _unit(row.get("purity_probs")),
        "pure_patient_s": _nonneg(row.get("pure_patient_s")),
        "patient_cosine": _num(row.get("patient_cosine")),
        "scorable": scorable,
        "unscorable_reason": None if scorable else reason,
        "arousal_raw": a_raw if scorable else None,
        "arousal_calibrated": a_cal if scorable else None,
        "arousal_calibration_level": a_lvl if scorable else None,
        "arousal_model": ("audeering_fallback" if source == "audeering" else "odyssey") if scorable else None,
        "odyssey_arousal_raw": _num(row.get(ODYSSEY_COL)),
        "audeering_arousal_raw": _num(row.get(AUDEERING_COL)),
        "valence_raw": v_raw if scorable else None,
        "valence_calibrated": v_cal if scorable else None,
        "valence_calibration_level": v_lvl if scorable else None,
        "text_valence": None,
        "text_arousal": None,
        "text_status": None,
        "text_language": None,
    }
    if text_lane_on:
        out["text_valence"] = _num(row.get("text_valence"))
        out["text_arousal"] = _num(row.get("text_arousal"))
        out["text_status"] = _str(row.get("text_status"))
        out["text_language"] = _str(row.get("text_language"))
    return out


def _reason_or_fail(reason: str) -> str:
    raise StoreError(f"unknown unscorable reason (one of {len(REASONS)} expected)")


def _int_or_none(value) -> int | None:
    f = _num(value)
    return int(f) if f is not None else None


def _unit(value) -> float | None:
    f = _num(value)
    if f is None:
        return None
    return min(1.0, max(0.0, f))


def _nonneg(value) -> float | None:
    f = _num(value)
    return None if f is None else max(0.0, f)


def _median(values: list[float]) -> float | None:
    return float(np.median(values)) if values else None


def _thirds(values: list[float]) -> tuple[float | None, float | None, float | None]:
    """Pipeline ``_thirds`` semantics on an already time-ordered list."""
    n = len(values)
    if n == 0:
        return None, None, None
    if n == 1:
        return values[0], None, values[0]
    if n == 2:
        return values[0], None, values[1]
    edges = [0, n // 3, (2 * n) // 3, n]
    out = []
    for i in range(3):
        chunk = values[edges[i] : edges[i + 1]]
        out.append(float(np.median(chunk)) if chunk else None)
    return out[0], out[1], out[2]


def consult_rows(windows: list[dict], clips_by_uid: dict[tuple[str, str], dict]) -> list[dict]:
    """Recompute one ``affect_consult`` row per (consult_uid, cut_version) from the mapped windows."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for w in windows:
        groups.setdefault((w["consult_uid"], w["cut_version"]), []).append(w)
    rows = []
    for key in sorted(groups):
        part = sorted(groups[key], key=lambda w: (w["start_ms"], w["window_key"]))
        clip = clips_by_uid[key]
        n = len(part)
        ok = [w for w in part if w["scorable"]]
        k = len(ok)
        row = {
            "consult_uid": key[0],
            "cut_version": key[1],
            "encounter_consult_key": _str(clip.get("encounter_consult_key")),
            "room_id": _str(clip.get("room_id")),
            "room_slug": _str(clip.get("room_slug")) or _str(clip.get("room_label")),
            "ist_date": clip["ist_date"],
            "doctor_uid8": _str(clip.get("doctor_uid8")),
            "n_windows": n,
            "n_scorable": k,
            "scorable_pct": round(100.0 * k / n, 4) if n else None,
        }
        for target in ("arousal", "valence"):
            for kind, col in (("", f"{target}_calibrated"), ("raw_", f"{target}_raw")):
                vals = [float(w[col]) for w in ok]
                o, m, c = _thirds(vals)
                row[f"{target}_{kind}median"] = _median(vals)
                row[f"{target}_{kind}open"] = o
                row[f"{target}_{kind}mid"] = m
                row[f"{target}_{kind}close"] = c
        for reason in REASONS:
            row[f"n_{reason}"] = sum(1 for w in part if not w["scorable"] and w["unscorable_reason"] == reason)
        rows.append(row)
    return rows


def build_payload(
    frame: pd.DataFrame,
    manifest: dict,
    clips: dict[str, dict],
    *,
    consults_json: dict | None = None,
    cal_a: dict | None = None,
    cal_v: dict | None = None,
    input_sha256: str | None = None,
) -> dict:
    missing = [k for k in RUN_REQUIRED if manifest.get(k) in (None, "")]
    if missing:
        raise StoreError(f"run manifest is missing: {', '.join(missing)}")
    if manifest["compute"] not in COMPUTE:
        raise StoreError(f"compute must be one of {COMPUTE}")
    text_lane_on = bool(manifest.get("text_lane_on"))
    unknown = sorted(set(frame["clip_id"].astype(str)) - set(clips))
    if unknown:
        raise StoreError(f"{len(unknown)} clip(s) have no clips.jsonl entry")
    a_map = cal_a["payload"] if cal_a else None
    v_map = cal_v["payload"] if cal_v else None
    frame = ensure_calibrated(frame, a_map, v_map)
    windows = [map_window(r, clips[str(r["clip_id"])], text_lane_on=text_lane_on) for r in frame.to_dict("records")]
    keys = [(w["consult_uid"], w["window_key"]) for w in windows]
    if len(set(keys)) != len(keys):
        raise StoreError("two windows map to the same window_key")
    by_uid = {(c["consult_uid"], c["cut_version"]): c for c in clips.values()}
    consults = consult_rows(windows, by_uid)
    if consults_json is not None:
        expect = {str(c["clip_id"]): int(c["n_windows"]) for c in consults_json.get("consults", [])}
        got: dict[str, int] = {}
        for r in frame["clip_id"].astype(str):
            got[r] = got.get(r, 0) + 1
        if expect and expect != got:
            raise StoreError("consults.json window counts disagree with windows.parquet")
    n_scorable = sum(1 for w in windows if w["scorable"])
    run = {k: manifest.get(k) for k in (
        "pipeline_version", "git_sha", "compute", "device", "worker_id", "speaker_source", "nemotron_model_rev",
        "arousal_model_id", "arousal_model_rev", "fallback_model_id", "fallback_model_rev", "valence_model_id",
        "valence_model_rev", "clef_question_set", "purity_rule_version", "purity_rule_json", "text_question_set",
        "scope_json", "timing_json", "gpu_seconds", "clef_input_tokens", "cost_usd_est", "started_at", "finished_at",
    )}
    run["text_lane_on"] = text_lane_on
    if not text_lane_on:
        run["text_question_set"] = None
    run["state"] = manifest.get("state") or "ok"
    run["error_code"] = manifest.get("error_code") if run["state"] == "failed" else None
    run["input_manifest_sha256"] = input_sha256 or sha256_text(canonical_json({"m": manifest, "n": len(windows)}))
    run["n_consults"] = len(consults)
    run["n_windows"] = len(windows)
    run["n_scorable"] = n_scorable
    run["n_fallback"] = sum(1 for w in windows if w["arousal_model"] == "audeering_fallback")
    run["n_clef_calls"] = int(manifest.get("n_clef_calls") or (frame["valence_status"].isin(["ok", "error"]).sum() if "valence_status" in frame else 0))
    run["n_text"] = sum(1 for w in windows if w["text_status"] == "ok")
    payload = {
        "version": PAYLOAD_VERSION,
        "calibration_arousal": cal_a,
        "calibration_valence": cal_v,
        "run": run,
        "windows": windows,
        "consults": consults,
    }
    assert_clean(payload)
    return payload


def assert_clean(payload: dict) -> None:
    """No text/name/url/audio keys anywhere in the payload (calibration maps are aggregates; checked separately)."""
    for section in ("windows", "consults"):
        for row in payload[section][:1]:
            for key in row:
                low = key.lower()
                if low.startswith("text_"):
                    continue
                if any(bad in low for bad in FORBIDDEN_KEYS):
                    raise StoreError(f"{section} carries a forbidden column '{key}'")
    for key in payload["run"]:
        if any(bad == key.lower() for bad in FORBIDDEN_KEYS):
            raise StoreError(f"run carries a forbidden key '{key}'")


# ---------------------------------------------------------------------------------------------------------------- SQL

_RUN_COLS = (
    "pipeline_version", "git_sha", "compute", "device", "worker_id", "speaker_source", "nemotron_model_rev",
    "arousal_model_id", "arousal_model_rev", "fallback_model_id", "fallback_model_rev", "valence_model_id",
    "valence_model_rev", "clef_question_set", "purity_rule_version", "purity_rule_json", "text_lane_on", "text_question_set",
    "scope_json", "input_manifest_sha256", "state", "error_code", "n_consults", "n_windows", "n_scorable", "n_fallback",
    "n_clef_calls", "n_text", "finished_at", "timing_json", "gpu_seconds", "clef_input_tokens", "cost_usd_est",
)


def _cal_cte(name: str, key: str) -> str:
    return f"""{name} AS (
  INSERT INTO affect_calibration_map (target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload)
  SELECT x.target, x.score_col, x.calib_version, x.min_n, x.fit_on, x.git_sha, x.sha256, x.payload
    FROM p, jsonb_populate_record(NULL::affect_calibration_map, p.j->'{key}') x
  ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
  RETURNING id
)"""


def ingest_statement(param: str = "$1") -> str:
    """ONE statement: maps (upsert by sha256), run (skipped when the same load already exists), windows, consults.

    Shared verbatim with lib/timbre/store.ts (tests compare them).
    """
    cols = ", ".join(_RUN_COLS)
    xcols = ", ".join(f"x.{c}" for c in _RUN_COLS)
    return f"""WITH p AS (SELECT {param}::jsonb AS j),
{_cal_cte('ca', 'calibration_arousal')},
{_cal_cte('cv', 'calibration_valence')},
prior AS (
  SELECT r.id FROM affect_run r, p, ca, cv
   WHERE r.input_manifest_sha256 = p.j->'run'->>'input_manifest_sha256' AND r.git_sha = p.j->'run'->>'git_sha'
     AND r.calibration_arousal_id = ca.id AND r.calibration_valence_id = cv.id AND r.state <> 'failed'
),
run AS (
  INSERT INTO affect_run ({cols}, calibration_arousal_id, calibration_valence_id, started_at)
  SELECT {xcols}, ca.id, cv.id, COALESCE(x.started_at, now())
    FROM p, ca, cv, jsonb_populate_record(NULL::affect_run, p.j->'run') x
   WHERE NOT EXISTS (SELECT 1 FROM prior)
  RETURNING id
),
w AS (
  INSERT INTO affect_window
  SELECT run.id, x.consult_uid, x.cut_version, x.window_key, x.start_ms, x.end_ms, x.abs_start_ms, x.abs_end_ms, x.room_day_id,
         x.bench_window_id, x.session_id, x.diarize_engine, x.diarize_ref, x.speaker_idx, x.doctor_slot, x.phase, x.lang, x.purity,
         x.purity_embedding, x.purity_probs, x.pure_patient_s, x.patient_cosine, x.scorable, x.unscorable_reason, x.arousal_raw,
         x.arousal_calibrated, x.arousal_calibration_level, x.arousal_model, x.odyssey_arousal_raw, x.audeering_arousal_raw,
         x.valence_raw, x.valence_calibrated, x.valence_calibration_level, x.text_valence, x.text_arousal, x.text_status,
         x.text_language, now()
    FROM run, p, jsonb_populate_recordset(NULL::affect_window, p.j->'windows') x
  RETURNING 1
),
c AS (
  INSERT INTO affect_consult
  SELECT run.id, x.consult_uid, x.cut_version, x.encounter_consult_key, x.room_id, x.room_slug, x.ist_date, x.doctor_uid8,
         x.n_windows, x.n_scorable, x.scorable_pct, x.arousal_median, x.valence_median, x.arousal_open, x.arousal_mid,
         x.arousal_close, x.valence_open, x.valence_mid, x.valence_close, x.arousal_raw_median, x.valence_raw_median,
         x.arousal_raw_open, x.arousal_raw_mid, x.arousal_raw_close, x.valence_raw_open, x.valence_raw_mid, x.valence_raw_close,
         x.n_no_voiceprint, x.n_no_patient, x.n_low_purity, x.n_short_pure_speech, x.n_low_patient_cosine, x.n_overlap,
         x.n_too_short, x.n_attender_speaks_for_patient, x.n_model_error, now()
    FROM run, p, jsonb_populate_recordset(NULL::affect_consult, p.j->'consults') x
  RETURNING 1
)
SELECT COALESCE((SELECT id FROM run), (SELECT id FROM prior LIMIT 1)) AS run_id,
       (SELECT count(*) FROM run)::int AS inserted,
       (SELECT count(*) FROM w)::int AS n_windows,
       (SELECT count(*) FROM c)::int AS n_consults"""


def resolve_statements(param: str = "$1") -> list[str]:
    """Write-time joins for the run whose input_manifest_sha256 is ``param`` (bench window, room, encounter). Idempotent."""
    runs = f"(SELECT id FROM affect_run WHERE input_manifest_sha256 = {param})"
    return [
        f"""UPDATE affect_window w
   SET bench_window_id = s.bw_id, room_day_id = COALESCE(w.room_day_id, s.rd_id), session_id = COALESCE(w.session_id, s.sess)
  FROM (
    SELECT w2.run_id, w2.window_key, b.id AS bw_id, b.room_day_id AS rd_id, b.session_id AS sess
      FROM affect_window w2
      JOIN LATERAL (
        SELECT bw.id, bw.room_day_id, bw.session_id FROM bench_window bw
         WHERE bw.start_ms <= w2.abs_start_ms AND bw.end_ms > w2.abs_start_ms
           AND (w2.session_id IS NULL OR bw.session_id = w2.session_id)
         ORDER BY bw.start_ms DESC LIMIT 1
      ) b ON true
     WHERE w2.run_id IN {runs} AND w2.bench_window_id IS NULL AND w2.abs_start_ms IS NOT NULL
  ) s
 WHERE w.run_id = s.run_id AND w.window_key = s.window_key""",
        f"""UPDATE affect_consult c
   SET encounter_consult_key = COALESCE(c.encounter_consult_key, s.ck),
       room_id = COALESCE(c.room_id, s.rid),
       room_slug = COALESCE((SELECT r.slug FROM room r WHERE r.id = COALESCE(c.room_id, s.rid)), c.room_slug)
  FROM (
    SELECT c2.run_id, c2.consult_uid, c2.cut_version,
           (SELECT e.consult_key FROM eta_encounter_windows e WHERE e.consult_uid = c2.consult_uid ORDER BY e.computed_at DESC NULLS LAST LIMIT 1) AS ck,
           COALESCE(
             (SELECT ci.room_id FROM consult_index ci WHERE ci.consult_uid = c2.consult_uid),
             (SELECT e.room_id FROM eta_encounter_windows e WHERE e.consult_uid = c2.consult_uid AND e.room_id IS NOT NULL ORDER BY e.computed_at DESC NULLS LAST LIMIT 1),
             (SELECT rd.room_id FROM affect_window w JOIN room_day rd ON rd.id = w.room_day_id
               WHERE w.run_id = c2.run_id AND w.consult_uid = c2.consult_uid AND w.cut_version = c2.cut_version ORDER BY w.start_ms LIMIT 1),
             (SELECT r.id FROM room r WHERE r.slug = c2.room_slug OR r.name = c2.room_slug ORDER BY r.disabled_at NULLS FIRST LIMIT 1)) AS rid
      FROM affect_consult c2
     WHERE c2.run_id IN {runs}
  ) s
 WHERE c.run_id = s.run_id AND c.consult_uid = s.consult_uid AND c.cut_version = s.cut_version""",
    ]


def _dollar_literal(text: str) -> str:
    tag = "tp"
    while f"${tag}$" in text:
        tag += "x"
    return f"${tag}${text}${tag}$"


def psql_script(payload: dict) -> str:
    """The whole load as one psql script in a single transaction (``psql -1``)."""
    body = canonical_json(payload)
    sha = payload["run"]["input_manifest_sha256"]
    lines = [ingest_statement(_dollar_literal(body)) + ";"]
    lines += [s + ";" for s in resolve_statements(f"'{sha}'")]
    return "\n".join(lines) + "\n"


def load_psql(payload: dict, dsn: str) -> dict:
    script = psql_script(payload)
    proc = subprocess.run(
        ["psql", dsn, "-1", "-qAt", "-v", "ON_ERROR_STOP=1", "-F", "\t"],
        input=script, capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        tail = proc.stderr.strip().splitlines()[-3:]
        raise StoreError("psql failed: " + " | ".join(t[:300] for t in tail))
    first = next((ln for ln in proc.stdout.splitlines() if "\t" in ln), "")
    parts = first.split("\t")
    if len(parts) < 4:
        raise StoreError("psql returned no run row")
    return {"run_id": int(parts[0]), "inserted": int(parts[1]), "n_windows": int(parts[2]), "n_consults": int(parts[3])}


def sign(body: bytes, secret: str, ts: int) -> str:
    return hmac.new(secret.encode("utf-8"), f"{ts}.".encode("utf-8") + body, hashlib.sha256).hexdigest()


def post_payload(payload: dict, url: str, secret: str, timeout: float = 120.0) -> dict:
    body = canonical_json(payload).encode("utf-8")
    ts = int(time.time())
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"content-type": "application/json", "x-timbre-ts": str(ts), "x-timbre-signature": sign(body, secret, ts)},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (fixed https URL from config)
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------------------------------------------- CLI


def build_from_files(windows: str, manifest: str, clips: str, consults: str | None = None) -> dict:
    man = json.loads(Path(manifest).read_text(encoding="utf-8"))
    frame = pd.read_parquet(windows)
    clip_map = load_clips(clips)
    cal_a = calibration_row(man["calibration_arousal_path"], target="arousal", git_sha=man["calibration_git_sha"], fit_on=man.get("calibration_fit_on", "gold_batches_1_2"))
    cal_v = calibration_row(man["calibration_valence_path"], target="valence", git_sha=man["calibration_git_sha"], fit_on=man.get("calibration_fit_on", "gold_batches_1_2"))
    cj = json.loads(Path(consults).read_text(encoding="utf-8")) if consults else None
    digest = hashlib.sha256()
    for path in (windows, clips, manifest) + ((consults,) if consults else ()):
        digest.update(sha256_file(path).encode())
    man_clean = {k: v for k, v in man.items() if not k.endswith("_path")}
    return build_payload(frame, man_clean, clip_map, consults_json=cj, cal_a=cal_a, cal_v=cal_v, input_sha256=digest.hexdigest())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tools.timbre.store", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("build", "psql", "post"):
        s = sub.add_parser(name)
        s.add_argument("--windows", required=True)
        s.add_argument("--manifest", required=True)
        s.add_argument("--clips", required=True)
        s.add_argument("--consults")
        if name == "build":
            s.add_argument("--out", required=True)
        if name == "psql":
            s.add_argument("--dsn-env", default="TIMBRE_DATABASE_URL")
        if name == "post":
            s.add_argument("--url", default=os.environ.get("TIMBRE_INGEST_URL", ""))
            s.add_argument("--secret-env", default="TIMBRE_INGEST_SECRET")
    args = ap.parse_args(argv)
    payload = build_from_files(args.windows, args.manifest, args.clips, args.consults)
    counts = f"consults={payload['run']['n_consults']} windows={payload['run']['n_windows']} scorable={payload['run']['n_scorable']}"
    if args.cmd == "build":
        Path(args.out).write_text(canonical_json(payload), encoding="utf-8")
        print(f"store build {counts}")
        return 0
    if args.cmd == "psql":
        dsn = os.environ.get(args.dsn_env)
        if not dsn:
            raise SystemExit(f"{args.dsn_env} is not set")
        res = load_psql(payload, dsn)
        print(f"store psql {counts} run_id={res['run_id']} inserted={res['inserted']} rows_w={res['n_windows']} rows_c={res['n_consults']}")
        return 0
    secret = os.environ.get(args.secret_env)
    if not secret or not args.url:
        raise SystemExit("ingest URL and secret are required")
    res = post_payload(payload, args.url, secret)
    print(f"store post {counts} -> {json.dumps({k: res.get(k) for k in ('run_id', 'inserted', 'n_windows', 'n_consults')})}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
