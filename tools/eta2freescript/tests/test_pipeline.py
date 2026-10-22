"""End to end over the synthetic consults with stored model output (replay) and with a FakeClient."""
import json
import sys

from conftest import CONSULTS, MODEL, stage_a

from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.validate import V, check


def test_every_synthetic_consult_yields_a_valid_artifact(replay_out):
    out, logs = replay_out
    for uid, lg in logs.items():
        assert lg["final_valid"], (uid, lg["final_errors"])
        art = json.loads((out / uid / "artifact.json").read_text())
        assert check(art) == [] and art["schema_version"] == "eta.freescript.v0.3"
        assert V.check(json.loads((out / uid / "artifact.v0.1.json").read_text())) == []
        assert json.loads((out / uid / "artifact.validation.json").read_text())["written"] is True
    assert "boto3" not in sys.modules


def test_fever_doctor_dose_and_follow_up(replay_out):
    out, logs = replay_out
    art = logs["synth-fever-dose"]["artifact"]
    gx = art["gp_extraction"]
    assert logs["synth-fever-dose"]["note_source"] == "llm_stageB-v10"
    assert [m["name"] for m in gx["medicines"]] == ["paracetamol 1 g"]
    assert gx["follow_up"]["followup_type"] == "FOLLOW_UP_WITH_REPORTS" and gx["follow_up"]["followup_date"] == "2026-10-12"
    assert [d["diagnosis_or_impression"] for d in gx["presenting_complaints"]["diagnoses"]] == ["Viral fever"]
    assert "market" not in gx["presenting_complaints"]["symptoms"]
    assert gx["general_advice"].lower().count("water") == 1
    assert [c["kind"] for c in art["completion_required"]] == ["inferred_confirm"] and not art["clip_boundary"]["suspected"]


def test_knee_boundary_quarantine_and_fallback(replay_out):
    _, logs = replay_out
    lg = logs["synth-boundary-knee"]
    art = lg["artifact"]
    assert lg["final_valid"] and lg["note_source"].startswith("llm_")
    assert "pantoprazole" not in art["note_text"].lower() and "medicines" not in art["gp_extraction"]
    assert art["clip_boundary"]["quarantined_turns"] == [0, 1, 2]
    assert {"role_track_two_consults", "second_patient_voice", "stage_a_topic"} <= set(art["clip_boundary"]["reasons"])
    assert sorted(c["kind"] for c in art["completion_required"]) == [
        "boundary_review", "drug_history", "exam_missing", "inferred_confirm", "pick_drug"]
    assert art["gp_extraction"]["comorbidities"][0]["duration"] == {"value": 60, "unit": "MONTHS"}
    assert art["gp_extraction"]["follow_up"]["followup_type"] == "IF_REQUIRED"
    assert art["encounter"]["transcript"]["role_track"]["two_consults"] is True
    assert any(p["speaker"] == "attendant" for p in art["provenance"])


def test_native_consult_without_role_track(replay_out):
    _, logs = replay_out
    lg = logs["synth-cough-native"]
    art = lg["artifact"]
    assert lg["speaker_source"] == "model_inferred" and lg["english_source"] == "none:native-hi"
    assert lg["note_source"] == "deterministic_fallback" and lg["llm_note_errors"] == ["stageB call failed: FileNotFoundError"]
    assert art["encounter"]["transcript"]["role_track"] is None
    assert [m["name"] for m in art["gp_extraction"]["medicines"]] == ["Ascoril 5 ml"]
    assert art["gp_extraction"]["follow_up"]["followup_date"] == "2026-10-19"
    assert [c["kind"] for c in art["completion_required"]] == ["inferred_confirm", "pick_drug"]


def test_fake_client_drives_both_stages(tmp_path):
    c = load_consult(CONSULTS, "synth-fever-dose")
    fake = FakeClient({"stageA-v3": json.dumps(stage_a("synth-fever-dose")), "stageB-v10": (MODEL / "synth-fever-dose" / "stageB.txt").read_text()})
    lg = run_consult(c, fake, tmp_path)
    assert lg["final_valid"] and [x["tag"] for x in fake.calls] == ["stageA-v3:synth-fever-dose", "stageB-v10:synth-fever-dose"]
    assert "[S0|doctor]" in fake.calls[0]["prompt"] and "{{" not in fake.calls[0]["prompt"]


def test_stage_a_sees_quarantine_marks_and_role_flags(tmp_path):
    c = load_consult(CONSULTS, "synth-boundary-knee")
    fake = FakeClient({"stageA": json.dumps(stage_a("synth-boundary-knee"))})
    run_consult(c, fake, tmp_path, Options(stage_b_enabled=False))
    p = fake.calls[0]["prompt"]
    assert p.count("[QUARANTINED: possible other consult]") == 3 and '"two_consults": true' in p
    assert len(fake.calls) == 1


def test_no_role_track_prompt_asks_for_inference(tmp_path):
    c = load_consult(CONSULTS, "synth-cough-native")
    fake = FakeClient({"stageA": json.dumps(stage_a("synth-cough-native"))})
    run_consult(c, fake, tmp_path, Options(stage_b_enabled=False))
    assert "NOT roles" in fake.calls[0]["prompt"] and "|doctor]" not in fake.calls[0]["prompt"]


def test_stage_b_note_naming_a_kept_out_drug_falls_back(tmp_path):
    c = load_consult(CONSULTS, "synth-fever-dose")
    bad = (MODEL / "synth-fever-dose" / "stageB.txt").read_text().replace("paracetamol 1 g", "paracetamol 1 g, also Dolo 650")
    fake = FakeClient({"stageA": json.dumps(stage_a("synth-fever-dose")), "stageB": bad})
    lg = run_consult(c, fake, tmp_path)
    assert lg["final_valid"] and lg["note_source"].startswith("llm_")
    assert "Dolo" not in lg["artifact"]["note_text"]


def test_stage_b_note_with_extra_heading_or_line_falls_back(tmp_path):
    c = load_consult(CONSULTS, "synth-fever-dose")
    bad = (MODEL / "synth-fever-dose" / "stageB.txt").read_text().replace("Further Investigation: CBC (today)", "Further Investigation: CBC (today)\nUSG abdomen")
    fake = FakeClient({"stageA": json.dumps(stage_a("synth-fever-dose")), "stageB": bad})
    lg = run_consult(c, fake, tmp_path)
    assert lg["final_valid"] and lg["note_source"].startswith("llm_")
    assert "USG" not in lg["artifact"]["note_text"]


def test_v1_prompts_still_load():
    from tools.eta2freescript.prompts import load_prompt
    for name in ("stageA-v1", "stageB-v3", "judge-v2", "stageA-v2", "stageB-v4", "judge-v3"):
        s, u = load_prompt(name)
        assert s.strip() and u.strip()
