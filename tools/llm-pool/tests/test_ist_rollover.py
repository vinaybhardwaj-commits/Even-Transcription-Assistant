from datetime import datetime, timezone

from llm_pool import timeutil
from llm_pool.cap import CapGuard, evaluate_cap
from llm_pool.ledger import Ledger, LedgerRow


def ts(year, month, day, hour, minute, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp()


def test_ist_day_boundary_is_1830_utc():
    assert timeutil.ist_day(ts(2026, 10, 17, 18, 29, 59)) == "2026-10-17"
    assert timeutil.ist_day(ts(2026, 10, 17, 18, 30, 0)) == "2026-10-18"
    assert timeutil.ist_day(ts(2026, 10, 17, 0, 0, 0)) == "2026-10-17"
    assert timeutil.ist_day(ts(2026, 10, 17, 23, 59, 59)) == "2026-10-18"


def test_ist_day_start_utc():
    start = timeutil.ist_day_start_utc(ts(2026, 10, 18, 5, 0, 0))
    assert start == datetime(2026, 10, 17, 18, 30, tzinfo=timezone.utc)
    bounds = timeutil.ist_day_bounds_utc(ts(2026, 10, 18, 5, 0, 0))
    assert (bounds[1] - bounds[0]).total_seconds() == 86400


def row(ts_value, est_usd, provider="bedrock"):
    return LedgerRow(
        caller="tester",
        principal="tester",
        model="haiku",
        model_id="global.anthropic.claude-haiku-5-5",
        provider=provider,
        price_family="haiku",
        in_tokens=1,
        out_tokens=1,
        cache_tokens=0,
        est_usd=est_usd,
        ts=ts_value,
    )


def test_ledger_rollover_splits_days(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    ledger.add(row(ts(2026, 10, 17, 18, 29, 59), 500.0))
    assert ledger.day_total_usd("2026-10-17") == 500.0
    assert ledger.day_total_usd("2026-10-18") == 0.0
    ledger.add(row(ts(2026, 10, 17, 18, 30, 0), 7.5))
    assert ledger.day_total_usd("2026-10-17") == 500.0
    assert ledger.day_total_usd("2026-10-18") == 7.5
    ledger.close()


def test_cap_ignores_previous_ist_day(tmp_path):
    clock = {"now": ts(2026, 10, 18, 1, 0, 0)}
    ledger = Ledger(tmp_path / "spend.sqlite3", clock=lambda: clock["now"])
    ledger.add(row(ts(2026, 10, 17, 18, 29, 59), 500.0))
    guard = CapGuard(ledger, 500.0, 0.8, clock=lambda: clock["now"])
    assert guard.reserve("tester", "bedrock", 0.0).allowed is True
    clock["now"] = ts(2026, 10, 17, 18, 29, 59)
    guard = CapGuard(ledger, 500.0, 0.8, clock=lambda: clock["now"])
    assert guard.reserve("tester", "bedrock", 0.0).allowed is False
    ledger.close()


def test_evaluate_cap_boundary():
    assert evaluate_cap(500.0, 500.0).allowed is False
    assert evaluate_cap(499.9999, 500.0).allowed is True
    assert evaluate_cap(500.01, 500.0).allowed is False


def test_warn_threshold():
    assert evaluate_cap(400.0, 500.0).warn is True
    assert evaluate_cap(399.99, 500.0).warn is False
    assert evaluate_cap(500.0, 500.0).percent_used == 100.0
