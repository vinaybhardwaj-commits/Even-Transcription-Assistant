"""Follow-up typing: every follow-up that reaches gp_extraction has a pulsepb FollowUpType, and a date when one can be read."""
import datetime as dt

import pytest

from tools.eta2freescript.followup import FOLLOW_UP_TYPES, add_interval, map_follow_up
from tools.eta2freescript.validate import V

VISIT = dt.date(2026, 10, 5)


def test_enum_matches_vendor_schema():
    assert list(FOLLOW_UP_TYPES) == V.SCHEMA["definitions"]["LlmFollowUp"]["properties"]["followup_type"]["enum"]


@pytest.mark.parametrize("fu,want", [
    ({"condition": "come back if the pain does not settle"}, "IF_REQUIRED"),
    ({"interval": {"value": 2, "unit": "WEEKS"}}, "MANDATORY_FOLLOW_UP"),
    ({"when": "after 1 week with the CBC report", "interval": {"value": 1, "unit": "WEEKS"}}, "FOLLOW_UP_WITH_REPORTS"),
    ({"interval": {"value": 1, "unit": "MONTHS"}, "with_referral": True}, "FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION"),
    ({"interval": {"value": 10, "unit": "DAYS"}, "with_reports": True, "with_referral": True}, "FOLLOW_UP_WITH_REPORT_AND_REFERRAL_PRESCRIPTION"),
    ({"type": "not-a-type", "condition": "if fever returns"}, "IF_REQUIRED"),
    ({"type": "MANDATORY_FOLLOW_UP", "condition": "if fever returns"}, "MANDATORY_FOLLOW_UP"),
])
def test_type_is_always_set(fu, want):
    out, _ = map_follow_up(fu, VISIT)
    assert out["followup_type"] == want
    assert out["followup_type"] in FOLLOW_UP_TYPES


def test_interval_becomes_date_and_text():
    out, notes = map_follow_up({"interval": {"value": 2, "unit": "WEEKS"}}, VISIT)
    assert out["followup_date"] == "2026-10-19"
    assert out["follow_up_instructions"] == "Review after 2 weeks"
    assert notes == []


def test_month_and_year_arithmetic():
    assert add_interval(dt.date(2026, 1, 31), 1, "MONTHS") == dt.date(2026, 2, 28)
    assert add_interval(dt.date(2026, 10, 5), 1, "YEARS") == dt.date(2027, 10, 5)


def test_stated_date_used_only_if_valid_and_not_past():
    assert map_follow_up({"date": "2026-10-20", "type": "MANDATORY_FOLLOW_UP"}, VISIT)[0]["followup_date"] == "2026-10-20"
    out, notes = map_follow_up({"date": "2026-09-01", "type": "MANDATORY_FOLLOW_UP"}, VISIT)
    assert "followup_date" not in out and notes == ["interval_unstated"]
    assert "followup_date" not in map_follow_up({"date": "next week", "condition": "if needed"}, VISIT)[0]


def test_bad_interval_is_not_guessed():
    out, notes = map_follow_up({"when": "come back later", "interval": {"value": 0, "unit": "WEEKS"}}, VISIT)
    assert out["followup_type"] == "MANDATORY_FOLLOW_UP" and "followup_date" not in out and notes == ["interval_unstated"]


def test_nothing_said_means_no_follow_up():
    assert map_follow_up({"type": None, "interval": None, "date": None, "when": None, "condition": None}, VISIT) == (None, [])
    assert map_follow_up(None, VISIT) == (None, [])


def test_weekday_is_the_next_occurrence_after_the_visit():
    out, notes = map_follow_up({"when": "come Friday", "type": "MANDATORY_FOLLOW_UP"}, VISIT)
    assert out["followup_date"] == "2026-10-09" and notes == []
    out, notes = map_follow_up({"when": "Monday", "type": "MANDATORY_FOLLOW_UP"}, VISIT)
    assert out["followup_date"] == "2026-10-12" and notes == []
    out, _ = map_follow_up({"date": "Friday"}, VISIT, heard="see you Friday")
    assert out["followup_date"] == "2026-10-09"


def test_mapped_follow_up_fits_vendor_schema():
    import jsonschema
    sch = dict(V.SCHEMA["definitions"]["LlmFollowUp"])
    out, _ = map_follow_up({"interval": {"value": 3, "unit": "DAYS"}, "condition": "if fever: persists"}, VISIT)
    jsonschema.validate(out, sch)
    assert ":" not in out["follow_up_instructions"]
