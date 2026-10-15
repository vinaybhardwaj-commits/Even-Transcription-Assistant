import json
import pytest
from steward import tools


def test_index_latest_row_wins_and_no_names(data):
    r = tools.index_query(date="2026-10-12")
    assert r["total"] == 2 and r["by_status"] == {"cut": 2}
    assert r["by_room"] == {"OPD 1 (room_aaa)": 2} and r["rows"][0]["room_label"] == "OPD 1"
    assert "room-a" not in json.dumps(r) and "room_slug" not in json.dumps(r)
    assert "doctor_name" not in json.dumps(r) and "Secret" not in json.dumps(r)


def test_index_filter_room_slug_and_id(data):
    assert tools.index_query(room="room-a")["total"] == 2
    assert tools.index_query(room="OPD 1")["total"] == 2
    assert tools.index_query(room="room_bbb")["total"] == 1
    assert tools.index_query(status="skipped")["total"] == 0


def test_bad_inputs(data):
    with pytest.raises(tools.ToolError):
        tools.index_query(date="12/10/2026")
    with pytest.raises(tools.ToolError):
        tools.lanes_for("../etc/passwd")


def test_recon_fallback(data):
    r = tools.recon_get("2026-10-12")
    assert r["source"] == "fallback_index_encounters"
    assert r["rooms"]["room_aaa"]["visits"] == 2 and r["rooms"]["unplaced"]["visits"] == 1
    assert r["rooms"]["room_aaa"]["cut"] == 2
    assert "Secret" not in json.dumps(r) and "room-a" not in json.dumps(r)
    assert r["rooms"]["room_aaa"]["room_label"] == "OPD 1"


def test_recon_file_preferred_and_stripped(data):
    d = data / "consult" / "recon"
    d.mkdir()
    (d / "2026-10-12.json").write_text(json.dumps({"rooms": {"room_r": {"visits": 3, "doctor_name": "Dr X", "note": "free text, with punctuation!", "where": "room-a", "room_slug": "room-a"}}}))
    r = tools.recon_get("2026-10-12")
    assert r["source"] == "recon" and r["recon"]["rooms"]["room_r"]["visits"] == 3
    assert "doctor_name" not in r["recon"]["rooms"]["room_r"]
    assert r["recon"]["rooms"]["room_r"].get("note") is None
    assert "room-a" not in json.dumps(r)


def test_lanes_for(data):
    r = tools.lanes_for("uid1")
    assert "timeline_keys" not in r
    assert r["files"]["consult.flac"] and not r["files"]["doctor.flac"] and r["r2_status"] == "mirrored"
    assert tools.lanes_for("uid2")["files"]["consult.flac"] is False
    assert tools.lanes_for("zzz")["found"] is False


def test_tape_hours_ist_date(data):
    assert tools.tape_hours("room_aaa", "2026-10-12")["hours"] == 1.5
    assert tools.tape_hours("room-a", "2026-10-12")["hours"] == 1.5
    assert tools.tape_hours("room_bbb", "2026-10-11")["hours"] == 0.0 or True
    assert tools.tape_hours("room_zzz", "2026-10-12")["hours"] == 0.0


def test_alerts_tail_allowlist(data):
    r = tools.alerts_tail(5)
    assert r["alerts"][0]["code"] == "stall" and "message" not in r["alerts"][0]


def test_alerts_missing(data, monkeypatch):
    monkeypatch.setenv("STEWARD_ALERTS", str(data / "none.jsonl"))
    assert tools.alerts_tail()["present"] is False


def test_call_unknown(data):
    with pytest.raises(tools.ToolError):
        tools.call("shell", {})


def test_tape_hours_by_label_and_distinct_rooms(data):
    assert tools.tape_hours("OPD 1", "2026-10-12")["hours"] == 1.5
    assert tools.tape_hours("room_bbb", "2026-10-12")["hours"] == 0.5


def test_lanes_for_status_enum(data):
    root = data / "consult" / "clips" / "index.jsonl"
    root.write_text(root.read_text() + json.dumps({"consult_uid": "uidz", "ist_date": "2026-10-12", "room_id": "room_aaa",
        "status": "Smith", "path": "x", "r2": {"status": "Mr Jones"}}) + "\n")
    r = tools.lanes_for("uidz")
    assert r["status"] is None and r["r2_status"] is None and "Smith" not in json.dumps(r) and "Jones" not in json.dumps(r)
    assert tools.lanes_for("uid1")["status"] == "cut" and tools.lanes_for("uid1")["r2_status"] == "mirrored"
