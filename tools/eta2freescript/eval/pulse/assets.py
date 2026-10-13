"""Load and validate the private replay assets file (env PULSE_REPLAY_ASSETS).

The file holds every system-specific string and constant. It never lives in this repository. The schema is strict:
a missing key, a wrong type or an unknown key is an error, and a file readable by group or others is refused.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

ASSETS_VERSION = "pulse-replay-assets/1"
ENV_NAME = "PULSE_REPLAY_ASSETS"
KINDS = ("medicine", "diagnosis", "comorbidity", "investigation", "surgery")
EFFORTS = ("low", "medium", "high")
LOOKUPS = ("exact", "substring")
USER_LEAD_KEYS = ("doctor_wrote", "interpreted_as", "also_known_as", "candidates_header", "question")


class AssetsError(Exception):
    """The assets file is missing, unsafe or does not match the schema."""


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _check_keys(obj, where: str, spec: dict) -> None:
    """spec: key -> predicate(value) -> bool."""
    if not isinstance(obj, dict):
        raise AssetsError(f"{where}: expected an object")
    unknown = sorted(set(obj) - set(spec))
    if unknown:
        raise AssetsError(f"{where}: unknown keys {unknown}")
    missing = sorted(set(spec) - set(obj))
    if missing:
        raise AssetsError(f"{where}: missing keys {missing}")
    for k, pred in spec.items():
        if not pred(obj[k]):
            raise AssetsError(f"{where}.{k}: wrong type or value")


def _str(v) -> bool:
    return isinstance(v, str)


def _kind_map(v) -> bool:
    return isinstance(v, dict) and set(v) == set(KINDS) and all(isinstance(x, str) for x in v.values())


def validate(a: dict) -> dict:
    """Strict check. Returns the same dict. Raises AssetsError."""
    _check_keys(a, "assets", {
        "assets_version": lambda v: v == ASSETS_VERSION, "source": _str, "extract": lambda v: isinstance(v, dict),
        "adjudicate": lambda v: isinstance(v, dict), "search": lambda v: isinstance(v, dict),
        "normalise": lambda v: isinstance(v, dict), "response_schema": lambda v: v is None or isinstance(v, dict)})
    _check_keys(a["extract"], "extract", {
        "system_template": lambda v: _str(v) and "{DATE}" in v, "section_guide": _str, "merge_clause": _str, "model": _str,
        "temperature": _is_num, "reasoning_effort": lambda v: v in EFFORTS, "max_tokens": lambda v: _is_int(v) and v > 0,
        "retries": lambda v: _is_int(v) and v >= 0})
    _check_keys(a["adjudicate"], "adjudicate", {
        "system_template": lambda v: _str(v) and "{ENTITY_TYPE}" in v and "{TYPE_RULE}" in v,
        "user_lead": lambda v: isinstance(v, dict) and set(v) == set(USER_LEAD_KEYS) and all(_str(x) for x in v.values()),
        "type_rules": _kind_map, "entity_types": _kind_map, "rule_lookup": lambda v: v in LOOKUPS, "model": _str,
        "temperature": _is_num, "max_tokens": lambda v: _is_int(v) and v > 0,
        "reasons": lambda v: isinstance(v, list) and v and all(_str(x) and x for x in v)})
    _check_keys(a["search"], "search", {
        "top_k": lambda v: _is_int(v) and v > 0, "max_candidates": lambda v: _is_int(v) and v > 0,
        "medicine_score_threshold": lambda v: _is_num(v) and 0 <= v <= 1, "popularity_weight": lambda v: _is_num(v) and v >= 0})
    _check_keys(a["normalise"], "normalise", {
        "duration_min": _is_int, "duration_max": _is_int, "date_years_ahead": lambda v: _is_int(v) and v >= 0})
    if a["normalise"]["duration_min"] > a["normalise"]["duration_max"]:
        raise AssetsError("normalise: duration_min > duration_max")
    return a


def check_private_file(path: Path, what: str):
    """Refuse a file that is not a regular file or is readable/writable by group or others. Raises AssetsError."""
    try:
        st = os.stat(path)
    except OSError as e:
        raise AssetsError(f"{what}: cannot stat the file ({type(e).__name__})") from None
    if not stat.S_ISREG(st.st_mode):
        raise AssetsError(f"{what}: not a regular file")
    if st.st_mode & 0o077:
        raise AssetsError(f"{what}: mode {stat.S_IMODE(st.st_mode):o} is group- or world-accessible; chmod 600")


def load_assets(path=None) -> dict:
    p = path if path is not None else os.environ.get(ENV_NAME)
    if not p:
        raise AssetsError(f"{ENV_NAME} is not set")
    p = Path(p)
    check_private_file(p, "assets file")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise AssetsError(f"assets file unreadable or not JSON ({type(e).__name__})") from None
    return validate(data)
