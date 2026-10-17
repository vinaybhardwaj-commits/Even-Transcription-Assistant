"""IST day arithmetic for the spend cap (fixed +05:30, no DST)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")
TZ_NAME = "Asia/Kolkata"


def ist_now(now: float | None = None) -> datetime:
    ts = datetime.now(tz=timezone.utc) if now is None else datetime.fromtimestamp(now, tz=timezone.utc)
    return ts.astimezone(IST)


def ist_day(now: float | None = None) -> str:
    return ist_now(now).date().isoformat()


def ist_day_start_utc(now: float | None = None) -> datetime:
    local = ist_now(now)
    start_local = datetime.combine(local.date(), datetime.min.time(), tzinfo=IST)
    return start_local.astimezone(timezone.utc)


def ist_day_bounds_utc(now: float | None = None) -> tuple[datetime, datetime]:
    start = ist_day_start_utc(now)
    return start, start + timedelta(days=1)
