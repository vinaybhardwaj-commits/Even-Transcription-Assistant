import sqlite3
import stat
from datetime import datetime, timezone

import pytest

from llm_pool.ledger import Ledger, LedgerRow
from llm_pool import timeutil


def row(**kwargs):
    base = dict(
        caller="tester",
        model="haiku",
        model_id="global.anthropic.claude-haiku-5-5",
        provider="bedrock",
        price_family="haiku",
        in_tokens=100,
        out_tokens=20,
        cache_tokens=0,
        est_usd=0.0001,
        request_id="chatcmpl-x",
    )
    base.update(kwargs)
    return LedgerRow(**base)


def test_add_and_totals(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    ledger.add(row())
    ledger.add(row(model="sonnet", model_id="global.anthropic.claude-sonnet-5-5", price_family="sonnet",
                   in_tokens=50, out_tokens=10, est_usd=0.0002))
    ledger.add(row(in_tokens=100, out_tokens=20, est_usd=0.0001))
    today = timeutil.ist_day()
    totals = ledger.totals_for_day(today)
    by_model = {entry["model_id"]: entry for entry in totals}
    haiku = by_model["global.anthropic.claude-haiku-5-5"]
    assert haiku["calls"] == 2
    assert haiku["in_tokens"] == 200
    assert haiku["out_tokens"] == 40
    assert haiku["est_usd"] == pytest.approx(0.0002)
    assert by_model["global.anthropic.claude-sonnet-5-5"]["calls"] == 1
    assert ledger.day_total_usd(today) == pytest.approx(0.0004)
    assert ledger.day_total_usd(today, provider="bedrock") == pytest.approx(0.0004)
    assert ledger.day_total_usd(today, provider="vertex") == 0.0
    ledger.close()


def test_ledger_file_is_private(tmp_path):
    path = tmp_path / "spend.sqlite3"
    ledger = Ledger(path)
    ledger.add(row())
    ledger.close()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_append_only_enforced(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    ledger.add(row())
    with pytest.raises(sqlite3.DatabaseError):
        ledger._conn.execute("UPDATE spend SET est_usd = 0")
    with pytest.raises(sqlite3.DatabaseError):
        ledger._conn.execute("DELETE FROM spend")
    assert ledger.row_count() == 1
    ledger.close()


def test_persists_across_reopen(tmp_path):
    path = tmp_path / "spend.sqlite3"
    ledger = Ledger(path)
    ledger.add(row(est_usd=0.5))
    ledger.close()
    reopened = Ledger(path)
    assert reopened.row_count() == 1
    assert reopened.day_total_usd(timeutil.ist_day()) == pytest.approx(0.5)
    reopened.close()


def test_ist_day_stamped_from_row_ts(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    before = datetime(2026, 10, 17, 18, 29, 59, tzinfo=timezone.utc)
    after = datetime(2026, 10, 17, 18, 30, 0, tzinfo=timezone.utc)
    ledger.add(row(ts=before.timestamp(), est_usd=1.0))
    ledger.add(row(ts=after.timestamp(), est_usd=2.0))
    assert ledger.day_total_usd("2026-10-17") == pytest.approx(1.0)
    assert ledger.day_total_usd("2026-10-18") == pytest.approx(2.0)
    ledger.close()
