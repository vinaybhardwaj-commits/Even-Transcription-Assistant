"""Hard daily AWS spend cap (00:00 IST) with an 80% warning line."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from . import timeutil
from .ledger import Ledger

log = logging.getLogger("llm_pool.cap")


@dataclass(frozen=True)
class CapDecision:
    capped: bool
    allowed: bool
    spent_usd: float
    cap_usd: float
    percent_used: float
    warn: bool


def evaluate_cap(spent_usd: float, cap_usd: float, warn_fraction: float = 0.8) -> CapDecision:
    allowed = spent_usd < cap_usd
    warn = spent_usd >= cap_usd * warn_fraction
    percent = (100.0 * spent_usd / cap_usd) if cap_usd else 0.0
    return CapDecision(True, allowed, round(spent_usd, 6), round(cap_usd, 6), round(percent, 2), warn)


class CapGuard:
    def __init__(self, ledger: Ledger, cap_usd: float, warn_fraction: float = 0.8, *, clock=time.time, logger=log):
        self.ledger = ledger
        self.cap_usd = float(cap_usd)
        self.warn_fraction = float(warn_fraction)
        self._clock = clock
        self.log = logger
        self._warned_day: str | None = None

    def check(self, provider: str) -> CapDecision:
        today = timeutil.ist_day(self._clock())
        if provider != "bedrock":
            return CapDecision(False, True, 0.0, 0.0, 0.0, False)
        spent = self.ledger.day_total_usd(today, provider="bedrock")
        decision = evaluate_cap(spent, self.cap_usd, self.warn_fraction)
        if decision.warn and self._warned_day != today:
            self.log.warning(
                "llm-pool: AWS spend USD %.2f of USD %.2f (%.1f%%) since 00:00 IST; cap refuses at 100%%",
                decision.spent_usd,
                decision.cap_usd,
                decision.percent_used,
            )
            self._warned_day = today
        if not decision.allowed:
            self.log.warning(
                "llm-pool: refusing bedrock call, AWS daily cap reached (USD %.2f of USD %.2f since 00:00 IST)",
                decision.spent_usd,
                decision.cap_usd,
            )
        return decision
