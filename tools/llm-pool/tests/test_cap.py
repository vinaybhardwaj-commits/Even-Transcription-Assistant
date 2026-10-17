import logging

from llm_pool.cap import CapGuard
from llm_pool.ledger import Ledger, LedgerRow
from llm_pool import timeutil


def seed(ledger, usd, provider="bedrock", principal="main"):
    ledger.add(
        LedgerRow(
            caller="seed",
            principal=principal,
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
    decision = guard.reserve("main", "bedrock", 0.0)
    assert decision.allowed is False
    assert decision.spent_usd == 500.0
    assert decision.percent_used == 100.0
    assert "refusing bedrock call for caller main" in caplog.text
    ledger.close()


def test_guard_allows_below_cap(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 499.9999)
    guard = CapGuard(ledger, 500.0, 0.8)
    assert guard.reserve("main", "bedrock", 0.0).allowed is True
    assert "refusing" not in caplog.text
    ledger.close()


def test_warn_line_at_80_percent_once_per_day(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 400.0)
    guard = CapGuard(ledger, 500.0, 0.8)
    assert guard.reserve("main", "bedrock", 0.0).warn is True
    assert guard.reserve("main", "bedrock", 0.0).warn is True
    warn_lines = [r for r in caplog.records if "cap refuses at 100%" in r.getMessage()]
    assert len(warn_lines) == 1
    ledger.close()


def test_vertex_is_not_aws_capped(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 500.0, provider="bedrock")
    seed(ledger, 99.0, provider="vertex")
    guard = CapGuard(ledger, 500.0, 0.8)
    decision = guard.reserve("main", "vertex", 5.0)
    assert decision.capped is False
    assert decision.allowed is True
    ledger.close()


def test_cap_uses_only_today(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 500.0)
    assert ledger.day_total_usd(timeutil.ist_day()) == 500.0
    assert ledger.day_total_usd("1999-01-01") == 0.0
    ledger.close()


def test_reservation_counts_against_cap(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 499.0)
    guard = CapGuard(ledger, 500.0, 0.8)
    first = guard.reserve("main", "bedrock", 0.9)
    assert first.allowed is True
    second = guard.reserve("main", "bedrock", 0.9)
    assert second.allowed is False
    assert second.reserved_usd == 0.9
    guard.release(first.reservation)
    assert guard.reserve("main", "bedrock", 0.9).allowed is True
    ledger.close()


def test_cap_is_per_principal(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 500.0, principal="alice")
    guard = CapGuard(ledger, 500.0, 0.8)
    assert guard.reserve("alice", "bedrock", 0.0).allowed is False
    assert guard.reserve("bob", "bedrock", 1.0).allowed is True
    ledger.close()


def test_total_cap_optional(tmp_path):
    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 60.0, principal="alice")
    guard = CapGuard(ledger, 500.0, 0.8, total_cap_usd=100.0)
    refused = guard.reserve("bob", "bedrock", 50.0)
    assert refused.allowed is False and refused.scope == "total"
    assert guard.reserve("bob", "bedrock", 30.0).allowed is True
    ledger.close()


def test_concurrent_reservations_cannot_overshoot(tmp_path):
    import threading

    ledger = Ledger(tmp_path / "spend.sqlite3")
    seed(ledger, 499.99)
    guard = CapGuard(ledger, 500.0, 0.8)
    results = []
    barrier = threading.Barrier(8)

    def go():
        barrier.wait()
        results.append(guard.reserve("main", "bedrock", 1.0).allowed)

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 499.99 + 1.0 already exceeds 500, so no call may pass.
    assert results.count(True) == 0
    ledger.close()
