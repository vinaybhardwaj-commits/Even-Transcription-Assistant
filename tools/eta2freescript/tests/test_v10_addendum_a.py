"""Addendum A (22 Oct 2026): failing-first tests, one per L0C case class. Committed tests use synthetic paraphrases only; the real cases live in
tests/fixtures_private/ (gitignored, 0600) and are read by test_v10_addendum_a_private.py when present. These import nothing from tools.eta2freescript.v10
so they fail (not just error) on 6c1256b5."""
import json
import re
from pathlib import Path

from conftest import empty_encounter, mk_consult
from tools.eta2freescript import boundary
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import run_consult

PROMPTS = Path(__file__).resolve().parents[1] / "prompts"


def run(tmp_path, lines, enc, roles, role_track=True):
    c = mk_consult(lines, roles=roles, role_track=role_track)
    return run_consult(c, FakeClient({"stageA": json.dumps(enc), "stageB": "no headings"}), tmp_path)["artifact"]


def adv(text, turns):
    return {"text": text, "basis": "said", "source_turns": turns}


# F1 --------------------------------------------------------------------------------------------------------------------------------------
def test_f1_stage_a_v3_defines_advice_as_the_treating_doctors_directive():
    t = (PROMPTS / "stageA-v3.md").read_text(encoding="utf-8")
    assert "only the treating doctor's directive to THIS patient" in t
    for phrase in ("history question", "the patient's own symptoms, triggers, habits or opinions", "advice another doctor gave in the past"):
        assert phrase in t


def test_f1_mapper_needs_a_doctor_turn_on_a_diarised_track(tmp_path):
    # every turn role unknown (cases db8a5mu7, 7s815msg): a patient's narrative of another doctor's advice is not advice
    lines = [(0, 4, "0", "My old doctor told me to avoid spicy food and rest completely."), (5, 9, "1", "Yes that is what I was told.")]
    a = run(tmp_path, lines, empty_encounter(advice=[adv("Avoid spicy food and rest", [0, 1])]), roles={}, role_track=False)
    assert "general_advice" not in a["gp_extraction"]
    ok = run(tmp_path / "d", [(0, 4, "0", "Avoid spicy food and rest.")], empty_encounter(advice=[adv("Avoid spicy food and rest", [0])]), roles={"0": "doctor"})
    assert ok["gp_extraction"]["general_advice"]


# F2 --------------------------------------------------------------------------------------------------------------------------------------
def test_f2_stage_a_v3_keeps_polarity_object_and_last_instruction():
    t = (PROMPTS / "stageA-v3.md").read_text(encoding="utf-8")
    for phrase in ("keep the doctor's polarity and object exactly", "A question", "is not an instruction", "use the doctor's LAST instruction",
                   "binds only to the item in its own clause"):
        assert phrase in t


# F3 --------------------------------------------------------------------------------------------------------------------------------------
def test_f3_a_medicine_named_like_an_investigation_is_kept_out(tmp_path):
    lines = [(0, 4, "0", "We will check your zinc level. No zinc tablet for now.")]
    enc = empty_encounter(investigations=[{"name": "Zinc level", "order_status": "ordered", "decision_turn": 0, "basis": "said", "source_turns": [0]}],
                          prescription=[{"action": "start", "decision_turn": 0, "generic": "zinc", "brand_as_said": None, "strength": None, "frequency": "at night",
                                         "duration": None, "route": None, "basis": "said", "confidence": 0.8, "source_quote_turn": 0, "source_turns": [0]}])
    a = run(tmp_path, lines, enc, roles={"0": "doctor"})
    assert "medicines" not in a["gp_extraction"] or not a["gp_extraction"]["medicines"]
    assert not [p for p in a.get("confirm_prompts", []) if "zinc" in json.dumps(p).lower()]
    assert any(p["kind"] == "medicine" and p["status"] == "discussed_only" and p["json_pointer"] is None for p in a["provenance"])


def test_f3_an_investigation_inside_a_longer_investigation_is_kept_out(tmp_path):
    lines = [(0, 6, "0", "Let us do glycosylated haemoglobin, HbA1c, it includes the Hb part.")]
    inv = [{"name": "HbA1c", "order_status": "ordered", "decision_turn": 0, "basis": "said", "source_turns": [0]},
           {"name": "Hb", "order_status": "ordered", "decision_turn": 0, "basis": "said", "source_turns": [0]}]
    a = run(tmp_path, lines, empty_encounter(investigations=inv), roles={"0": "doctor"})
    assert [i["name"] for i in a["gp_extraction"]["further_investigations"]] == ["HbA1c"]


# F4 --------------------------------------------------------------------------------------------------------------------------------------
def test_f4_leading_goodbye_gap_greeting_quarantines_the_previous_patient():
    lines = [(0, 4, "0", "Take rest and drink water."), (5, 8, "1", "Okay doctor."), (9, 12, "0", "Thank you, take care."), (40, 43, "0", "Hello, come sit."),
             (44, 50, "1", "Doctor I have a headache."), (51, 58, "0", "How long has it been.")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient"})
    b = boundary.detect(c)
    assert {0, 1, 2} <= b.quarantined and 3 not in b.quarantined and 4 not in b.quarantined
    short_gap = [(0, 4, "0", "Take rest."), (5, 8, "0", "Thank you."), (10, 13, "0", "Hello, come sit."), (14, 20, "1", "I have a headache.")]
    assert not boundary.detect(mk_consult(short_gap, roles={"0": "doctor", "1": "patient"})).quarantined


# F5 --------------------------------------------------------------------------------------------------------------------------------------
def test_f5_name_masker_never_masks_a_brand():
    from tools.timbre.phi_mask import mask_phi
    assert "Dolo" in mask_phi("my name is Dolo and the pain is bad").text and "Telma" in mask_phi("name is Telma given at night").text
    assert "Anita" not in mask_phi("my name is Anita and I slept").text
