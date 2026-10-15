"""Daily spend cap, kill-switch flag file, and the model-call log (tokens and cost only, never content)."""
from __future__ import annotations
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config

IST = timezone(timedelta(hours=5, minutes=30))


def ist_today() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def cost_usd(tokens_in: int, tokens_out: int) -> float:
    return round(tokens_in * config.PRICE_IN / 1e6 + tokens_out * config.PRICE_OUT / 1e6, 6)


def estimate_call_usd(prompt_chars: int, max_tokens: int) -> float:
    """Worst case: prompt at CHARS_PER_TOKEN chars per token plus max_tokens of output."""
    return cost_usd(int(prompt_chars / config.CHARS_PER_TOKEN) + 1, max_tokens)


class RunLock:
    """flock held for the whole run, next to the ledger. A second run refuses to start."""

    def __init__(self, ledger_path: Path):
        self.path = Path(str(ledger_path) + ".lock")
        self.f = None

    def __enter__(self):
        import fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(self.path, "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.f.close()
            raise RuntimeError("another steward run holds the lock")
        return self

    def __exit__(self, *a):
        self.f.close()


def enabled(home: Path | None = None) -> bool:
    return ((home or config.home_dir()) / "ENABLED").exists()


class CapExceeded(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: Path, cap_usd: float, run_cap_usd: float | None = None):
        self.path = Path(path)
        self.cap = config.parse_cap(cap_usd, config.MAX_DAILY_CAP, "daily cap")
        self.run_cap = None if run_cap_usd is None else config.parse_cap(run_cap_usd, config.MAX_RUN_CAP, "run cap")
        self.run_spent = 0.0

    def spent_today(self, day: str | None = None) -> float:
        day = day or ist_today()
        total = 0.0
        if self.path.exists():
            for line in self.path.read_text().splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("ist_day") == day:
                    total += float(r.get("cost_usd", 0))
        return round(total, 6)

    def check(self, est_usd: float = 0.0) -> None:
        """Call before each model call with the worst-case cost of that call. Hard stop: raises when
        spent + estimate would exceed the daily cap or the per-run cap."""
        if self.spent_today() + est_usd > self.cap:
            raise CapExceeded(f"daily cap {self.cap} would be exceeded")
        if self.run_cap is not None and self.run_spent + est_usd > self.run_cap:
            raise CapExceeded(f"run cap {self.run_cap} would be exceeded")

    def record_worst(self, model: str, est_usd: float, seconds: float, tag: str = "failed") -> float:
        """A failed or timed-out attempt: usage unknown, so book the worst-case estimate."""
        self.run_spent += est_usd
        self._append({"model": model, "tag": tag, "tokens_in": None, "tokens_out": None,
                      "seconds": round(seconds, 2), "cost_usd": round(est_usd, 6)})
        return est_usd

    def _append(self, extra: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        row = {"ts": datetime.now(IST).isoformat(timespec="seconds"), "ist_day": ist_today(), **extra}
        with open(self.path, "a") as f:
            f.write(json.dumps(row) + "\n")

    def record(self, model: str, tokens_in: int, tokens_out: int, seconds: float, tag: str = "") -> float:
        c = cost_usd(tokens_in, tokens_out)
        self.run_spent += c
        self._append({"model": model, "tag": tag, "tokens_in": tokens_in, "tokens_out": tokens_out,
                      "seconds": round(seconds, 2), "cost_usd": c})
        return c
