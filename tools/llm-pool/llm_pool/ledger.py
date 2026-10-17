"""Append-only spend ledger (SQLite, one row per call, IST day stamped at write)."""
from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import timeutil

SCHEMA = """
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  ist_day TEXT NOT NULL,
  caller TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  price_family TEXT NOT NULL,
  in_tokens INTEGER NOT NULL,
  out_tokens INTEGER NOT NULL,
  cache_tokens INTEGER NOT NULL,
  est_usd REAL NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  principal TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL DEFAULT 'actual'
);
CREATE INDEX IF NOT EXISTS spend_by_day ON spend (ist_day, provider);
CREATE TRIGGER IF NOT EXISTS spend_no_update BEFORE UPDATE ON spend
BEGIN SELECT RAISE(ABORT, 'llm-pool spend ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS spend_no_delete BEFORE DELETE ON spend
BEGIN SELECT RAISE(ABORT, 'llm-pool spend ledger is append-only'); END;
"""


# Rows written before the principal column existed carry '' and are bucketed by their caller label.
_PRINCIPAL_SQL = "CASE WHEN principal = '' THEN caller ELSE principal END"


@dataclass(frozen=True)
class LedgerRow:
    caller: str
    model: str
    model_id: str
    provider: str
    price_family: str
    in_tokens: int
    out_tokens: int
    cache_tokens: int
    est_usd: float
    request_id: str = ""
    ts: float | None = None
    # `caller` is only a sub-label (X-LLM-Pool-Caller); `principal` is the authenticated identity
    # (per-caller token name, or "main") and is the cap bucket. Empty principal falls back to caller.
    principal: str = ""
    # actual = provider-reported usage; reserved = provider accepted the call but reported no usage,
    # so the worst-case reservation was billed; none = provider rejected / never accepted the call.
    basis: str = "actual"


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="milliseconds")


class Ledger:
    def __init__(self, path: str | Path, *, clock=time.time):
        self._clock = clock
        self._lock = threading.Lock()
        self.path = str(path)
        if self.path != ":memory:":
            file = Path(self.path).expanduser()
            file.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(file, check_same_thread=False)
            try:
                file.chmod(0o600)
            except OSError:
                pass
        else:
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        columns = {r["name"] for r in self._conn.execute("PRAGMA table_info(spend)")}
        # ALTER ADD COLUMN is not blocked by the append-only triggers (they guard UPDATE/DELETE rows).
        if "principal" not in columns:
            self._conn.execute("ALTER TABLE spend ADD COLUMN principal TEXT NOT NULL DEFAULT ''")
        if "basis" not in columns:
            self._conn.execute("ALTER TABLE spend ADD COLUMN basis TEXT NOT NULL DEFAULT 'actual'")
        self._conn.execute("CREATE INDEX IF NOT EXISTS spend_by_principal ON spend (ist_day, provider, principal)")

    def add(self, row: LedgerRow) -> int:
        ts = row.ts if row.ts is not None else self._clock()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO spend (ts, ist_day, caller, model, model_id, provider, price_family,"
                " in_tokens, out_tokens, cache_tokens, est_usd, request_id, principal, basis)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    _iso(ts),
                    timeutil.ist_day(ts),
                    row.caller,
                    row.model,
                    row.model_id,
                    row.provider,
                    row.price_family,
                    int(row.in_tokens),
                    int(row.out_tokens),
                    int(row.cache_tokens),
                    float(row.est_usd),
                    row.request_id,
                    row.principal or row.caller,
                    row.basis,
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def totals_for_day(self, ist_day: str, provider: str | None = None) -> list[dict]:
        query = (
            "SELECT model_id, provider, COUNT(*) AS calls, SUM(in_tokens) AS in_tokens,"
            " SUM(out_tokens) AS out_tokens, SUM(cache_tokens) AS cache_tokens,"
            " SUM(est_usd) AS est_usd FROM spend WHERE ist_day = ?"
        )
        params: list = [ist_day]
        if provider is not None:
            query += " AND provider = ?"
            params.append(provider)
        query += " GROUP BY model_id, provider ORDER BY model_id, provider"
        with self._lock:
            rows = self._conn.execute(query, params).fetchall()
        return [
            {
                "model_id": r["model_id"],
                "provider": r["provider"],
                "calls": int(r["calls"]),
                "in_tokens": int(r["in_tokens"] or 0),
                "out_tokens": int(r["out_tokens"] or 0),
                "cache_tokens": int(r["cache_tokens"] or 0),
                "est_usd": round(float(r["est_usd"] or 0.0), 6),
            }
            for r in rows
        ]

    def day_total_usd(self, ist_day: str, provider: str | None = None, principal: str | None = None) -> float:
        with self._lock:
            query = "SELECT COALESCE(SUM(est_usd), 0) AS total FROM spend WHERE ist_day = ?"
            params: list = [ist_day]
            if provider is not None:
                query += " AND provider = ?"
                params.append(provider)
            if principal is not None:
                query += f" AND {_PRINCIPAL_SQL} = ?"
                params.append(principal)
            total = self._conn.execute(query, params).fetchone()["total"]
        return round(float(total or 0.0), 6)

    def totals_by_principal(self, ist_day: str) -> list[dict]:
        query = (
            f"SELECT {_PRINCIPAL_SQL} AS principal, provider, COUNT(*) AS calls, SUM(est_usd) AS est_usd"
            f" FROM spend WHERE ist_day = ? GROUP BY {_PRINCIPAL_SQL}, provider ORDER BY 1, 2"
        )
        with self._lock:
            rows = self._conn.execute(query, [ist_day]).fetchall()
        return [
            {
                "principal": r["principal"],
                "provider": r["provider"],
                "calls": int(r["calls"]),
                "est_usd": round(float(r["est_usd"] or 0.0), 6),
            }
            for r in rows
        ]

    def row_count(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) AS n FROM spend").fetchone()["n"])

    def close(self) -> None:
        with self._lock:
            self._conn.close()
