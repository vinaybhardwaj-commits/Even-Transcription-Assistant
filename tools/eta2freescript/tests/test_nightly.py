"""Nightly selection, the off switch, and the ingest payload. Synthetic folders only. No model call."""
import json
from datetime import datetime, timezone

import pytest

from tools.eta2freescript.nightly import NightlyError, consult_eligible, flag_enabled, include_sealed, jobs_to_rows, load_config, role_doc_from_feed, run, select_day
from tools.eta2freescript.store import payload_from_artifact, redact, sign

# 2026-10-05 04:30:00Z == 10:00 IST
T0 = 1_791_174_600_000
MARKER = "SYNTH_MARKER_NOT_A_NAME"


def _folder(root, uid, day_ms=T0, role_ok=True, transcript=True):
    d = root / uid
    d.mkdir()
    if transcript:
        (d / "transcript.json").write_text(json.dumps({
            "consult_uid": uid,
            "clip": {"t0_ms": day_ms, "t1_ms": day_ms + 60_000, "room_slug": "synth-room"},
            "language_code": "en-IN",
            "english_segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker_id": "0", "text": MARKER}],
        }))
    if role_ok:
        (d / "role.json").write_text(json.dumps({
            "layer": "role", "engine": "llm-roles", "status": "ok",
            "segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker": "0", "role": "doctor", "text": MARKER}],
        }))
    return d


def test_flag_on_by_default_and_zero_is_the_kill_switch():
    assert flag_enabled({}) is True
    assert flag_enabled({}, False) is False
    assert flag_enabled({}, True) is True
    assert flag_enabled({"ETA_FREESCRIPT": "0"}, True) is False
    assert flag_enabled({"ETA_FREESCRIPT": "1"}, False) is True
    with pytest.raises(NightlyError):
        flag_enabled({"ETA_FREESCRIPT": "maybe"}, True)


def test_load_config_defaults_on(tmp_path):
    cfg_path = tmp_path / "n.json"
    cfg_path.write_text(json.dumps({"enabled": False, "data": "x"}))
    assert load_config(str(cfg_path), {})["enabled"] is False
    assert load_config(str(cfg_path), {"ETA_FREESCRIPT": "1"})["enabled"] is True
    assert load_config(None, {})["enabled"] is True
    assert load_config(None, {"ETA_FREESCRIPT": "0"})["enabled"] is False


def test_select_day_needs_sarvam_and_role_track_and_drops_text(tmp_path):
    _folder(tmp_path, "synth-a")
    _folder(tmp_path, "synth-b", role_ok=False)
    (tmp_path / "synth-b").mkdir(exist_ok=True)
    (tmp_path / "synth-b" / "transcript.json").write_text("{}")
    _folder(tmp_path, "synth-c", day_ms=T0 + 86_400_000)
    rows = select_day(tmp_path, "2026-10-05")
    assert [r["uid"] for r in rows] == ["synth-a"]
    assert rows[0]["room_slug"] == "synth-room"
    assert MARKER not in json.dumps(rows)
    one = consult_eligible(tmp_path / "synth-a", "2026-10-05")
    assert set(one) == {"uid", "ist_date", "room_slug", "doctor_uid8", "job_id"}


def test_run_posts_redacted_artifact_and_stays_quiet_when_off(tmp_path, capsys):
    _folder(tmp_path, "synth-a")
    cfg = {"enabled": False, "data": str(tmp_path), "app_url": "https://app.test", "max_consults": 40}
    assert run(cfg, "2026-10-05", pending=False) == 0
    assert "disabled" in capsys.readouterr().out

    posted = {}

    def run_one(_uid):
        return {"final_valid": True, "final_errors": [], "artifact": {
            "schema_version": "eta.freescript.v0.2",
            "encounter": {"eta_encounter_id": "synth-a", "room": "synth-room",
                          "transcript": {"segment_count": 1, "segments": [{"text": MARKER}], "speaker_source": "role_track"}},
            "pulse_link": {"consult_uid": "synth-a"},
            "generator": {"code_sha256": "a" * 64, "prompt_sha256": "b" * 64, "model": "anthropic.claude"},
            "gp_extraction": {"medicines": []}, "completion_required": [], "note_text": "Medication:",
        }}

    def post(body):
        posted["body"] = body
        return {"ok": True, "inserted": 1, "run_id": 1}

    cfg["enabled"] = True
    assert run(cfg, "2026-10-05", run_one=run_one, post=post, pending=False) == 0
    body = posted["body"]
    assert body["consult_uid"] == "synth-a"
    assert body["validator"]["ok"] is True
    assert "segments" not in json.dumps(body["artifact"]["encounter"]["transcript"])
    assert MARKER not in json.dumps(body)
    out = capsys.readouterr().out
    assert MARKER not in out
    assert "posted" in out


def test_a_failed_artifact_is_posted_as_rejected_with_cost(tmp_path, capsys):
    _folder(tmp_path, "synth-a")
    posted = {}

    def run_one(_uid):
        return {"final_valid": False, "final_errors": ["FRX-A1 general_advice must be at most 300 characters and 5 items"],
                "cost_usd": 0.0123, "artifact": {
                    "schema_version": "eta.freescript.v0.2",
                    "encounter": {"eta_encounter_id": "synth-a", "room": "synth-room", "transcript": {"segment_count": 1}},
                    "pulse_link": {"consult_uid": "synth-a"},
                    "generator": {"code_sha256": "a" * 64, "prompt_sha256": "b" * 64, "model": "anthropic.claude"},
                    "gp_extraction": {}, "completion_required": [], "note_text": "Medication:",
                }}

    def post(body):
        posted["body"] = body
        return {"ok": True, "inserted": 1, "run_id": 2}

    cfg = {"enabled": True, "data": str(tmp_path), "app_url": "https://app.test", "max_consults": 40}
    assert run(cfg, "2026-10-05", run_one=run_one, post=post, pending=False) == 2
    body = posted["body"]
    assert body["validator"]["ok"] is False
    assert body["validator"]["errors"][0].startswith("FRX-A1")
    assert body["cost_usd"] == 0.0123
    out = capsys.readouterr().out
    assert "rejected" in out and "FRX-A1" not in out


def test_pending_consult_is_included_and_a_missing_folder_is_counted(tmp_path):
    _folder(tmp_path, "synth-a")
    rows, missing = jobs_to_rows(
        [{"job_id": "job_abc123", "consult_uid": "synth-a"}, {"job_id": "job_missing1", "consult_uid": "synth-nope"}],
        tmp_path)
    assert rows[0]["job_id"] == "job_abc123" and rows[0]["uid"] == "synth-a"
    assert missing == ["synth-nope"]
    assert MARKER not in json.dumps(rows)


def test_sealed_consult_is_included_once_a_role_track_is_filled(tmp_path):
    _folder(tmp_path, "synth-sealed", role_ok=False)
    role = {"layer": "role", "engine": "llm-roles", "status": "ok",
            "segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker": "0", "role": "doctor", "text": MARKER}]}
    rows, missing = include_sealed(tmp_path, "2026-10-05", ["synth-sealed", "synth-none"], lambda uid: role if uid == "synth-sealed" else None)
    assert [r["uid"] for r in rows] == ["synth-sealed"]
    assert missing == ["synth-none"]
    written = json.loads((tmp_path / "synth-sealed" / "role.json").read_text())
    assert MARKER not in json.dumps(written)
    assert "text" not in json.dumps(written["segments"])
    again, missing_again = include_sealed(tmp_path, "2026-10-05", ["synth-sealed"], lambda uid: role)
    assert [r["uid"] for r in again] == ["synth-sealed"] and missing_again == []


def test_role_feed_row_becomes_a_role_file_without_text():
    doc = role_doc_from_feed({
        "segments": [{"t0_ms": 1, "t1_ms": 2, "speaker": "0", "role": "doctor", "text": MARKER}],
        "flags": {"attender_present": False, "two_consults": False, "diar_partial": False},
    })
    assert doc["status"] == "ok" and doc["extras"]["two_consults"] == {"flag": False}
    assert MARKER not in json.dumps(doc)


def test_sign_matches_the_ts_construction():
    assert sign("{}", "s3cret", 1_759_000_000) == __import__("hmac").new(
        b"s3cret", b"1759000000.{}", __import__("hashlib").sha256).hexdigest()


def test_redact_keeps_the_note_and_drops_segments():
    art = redact({"note_text": "Medication:", "encounter": {"transcript": {"segment_count": 2, "segments": [{"text": MARKER}]}}})
    assert art["note_text"] == "Medication:"
    assert art["encounter"]["transcript"] == {"segment_count": 2}


def test_payload_omits_empty_optional_fields():
    art = {"schema_version": "eta.freescript.v0.2", "encounter": {"eta_encounter_id": "synth-a"},
           "pulse_link": {"consult_uid": "synth-a"}, "generator": {"code_sha256": "c" * 64, "prompt_sha256": "d" * 64},
           "completion_required": [{"kind": "exam_missing"}]}
    body = payload_from_artifact(art, ist_date="2026-10-05")
    assert body["version"] == "freescript-store-v1"
    assert "job_id" not in body and "prescription_uid" not in body
    assert len(body["input_sha256"]) == 64
    # ist date of the fixed instant, so a clock change in CI cannot drift the helper
    assert datetime.fromtimestamp(T0 / 1000, tz=timezone.utc).isoformat().startswith("2026-10-05")
