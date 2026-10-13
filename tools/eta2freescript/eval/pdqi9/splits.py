"""Split lists (private) and the lockbox rule: a lockbox uid is scored only with --lockbox --candidate <id>, once per candidate."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

LEDGER_ENV = "FREESCRIPT_LOCKBOX_LEDGER"


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
