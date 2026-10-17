"""Per-caller daily AWS cap (00:00 IST) with atomic reservations and an 80% warning line.

The cap prevents wasted compute, not cost. A caller is the authenticated identity (a per-caller
token's name from config "callers", or "main" for the main token); the X-LLM-Pool-Caller header is
only a ledger label and never changes the bucket. Before an upstream call the worst-case spend of
that call is reserved under a lock; the reservation is settled to the real usage afterwards."""
from __future__ import annotations

import itertools
import logging
import threading
import time
from dataclasses import dataclass

from . import timeutil
from .ledger import Ledger, LedgerRow

log = logging.getLogger("llm_pool.cap")

RESERVATION_TTL_S = 6 * 3600


@dataclass(frozen=True)
class Reservation:
    rid: int
    principal: str
    provider: str
    usd: float
    input_tokens: int
    output_tokens: int
    created: float


@dataclass(frozen=True)
class CapDecision:
    capped: bool
    allowed: bool
    spent_usd: float
    cap_usd: float
    percent_used: float
    warn: bool
    principal: str = ""
    reserved_usd: float = 0.0
    estimate_usd: float = 0.0
    scope: str = "caller"
    reservation: Reservation | None = None


def evaluate_cap(spent_usd: float, cap_usd: float, warn_fraction: float = 0.8,
                 reserved_usd: float = 0.0, estimate_usd: float = 0.0) -> CapDecision:
    allowed = (spent_usd + reserved_usd + estimate_usd) <= cap_usd and spent_usd < cap_usd
    warn = spent_usd >= cap_usd * warn_fraction
    percent = (100.0 * spent_usd / cap_usd) if cap_usd else 0.0
    return CapDecision(True, allowed, round(spent_usd, 6), round(cap_usd, 6), round(percent, 2), warn,
                       reserved_usd=round(reserved_usd, 6), estimate_usd=round(estimate_usd, 6))


class CapGuard:
    def __init__(self, ledger: Ledger, cap_per_caller_usd: float, warn_fraction: float = 0.8, *,
                 total_cap_usd: float | None = None, clock=time.time, logger=log):
        self.ledger = ledger
        self.cap_usd = float(cap_per_caller_usd)
        self.total_cap_usd = float(total_cap_usd) if total_cap_usd else None
        self.warn_fraction = float(warn_fraction)
        self._clock = clock
        self.log = logger
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._open: dict[int, Reservation] = {}
        self._warned: set[tuple[str, str]] = set()

    def _expire_locked(self, now: float) -> None:
        for rid in [r for r, res in self._open.items() if now - res.created > RESERVATION_TTL_S]:
            del self._open[rid]

    def reserved_usd(self, principal: str | None = None) -> float:
        with self._lock:
            return round(sum(r.usd for r in self._open.values()
                             if r.provider == "bedrock" and (principal is None or r.principal == principal)), 6)

    def reserve(self, principal: str, provider: str, estimate_usd: float, input_tokens: int = 0,
                output_tokens: int = 0) -> CapDecision:
        """Atomically check the caller's cap including in-flight reservations and take a reservation."""
        now = self._clock()
        today = timeutil.ist_day(now)
        estimate = max(float(estimate_usd), 0.0)
        with self._lock:
            self._expire_locked(now)
            if provider != "bedrock":
                res = Reservation(next(self._ids), principal, provider, estimate, int(input_tokens),
                                  int(output_tokens), now)
                self._open[res.rid] = res
                return CapDecision(False, True, 0.0, 0.0, 0.0, False, principal=principal,
                                   estimate_usd=estimate, reservation=res)
            spent = self.ledger.day_total_usd(today, provider="bedrock", principal=principal)
            reserved = sum(r.usd for r in self._open.values()
                           if r.provider == "bedrock" and r.principal == principal)
            decision = evaluate_cap(spent, self.cap_usd, self.warn_fraction, reserved, estimate)
            scope = "caller"
            allowed = decision.allowed
            if allowed and self.total_cap_usd is not None:
                total_spent = self.ledger.day_total_usd(today, provider="bedrock")
                total_reserved = sum(r.usd for r in self._open.values() if r.provider == "bedrock")
                if total_spent >= self.total_cap_usd or total_spent + total_reserved + estimate > self.total_cap_usd:
                    allowed = False
                    scope = "total"
                    decision = evaluate_cap(total_spent, self.total_cap_usd, self.warn_fraction,
                                            total_reserved, estimate)
            res = None
            if allowed:
                res = Reservation(next(self._ids), principal, provider, estimate, int(input_tokens),
                                  int(output_tokens), now)
                self._open[res.rid] = res
            decision = CapDecision(
                True, allowed, decision.spent_usd, decision.cap_usd, decision.percent_used, decision.warn,
                principal=principal, reserved_usd=decision.reserved_usd, estimate_usd=decision.estimate_usd,
                scope=scope, reservation=res,
            )
        self._log(decision, today)
        return decision

    def _log(self, decision: CapDecision, today: str) -> None:
        key = (today, decision.principal if decision.scope == "caller" else "*total*")
        if decision.warn and key not in self._warned:
            self._warned.add(key)
            self.log.warning(
                "llm-pool: caller %s AWS spend USD %.2f of USD %.2f (%.1f%%) since 00:00 IST; cap refuses at 100%%",
                decision.principal, decision.spent_usd, decision.cap_usd, decision.percent_used,
            )
        if not decision.allowed:
            self.log.warning(
                "llm-pool: refusing bedrock call for caller %s, AWS %s cap (spent USD %.2f + in-flight USD %.2f"
                " + this call up to USD %.2f vs USD %.2f since 00:00 IST)",
                decision.principal, decision.scope, decision.spent_usd, decision.reserved_usd,
                decision.estimate_usd, decision.cap_usd,
            )

    def settle(self, reservation: Reservation, row: LedgerRow) -> int:
        """Write the ledger row and drop the reservation in one critical section, so the spend is
        never invisible (neither reserved nor recorded) to a concurrent reserve()."""
        with self._lock:
            row_id = self.ledger.add(row)
            self._open.pop(reservation.rid, None)
        return row_id

    def release(self, reservation: Reservation) -> None:
        with self._lock:
            self._open.pop(reservation.rid, None)
