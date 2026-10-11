"""Follow-up typing. Pulse drops a follow-up that has no followup_type, so every follow-up that reaches gp_extraction
carries one of the pulsepb FollowUpType names (vendor schema LlmFollowUp.followup_type), plus a date when one can be
read from the tape.

LlmFollowUp has no interval field: a stated interval ("after 2 weeks") is written into follow_up_instructions and turned
into followup_date = visit date (IST) + interval. A date Stage A reports is used only if it is a valid ISO date on or
after the visit. Type, when Stage A's value is missing or not an enum name:
  reports and referral said -> FOLLOW_UP_WITH_REPORT_AND_REFERRAL_PRESCRIPTION
  reports said              -> FOLLOW_UP_WITH_REPORTS
  referral said             -> FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION
  only a condition          -> IF_REQUIRED ("come back if ...")
  otherwise                 -> MANDATORY_FOLLOW_UP
"""
from __future__ import annotations

import calendar
import datetime as dt
import re

FOLLOW_UP_TYPES = ("IF_REQUIRED", "MANDATORY_FOLLOW_UP", "FOLLOW_UP_WITH_REPORTS",
                   "FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION", "FOLLOW_UP_WITH_REPORT_AND_REFERRAL_PRESCRIPTION")
INTERVAL_UNITS = ("DAYS", "WEEKS", "MONTHS", "YEARS")
REPORT_RE = re.compile(r"\breports?\b|\bresults?\b", re.I)


def add_interval(d: dt.date, value: int, unit: str) -> dt.date:
    unit = unit.upper()
    if unit == "DAYS":
        return d + dt.timedelta(days=value)
    if unit == "WEEKS":
        return d + dt.timedelta(weeks=value)
    months = value * (12 if unit == "YEARS" else 1)
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def interval_of(fu: dict) -> tuple[int, str] | None:
    iv = fu.get("interval")
    if not isinstance(iv, dict):
        return None
    v, u = iv.get("value"), str(iv.get("unit") or "").upper()
    if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 366 or u not in INTERVAL_UNITS:
        return None
    return v, u


def _date(s, visit: dt.date) -> dt.date | None:
    try:
        d = dt.date.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None
    return d if d >= visit else None


def interval_text(v: int, u: str) -> str:
    unit = u.lower().rstrip("s")
    return f"after {v} {unit}{'' if v == 1 else 's'}"


def follow_up_type(fu: dict, has_interval_or_date: bool) -> str:
    t = fu.get("type")
    if t in FOLLOW_UP_TYPES:
        return t
    text = " ".join(str(fu.get(k) or "") for k in ("when", "condition"))
    reports = bool(fu.get("with_reports")) or bool(REPORT_RE.search(text))
    referral = bool(fu.get("with_referral"))
    if reports and referral:
        return "FOLLOW_UP_WITH_REPORT_AND_REFERRAL_PRESCRIPTION"
    if reports:
        return "FOLLOW_UP_WITH_REPORTS"
    if referral:
        return "FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION"
    if fu.get("condition") and not has_interval_or_date:
        return "IF_REQUIRED"
    return "MANDATORY_FOLLOW_UP"


def map_follow_up(fu: dict | None, visit: dt.date) -> tuple[dict | None, list[str]]:
    """(LlmFollowUp or None, notes). Notes name what is missing: 'interval_unstated' when a definite follow-up has no date."""
    if not isinstance(fu, dict):
        return None, []
    iv = interval_of(fu)
    date = _date(fu.get("date"), visit)
    if date is None and iv:
        date = add_interval(visit, *iv)
    said = any(fu.get(k) for k in ("when", "condition")) or iv or date or fu.get("type") in FOLLOW_UP_TYPES
    if not said:
        return None, []
    parts = []
    if fu.get("when"):
        parts.append(str(fu["when"]))
    elif iv:
        parts.append("Review " + interval_text(*iv))
    if fu.get("condition"):
        parts.append(str(fu["condition"]))
    out = {"followup_type": follow_up_type(fu, bool(iv or date))}
    if parts:
        out["follow_up_instructions"] = " - ".join(parts).replace(":", " -")[:200]
    if date:
        out["followup_date"] = date.isoformat()
    notes = []
    if out["followup_type"] != "IF_REQUIRED" and not date:
        notes.append("interval_unstated")
    return out, notes
