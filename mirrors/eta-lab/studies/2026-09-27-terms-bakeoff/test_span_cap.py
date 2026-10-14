"""Tests for the 60-minute span cap (Fable 17:45, ADDENDUM-13)."""
import json
from datetime import datetime

from span_cap import filter_by_span_cap, SPAN_CAP_S


def test_cap_is_inclusive_at_exactly_60_minutes():
    kept, excluded = filter_by_span_cap([("a", 3600.0), ("b", 3600.1), ("c", 3599.9)])
    assert kept == ["a", "c"]
    assert excluded == ["b"]


def test_default_cap_is_3600s():
    assert SPAN_CAP_S == 3600.0


def test_real_data_excludes_exactly_7():
    """Structural check only: counts/ids, no drug or patient content - same convention as every prior real-data
    verification in this bake-off."""
    def parse_iso(s):
        return datetime.fromisoformat(s)

    consults = []
    for day in ("22", "23", "24"):
        with open(f"/home/eta/eta-data/cap/2026-09-{day}/links.jsonl") as f:
            for line in f:
                r = json.loads(line)
                if r.get("status") in ("confirmed", "probable"):
                    a, b = r["span"]
                    dur = (parse_iso(b) - parse_iso(a)).total_seconds()
                    consults.append(((day, r["consult_id"]), dur))

    kept, excluded = filter_by_span_cap(consults)
    assert len(kept) + len(excluded) == 99
    assert len(excluded) == 7  # matches ADDENDUM-12's table exactly (60min: 7 excluded, 92 retained)
    assert len(kept) == 92
