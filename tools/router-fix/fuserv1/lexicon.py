#!/usr/bin/env python3
"""FUSER v1 B1: independent drug-name lexicon (lid-debug #4501 D1-D4), built from Pulse rx_history,
NOT from clinical1/any scorer truth (independence is the point -- a lexicon fitted to the test data
would not be a real second witness). Generic names only (brand names are a v1.1 extension, not needed
for clinical1/hi-en style speech which names generics).
"""
import collections
import json
import re

EXCLUDE_DATES = {"2026-09-25", "2026-09-26"}  # W27.2's leakage rule; belt-and-braces here (see ETR-BUILD-PLAN.md cd9130731210)

_PAREN = re.compile(r"\([^)]*\)")
_DOSE_PATTERN = re.compile(r"\b\d[\d.]*\s*(mg|mcg|g|iu|ml|gm|kg|%)\b", re.IGNORECASE)
_NUMBER = re.compile(r"\d[\d.]*")
_NON_ALPHA = re.compile(r"[^a-z\s]")
_WS = re.compile(r"\s+")


def clean_ingredient(raw: str) -> str:
    """Normalise one generic-name ingredient string: drop parentheticals, dose/unit tokens, stray
    numbers and punctuation. Fixes lid-debug's found dirt ("paracetamol mg" and "diclofenac sodm"-style
    entries become "paracetamol" / "diclofenac sodm" -> sodm isn't a dose token, stays -- salt-form
    suffixes are a known residual gap, not attempted here)."""
    s = raw.lower()
    s = _PAREN.sub(" ", s)
    s = _DOSE_PATTERN.sub(" ", s)
    s = _NUMBER.sub(" ", s)
    s = _NON_ALPHA.sub(" ", s)
    return _WS.sub(" ", s).strip()


def load_lexicon(rx_history_path: str, exclude_dates=EXCLUDE_DATES, min_count: int = 2) -> dict[str, int]:
    """{cleaned generic ingredient name: use count}, combo drugs split on "+" into their ingredients
    (a doctor/patient speaking names one ingredient at a time). min_count drops one-off typos/noise."""
    counts: collections.Counter[str] = collections.Counter()
    with open(rx_history_path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("cls") != "drug" or d.get("date") in exclude_dates:
                continue
            generic = (d.get("generic") or "").strip()
            if not generic:
                continue
            for part in generic.split("+"):
                cleaned = clean_ingredient(part)
                if len(cleaned) >= 3:
                    counts[cleaned] += 1
    return {name: n for name, n in counts.items() if n >= min_count}
