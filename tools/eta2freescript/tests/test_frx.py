"""Finished-prescription rules (FRX-*). Examples A and B are the spec's synthetic consults.

Pass: the built artefact has no finding for that rule. Fail: one mutation of A or B, and frx() reports it.
FRX-D4 is a warning: it is in frx() and absent from check(). Medication rules M8-M13 block.
"""
from __future__ import annotations

import copy
import datetime as dt
from datetime import timedelta, timezone

import pytest

from conftest import build_artifact, empty_encounter

from tools.eta2freescript.ingest import Consult, RoleFlags, Turn
from tools.eta2freescript.mapper import duration
from tools.eta2freescript.validate import check, frx

IST = timezone(timedelta(hours=5, minutes=30))
DOC = {"0": "doctor", "1": "patient"}

# Every code frx() can emit. A pass and a fail below name each one.
CODES = (
    "E1 E2 E3 P1 P2 P3 P4 P5 M1 M2 M3 M4 M5 M6 M7 M8 M9 M10 M11 M12 M13 "
    "S1 S2 S3 I1 I2 R1 A1 A2 D1 D2 D3 D4 PR1 PR2 PR3 F1 F2 F3 F4 C1 C2"
).split()


def _consult(day, lines, uid, role_track, roles=None):
    base = dt.datetime(day.year, day.month, day.day, 10, 0, tzinfo=IST)
    t0 = int(base.timestamp() * 1000)
    turns = []
    for i, (a, b, sp, text) in enumerate(lines):
        role = (roles or {}).get(sp, "unknown")
        turns.append(Turn(idx=i, t0_ms=t0 + int(a * 1000), t1_ms=t0 + int(b * 1000), speaker=sp, text=text, lang="en",
                          role=role if role_track else "unknown", role_source="role_track" if role_track else "none"))
    end = t0 + int((lines[-1][1] + 2) * 1000)
    return Consult(uid=uid, turns=turns, clip_t0_ms=t0, clip_t1_ms=end, language_code="en", english_source="native",
                   diarised=True, room="synth-room", role_track=role_track,
                   role_flags=RoleFlags() if role_track else None, meta={"consult_uid": uid})


A_LINES = [
    (0, 2, "0", "Good morning."),
    (2, 4, "1", "My knee hurts."),
    (4, 6, "0", "Since when?"),
    (6, 8, "1", "Two weeks."),
    (8, 14, "1", "I've been taking Dolo 650 for the pain."),
    (14, 16, "0", "Any swelling?"),
    (16, 18, "1", "A little."),
    (18, 20, "0", "Let me see."),
    (20, 22, "1", "It gives way."),
    (22, 32, "0", "Your MRI shows a complete ACL tear. You'll need an ACL reconstruction; take your time to decide, but that is my advice."),
    (32, 34, "1", "Is that necessary?"),
    (34, 42, "0", "For pain take paracetamol 1 g when needed, maximum three a day."),
    (42, 48, "0", "And apply this gel twice a day for two weeks."),
    (48, 56, "0", "Get a standing X-ray of both knees and come back after two weeks with the report."),
]

B_LINES = [
    (0, 2, "0", "Good morning."),
    (2, 4, "1", "Burning after food."),
    (4, 6, "0", "Since when?"),
    (6, 10, "1", "I take pantoprazole every morning."),
    (10, 12, "0", "How long?"),
    (12, 14, "1", "A few months."),
    (14, 20, "0", "Stop the painkiller you bought from the chemist."),
    (20, 22, "1", "Alright."),
    (22, 30, "0", "I'm giving you a syrup, two spoons three times after food, for two weeks."),
    (30, 32, "1", "Okay."),
    (32, 40, "0", "If it's not better in two weeks we'll do an endoscopy."),
    (40, 46, "0", "Come back if the burning continues."),
]


def example_a():
    c = _consult(dt.date(2026, 10, 10), A_LINES, "synth-fs-a", True, DOC)
    enc = empty_encounter(
        examination=[],
        diagnoses=[{"label": "Complete tear of anterior cruciate ligament", "raw_name": "complete ACL tear", "rank": "primary",
                    "doctor_named": True, "status": "confirmed", "basis": "said", "icd10_suggestion": "S83.5",
                    "icd10_confidence": 0.8, "source_turns": [9]}],
        procedures=[{"name": "Anterior Cruciate Ligament Reconstruction", "raw_name": "ACL reconstruction",
                     "advised_kind": "offered_elective", "decision_turn": 9, "basis": "said", "source_turns": [9]}],
        prescription=[{"action": "start", "decision_turn": 11, "generic": "paracetamol", "brand_as_said": "Dolo 650",
                       "strength": "1 g", "frequency": "when needed, maximum three a day", "duration": None,
                       "basis": "said", "confidence": 0.9, "source_turns": [11, 4]}],
        investigations=[{"name": "X-ray Both Knees Standing AP", "order_status": "ordered", "basis": "said",
                         "decision_turn": 13, "source_turns": [13]}],
        follow_up={"type": "FOLLOW_UP_WITH_REPORTS", "interval": {"value": 2, "unit": "WEEKS"},
                   "when": "Review after 2 weeks with X-ray report", "with_reports": True, "basis": "said", "source_turns": [13]},
        regimen_slots=[{"dosage_form": "gel", "frequency": "twice a day", "duration": "for two weeks",
                        "indication_said": "knee pain", "quote_turn": 12, "source_turns": [12], "confidence": 0.5}],
    )
    return build_artifact(c, enc)


def example_b():
    c = _consult(dt.date(2026, 10, 11), B_LINES, "synth-fs-b", False)
    enc = empty_encounter(
        examination=[],
        diagnoses=[{"label": "Dyspepsia", "raw_name": "acidity", "rank": "primary", "doctor_named": True,
                    "status": "confirmed", "basis": "said", "source_turns": [10]}],
        prescription=[{"action": "stop", "decision_turn": 6, "generic": "painkiller", "basis": "said",
                       "confidence": 0.8, "source_turns": [6]}],
        drug_history=[{"name_as_said": "pantoprazole", "text": "Takes pantoprazole", "current": True,
                       "reported_by": "patient", "source_turns": [3]}],
        procedures=[{"name": "Upper GI endoscopy", "raw_name": "endoscopy", "advised_kind": "conditional",
                     "notes": "if not better in 2 weeks", "decision_turn": 10, "basis": "said", "source_turns": [10]}],
        regimen_slots=[{"dosage_form": "syrup", "frequency": "three times", "duration": "for two weeks",
                        "timing": "after food", "strength": "two spoons", "indication_said": "burning",
                        "quote_turn": 8, "source_turns": [8], "confidence": 0.5}],
        follow_up={"condition": "Come back if the burning continues", "basis": "said", "source_turns": [11]},
    )
    return build_artifact(c, enc)


def hits(art, code):
    prefix = "FRX-" + code
    return [e for e in frx(art) if e.startswith(prefix) and (len(e) == len(prefix) or not e[len(prefix)].isalnum())]


def _med(art):
    return next(p for p in art["provenance"] if p.get("json_pointer") == "/medicines/0")


def _proc(art):
    return next(p for p in art["provenance"] if p.get("kind") == "procedure" and p.get("status") == "prescribed")


def _drop(art, kind):
    art["completion_required"] = [c for c in art["completion_required"] if c.get("kind") != kind]


# --- golden artefacts -------------------------------------------------------

def test_example_a_is_a_finished_prescription():
    a = example_a()
    assert check(a) == [], check(a)
    assert a["schema_version"] == "eta.freescript.v0.3"
    assert a["encounter"]["visit_date_ist"] == "2026-10-10"
    assert a["generator"]["run_id"] and a["room_facts"] == {"allergies": [], "vitals": []}
    assert all(p.get("evidence_state") for p in a["provenance"])
    dx = a["gp_extraction"]["presenting_complaints"]["diagnoses"]
    assert dx[0]["diagnosis_or_impression"] == "Complete tear of anterior cruciate ligament"
    assert dx[0]["is_differential_diagnosis"] is False
    pom = a["gp_extraction"]["plan_of_management"]
    assert pom["requires_surgery_or_procedure"] is True
    assert pom["surgery_or_procedure_recommendations"][0]["name"] == "Anterior Cruciate Ligament Reconstruction"
    assert _proc(a)["procedure"]["advised_kind"] == "offered_elective"
    med = a["gp_extraction"]["medicines"][0]
    assert "1" in med["name"] and "g" in med["name"] and "1000" not in med["name"]
    assert med["frequency"] == "when needed, maximum three a day" and "duration" not in med
    parts = _med(a)["medicine"]
    assert parts["duration"]["evidence_state"] == "not_said_in_room"
    assert "Dolo 650" in parts["strength"]["as_heard"] and "T4" in parts["strength"]["as_heard"]
    assert "doctor_dose_precedence" in _med(a)["flags"]
    fu = a["gp_extraction"]["follow_up"]
    assert fu["followup_type"] == "FOLLOW_UP_WITH_REPORTS" and fu["followup_date"] == "2026-10-24"
    assert "X-ray report" in fu["follow_up_instructions"]
    owner = next(p for p in a["provenance"] if p.get("json_pointer") == "/follow_up")
    assert owner["follow_up"]["interval"] == {"value": 2, "unit": "WEEKS"}
    assert a["gp_extraction"]["further_investigations"][0]["name"] == "X-ray Both Knees Standing AP"
    assert len(a["slots"]) == 1 and a["slots"][0]["form"]["text"] == "gel"
    kinds = {c["kind"] for c in a["completion_required"]}
    assert {"dose_unstated", "pick_drug", "exam_missing"} <= kinds and "follow_up_missing" not in kinds
    dose = next(c for c in a["completion_required"] if c["kind"] == "dose_unstated")
    assert dose["detail"] == _med(a)["item_id"]
    slot = a["slots"][0]
    pick = next(c for c in a["completion_required"] if c["kind"] == "pick_drug")
    assert pick["item_id"] == slot["slot_id"] and pick["prompt"] == "Name this drug" and "knee pain" in pick["detail"]


def test_example_b_keeps_conditional_and_unnamed_items_out():
    b = example_b()
    assert check(b) == [], check(b)
    assert b["encounter"]["visit_date_ist"] == "2026-10-11"
    assert b["schema_version"] == "eta.freescript.v0.3"
    pom = b["gp_extraction"]["plan_of_management"]
    assert pom["requires_surgery_or_procedure"] is False
    assert "surgery_or_procedure_recommendations" not in pom
    plan = pom["management_plan"]
    assert "Stop painkiller" in plan and "Upper GI endoscopy" in plan and "if not better" in plan
    assert "medicines" not in b["gp_extraction"]
    stopped = next(p for p in b["provenance"] if p.get("status") == "stopped")
    assert stopped["negated"] is True and stopped["json_pointer"] is None and "painkiller" in stopped["names"]
    hist = next(p for p in b["provenance"] if p.get("status") == "drug_history")
    assert "pantoprazole" in hist["names"] and hist["json_pointer"] is None and "speaker_uncertain" in hist["flags"]
    endo = next(p for p in b["provenance"] if p.get("kind") == "procedure")
    assert endo["json_pointer"] is None and endo["procedure"]["advised_kind"] == "conditional"
    assert endo["text"] in plan
    fu = b["gp_extraction"]["follow_up"]
    assert fu["followup_type"] == "IF_REQUIRED" and "followup_date" not in fu
    assert "burning" in fu["follow_up_instructions"]
    assert b["gp_extraction"]["presenting_complaints"]["diagnoses"][0]["raw_name"] == "acidity"
    slot = b["slots"][0]
    assert slot["form"]["text"] == "syrup" and slot["json_pointer"] is None
    prompts = {c["kind"]: c["prompt"] for c in b["completion_required"]}
    assert prompts["drug_history"] == "Continue pantoprazole?"
    assert prompts["pick_drug"] == "Name this drug" and "surgery_confirm" in prompts and "exam_missing" in prompts


@pytest.mark.parametrize("code", CODES)
def test_frx_pass(code):
    """The worked example that exercises the rule does not trip it."""
    base = example_b() if code in {"M7", "PR2", "F2"} else example_a()
    # F2's pass is example A (a dated follow-up). M7 and the conditional half of PR2 are example B.
    if code == "F2":
        base = example_a()
    if code == "M4":
        med = _med(base)
        med["medicine"]["strength"]["source"] = "patient"
    if code == "M6":
        med = _med(base)
        med["status"] = "continued"
        med["medicine"]["explicit_continue"] = True
        med["decision"]["quote"] = med["decision"]["quote"] + " and continue"
    assert hits(base, code) == []


@pytest.mark.parametrize("code,which,mutate", [
    ("E1", "a", lambda a: a["generator"].__setitem__("model_provider", "other")),
    ("E2", "a", lambda a: a["encounter"].__setitem__("visit_date_ist", "1999-01-01")),
    ("E3", "a", lambda a: a.__setitem__("note_text", a["note_text"] + " " + "98" + "76543210")),
    ("P1", "a", lambda a: _med(a).__setitem__("json_pointer", None)),
    ("P2", "a", lambda a: _med(a).__setitem__("evidence_state", "inferred")),
    ("P3", "a", lambda a: [ev.__setitem__("quote", "") for ev in _med(a)["evidence"]]),
    ("P4", "a", lambda a: a["provenance"].append({
        "item_id": "dxextra", "kind": "diagnosis", "text": "maybe", "evidence_state": "inferred",
        "status": "discussed_only", "negated": False, "confidence": 0.9, "json_pointer": None,
        "flags": [], "evidence": [], "decision": None})),
    ("P5", "a", lambda a: _drop(a, "dose_unstated")),
    ("M1", "a", lambda a: a["gp_extraction"]["medicines"][0].__setitem__("name", "statin")),
    ("M2", "a", lambda a: a["gp_extraction"]["medicines"][0].__setitem__("name", "paracetamol")),
    ("M3", "a", lambda a: a["gp_extraction"]["medicines"][0].__setitem__("name", "paracetamol 1000 mg")),
    ("M4", "a", lambda a: (
        _med(a)["medicine"]["strength"].__setitem__("source", "patient"),
        _med(a)["medicine"]["strength"].pop("as_heard", None),
        _med(a)["flags"].remove("doctor_dose_precedence") if "doctor_dose_precedence" in _med(a)["flags"] else None)),
    ("M5", "a", lambda a: _med(a)["medicine"]["frequency"].__setitem__("evidence_state", "not_said_in_room")),
    ("M6", "a", lambda a: (_med(a).__setitem__("status", "continued"), _med(a)["medicine"].__setitem__("explicit_continue", False))),
    ("M7", "a", lambda a: a["provenance"].append({
        "item_id": "medstop", "kind": "medicine", "text": "Stop paracetamol", "status": "stopped", "negated": True,
        "json_pointer": None, "names": ["paracetamol"], "evidence_state": "heard_in_room"})),
    ("M8", "a", lambda a: a["gp_extraction"]["medicines"][0].__setitem__("name", "Zzyzx 1 g")),
    ("M9", "a", lambda a: _med(a)["evidence"][0].__setitem__("quote_native", "ರಿವರಾಕ್ಸಾಬಾನ್ 10 mg")),
    ("M10", "a", lambda a: a["gp_extraction"]["medicines"][0].__setitem__("name", "Zzyzx 1 g")),
    ("M11", "a", lambda a: (
        a["gp_extraction"]["medicines"][0].__setitem__("name", "omeprazole 20 mg"),
        a["gp_extraction"]["medicines"][0].__setitem__("raw_name", "Voquezna"))),
    ("M12", "a", lambda a: (
        a["gp_extraction"]["medicines"][0].__setitem__("name", "paracetamol 10 ml"),
        _med(a)["medicine"]["strength"].update({"text": "10 ml", "value": "10", "unit": "ml"}),
        _med(a)["medicine"].__setitem__("dosage_form", "tablet"))),
    ("M13", "a", lambda a: (
        a["gp_extraction"]["medicines"][0].__setitem__("name", "paracetamol 9400 mg"),
        _med(a)["medicine"]["strength"].update({"text": "9400 mg", "value": "9400", "unit": "mg"}))),
    ("S1", "a", lambda a: a["slots"][0]["form"].__setitem__("text", "Paracetamol")),
    ("S2", "a", lambda a: _drop(a, "pick_drug")),
    ("S3", "a", lambda a: a["slots"][0]["timing"].__setitem__("text", "None")),
    ("I1", "a", lambda a: next(p for p in a["provenance"] if p.get("json_pointer") == "/further_investigations/0")["investigation"].__setitem__("order_status", "conditional")),
    ("I2", "a", lambda a: a["gp_extraction"]["further_investigations"][0].__setitem__("urgent", True)),
    ("R1", "a", lambda a: a["gp_extraction"].setdefault("referrals", []).append({"speciality": "D" + "r " + "Planted"})),
    ("A1", "a", lambda a: a["gp_extraction"].__setitem__("general_advice", "x" * 301)),
    ("A2", "a", lambda a: a["room_facts"]["allergies"].append({"name": "paracetamol"})),
    ("D1", "a", lambda a: next(p for p in a["provenance"] if p.get("json_pointer") == "/presenting_complaints/diagnoses/0")["diagnosis"].__setitem__("is_primary", False)),
    ("D2", "a", lambda a: next(p for p in a["provenance"] if p.get("json_pointer") == "/presenting_complaints/diagnoses/0")["diagnosis"]["icd10"].__setitem__("code", "BP")),
    ("D3", "a", lambda a: a["gp_extraction"]["presenting_complaints"]["diagnoses"].append(
        {"diagnosis_or_impression": "Knee pain", "is_differential_diagnosis": False, "raw_name": "knee pain"})),
    ("D4", "a", lambda a: (
        a["gp_extraction"]["presenting_complaints"]["diagnoses"][0].__setitem__("diagnosis_or_impression", "Pre-diabetes"),
        a["room_facts"]["vitals"].append({"name": "HbA1c", "value": "6.8"}))),
    ("PR1", "a", lambda a: a["gp_extraction"]["plan_of_management"].__setitem__("requires_surgery_or_procedure", False)),
    ("PR2", "a", lambda a: _proc(a).__setitem__("json_pointer", None)),
    ("PR3", "a", lambda a: a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"][0].__setitem__("name", "")),
    ("F1", "a", lambda a: a["gp_extraction"]["follow_up"].__setitem__("followup_type", "UNKNOWN")),
    ("F2", "a", lambda a: a["gp_extraction"]["follow_up"].__setitem__("followup_date", "2026-10-27")),
    ("F3", "a", lambda a: a["gp_extraction"]["follow_up"].__setitem__("no_follow_up_needed", True)),
    ("F4", "a", lambda a: (
        a["provenance"].__setitem__(slice(None), [p for p in a["provenance"] if p.get("kind") != "follow_up"]),
        a["gp_extraction"].pop("follow_up", None),
        _drop(a, "follow_up_missing"))),
    ("C1", "a", lambda a: a["completion_required"][0].__setitem__("item_id", "no-such")),
    ("C2", "a", lambda a: a.__setitem__("note_text", a["note_text"].replace(
        "Surgery or Procedure: Anterior Cruciate Ligament Reconstruction", "Surgery or Procedure:"))),
])
def test_frx_fail(code, which, mutate):
    art = example_a() if which == "a" else example_b()
    mutate(art)
    assert hits(art, code), frx(art)


def test_frx_m8_blocks_an_unresolvable_name():
    art = example_a()
    art["gp_extraction"]["medicines"][0]["name"] = "Zzyzx 1 g"
    art["gp_extraction"]["medicines"][0]["aliases"] = []
    assert hits(art, "M8")
    assert any(e.startswith("FRX-M8") for e in check(art))


def test_frx_m10_blocks_an_unresolvable_heard_alias():
    art = example_a()
    art["gp_extraction"]["medicines"][0]["aliases"] = ["Zzyzx"]
    assert any(e.startswith("FRX-M10") for e in check(art))


def test_frx_m4_patient_source_passes_when_the_doctor_value_is_kept():
    art = example_a()
    med = _med(art)
    med["medicine"]["strength"]["source"] = "patient"
    assert "Dolo 650" in med["medicine"]["strength"]["as_heard"]
    assert "doctor_dose_precedence" in med["flags"]
    assert "1" in art["gp_extraction"]["medicines"][0]["name"]
    assert hits(art, "M4") == []
    assert check(art) == []


def test_emit_years_switch(monkeypatch):
    monkeypatch.delenv("ETA_FREESCRIPT_EMIT_YEARS", raising=False)
    assert duration({"value": 2, "unit": "YEARS"})[0] == {"value": 24, "unit": "MONTHS"}
    monkeypatch.setenv("ETA_FREESCRIPT_EMIT_YEARS", "0")
    assert duration({"value": 2, "unit": "YEARS"})[0] == {"value": 24, "unit": "MONTHS"}
    monkeypatch.setenv("ETA_FREESCRIPT_EMIT_YEARS", "1")
    assert duration({"value": 2, "unit": "YEARS"})[0] == {"value": 2, "unit": "YEARS"}
    monkeypatch.setenv("ETA_FREESCRIPT_EMIT_YEARS", "maybe")
    with pytest.raises(ValueError):
        duration({"value": 2, "unit": "YEARS"})


def test_example_b_conditional_procedure_needs_surgery_confirm():
    """PR2 pass on B: conditional stays out, the sentence is in the plan, surgery_confirm exists."""
    b = example_b()
    assert hits(b, "PR2") == []
    b2 = copy.deepcopy(b)
    _drop(b2, "surgery_confirm")
    assert hits(b2, "PR2")
