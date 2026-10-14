"""Tests for the consult-length bands (Fable 18:45 ruling, ADDENDUM-17 P1)."""
import json
from datetime import datetime

import pytest

from length_band import band_for
from span_cap import SPAN_CAP_S


def test_band_boundaries():
    assert band_for(0.0) == "short <=10min"
    assert band_for(599.9) == "short <=10min"
    assert band_for(600.0) == "medium 10-30min"
    assert band_for(1799.9) == "medium 10-30min"
    assert band_for(1800.0) == "long 30-60min"
    assert band_for(3599.9) == "long 30-60min"


def test_span_cap_itself_is_in_the_long_band_not_out_of_range():
    # a consult right at the 60min cap must still band correctly, not raise.
    assert band_for(SPAN_CAP_S) == "long 30-60min"


def test_duration_beyond_the_span_cap_raises():
    # anything past SPAN_CAP_S should already be excluded before banding is ever called.
    with pytest.raises(ValueError):
        band_for(SPAN_CAP_S + 1.0)


def test_real_data_band_counts_match_the_addendum17_table():
    def parse_iso(s):
        return datetime.fromisoformat(s)

    counts = {}
    for day in ("22", "23", "24"):
        with open(f"/home/eta/eta-data/cap/2026-09-{day}/links.jsonl") as f:
            for line in f:
                r = json.loads(line)
                if r.get("status") not in ("confirmed", "probable"):
                    continue
                a, b = r["span"]
                dur = (parse_iso(b) - parse_iso(a)).total_seconds()
                if dur > SPAN_CAP_S:
                    continue
                band = band_for(dur)
                counts[band] = counts.get(band, 0) + 1

    assert counts["short <=10min"] == 34
    assert counts["medium 10-30min"] == 44
    assert counts["long 30-60min"] == 14
    assert sum(counts.values()) == 92
