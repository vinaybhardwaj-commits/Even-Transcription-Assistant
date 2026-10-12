"""Timbre v1 production pipeline: purity, Odyssey arousal, Clef valence, calibration.

One command, from the repo root::

    python -m tools.timbre.pipeline --sessions clips.csv --audio-dir DIR \\
        --speaker nemotron --nemotron-dir NLP --voiceprints voiceprints.json \\
        --embeddings-dir EMB --calibration-arousal A.json --calibration-valence V.json \\
        --out results/

    python -m tools.timbre.pipeline evaluate --scores results/windows.parquet \\
        --gold-labels batch1.csv batch2.csv --batch-col batch --out results/eval.json

Scoring runs the mandatory purity rule before either model. A window that fails
is unscorable with a reason and is not sent to Odyssey or Clef. audEERING runs
only when Odyssey does not return a finite arousal. Clef runs only when
``TIMBRE_CLEF=1``. The Jev text lane v2 is off unless ``--text-lane`` is set.

Evaluation cross-fits calibration: batch 1 is fit and applied to batch 2, and
the reverse (or a room-day GroupKFold). A row's gold never enters the map that
scores it. Logs are counts only.

The output directory is private. Do not commit it. It holds window ids.
"""

from __future__ import annotations

import argparse
import io
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from tools.timbre.audio import TARGET_SR, read_audio
from tools.timbre.calibrate import (
    CLEF_VALENCE_COL,
    DEFAULT_MIN_N,
    GOLD_BATCHES,
    ODYSSEY_AROUSAL_COL,
    CalibError,
    apply_calibration,
    fit_calibration,
    load_calibration,
)
from tools.timbre.evaluate import concordance_ccc, spearman
from tools.timbre.purity import PurityError, PurityRule, embedding_purity, probs_purity
from tools.timbre.r2audio import fetch_audio
from tools.timbre.scale import slice_audio
from tools.timbre.windows import Window, clip_id_of, load_windows, window_id_at

AUDEERING_COL = "audeering_msp_dim.v1__arousal"
AROUSAL_MODEL = "odyssey_wavlm_dim.v1"
FALLBACK_MODEL = "audeering_msp_dim.v1"
VALENCE_MODEL = "clef_omni_valence.v1"
VALENCE_MODEL_ID = "@cf/cloudflare/clef-omni"

_SLOT_REASON = {
    "no_doctor_evidence": "no_voiceprint",
    "centroid_below_threshold": "no_voiceprint",
    "centroid_margin": "no_voiceprint",
    "eta_below_threshold": "no_voiceprint",
    "eta_missing_cosine": "no_voiceprint",
    "eta_two_clinicians": "no_voiceprint",
    "eta_slot_label_conflict": "no_voiceprint",
    "no_patient_speech": "no_patient",
    "patient_rival": "attender_speaks_for_patient",
    "eta_centroid_disagree": "no_patient",
}
_PATIENT_ROLES = {"patient"}
_LOG_INTS = (
    "n_windows",
    "n_scorable",
    "n_unscorable",
    "n_consults",
    "n_fallback",
    "n_clef",
    "n_text",
    "clef_on",
    "text_lane_on",
)


class PipelineError(ValueError):
    pass


@dataclass
class PipelineConfig:
    """File paths and injected fakes. Tests pass arrays and extractors; the CLI fills paths."""

    sessions_csv: str | None = None
    windows_csv: str | None = None
    audio_dir: str | None = None
    speaker: str = "nemotron"
    nemotron_dir: str | None = None
    segments_path: str | None = None
    voiceprints_path: str | None = None
    embeddings_dir: str | None = None
    slot_embeddings_dir: str | None = None
    calibration_arousal: str | None = None
    calibration_valence: str | None = None
    out: str | None = None
    text_lane: bool = False
    text_in: str | None = None
    use_r2: bool = False
    device: str = "cpu"
    doctor_slot: int | None = None
    patient_slot: int | None = None
    min_n: int = DEFAULT_MIN_N
    records: list[dict] | None = None
    audio_by_clip: dict | None = None
    audio_by_window: dict | None = None
    nlp_by_clip: dict | None = None
    embeddings_by_clip: dict | None = None
    slot_embeddings_by_clip: dict | None = None
    voiceprints: dict | None = None
    r2_client: object | None = None
    r2_prefixes: tuple[str, ...] | None = None
    odyssey: object | None = None
    audeering: object | None = None
    clef: object | None = None
    text_rows: list[dict] | None = None
    text_transport: object | None = None
    text_env: dict | None = None
    gold_labels: list[str] | None = None
    gold_frame: pd.DataFrame | None = None
    batch_col: str = "batch"
    cv: str = "batch"
    eval_scores: str | None = None
    eval_out: str | None = None


@dataclass
class PipelineResult:
    windows: pd.DataFrame
    consults: list[dict]
    summary: dict
    evaluation: dict | None = None
    calls: dict = field(default_factory=dict)


def format_summary(summary: dict) -> str:
    """Counts only. Window ids, clip ids, and keys are not part of this line."""
    parts = []
    for key in _LOG_INTS:
        if key in summary:
            parts.append(f"{key}={int(summary[key])}")
    return "pipeline " + " ".join(parts)


def slot_reason(reason: str | None) -> str:
    if not reason or reason == "ok":
        return "no_patient"
    return _SLOT_REASON.get(reason, "no_patient")


def unscorable_reason(judged: dict) -> str | None:
    """First failing gate on a ``PurityRule.judge`` result. None when the window is kept."""
    if judged.get("keep"):
        return None
    rule = judged.get("rule") or PurityRule().to_dict()
    purity = judged.get("purity")
    pure_s = judged.get("pure_patient_s")
    cos = judged.get("cos_patient_mean")
    overlap = judged.get("overlap_s") or 0.0
    if purity is None or not np.isfinite(purity) or float(purity) < float(rule["min_purity"]):
        return "low_purity"
    if pure_s is None or float(pure_s) < float(rule["min_pure_s"]):
        return "short_pure_speech"
    floor = rule.get("min_cos_patient_mean")
    if floor is not None and cos is not None and np.isfinite(cos) and float(cos) < float(floor):
        return "low_patient_cosine"
    if float(overlap) > float(pure_s or 0.0) and float(overlap) > 0.0:
        return "overlap"
    return "low_purity"


def judge_window(embedding: dict | None, probs: dict | None, rule: PurityRule | None = None) -> dict:
    """``PurityRule.judge``: purity and pure-patient seconds are the worse source."""
    rule = rule or PurityRule()
    try:
        return rule.judge(embedding=embedding, probs=probs)
    except PurityError as exc:
        raise PipelineError(str(exc)) from exc


def frame_bounds(n: int, frame_ms: float, start_s: float, end_s: float, origin_s: float = 0.0) -> tuple[int, int]:
    hop = float(frame_ms) / 1000.0
    if hop <= 0:
        raise PipelineError("frame_ms must be > 0")
    i0 = int(np.floor((float(start_s) - float(origin_s)) / hop + 1e-9))
    i1 = int(np.ceil((float(end_s) - float(origin_s)) / hop - 1e-9))
    i0 = max(0, min(int(n), i0))
    i1 = max(i0, min(int(n), i1))
    return i0, i1


def consult_aggregates(frame: pd.DataFrame) -> list[dict]:
    """Per consult: median, open/mid/close trajectory, and the scorable percentage.

    The list is the output table. Callers must not print it.
    """
    if frame.empty:
        return []
    rows = []
    for clip_id, part in frame.groupby(frame["clip_id"].map(_clean), sort=True):
        part = part.sort_values(["start_s", "window_id"])
        n = int(len(part))
        scorable = part.loc[part["scorable"].astype(bool)]
        k = int(len(scorable))
        rows.append(
            {
                "clip_id": clip_id,
                "room": _clean(part["room"].iloc[0]) if "room" in part.columns else "",
                "doctor_uid8": _clean(part["doctor_uid8"].iloc[0]) if "doctor_uid8" in part.columns else "",
                "n_windows": n,
                "n_scorable": k,
                "scorable_pct": (100.0 * k / n) if n else None,
                "arousal_median": _median(scorable, "arousal_calibrated", "arousal_raw"),
                "valence_median": _median(scorable, "valence_calibrated", "valence_raw"),
                "trajectory": {
                    "arousal": _thirds(scorable, "arousal_calibrated", "arousal_raw"),
                    "valence": _thirds(scorable, "valence_calibrated", "valence_raw"),
                },
            }
        )
    return rows


def scorable_rate_by_room(frame: pd.DataFrame) -> list[dict]:
    if frame.empty or "room" not in frame.columns:
        return []
    rows = []
    rooms = frame["room"].map(_clean)
    for room in sorted(set(rooms)):
        part = frame.loc[rooms.eq(room)]
        n = int(len(part))
        k = int(part["scorable"].astype(bool).sum()) if "scorable" in part.columns else 0
        rows.append(
            {
                "room": room,
                "n": n,
                "n_scorable": k,
                "scorable_rate": (k / n) if n else None,
            }
        )
    return rows


def load_gold_labels(paths: list[str], batch_col: str) -> pd.DataFrame:
    """Concatenate one or more gold CSVs. Duplicate window ids are an error."""
    if not paths:
        raise PipelineError("gold labels are missing")
    frames = []
    for path in paths:
        file = Path(path)
        if not file.is_file():
            raise PipelineError(f"gold labels not found: {file.name}")
        frames.append(pd.read_csv(file, dtype=str, keep_default_na=False))
    gold = pd.concat(frames, ignore_index=True)
    if "window_id" not in gold.columns:
        raise PipelineError("gold labels need window_id")
    if batch_col not in gold.columns:
        raise PipelineError(f"gold labels need batch column {batch_col}")
    gold["window_id"] = gold["window_id"].map(_clean)
    if gold["window_id"].eq("").any() or gold["window_id"].duplicated().any():
        raise PipelineError("gold labels have an empty or duplicate window_id")
    gold["batch_label"] = gold[batch_col].map(_clean)
    codes, mapping = _batch_codes(gold["batch_label"])
    gold["batch"] = codes
    gold.attrs["batch_map"] = mapping
    for dim in ("arousal", "valence"):
        if dim in gold.columns:
            gold[dim] = pd.to_numeric(gold[dim], errors="coerce")
    return gold


def cross_fit_predictions(
    scores: pd.DataFrame,
    labels: pd.DataFrame,
    *,
    batch_col: str = "batch",
    cv: str = "batch",
    min_n: int = DEFAULT_MIN_N,
) -> tuple[pd.DataFrame, dict]:
    """Out-of-fold calibrated rows, plus fold metadata. Fit ids and test ids are disjoint."""
    joined = _join_gold(scores, labels, batch_col)
    method, folds = _folds(joined, cv)
    oof_parts = []
    fold_meta = []
    overlap = 0
    for train, test, held in folds:
        fit_ids = set(train["window_id"].map(_clean))
        test_ids = set(test["window_id"].map(_clean))
        both = fit_ids & test_ids
        overlap += len(both)
        if both:
            raise PipelineError("calibration fold overlaps the rows it scores")
        scored = _apply_fold(train, test, min_n=min_n)
        oof_parts.append(scored)
        fold_meta.append(
            {
                "held_out": held,
                "n_fit": int(len(train)),
                "n_test": int(len(test)),
                "n_fit_ids": len(fit_ids),
                "n_test_ids": len(test_ids),
            }
        )
    if not oof_parts:
        raise PipelineError("cross-fit produced no folds")
    oof = pd.concat(oof_parts, ignore_index=True)
    meta = {
        "method": method,
        "batch_col": batch_col,
        "cv": cv,
        "folds": fold_meta,
        "leakage": {"overlapping_ids": overlap, "n_oof": int(len(oof))},
    }
    return oof, meta


def cross_fit_evaluation(
    scores: pd.DataFrame,
    labels: pd.DataFrame,
    *,
    batch_col: str = "batch",
    cv: str = "batch",
    min_n: int = DEFAULT_MIN_N,
) -> dict:
    """Fit on one side and score the other. The two id sets of a fold are disjoint.

    ``cv="batch"`` with two or more batches is leave-one-batch-out (batch 1 fit
    applied to batch 2, and the reverse). ``cv="room-day"`` is GroupKFold on
    ``room|date``. A single batch falls through to that room-day split. Fitting
    the map on the rows it scores is refused.
    """
    oof, meta = cross_fit_predictions(scores, labels, batch_col=batch_col, cv=cv, min_n=min_n)
    report = {
        **meta,
        "arousal": _dimension_block(oof, "arousal", ODYSSEY_AROUSAL_COL, "arousal_calibrated"),
        "valence": _dimension_block(oof, "valence", CLEF_VALENCE_COL, "valence_calibrated"),
        "scorable_rate_by_room": scorable_rate_by_room(scores),
    }
    return report


def run_pipeline(cfg: PipelineConfig | None = None) -> PipelineResult:
    """Score patient windows. Models are called only after ``PurityRule.judge`` keeps the row."""
    cfg = cfg or PipelineConfig()
    records = cfg.records if cfg.records is not None else _records_from_files(cfg)
    rule = PurityRule()
    clef_on = _clef_enabled()
    calls = {"odyssey": 0, "audeering": 0, "clef": 0, "r2": 0}
    odyssey = cfg.odyssey
    audeering = cfg.audeering
    clef = cfg.clef
    rows = []
    for rec in records:
        row, odyssey, audeering, clef = _score_one(
            rec,
            cfg,
            rule,
            clef_on=clef_on,
            odyssey=odyssey,
            audeering=audeering,
            clef=clef,
            calls=calls,
        )
        rows.append(row)
    frame = pd.DataFrame(rows)
    frame = _apply_saved(frame, cfg)
    frame = _attach_text(frame, cfg)
    consults = consult_aggregates(frame)
    summary = _summary(frame, clef_on=clef_on, text_lane=cfg.text_lane)
    evaluation = None
    if cfg.gold_frame is not None or cfg.gold_labels:
        labels = cfg.gold_frame if cfg.gold_frame is not None else load_gold_labels(list(cfg.gold_labels or []), cfg.batch_col)
        evaluation = cross_fit_evaluation(frame, labels, batch_col=cfg.batch_col, cv=cfg.cv, min_n=cfg.min_n)
    if cfg.out:
        _write_outputs(Path(cfg.out), frame, consults, evaluation)
    return PipelineResult(windows=frame, consults=consults, summary=summary, evaluation=evaluation, calls=calls)


def run_evaluation(
    scores,
    labels,
    *,
    batch_col: str = "batch",
    cv: str = "batch",
    min_n: int = DEFAULT_MIN_N,
    out: str | None = None,
) -> dict:
    frame = scores if isinstance(scores, pd.DataFrame) else _read_table(scores)
    gold = labels if isinstance(labels, pd.DataFrame) else load_gold_labels(list(labels), batch_col)
    report = cross_fit_evaluation(frame, gold, batch_col=batch_col, cv=cv, min_n=min_n)
    if out:
        _write_json(report, Path(out))
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m tools.timbre.pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)
    score = sub.add_parser("score", help="purity, Odyssey arousal, Clef valence, calibration")
    _add_score_args(score)
    ev = sub.add_parser("evaluate", help="cross-fit gold metrics; calibration does not see the scored batch")
    ev.add_argument("--scores", required=True, help="per-window table from score")
    ev.add_argument("--gold-labels", nargs="+", required=True, help="one or more gold CSVs")
    ev.add_argument("--batch-col", default="batch")
    ev.add_argument("--cv", choices=("batch", "room-day"), default="batch")
    ev.add_argument("--min-n", type=int, default=DEFAULT_MIN_N)
    ev.add_argument("--out", required=True)
    # `python -m tools.timbre.pipeline --sessions ...` is the score command.
    argv = list(argv) if argv is not None else None
    if argv is None:
        import sys

        argv = sys.argv[1:]
    if argv and argv[0] not in {"score", "evaluate", "-h", "--help"}:
        argv = ["score", *argv]
    args = parser.parse_args(argv)
    try:
        if args.cmd == "evaluate":
            report = run_evaluation(
                args.scores,
                args.gold_labels,
                batch_col=args.batch_col,
                cv=args.cv,
                min_n=args.min_n,
                out=args.out,
            )
            print(_eval_line(report))
            return
        cfg = _config_from_args(args)
        result = run_pipeline(cfg)
        print(format_summary(result.summary))
        if result.evaluation is not None:
            print(_eval_line(result.evaluation))
    except (PipelineError, CalibError) as exc:
        raise SystemExit(f"pipeline: {exc}") from None


def _eval_line(report: dict) -> str:
    arousal = report["arousal"]["calibrated"]["pooled"]
    valence = report["valence"]["calibrated"]["pooled"]
    rooms = len(report.get("scorable_rate_by_room") or [])
    return (
        "pipeline-eval "
        f"method={report['method']} folds={len(report['folds'])} "
        f"arousal_spearman={_num(arousal.get('spearman'))} "
        f"valence_spearman={_num(valence.get('spearman'))} "
        f"rooms={rooms} overlap={int(report['leakage']['overlapping_ids'])}"
    )


def _add_score_args(score: argparse.ArgumentParser) -> None:
    score.add_argument("--sessions", default=None, help="clips CSV (R2 key or local audio)")
    score.add_argument("--windows", default=None, help="existing windows CSV; skips the generator")
    score.add_argument("--audio-dir", default=None)
    score.add_argument("--speaker", choices=("nemotron", "segments"), default="nemotron")
    score.add_argument("--nemotron-dir", default=None)
    score.add_argument("--segments", default=None)
    score.add_argument("--voiceprints", default=None, help="JSON of doctor_uid8 to a centroid vector")
    score.add_argument("--embeddings-dir", default=None, help="per-clip frame embeddings, <clip_id>.npy")
    score.add_argument("--slot-embeddings-dir", default=None)
    score.add_argument("--calibration-arousal", default=None)
    score.add_argument("--calibration-valence", default=None)
    score.add_argument("--out", required=True)
    score.add_argument("--text-lane", action="store_true", help="optional Jev text lane v2; off by default")
    score.add_argument("--text-in", default=None, help="JSONL of window text for the text lane")
    score.add_argument("--r2", action="store_true", help="fetch clip audio from R2 when it is not local")
    score.add_argument("--device", default="cpu")
    score.add_argument("--doctor-slot", type=int, default=None)
    score.add_argument("--patient-slot", type=int, default=None)
    score.add_argument("--min-n", type=int, default=DEFAULT_MIN_N)
    score.add_argument("--gold-labels", nargs="+", default=None)
    score.add_argument("--batch-col", default="batch")
    score.add_argument("--cv", choices=("batch", "room-day"), default="batch")


def _config_from_args(args) -> PipelineConfig:
    return PipelineConfig(
        sessions_csv=args.sessions,
        windows_csv=args.windows,
        audio_dir=args.audio_dir,
        speaker=args.speaker,
        nemotron_dir=args.nemotron_dir,
        segments_path=args.segments,
        voiceprints_path=args.voiceprints,
        embeddings_dir=args.embeddings_dir,
        slot_embeddings_dir=args.slot_embeddings_dir,
        calibration_arousal=args.calibration_arousal,
        calibration_valence=args.calibration_valence,
        out=args.out,
        text_lane=bool(args.text_lane),
        text_in=args.text_in,
        use_r2=bool(args.r2),
        device=args.device,
        doctor_slot=args.doctor_slot,
        patient_slot=args.patient_slot,
        min_n=args.min_n,
        gold_labels=args.gold_labels,
        batch_col=args.batch_col,
        cv=args.cv,
    )


def _score_one(rec, cfg, rule, *, clef_on, odyssey, audeering, clef, calls):
    base = _blank(rec)
    duration = float(rec["end_s"]) - float(rec["start_s"])
    if duration + 1e-6 < rule.min_pure_s:
        base["reason"] = "too_short"
        return base, odyssey, audeering, clef
    if rec.get("pre_reason"):
        base["reason"] = rec["pre_reason"]
        return base, odyssey, audeering, clef
    embedding, probs = _evidence(rec)
    if embedding is None and probs is None:
        base["reason"] = "no_voiceprint"
        return base, odyssey, audeering, clef
    if embedding is None and not rec.get("embedding_optional", False):
        base["reason"] = "no_voiceprint"
        base["purity_probs"] = None if probs is None else probs.get("purity")
        return base, odyssey, audeering, clef
    judged = judge_window(embedding, probs, rule)
    base["purity"] = judged.get("purity")
    base["pure_patient_s"] = judged.get("pure_patient_s")
    base["patient_cosine"] = judged.get("cos_patient_mean")
    base["purity_embedding"] = None if embedding is None else embedding.get("purity")
    base["purity_probs"] = None if probs is None else probs.get("purity")
    reason = unscorable_reason(judged)
    if reason:
        base["reason"] = reason
        return base, odyssey, audeering, clef
    audio, sr = _audio_for(rec, cfg, calls)
    if audio is None:
        base["reason"] = "no_patient"
        base["scorable"] = False
        return base, odyssey, audeering, clef
    if odyssey is None:
        odyssey = _build(AROUSAL_MODEL, cfg.device)
    o_row = _extract(odyssey, audio, sr)
    calls["odyssey"] += 1
    o_ar = _feature(o_row, "arousal")
    base[ODYSSEY_AROUSAL_COL] = o_ar if o_ar is not None else np.nan
    fallback = o_ar is None
    a_ar = None
    if fallback:
        if audeering is None:
            audeering = _build(FALLBACK_MODEL, cfg.device)
        a_row = _extract(audeering, audio, sr)
        calls["audeering"] += 1
        a_ar = _feature(a_row, "arousal")
        base[AUDEERING_COL] = a_ar if a_ar is not None else np.nan
    base["audeering_fallback"] = bool(fallback)
    base["arousal_source"] = "audeering" if fallback and a_ar is not None else ("odyssey" if o_ar is not None else "none")
    base["arousal_raw"] = a_ar if fallback and a_ar is not None else (o_ar if o_ar is not None else np.nan)
    if clef_on:
        if clef is None:
            clef = _build(VALENCE_MODEL, cfg.device)
        c_row = _extract(clef, audio, sr)
        calls["clef"] += 1
        v = _feature(c_row, "valence")
        base[CLEF_VALENCE_COL] = v if v is not None else np.nan
        base["valence_raw"] = base[CLEF_VALENCE_COL]
        base["valence_status"] = "ok" if v is not None else "error"
    else:
        base["valence_status"] = "disabled"
    base["scorable"] = True
    base["reason"] = ""
    return base, odyssey, audeering, clef


def _blank(rec: dict) -> dict:
    return {
        "window_id": rec["window_id"],
        "clip_id": rec.get("clip_id") or clip_id_of(rec["window_id"]),
        "room": rec.get("room") or "",
        "date": rec.get("date") or "",
        "doctor_uid8": rec.get("doctor_uid8") or "",
        "lang": rec.get("lang") or "",
        "phase": rec.get("phase") or "",
        "start_s": float(rec["start_s"]),
        "end_s": float(rec["end_s"]),
        "purity": np.nan,
        "pure_patient_s": np.nan,
        "patient_cosine": np.nan,
        "purity_embedding": np.nan,
        "purity_probs": np.nan,
        "scorable": False,
        "reason": "",
        "arousal_raw": np.nan,
        "arousal_calibrated": np.nan,
        "arousal_calibration_level": "uncalibrated",
        "valence_raw": np.nan,
        "valence_calibrated": np.nan,
        "valence_calibration_level": "uncalibrated",
        "audeering_fallback": False,
        "arousal_source": "none",
        "valence_status": "skipped",
        ODYSSEY_AROUSAL_COL: np.nan,
        AUDEERING_COL: np.nan,
        CLEF_VALENCE_COL: np.nan,
        "model_versions": {
            "arousal": AROUSAL_MODEL,
            "arousal_fallback": FALLBACK_MODEL,
            "valence": VALENCE_MODEL_ID,
        },
    }


def _evidence(rec: dict) -> tuple[dict | None, dict | None]:
    embedding = rec.get("embedding")
    probs = rec.get("probs_score")
    if embedding is None and _filled(rec, "cos_patient"):
        other = _json_vec(rec["cos_other"]) if _filled(rec, "cos_other") else None
        hop = float(rec["hop_s"]) if _filled(rec, "hop_s") else 0.5
        embedding = embedding_purity(_json_vec(rec["cos_patient"]), other, hop_s=hop)
    if probs is None and _filled(rec, "probs"):
        matrix = np.asarray(json.loads(rec["probs"]), dtype=np.float64)
        slot = int(rec["patient_slot"]) if _filled(rec, "patient_slot") else 0
        frame_s = float(rec["frame_s"]) if _filled(rec, "frame_s") else 0.010
        kwargs = {"frame_s": frame_s}
        if _filled(rec, "doctor_slot"):
            kwargs["doctor_slot"] = int(rec["doctor_slot"])
        probs = probs_purity(matrix, slot, **kwargs)
    if embedding is None and probs is None and _filled(rec, "purity") and _filled(rec, "pure_patient_s"):
        embedding = {
            "source": "embedding",
            "purity": float(rec["purity"]),
            "pure_patient_s": float(rec["pure_patient_s"]),
            "n_frames": 1,
        }
        if _filled(rec, "cos_patient_mean"):
            embedding["cos_patient_mean"] = float(rec["cos_patient_mean"])
        rec["embedding_optional"] = True
    return embedding, probs


def _audio_for(rec, cfg: PipelineConfig, calls: dict):
    wid = rec["window_id"]
    clip = rec.get("clip_id") or clip_id_of(wid)
    if cfg.audio_by_window and wid in cfg.audio_by_window:
        return cfg.audio_by_window[wid]
    if rec.get("audio_path"):
        return read_audio(rec["audio_path"])
    audio = None
    sr = TARGET_SR
    if cfg.audio_by_clip and clip in cfg.audio_by_clip:
        audio, sr = cfg.audio_by_clip[clip]
    elif cfg.audio_dir:
        from tools.timbre.doctor_ref import find_clip_audio
        from tools.timbre.windows import find_audio

        window_file = find_audio(cfg.audio_dir, wid)
        if window_file is not None:
            return read_audio(window_file)
        clip_file = find_clip_audio(cfg.audio_dir, clip)
        if clip_file is not None:
            audio, sr = read_audio(clip_file)
    if audio is None and (cfg.use_r2 or rec.get("r2_key")) and rec.get("r2_key"):
        blob = fetch_audio(rec["r2_key"], client=cfg.r2_client, prefixes=cfg.r2_prefixes)
        calls["r2"] += 1
        audio, sr = _decode_bytes(blob)
    if audio is None:
        return None, TARGET_SR
    if rec.get("audio_is_window"):
        return audio, sr
    return slice_audio(audio, sr, float(rec["start_s"]), float(rec["end_s"])), sr


def _apply_saved(frame: pd.DataFrame, cfg: PipelineConfig) -> pd.DataFrame:
    if frame.empty:
        return frame
    out = frame.copy()
    out["_arousal_input"] = pd.to_numeric(out["arousal_raw"], errors="coerce")
    if cfg.calibration_arousal:
        calib = load_calibration(cfg.calibration_arousal)
        applied = apply_calibration(out, calib, score_col="_arousal_input")
        out["arousal_calibrated"] = applied["_arousal_input__calibrated"]
        out["arousal_calibration_level"] = applied["_arousal_input__calibration_level"]
        out.loc[~out["scorable"], "arousal_calibrated"] = np.nan
        out.loc[~out["scorable"], "arousal_calibration_level"] = "uncalibrated"
    if cfg.calibration_valence:
        calib = load_calibration(cfg.calibration_valence)
        applied = apply_calibration(out, calib, score_col=CLEF_VALENCE_COL)
        out["valence_calibrated"] = applied[f"{CLEF_VALENCE_COL}__calibrated"]
        out["valence_calibration_level"] = applied[f"{CLEF_VALENCE_COL}__calibration_level"]
        out.loc[~out["scorable"], "valence_calibrated"] = np.nan
        out.loc[~out["scorable"], "valence_calibration_level"] = "uncalibrated"
    return out.drop(columns=["_arousal_input"])


def _attach_text(frame: pd.DataFrame, cfg: PipelineConfig) -> pd.DataFrame:
    if not cfg.text_lane or frame.empty:
        return frame
    from tools.timbre.attribute import attribute_window
    from tools.timbre.jev_text import PROMPT_VERSION_V2, TextLaneError
    from tools.timbre.text_lane import score_rows

    rows = cfg.text_rows if cfg.text_rows is not None else _read_jsonl(cfg.text_in)
    prepared = []
    skipped = {}
    for row in rows:
        if _needs_attribute(row):
            attr = attribute_window(row)
            if attr.status != "ok" or not attr.text.strip():
                skipped[attr.window_id] = attr.status
                continue
            prepared.append({"window_id": attr.window_id, "text": attr.text, "gloss": attr.gloss or ""})
        else:
            prepared.append(row)
    scored = []
    if prepared:
        try:
            scored = score_rows(
                prepared,
                env=cfg.text_env,
                transport=cfg.text_transport,
                question_set=PROMPT_VERSION_V2,
            )
        except TextLaneError as exc:
            raise PipelineError(str(exc)) from None
    by_id = {r["window_id"]: r for r in scored}
    valence, arousal, status, language = [], [], [], []
    for wid in frame["window_id"]:
        hit = by_id.get(wid)
        if hit is None:
            valence.append(np.nan)
            arousal.append(np.nan)
            status.append(skipped.get(wid, "missing"))
            language.append("")
            continue
        valence.append(hit.get("valence") if hit.get("valence") is not None else np.nan)
        arousal.append(hit.get("arousal") if hit.get("arousal") is not None else np.nan)
        status.append(hit.get("status") or "")
        language.append(hit.get("language") or "")
    out = frame.copy()
    out["text_valence"] = valence
    out["text_arousal"] = arousal
    out["text_status"] = status
    out["text_language"] = language
    out["text_question_set"] = PROMPT_VERSION_V2
    return out


def _records_from_files(cfg: PipelineConfig) -> list[dict]:
    voiceprints = cfg.voiceprints if cfg.voiceprints is not None else _load_voiceprints(cfg.voiceprints_path)
    if cfg.windows_csv:
        windows = load_windows(cfg.windows_csv, cfg.audio_dir)
        return [_from_window(w, voiceprints) for w in windows]
    if not cfg.sessions_csv:
        raise PipelineError("need --sessions or --windows")
    clips = _load_session_clips(cfg.sessions_csv)
    records = []
    for clip in clips:
        records.extend(_windows_for_clip(clip, cfg, voiceprints))
    return records


def _windows_for_clip(clip: dict, cfg: PipelineConfig, voiceprints: dict) -> list[dict]:
    doctor = _clean(clip.get("doctor_uid8"))
    centroid = voiceprints.get(doctor)
    voiceprint_ok = centroid is not None
    common = {
        "clip_id": clip["clip_id"],
        "room": clip.get("room") or "",
        "date": clip.get("date") or "",
        "lang": clip.get("lang") or "",
        "phase": clip.get("phase") or "",
        "doctor_uid8": doctor,
        "r2_key": clip.get("r2_key") or "",
        "voiceprint_ok": voiceprint_ok,
    }
    if cfg.speaker == "segments":
        return _segment_windows(clip, cfg, common, centroid)
    return _nemotron_windows(clip, cfg, common, centroid)


def _nemotron_windows(clip, cfg, common, centroid) -> list[dict]:
    from tools.timbre.nemotron_windows import build_from_nlp
    from tools.timbre.slots import map_slots

    if centroid is None and cfg.doctor_slot is None and cfg.patient_slot is None:
        return [_unscored(common, clip, "no_voiceprint")]
    loaded = _nlp_for(clip, cfg)
    if loaded is None:
        return [_unscored(common, clip, "no_patient")]
    probs = loaded.probs if hasattr(loaded, "probs") else np.asarray(loaded, dtype=np.float64)
    frame_ms = float(getattr(loaded, "frame_ms", clip.get("frame_ms") or 10.0))
    embeddings = _matrix_for(clip["clip_id"], cfg.embeddings_by_clip, cfg.embeddings_dir)
    slot_emb = _matrix_for(clip["clip_id"], cfg.slot_embeddings_by_clip, cfg.slot_embeddings_dir)
    slot_kwargs = {}
    if cfg.doctor_slot is not None or cfg.patient_slot is not None:
        slot_kwargs["doctor_slot"] = cfg.doctor_slot
        slot_kwargs["patient_slot"] = cfg.patient_slot
    elif centroid is not None and (embeddings is not None or slot_emb is not None):
        slot_kwargs["doctor_centroid"] = np.asarray(centroid, dtype=np.float64)
        if slot_emb is not None:
            slot_kwargs["slot_embeddings"] = slot_emb
        else:
            slot_kwargs["frame_embeddings"] = embeddings
    decision = map_slots(probs, frame_ms=frame_ms, **slot_kwargs)
    if not decision.accepted:
        return [_unscored(common, clip, slot_reason(decision.reason))]
    built = build_from_nlp(
        _as_nlp(loaded, probs, frame_ms),
        clip_id=clip["clip_id"],
        room=common["room"],
        date=common["date"],
        lang=common["lang"],
        phase=common["phase"],
        decision=decision,
    )
    if not built.rows:
        return [_unscored(common, clip, "short_pure_speech")]
    patient_ref, doctor_ref = _refs(probs, embeddings, decision, centroid)
    out = []
    for row in built.rows:
        rec = {**common, **row, "voiceprint_ok": True}
        i0, i1 = frame_bounds(probs.shape[0], frame_ms, float(row["start_s"]), float(row["end_s"]))
        window_probs = probs[i0:i1]
        rec["probs_score"] = probs_purity(
            window_probs,
            int(decision.patient_slot),
            frame_s=frame_ms / 1000.0,
            doctor_slot=int(decision.doctor_slot),
        )
        if embeddings is not None and patient_ref is not None and doctor_ref is not None and i1 > i0:
            rec["embedding"] = _embedding_from_frames(
                embeddings[i0:i1], patient_ref, doctor_ref, hop_s=frame_ms / 1000.0
            )
        elif embeddings is None and slot_emb is None:
            rec["embedding_optional"] = False
        out.append(rec)
    return out


def _segment_windows(clip, cfg, common, centroid) -> list[dict]:
    segments = _segments_for(clip, cfg)
    patient = [
        seg
        for seg in segments
        if seg.role in _PATIENT_ROLES and not seg.overlap and (seg.end_s - seg.start_s) >= 3.0
    ]
    if not patient:
        return [_unscored(common, clip, "no_patient")]
    if centroid is None and cfg.embeddings_dir is None and cfg.embeddings_by_clip is None:
        return [_unscored(common, clip, "no_voiceprint")]
    rows = []
    for seg in patient:
        start = float(seg.start_s)
        while start + 3.0 <= float(seg.end_s) + 1e-9:
            end = min(float(seg.end_s), start + 15.0)
            if end - start + 1e-9 < 3.0:
                break
            start_ms = int(round(start * 1000.0))
            rec = {
                **common,
                "window_id": window_id_at(clip["clip_id"], start_ms),
                "start_s": start,
                "end_s": end,
                "role": "patient",
                "voiceprint_ok": centroid is not None,
            }
            rows.append(rec)
            start = end
    return rows or [_unscored(common, clip, "short_pure_speech")]


def _unscored(common: dict, clip: dict, reason: str) -> dict:
    duration = float(clip.get("duration_s") or 0.0)
    start_ms = 0
    return {
        **common,
        "window_id": window_id_at(clip["clip_id"], start_ms),
        "start_s": 0.0,
        "end_s": duration if duration > 0 else 3.0,
        "pre_reason": reason,
        "role": "patient",
    }


def _from_window(window: Window, voiceprints: dict) -> dict:
    doctor = _clean(window.meta.get("doctor_uid8"))
    rec = {
        "window_id": window.window_id,
        "clip_id": window.clip_id,
        "room": window.room,
        "date": window.date,
        "lang": window.lang,
        "phase": window.phase,
        "start_s": window.start_s,
        "end_s": window.end_s,
        "doctor_uid8": doctor,
        "role": window.role,
        "audio_path": str(window.audio_path) if window.audio_path else "",
        "audio_is_window": bool(window.audio_path),
        "r2_key": _clean(window.meta.get("r2_key")),
        "voiceprint_ok": True,
    }
    for key in (
        "cos_patient",
        "cos_other",
        "hop_s",
        "probs",
        "patient_slot",
        "doctor_slot",
        "frame_s",
        "purity",
        "pure_patient_s",
        "cos_patient_mean",
    ):
        if key in window.meta and _filled(window.meta, key):
            rec[key] = window.meta[key]
    if doctor and voiceprints and doctor not in voiceprints and "purity" not in rec and "cos_patient" not in rec:
        rec["voiceprint_ok"] = False
    return rec


def _load_session_clips(path: str) -> list[dict]:
    file = Path(path)
    if not file.is_file():
        raise PipelineError(f"sessions CSV not found: {file.name}")
    frame = pd.read_csv(file, dtype=str, keep_default_na=False)
    if "window_id" in frame.columns:
        raise PipelineError("sessions CSV looks like a windows file; pass --windows")
    need = [c for c in ("clip_id", "room", "date", "duration_s") if c not in frame.columns]
    if need:
        raise PipelineError("sessions CSV missing columns: " + ", ".join(need))
    rows = []
    seen = set()
    for rec in frame.to_dict(orient="records"):
        clip_id = _clean(rec["clip_id"])
        if not clip_id or clip_id in seen:
            raise PipelineError("sessions CSV has an empty or duplicate clip_id")
        seen.add(clip_id)
        duration = float(rec["duration_s"])
        if duration <= 0:
            raise PipelineError("duration_s must be > 0")
        rows.append(
            {
                "clip_id": clip_id,
                "room": rec["room"],
                "date": rec["date"],
                "duration_s": duration,
                "lang": rec.get("lang") or "",
                "phase": rec.get("phase") or "",
                "doctor_uid8": _clean(rec.get("doctor_uid8")),
                "r2_key": _clean(rec.get("r2_key")),
                "frame_ms": rec.get("frame_ms") or "",
            }
        )
    return rows


def _nlp_for(clip: dict, cfg: PipelineConfig):
    if cfg.nlp_by_clip and clip["clip_id"] in cfg.nlp_by_clip:
        return cfg.nlp_by_clip[clip["clip_id"]]
    if not cfg.nemotron_dir:
        return None
    root = Path(cfg.nemotron_dir)
    from tools.timbre.nemotron_probs import load_nlp

    for name in (f"{clip['clip_id']}.nlp", f"{clip['clip_id']}.nlp.gz"):
        path = root / name
        if path.is_file():
            return load_nlp(path, expected_duration_s=float(clip["duration_s"]), tol_s=max(5.0, 0.05 * float(clip["duration_s"])))
    return None


def _segments_for(clip: dict, cfg: PipelineConfig):
    if cfg.nlp_by_clip and isinstance(cfg.nlp_by_clip.get(clip["clip_id"]), list):
        return cfg.nlp_by_clip[clip["clip_id"]]
    if not cfg.segments_path:
        return []
    from tools.timbre.doctor_ref import load_segment_table

    table = load_segment_table(cfg.segments_path)
    return list(table.get(clip["clip_id"], []))


def _matrix_for(clip_id: str, memory: dict | None, directory: str | None):
    if memory and clip_id in memory:
        return np.asarray(memory[clip_id], dtype=np.float64)
    if not directory:
        return None
    path = Path(directory) / f"{clip_id}.npy"
    if not path.is_file():
        return None
    return np.load(path)


def _refs(probs, embeddings, decision, centroid):
    if embeddings is None:
        return None, None if centroid is None else np.asarray(centroid, dtype=np.float64)
    emb = np.asarray(embeddings, dtype=np.float64)
    if emb.shape[0] != probs.shape[0]:
        raise PipelineError("frame embeddings must match the probability frame count")
    mask = _dominant(probs, int(decision.patient_slot))
    if not np.any(mask):
        return None, None if centroid is None else np.asarray(centroid, dtype=np.float64)
    patient_ref = emb[mask].mean(axis=0)
    doctor_ref = np.asarray(centroid, dtype=np.float64) if centroid is not None else None
    if doctor_ref is None:
        dmask = _dominant(probs, int(decision.doctor_slot))
        if np.any(dmask):
            doctor_ref = emb[dmask].mean(axis=0)
    return patient_ref, doctor_ref


def _embedding_from_frames(frames, patient_ref, doctor_ref, *, hop_s: float) -> dict:
    from tools.timbre.slots import cosine

    cp = [cosine(row, patient_ref) for row in np.asarray(frames, dtype=np.float64)]
    co = [cosine(row, doctor_ref) for row in np.asarray(frames, dtype=np.float64)]
    return embedding_purity(cp, co, hop_s=hop_s)


def _dominant(probs, slot: int, thr: float = 0.5) -> np.ndarray:
    arr = np.asarray(probs, dtype=np.float64)
    above = arr >= thr
    single = above.sum(axis=1) == 1
    return single & (np.argmax(arr, axis=1) == int(slot))


def _as_nlp(loaded, probs, frame_ms):
    if hasattr(loaded, "probs") and hasattr(loaded, "frame_ms"):
        return loaded
    from types import SimpleNamespace

    return SimpleNamespace(probs=np.asarray(probs, dtype=np.float64), frame_ms=float(frame_ms))


def _apply_fold(train: pd.DataFrame, test: pd.DataFrame, *, min_n: int) -> pd.DataFrame:
    """Fit on ``train`` only. Scores and labels are separate frames so the join cannot collide."""
    out = test.copy()
    batches = tuple(sorted({int(v) for v in pd.to_numeric(train["batch"], errors="coerce").dropna().unique()})) or GOLD_BATCHES
    label_cols = [c for c in ("window_id", "batch", "room", "date", "doctor_uid8", "arousal", "valence") if c in train.columns]
    labels = train[label_cols].copy()
    for score_col, gold_col, dest in (
        (ODYSSEY_AROUSAL_COL, "arousal", "arousal_calibrated"),
        (CLEF_VALENCE_COL, "valence", "valence_calibrated"),
    ):
        if score_col not in train.columns:
            out[dest] = np.nan
            continue
        score_cols = [c for c in ("window_id", "room", "doctor_uid8", score_col) if c in train.columns]
        calib = fit_calibration(
            train[score_cols].copy(),
            labels,
            score_col=score_col,
            gold_col=gold_col,
            min_n=min_n,
            batches=batches,
        )
        applied = apply_calibration(test, calib, score_col=score_col)
        out[dest] = applied[f"{score_col}__calibrated"].to_numpy()
    return out


def _folds(frame: pd.DataFrame, cv: str):
    labels = frame["batch_label"].map(_clean) if "batch_label" in frame.columns else frame["batch"].map(_clean)
    batches = [b for b in sorted(set(labels)) if b]
    if cv == "room-day" or len(batches) < 2:
        if cv == "batch" and len(batches) < 2:
            return "room-day", list(_room_day_folds(frame))
        if cv == "room-day":
            return "room-day", list(_room_day_folds(frame))
    folds = []
    for held in batches:
        test = frame.loc[labels.eq(held)].copy()
        train = frame.loc[~labels.eq(held)].copy()
        if train.empty or test.empty:
            continue
        folds.append((train, test, str(held)))
    if len(folds) < 2 and cv == "batch":
        raise PipelineError("batch cross-fit needs two batches")
    return "batch-swap", folds


def _room_day_folds(frame: pd.DataFrame):
    from sklearn.model_selection import GroupKFold

    groups = (frame["room"].map(_clean) + "|" + frame["date"].map(_clean)).to_numpy()
    n_groups = len(set(groups))
    if n_groups < 2:
        raise PipelineError("room-day cross-fit needs at least two room-days")
    splitter = GroupKFold(n_splits=min(5, n_groups))
    x = np.zeros((len(frame), 1))
    for train_idx, test_idx in splitter.split(x, groups=groups):
        train = frame.iloc[train_idx].copy()
        test = frame.iloc[test_idx].copy()
        yield train, test, f"room-day:{len(test_idx)}"


def _join_gold(scores: pd.DataFrame, labels: pd.DataFrame, batch_col: str) -> pd.DataFrame:
    gold = labels.copy()
    if "batch_label" not in gold.columns:
        if batch_col not in gold.columns and "batch" not in gold.columns:
            raise PipelineError(f"gold labels need batch column {batch_col}")
        source = gold[batch_col] if batch_col in gold.columns else gold["batch"]
        gold["batch_label"] = source.map(_clean)
        codes, _mapping = _batch_codes(gold["batch_label"])
        gold["batch"] = codes
    keep = [c for c in ("window_id", "batch", "batch_label", "room", "date", "doctor_uid8", "arousal", "valence", "not_patient", "unusable", "is_repeat") if c in gold.columns]
    merged = scores.merge(gold[keep], on="window_id", how="inner", suffixes=("", "_gold"))
    if merged.empty:
        raise PipelineError("no rows matched on window_id")
    for name in ("room", "date", "doctor_uid8", "arousal", "valence"):
        alt = f"{name}_gold"
        if alt in merged.columns:
            merged[name] = merged[alt].where(merged[alt].map(_clean) != "", merged[name] if name in scores.columns else merged[alt])
    if "batch" not in merged.columns:
        raise PipelineError("gold labels need a batch column")
    return merged


def _dimension_block(frame: pd.DataFrame, gold_col: str, raw_col: str, cal_col: str) -> dict:
    return {
        "raw": _split_metrics(frame, gold_col, raw_col),
        "calibrated": _split_metrics(frame, gold_col, cal_col),
    }


def _split_metrics(frame: pd.DataFrame, gold_col: str, pred_col: str) -> dict:
    pooled = _pair_metrics(frame, gold_col, pred_col)
    by_batch = {}
    labels = frame["batch_label"] if "batch_label" in frame.columns else frame["batch"].map(str)
    for label in sorted(set(labels.map(_clean))):
        if not label:
            continue
        by_batch[label] = _pair_metrics(frame.loc[labels.map(_clean).eq(label)], gold_col, pred_col)
    return {"pooled": pooled, "by_batch": by_batch}


def _pair_metrics(frame: pd.DataFrame, gold_col: str, pred_col: str) -> dict:
    if gold_col not in frame.columns or pred_col not in frame.columns:
        return {"spearman": None, "ccc": None, "n": 0}
    gold = pd.to_numeric(frame[gold_col], errors="coerce").to_numpy(dtype=np.float64)
    pred = pd.to_numeric(frame[pred_col], errors="coerce").to_numpy(dtype=np.float64)
    mask = np.isfinite(gold) & np.isfinite(pred)
    return {
        "spearman": spearman(gold, pred),
        "ccc": concordance_ccc(gold, pred),
        "n": int(mask.sum()),
    }


def _summary(frame: pd.DataFrame, *, clef_on: bool, text_lane: bool) -> dict:
    n = int(len(frame))
    k = int(frame["scorable"].astype(bool).sum()) if n and "scorable" in frame.columns else 0
    return {
        "n_windows": n,
        "n_scorable": k,
        "n_unscorable": n - k,
        "n_consults": int(frame["clip_id"].nunique()) if n else 0,
        "n_fallback": int(frame["audeering_fallback"].astype(bool).sum()) if n and "audeering_fallback" in frame.columns else 0,
        "n_clef": int((frame["valence_status"] == "ok").sum()) if n and "valence_status" in frame.columns else 0,
        "n_text": int((frame["text_status"] == "ok").sum()) if text_lane and n and "text_status" in frame.columns else 0,
        "clef_on": int(clef_on),
        "text_lane_on": int(text_lane),
    }


def _write_outputs(out: Path, frame: pd.DataFrame, consults: list[dict], evaluation: dict | None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    _write_table(frame, out / "windows.parquet")
    _write_json({"consults": consults}, out / "consults.json")
    if evaluation is not None:
        _write_json(evaluation, out / "eval.json")


def _write_table(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    blob = frame.copy()
    if "model_versions" in blob.columns:
        blob["model_versions"] = blob["model_versions"].map(lambda v: json.dumps(v) if isinstance(v, dict) else v)
    blob.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def _write_json(payload: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(_jsonify(payload), indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _read_table(path: str) -> pd.DataFrame:
    file = Path(path)
    if not file.is_file():
        raise PipelineError(f"scores not found: {file.name}")
    if file.suffix == ".csv":
        return pd.read_csv(file)
    return pd.read_parquet(file)


def _read_jsonl(path: str | None) -> list[dict]:
    if not path:
        raise PipelineError("text lane needs --text-in")
    file = Path(path)
    if not file.is_file():
        raise PipelineError(f"text file not found: {file.name}")
    rows = []
    for line in file.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def _load_voiceprints(path: str | None) -> dict:
    if not path:
        return {}
    file = Path(path)
    if not file.is_file():
        raise PipelineError(f"voiceprints not found: {file.name}")
    payload = json.loads(file.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and "doctors" in payload and isinstance(payload["doctors"], dict):
        payload = payload["doctors"]
    out = {}
    for key, value in payload.items():
        if isinstance(value, dict):
            value = value.get("centroid")
        if value is None:
            continue
        out[_clean(key)] = [float(v) for v in value]
    return out


def _decode_bytes(blob: bytes):
    import soundfile as sf

    audio, sr = sf.read(io.BytesIO(blob), dtype="float32", always_2d=False)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim != 1:
        raise PipelineError("clip audio must be mono")
    if int(sr) != TARGET_SR:
        raise PipelineError("clip audio must be 16 kHz")
    return audio, int(sr)


def _build(name: str, device: str):
    from tools.timbre.extractors.base import build_extractor

    return build_extractor(name, device)


def _extract(extractor, audio, sr) -> dict:
    try:
        result = extractor.extract(np.asarray(audio, dtype=np.float32), int(sr))
    except Exception:
        return {"status": "error", "features": {}}
    if not isinstance(result, dict):
        return {"status": "error", "features": {}}
    return result


def _feature(result: dict, name: str) -> float | None:
    if result.get("status") not in (None, "ok"):
        return None
    feats = result.get("features") or {}
    value = feats.get(name)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(number):
        return None
    return number


def _clef_enabled() -> bool:
    return os.environ.get("TIMBRE_CLEF") == "1"


def _needs_attribute(row: dict) -> bool:
    if not isinstance(row, dict):
        return False
    if row.get("text") and not any(k in row for k in ("turns", "diarization", "transcript_segments")):
        return False
    return any(k in row for k in ("turns", "diarization", "diarize_segments", "transcript_segments", "segments"))


def _batch_codes(labels: pd.Series) -> tuple[pd.Series, dict]:
    numeric = pd.to_numeric(labels, errors="coerce")
    if numeric.notna().all():
        codes = numeric.astype(int)
        mapping = {str(int(v)): int(v) for v in sorted(set(codes))}
        return codes, mapping
    cats = sorted({_clean(v) for v in labels})
    mapping = {cat: i + 1 for i, cat in enumerate(cats)}
    return labels.map(lambda v: mapping[_clean(v)]), mapping


def _thirds(part: pd.DataFrame, primary: str, fallback: str) -> dict:
    if part.empty:
        return {"open": None, "mid": None, "close": None}
    values = _prefer(part, primary, fallback)
    n = int(values.size)
    if n == 1:
        only = _finite_or_none(values[0])
        return {"open": only, "mid": None, "close": only}
    if n == 2:
        return {"open": _finite_or_none(values[0]), "mid": None, "close": _finite_or_none(values[1])}
    edges = [0, n // 3, (2 * n) // 3, n]
    names = ("open", "mid", "close")
    out = {}
    for i, name in enumerate(names):
        chunk = values[edges[i] : edges[i + 1]]
        finite = chunk[np.isfinite(chunk)]
        out[name] = float(np.median(finite)) if finite.size else None
    return out


def _median(part: pd.DataFrame, primary: str, fallback: str):
    if part.empty:
        return None
    values = _prefer(part, primary, fallback)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return None
    return float(np.median(finite))


def _prefer(part: pd.DataFrame, primary: str, fallback: str) -> np.ndarray:
    primary_v = pd.to_numeric(part[primary], errors="coerce").to_numpy(dtype=np.float64) if primary in part.columns else np.full(len(part), np.nan)
    fallback_v = pd.to_numeric(part[fallback], errors="coerce").to_numpy(dtype=np.float64) if fallback in part.columns else np.full(len(part), np.nan)
    use_primary = np.isfinite(primary_v)
    out = np.where(use_primary, primary_v, fallback_v)
    return np.asarray(out, dtype=np.float64)


def _finite_or_none(value) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return float(value)


def _filled(rec: dict, key: str) -> bool:
    if key not in rec:
        return False
    value = rec[key]
    text = str(value).strip()
    return text != "" and text.lower() not in {"nan", "none"}


def _json_vec(text: str):
    return json.loads(text) if isinstance(text, str) else text


def _clean(value) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    if text.lower() in {"", "nan", "none"}:
        return ""
    return text


def _num(value) -> str:
    if value is None or not np.isfinite(value):
        return "na"
    return f"{float(value):.4f}"


def _jsonify(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonify(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonify(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        number = float(obj)
        return number if np.isfinite(number) else None
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


if __name__ == "__main__":
    main()
