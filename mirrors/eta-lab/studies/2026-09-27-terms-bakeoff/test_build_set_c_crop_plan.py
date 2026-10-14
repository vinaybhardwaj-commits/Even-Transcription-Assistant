"""Tests for build_set_c_crop_plan.py.

The real-data test locks in the actual counts after hist_manifest.py's union-by-r2_key fix (refuter-2 #5198 /
refuter-3 #5199): the 7 (day, room_id) pairs that looked like conflicts (refuter-3's earlier #5193) turned out to
be complementary partial windows of the same session, verified independently (111 shared chunks, 0 field
mismatches, 0 time-overlaps among non-shared chunks) - so they union cleanly instead of raising. Real result: 87
ok, 5 tape_gap (all genuine ~5.4s mid-span gaps), 0 no_tape_in_span, 0 no_manifest_entry, 7 span_cap-excluded."""
import os

import pytest

import build_set_c_crop_plan as m
from hist_manifest import HistManifestConflict

REAL_DATA_PRESENT = (
    os.path.exists(os.path.expanduser("~/eta-data/hist/manifest.json"))
    and os.path.exists(os.path.expanduser("~/eta-data/cap/2026-09-22/links.jsonl"))
)


def test_missing_job_is_no_manifest_entry_not_tape_gap(monkeypatch):
    fake_consult = {
        "consult_id": "x", "day": "22", "room_id": "room_missing",
        "span_start": "s", "span_end": "e", "duration_s": 10.0,
    }
    monkeypatch.setattr(m, "list_set_c_consults", lambda: ([fake_consult], []))

    def _raise(*a, **kw):
        raise KeyError("no such job")
    monkeypatch.setattr(m, "load_chunks_for_job", _raise)

    results, excluded = m.build_plan()
    assert len(results) == 1
    assert results[0]["status"] == "no_manifest_entry"


def test_manifest_conflict_propagates_uncaught(monkeypatch):
    fake_consult = {
        "consult_id": "x", "day": "24", "room_id": "room_conflicted",
        "span_start": "s", "span_end": "e", "duration_s": 10.0,
    }
    monkeypatch.setattr(m, "list_set_c_consults", lambda: ([fake_consult], []))

    def _raise(*a, **kw):
        raise HistManifestConflict("room_conflicted/2026-09-24 differs between manifests")
    monkeypatch.setattr(m, "load_chunks_for_job", _raise)

    with pytest.raises(HistManifestConflict):
        m.build_plan()


def test_summarize_counts_by_status():
    results = [{"status": "ok"}, {"status": "ok"}, {"status": "tape_gap"}]
    assert m.summarize(results) == {"ok": 2, "tape_gap": 1}


@pytest.mark.skipif(not REAL_DATA_PRESENT, reason="real hist manifest / cap links data not present on this box")
def test_real_data_matches_found_counts():
    results, excluded = m.build_plan()
    assert len(results) == 92
    assert len(excluded) == 7
    from collections import Counter
    counts = Counter(r["status"] for r in results)
    assert counts["ok"] == 87
    assert counts["tape_gap"] == 5
    assert counts.get("no_tape_in_span", 0) == 0
    assert counts.get("no_manifest_entry", 0) == 0
