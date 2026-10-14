"""Tests for the set (c) consult selector (structural checks only - no drug/patient content, same convention as
test_span_cap.py's real-data check)."""
from select_set_c_consults import list_set_c_consults


def test_matches_witnessed_92_7_split():
    kept, excluded = list_set_c_consults()
    assert len(kept) == 92
    assert len(excluded) == 7


def test_kept_consults_have_no_null_room():
    kept, _ = list_set_c_consults()
    assert all(c["room_id"] for c in kept)


def test_span_is_used_directly_not_repadded():
    """ADDENDUM-2 G1 (witnessed): links.jsonl's span is ALREADY called_at-30s..completed_at+30s - this module
    must not add a second pad."""
    kept, _ = list_set_c_consults()
    sample = kept[0]
    assert sample["span_end"] > sample["span_start"]
    assert sample["duration_s"] == (sample["span_end"] - sample["span_start"]).total_seconds()


def test_no_duplicate_consult_ids_within_a_day():
    kept, excluded = list_set_c_consults()
    seen = set()
    for c in kept + excluded:
        key = (c["day"], c["consult_id"])
        assert key not in seen
        seen.add(key)


def test_kept_spans_are_within_the_cap():
    from span_cap import SPAN_CAP_S
    kept, _ = list_set_c_consults()
    assert all(c["duration_s"] <= SPAN_CAP_S for c in kept)


def test_excluded_spans_exceed_the_cap():
    from span_cap import SPAN_CAP_S
    _, excluded = list_set_c_consults()
    assert all(c["duration_s"] > SPAN_CAP_S for c in excluded)
