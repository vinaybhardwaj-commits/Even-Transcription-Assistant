import pytest
from steward import phi, report
from fake_identity import fake_label, fake_email


@pytest.mark.parametrize("t", ["id 1234567 here", "mail " + fake_email(1), "call +91 98765 43210", "9876543210", "080-1234-5678"])
def test_blocks(t):
    with pytest.raises(phi.PhiGuardError):
        phi.check(t)


@pytest.mark.parametrize("t", ["2026-10-12 10:30:00", "3 cut, 1 skipped, 12.5 h tape", "uid 1hdjkt3959ut7otnb31o947vi4", "room-a 99999"])
def test_allows(t):
    assert phi.check(t) == t


def test_model_guard():
    phi.assert_model_ok("global.anthropic.claude-sonnet-4-6")
    for m in ("openai.gpt-oss", "qwen.qwen3", "anthropic.other"):
        with pytest.raises(phi.PhiGuardError):
            phi.assert_model_ok(m)


def test_report_drops_bad_items(data):
    rep = {"summary_md": "ok 3 cut", "items": [
        {"kind": "suggestion", "title": "recut", "body_md": "fine", "consult_uid": "uid1",
         "proposed_action": {"type": "recut", "args": {"consult_uid": "uid1", "evil": "rm -rf", "date": "2026-10-12"}}},
        {"kind": "suggestion", "title": "bad phone", "body_md": "call 9876543210"},
        {"kind": "suggestion", "title": "bad action", "body_md": "x", "proposed_action": {"type": "deploy", "args": {}}},
        {"kind": "action", "title": "x", "body_md": "x"},
        {"kind": "question", "title": "q", "body_md": "why", "proposed_action": {"type": "recut", "args": {}}}]}
    s, items, dropped = report.validate(rep)
    assert len(items) == 2 and len(dropped) == 3
    assert items[1]["proposed_action"] is None
    assert items[0]["proposed_action"] == {"type": "recut", "args": {"consult_uid": "uid1", "date": "2026-10-12"}}


def test_report_summary_phi_raises(data):
    with pytest.raises(phi.PhiGuardError):
        report.validate({"summary_md": "mail " + fake_email(2), "items": []})


def test_dates_next_to_counts_allowed():
    phi.check("2026-10-12 10:30:00 to 2026-10-12 11:00:00, 12 cut")
    with pytest.raises(phi.PhiGuardError):
        phi.check("seen 2026-10-12 call 98765 43210")


def test_slug_guard_summary_and_items(data):
    with pytest.raises(phi.PhiGuardError):
        report.validate({"summary_md": "room-a has 2 cut", "items": []})
    with pytest.raises(phi.PhiGuardError):
        report.validate({"summary_md": "ROOM-B is quiet", "items": []})
    s, items, dropped = report.validate({"summary_md": "OPD 1 (room_aaa) has 2 cut", "items": [
        {"kind": "question", "title": "Gap in room-a", "body_md": "x"},
        {"kind": "question", "title": "Gap in OPD 1", "body_md": "ids only"}]})
    assert len(items) == 1 and items[0]["title"] == "Gap in OPD 1" and len(dropped) == 1


def test_items_as_json_string_and_bad_type(data):
    import json
    _, items, dropped = report.validate({"summary_md": "ok", "items": json.dumps([{"kind": "question", "title": "t", "body_md": "b"}])})
    assert len(items) == 1
    _, items, dropped = report.validate({"summary_md": "ok", "items": "nonsense"})
    assert items == [] and dropped == ["items_not_json"]
