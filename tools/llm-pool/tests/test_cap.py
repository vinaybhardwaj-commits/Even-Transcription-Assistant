import logging

from llm_pool.cap import CapGuard
from llm_pool.ledger import Ledger, LedgerRow
from llm_pool import timeutil


def seed(ledger, usd, provider="bedrock", ist_day=None):
    ledger.add(
        LedgerRow(
            caller="seed",
            model="haiku",
            model_id="global.anthropic.claude-haiku-5-5",
            provider=provider,
            price_family="haiku",
            in_tokens=1,
            out_tokens=1,
            cache_tokens=0,
            est_usd=usd,
        )
    )


def test_guard_refuses_at_exact_cap(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 500.0)
    guard = CapGuard(ledger, 500.0, 0.8)
    decision = guard.check("bedrock")
    assert decision.allowed is False
    assert decision.spent_usd == 500.0
    assert decision.percent_used == 100.0
    assert "refusing bedrock call" in caplog.text
    ledger.close()


def test_guard_allows_below_cap(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 499.9999)
    guard = CapGuard(ledger, 500.0, 0.8)
    assert guard.check("bedrock").allowed is True
    assert "refusing" not in caplog.text
    ledger.close()


def test_warn_line_at_80_percent_once_per_day(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 400.0)
    guard = CapGuard(ledger, 500.0, 0.8)
    assert guard.check("bedrock").warn is True
    assert guard.check("bedrock").warn is True
    warn_lines = [r for r in caplog.records if "cap refuses at 100%" in r.getMessage()]
    assert len(warn_lines) == 1
    ledger.close()


def test_vertex_is_not_aws_capped(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 500.0, provider="bedrock")
    seed(ledger, 99.0, provider="vertex")
    guard = CapGuard(ledger, 500.0, 0.8)
    decision = guard.check("vertex")
    assert decision.capped is False
    assert decision.allowed is True
    ledger.close()


def test_cap_uses_only_today(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 500.0)
    assert ledger.day_total_usd(timeutil.ist_day()) == 500.0
    assert ledger.day_total_usd("1999-01-01") == 0.0
    ledger.close()
