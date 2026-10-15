import json
import pytest


@pytest.fixture
def data(tmp_path, monkeypatch):
    root = tmp_path / "eta-data"
    c = root / "consult"
    (c / "clips" / "2026-10-12" / "room-a" / "uid1").mkdir(parents=True)
    (c / "clips" / "2026-10-12" / "room-a" / "uid1" / "consult.flac").write_text("x")
    (c / "clips" / "2026-10-12" / "room-a" / "uid1" / "timeline.json").write_text(json.dumps({"turns": [], "meta": {}}))
    rows = [
        {"consult_uid": "uid1", "ist_date": "2026-10-12", "room_id": "room_aaa", "room_slug": "room-a", "status": "cut",
         "doctor_name": "Dr Secret Name", "boundary_source": "pqm", "minutes": 3.6, "path": "2026-10-12/room-a/uid1",
         "r2": {"status": "mirrored"}, "span_start": "2026-10-12 10:00:00.000"},
        {"consult_uid": "uid2", "ist_date": "2026-10-12", "room_id": "room_aaa", "room_slug": "room-a", "status": "skipped",
         "doctor_name": "Dr Other", "close_reason": "too_short", "span_start": "2026-10-12 11:00:00.000"},
        {"consult_uid": "uid2", "ist_date": "2026-10-12", "room_id": "room_aaa", "room_slug": "room-a", "status": "cut",
         "doctor_name": "Dr Other", "span_start": "2026-10-12 11:00:00.000", "path": "nope", "r2": {"status": "pending"}},
        {"consult_uid": "uid3", "ist_date": "2026-10-11", "room_id": "room_bbb", "room_slug": "room-b", "status": "cut"},
    ]
    (c / "clips" / "index.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    (root / "drtpqma" / "2026-10-12").mkdir(parents=True)
    (root / "drtpqma" / "2026-10-12" / "encounters.json").write_text(json.dumps({"date": "2026-10-12", "encounters": [
        {"id": "e1", "room_id": "room_aaa", "doctor": "Dr Secret Name"}, {"id": "e2", "room_id": None},
        {"id": "e3", "room_id": "room_aaa"}]}))
    (root / "tapes").mkdir()
    (root / "tapes" / "manifest.jsonl").write_text("\n".join(json.dumps(x) for x in [
        {"room_id": "room_aaa", "started_at": "2026-10-12T04:30:00Z", "duration_ms": 3600000},
        {"room_id": "room_aaa", "started_at": "2026-10-12T05:30:00Z", "duration_ms": 1800000},
        {"room_id": "room_aaa", "started_at": "2026-10-11T05:30:00Z", "duration_ms": 1800000},
        {"room_id": "room_bbb", "started_at": "2026-10-12T05:30:00Z", "duration_ms": 1800000}]) + "\n")
    (c / "ALERTS.jsonl").write_text(json.dumps({"ts": "t", "code": "stall", "room_id": "room_aaa", "message": "Dr Secret said hi", "count": 2}) + "\n")
    (tmp_path / "labels.json").write_text(json.dumps({"rooms": [{"room_id": "room_aaa", "label": "OPD 1"}]}))
    monkeypatch.setenv("STEWARD_ROOM_LABELS", str(tmp_path / "labels.json"))
    monkeypatch.setenv("STEWARD_DATA_ROOT", str(root))
    monkeypatch.setenv("STEWARD_LEDGER", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("STEWARD_NO_SLEEP", "1")
    monkeypatch.setenv("STEWARD_OUT", str(tmp_path / "out"))
    monkeypatch.setenv("STEWARD_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    return root
