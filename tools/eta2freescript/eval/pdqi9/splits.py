"""Split lists (private) and the lockbox rule: a lockbox uid is scored only with --lockbox --candidate <id>, once per candidate."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import time
from pathlib import Path

LEDGER_ENV = "FREESCRIPT_LOCKBOX_LEDGER"
RULE_ENV = "FREESCRIPT_LOCKBOX_RULE"


class SplitError(RuntimeError):
    pass


class Splits:
    def __init__(self, tuning: list[str], lockbox: list[str]):
        self.tuning, self.lockbox = set(tuning), set(lockbox)
        both = self.tuning & self.lockbox
        if both:
            raise SplitError(f"split lists overlap on {len(both)} uid(s)")

    @classmethod
    def load(cls, path: Path) -> "Splits":
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(d, dict) or not all(isinstance(d.get(k), list) for k in ("tuning", "lockbox")):
            raise SplitError("split file must be {\"tuning\": [...], \"lockbox\": [...]}")
        return cls([str(u) for u in d["tuning"]], [str(u) for u in d["lockbox"]])

    def name_for(self, uid: str) -> str | None:
        return "lockbox" if uid in self.lockbox else "tuning" if uid in self.tuning else None


def _entries(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def ledger_path() -> Path:
    p = os.environ.get(LEDGER_ENV)
    if not p:
        raise SplitError(f"a lockbox run needs {LEDGER_ENV} (a fixed path outside --out); unset, refusing")
    return Path(p)


def gate(splits: Splits, uids: list[str], lockbox: bool, candidate: str | None) -> str:
    """Return the split name for this run, or raise. A lockbox run appends its ledger entry (append-only JSONL, 0600) before any scoring."""
    names = {u: splits.name_for(u) for u in uids}
    unknown = [u for u, n in names.items() if n is None]
    if unknown:
        raise SplitError(f"{len(unknown)} uid(s) are in neither split list; refusing to score")
    in_lock = [u for u, n in names.items() if n == "lockbox"]
    if lockbox:
        if not candidate:
            raise SplitError("--lockbox needs --candidate <id>")
        if len(in_lock) != len(uids):
            raise SplitError("a lockbox run scores lockbox uids only; tuning uids present")
        p = ledger_path()
        if any(e.get("candidate") == candidate for e in _entries(p)):
            raise SplitError(f"lockbox already run for candidate {candidate!r}; a second run is refused")
        p.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps({"candidate": candidate, "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "n": len(uids)}) + "\n")
        return "lockbox"
    if in_lock:
        raise SplitError(f"{len(in_lock)} lockbox uid(s) in this run; lockbox needs --lockbox --candidate <id>")
    return "tuning"


class LockboxRuleError(SplitError):
    """The lockbox rule file is missing, unreadable or invalid. `code` is one of rule_unset, rule_unreadable, rule_invalid; the text never carries file content."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


_HEX64 = re.compile(r"[0-9a-f]{64}")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _parse_date(v) -> dt.date:
    if not isinstance(v, str) or not _DATE.fullmatch(v):
        raise ValueError("date")
    return dt.date.fromisoformat(v)


class LockboxRule:
    """Lockbox membership by rule: a set of uid hashes plus an IST date range. The real file lives outside the repo."""

    KEYS = {"version", "uid_sha256", "date_from", "date_to"}

    def __init__(self, uid_sha256: set[str], date_from: dt.date, date_to: dt.date):
        self.uid_sha256, self.date_from, self.date_to = uid_sha256, date_from, date_to

    @classmethod
    def load(cls, path: Path | str | None = None) -> "LockboxRule":
        path = path or os.environ.get(RULE_ENV)
        if not path:
            raise LockboxRuleError("rule_unset")
        try:
            d = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            raise LockboxRuleError("rule_unreadable") from None
        except ValueError:
            raise LockboxRuleError("rule_invalid") from None
        try:
            if not isinstance(d, dict) or set(d) != cls.KEYS or d["version"] != 1 or isinstance(d["version"], bool):
                raise ValueError
            h = d["uid_sha256"]
            if not isinstance(h, list) or not all(isinstance(x, str) and _HEX64.fullmatch(x) for x in h):
                raise ValueError
            lo, hi = _parse_date(d["date_from"]), _parse_date(d["date_to"])
            if lo > hi:
                raise ValueError
        except (ValueError, TypeError):
            raise LockboxRuleError("rule_invalid") from None
        return cls(set(h), lo, hi)

    def hit_hash(self, uid: str) -> bool:
        return hashlib.sha256(uid.encode("utf-8")).hexdigest() in self.uid_sha256

    def hit_date(self, ist_date: dt.date) -> bool:
        return self.date_from <= ist_date <= self.date_to


def tuning_guard(rule: LockboxRule, dates: dict[str, str | None]) -> tuple[int, int, int]:
    """(n_hash, n_date, n_nodate) over uid -> IST date string (None when unknown). Any non-zero count means abort. Never returns or raises uids."""
    n_hash = n_date = n_nodate = 0
    for uid, raw in dates.items():
        try:
            d = _parse_date(raw)
        except ValueError:
            d = None
        n_hash += rule.hit_hash(uid)
        if d is None:
            n_nodate += 1
        else:
            n_date += rule.hit_date(d)
    return n_hash, n_date, n_nodate
