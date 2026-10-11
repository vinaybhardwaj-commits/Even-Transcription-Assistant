"""Operator entry for the Timbre text lane.

    python -m tools.timbre.text_lane mask --in windows.csv --out masked.jsonl
    python -m tools.timbre.text_lane from-stt --in stt.jsonl --out masked.jsonl
    TIMBRE_TEXT_LANE=1 TIMBRE_JEV_MOCK=1 python -m tools.timbre.text_lane score \\
        --in masked.jsonl --out scores.jsonl --cache text-cache --cost-log scores.cost.jsonl

``mask`` and ``from-stt`` stay on the machine. ``score`` refuses unless
``TIMBRE_TEXT_LANE`` is on. Stdout is counts only. The masked JSONL is the
operator's file and is not a log; do not commit it when it came from a real window.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
from pathlib import Path

from tools.timbre.jev_text import (
    JevCallError,
    TextLaneError,
    TextLaneFlagError,
    append_cost,
    require_text_lane,
    score_window,
    write_scores,
)
from tools.timbre.phi_mask import mask_phi
from tools.timbre.stt_text import load_stt_windows, patient_text_from_window

_TEXT_COLUMNS = ("text", "masked_text", "patient_text")


def load_operator_text(path: Path | str) -> list[tuple[str, str]]:
    """CSV or JSON/JSONL of window_id plus text. Errors do not echo the cell."""
    src = Path(path)
    raw = src.read_text(encoding="utf-8")
    if not raw.strip():
        return []
    head = raw.lstrip()
    suffix = src.suffix.lower()
    if suffix == ".csv" or head.lower().startswith("window_id"):
        rows = _from_csv(raw)
    elif head[0] == "[":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            raise TextLaneError("text file is not valid JSON") from None
        if not isinstance(data, list):
            raise TextLaneError("text file is not valid JSON")
        rows = [_pair(obj) for obj in data]
    elif head[0] == "{" and "\n" not in raw.strip():
        try:
            rows = [_pair(json.loads(raw))]
        except json.JSONDecodeError:
            raise TextLaneError("text file is not valid JSON") from None
    else:
        rows = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(_pair(json.loads(line)))
            except json.JSONDecodeError:
                raise TextLaneError("text file is not valid JSONL") from None
    _reject_duplicate_ids(rows)
    return rows


def score_rows(
    rows: list[tuple[str, str]],
    *,
    env: dict[str, str] | None = None,
    cache_dir: Path | str | None = None,
    cost_log: Path | str | None = None,
    transport=None,
    sleep=None,
    rng=None,
) -> list[dict]:
    """Score every window. One HTTP failure becomes a row; a missing key aborts."""
    require_text_lane(env)
    out: list[dict] = []
    for window_id, text in rows:
        try:
            row = score_window(
                text,
                window_id=window_id,
                env=env,
                cache_dir=cache_dir,
                transport=transport,
                sleep=sleep,
                rng=rng,
            )
        except JevCallError as exc:
            if str(exc) == "config_missing_key":
                raise
            row = {
                "window_id": window_id,
                "status": "error",
                "http_status": exc.status,
                "text_sha256": None,
                "char_count": 0,
                "model": None,
                "cache_hit": False,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": 0.0,
                "latency_ms": 0,
                "valence": None,
                "arousal": None,
                "engaged": None,
                "resistant": None,
                "unresolved_doubt": None,
                "confidence": None,
                "prompt_version": None,
                "reason_rejected": False,
            }
        if cost_log is not None:
            append_cost(cost_log, row)
        out.append(row)
    return out


def summarise(rows: list[dict]) -> dict:
    """Counts, tokens, and dollars. No transcript and no per-window text."""

    def n_status(status: str) -> int:
        return sum(1 for r in rows if r.get("status") == status)

    return {
        "windows": len(rows),
        "ok": n_status("ok"),
        "cache_hits": sum(1 for r in rows if r.get("cache_hit")),
        "residual_phi": n_status("residual_phi"),
        "empty": n_status("empty"),
        "incomplete": n_status("incomplete"),
        "error": n_status("error"),
        "input_tokens": int(sum(int(r.get("input_tokens") or 0) for r in rows)),
        "output_tokens": int(sum(int(r.get("output_tokens") or 0) for r in rows)),
        "cost_usd": float(sum(float(r.get("cost_usd") or 0.0) for r in rows)),
    }


def mask_file(src: Path | str, dest: Path | str) -> dict:
    rows = load_operator_text(src)
    written = []
    residual = 0
    tag_counts: dict[str, int] = {}
    for window_id, text in rows:
        masked = mask_phi(text)
        for tag, n in masked.counts.items():
            tag_counts[tag] = tag_counts.get(tag, 0) + n
        if masked.residual:
            residual += 1
        written.append(
            {
                "window_id": window_id,
                "text": masked.text,
                "char_count": len(masked.text),
                "residual": list(masked.residual),
            }
        )
    _write_jsonl(written, dest)
    return {"windows": len(written), "residual": residual, "tags": tag_counts}


def from_stt_file(src: Path | str, dest: Path | str) -> dict:
    windows = load_stt_windows(src)
    extracted = [patient_text_from_window(w) for w in windows]
    written = []
    for row in extracted:
        if row.status != "ok" or row.mask is None:
            continue
        written.append(
            {
                "window_id": row.window_id,
                "text": row.text,
                "char_count": len(row.text),
                "n_patient_turns": row.n_turns,
                "residual": list(row.mask.residual),
            }
        )
    _write_jsonl(written, dest)
    return {
        "windows": len(extracted),
        "ok": sum(1 for r in extracted if r.status == "ok"),
        "no_patient_speaker": sum(1 for r in extracted if r.status == "no_patient_speaker"),
        "not_patient_attributed": sum(1 for r in extracted if r.status == "not_patient_attributed"),
        "no_turns": sum(1 for r in extracted if r.status == "no_turns"),
        "patient_turns": int(sum(r.n_turns for r in extracted)),
        "residual": sum(1 for r in extracted if r.mask is not None and r.mask.residual),
    }


def _write_jsonl(rows: list[dict], path: Path | str) -> None:
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    body = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(dest)


def _pair(obj: object) -> tuple[str, str]:
    if not isinstance(obj, dict):
        raise TextLaneError("row is not an object")
    window_id = obj.get("window_id")
    if not isinstance(window_id, str) or not window_id.strip():
        raise TextLaneError("row is missing window_id")
    window_id = window_id.strip()
    if not _safe_id(window_id):
        raise TextLaneError("window_id is not a safe id")
    for key in _TEXT_COLUMNS:
        val = obj.get(key)
        if isinstance(val, str):
            return window_id, val
    raise TextLaneError("row is missing text")


def _from_csv(raw: str) -> list[tuple[str, str]]:
    reader = csv.DictReader(io.StringIO(raw))
    fields = reader.fieldnames or []
    if "window_id" not in fields:
        raise TextLaneError("csv is missing window_id")
    col = next((c for c in _TEXT_COLUMNS if c in fields), None)
    if col is None:
        raise TextLaneError("csv is missing text")
    rows = []
    for rec in reader:
        window_id = (rec.get("window_id") or "").strip()
        if not window_id:
            raise TextLaneError("row is missing window_id")
        if not _safe_id(window_id):
            raise TextLaneError("window_id is not a safe id")
        rows.append((window_id, rec.get(col) or ""))
    return rows


def _safe_id(window_id: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9_.:|\-]{1,80}", window_id) is not None


def _reject_duplicate_ids(rows: list[tuple[str, str]]) -> None:
    seen: set[str] = set()
    for window_id, _text in rows:
        if window_id in seen:
            raise TextLaneError("duplicate window_id")
        seen.add(window_id)


def _print_summary(summary: dict) -> None:
    print(json.dumps(summary, sort_keys=True))


def main(argv: list[str] | None = None) -> None:
    import argparse

    p = argparse.ArgumentParser(prog="python -m tools.timbre.text_lane")
    sub = p.add_subparsers(dest="cmd", required=True)

    mask_p = sub.add_parser("mask", help="mask a window_id + text CSV or JSONL")
    mask_p.add_argument("--in", dest="src", required=True)
    mask_p.add_argument("--out", required=True)

    stt_p = sub.add_parser("from-stt", help="patient lines from a Scribe STT export, then mask")
    stt_p.add_argument("--in", dest="src", required=True)
    stt_p.add_argument("--out", required=True)

    score_p = sub.add_parser("score", help="score masked text with Jev (TIMBRE_TEXT_LANE=1)")
    score_p.add_argument("--in", dest="src", required=True)
    score_p.add_argument("--out", required=True)
    score_p.add_argument("--cache", default=None)
    score_p.add_argument("--cost-log", default=None)

    args = p.parse_args(argv)
    try:
        if args.cmd == "mask":
            _print_summary(mask_file(args.src, args.out))
            return
        if args.cmd == "from-stt":
            _print_summary(from_stt_file(args.src, args.out))
            return
        if args.cmd == "score":
            try:
                require_text_lane()
            except (TextLaneError, TextLaneFlagError) as exc:
                print(str(exc), file=sys.stderr)
                raise SystemExit(2) from None
            rows = load_operator_text(args.src)
            scored = score_rows(rows, cache_dir=args.cache, cost_log=args.cost_log)
            write_scores(scored, args.out)
            _print_summary(summarise(scored))
            return
    except TextLaneError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
    raise SystemExit(2)


if __name__ == "__main__":
    main()
