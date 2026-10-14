"""Mechanical eligibility for the 14-16 Oct lockbox (decided on 17 Oct from these row fields). Pure; no defaults: a missing or ill-typed field raises."""
from __future__ import annotations

import datetime as dt
import re

_BOOLS = ("has_text_layer", "has_role_layer", "rx_signed", "doctor_is_test", "artifact_written", "artifact_final_valid")
MIN_SECONDS = 120
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _check(row: dict) -> None:
    if not isinstance(row, dict):
        raise TypeError("row must be a dict")
    if not isinstance(row.get("consult_uid"), str) or not row["consult_uid"]:
        raise ValueError("consult_uid")
    d = row.get("ist_date")
    if not isinstance(d, str) or not _DATE.fullmatch(d):
        raise ValueError("ist_date")
    dt.date.fromisoformat(d)
    for k in _BOOLS:
        if not isinstance(row.get(k), bool):
            raise ValueError(k)
    s = row.get("transcript_seconds")
    if isinstance(s, bool) or not isinstance(s, (int, float)) or s != s or s < 0:
        raise ValueError("transcript_seconds")


def eligible(row: dict) -> tuple[bool, str]:
    """artifact_final_valid is checked for type but is NOT a filter: an invalid artifact counts against the validator floor (spec 8.2)."""
    _check(row)
    if not row["has_text_layer"]:
        return False, "no_text"
    if not row["has_role_layer"]:
        return False, "no_role"
    if row["transcript_seconds"] < MIN_SECONDS:
        return False, "short_clip"
    if not row["rx_signed"]:
        return False, "no_signed_rx"
    if row["doctor_is_test"]:
        return False, "test_doctor"
    if not row["artifact_written"]:
        return False, "no_artifact"
    return True, "ok"


def select(rows: list[dict], date_from: str, date_to: str) -> list[str]:
    """Sorted uids that are eligible and dated within [date_from, date_to] (IST, inclusive)."""
    lo, hi = dt.date.fromisoformat(date_from), dt.date.fromisoformat(date_to)
    if lo > hi:
        raise ValueError("date_from after date_to")
    out = set()
    for r in rows:
        ok, _ = eligible(r)
        if ok and lo <= dt.date.fromisoformat(r["ist_date"]) <= hi:
            out.add(r["consult_uid"])
    return sorted(out)
