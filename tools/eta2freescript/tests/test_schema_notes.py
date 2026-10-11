"""The two schema notes from the problem-paper review.

(1) Speakers. The vendored artifact enum is doctor|patient|attendant|unknown — no staff, and it spells
    "attendant" where the REB role track says "attender". Map attender→attendant at ingestion; add staff and
    other in eta.freescript.v0.2; keep v0.1 validation working via to_v01.

(2) DurationUnit. The w38 schema description says years are emitted as MONTHS×12, and the vendored enum is
    only DAYS|WEEKS|MONTHS. Pulse code has a YEARS DurationUnit. Follow the vendored file; document the
    discrepancy; do not widen the unit in v0.2.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.ingest import ARTIFACT_SPEAKER, Turn, apply_inferred_roles, join_roles
from tools.eta2freescript.mapper import duration
from tools.eta2freescript.note import flags_by_pointer, render_note
from tools.eta2freescript.schema import build_v02
from tools.eta2freescript.validate import V, check, schema_v02, to_v01

VENDOR_SCHEMA = Path(__file__).resolve().parents[1] / "vendor" / "freescript-w38" / "eta-freescript-artifact.schema.json"


def vendor():
    return json.loads(VENDOR_SCHEMA.read_text(encoding="utf-8"))


# --- (1) speakers -----------------------------------------------------------------

def test_vendored_speaker_enum_has_no_staff_and_spells_attendant():
    """Anchor: the v0.1 enum the problem paper compared against."""
    assert vendor()["definitions"]["ProvenanceItem"]["properties"]["speaker"]["enum"] == [
        "doctor", "patient", "attendant", "unknown"]


def test_v02_adds_staff_and_other_keeps_attendant_never_attender():
    assert schema_v02()["definitions"]["ProvenanceItem"]["properties"]["speaker"]["enum"] == [
        "doctor", "patient", "attendant", "staff", "other", "unknown"]
    assert build_v02.SPEAKERS_V02 == ["doctor", "patient", "attendant", "staff", "other", "unknown"]
    assert "attender" not in ARTIFACT_SPEAKER.values()
    assert ARTIFACT_SPEAKER["attender"] == "attendant" and ARTIFACT_SPEAKER["attendant"] == "attendant"


def test_attender_mapped_at_ingestion_from_track_and_inferred():
    ts = [Turn(idx=0, t0_ms=0, t1_ms=1000, speaker="0", text="x"),
          Turn(idx=1, t0_ms=1000, t1_ms=2000, speaker="1", text="y")]
    join_roles(ts, {"status": "ok", "layer": "role", "engine": "llm-roles",
                    "segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker": "0", "role": "doctor"},
                                 {"t0_ms": 1000, "t1_ms": 2000, "speaker": "1", "role": "attender"}]})
    assert [t.role for t in ts] == ["doctor", "attendant"]
    ts2 = [Turn(idx=0, t0_ms=0, t1_ms=1, speaker="0", text="x")]
    apply_inferred_roles(ts2, [{"speaker": "S0", "role": "attender", "confidence": 0.9}])
    assert ts2[0].role == "attendant"


def test_staff_and_other_reach_v02_provenance_and_project_to_unknown_for_v01():
    """A staff / other turn validates as v0.2; the v0.1 projection remaps them so the vendored validator accepts it."""
    c = mk_consult([(0, 3, "0", "Please wait here."), (4, 8, "1", "Fever for two days."),
                    (9, 14, "0", "Take paracetamol 500 mg twice a day for three days.")],
                   roles={"0": "staff", "1": "patient"})
    enc = empty_encounter(
        chief_complaint={"text": "Fever", "duration": "2 days", "basis": "said", "source_turns": [1]},
        examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
        prescription=[{"action": "start", "decision_turn": 2, "generic": "paracetamol", "brand_as_said": None,
                       "strength": "500 mg", "frequency": "twice a day", "duration": "3 days", "route": "oral",
                       "basis": "said", "confidence": 0.85, "source_quote_turn": 2, "source_turns": [2]}],
        diagnoses=[{"label": "Viral fever", "rank": "primary", "doctor_named": True, "status": "provisional",
                    "basis": "said", "icd10_suggestion": None, "source_turns": [2]}],
        follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 1, "unit": "WEEKS"}, "basis": "said", "source_turns": [2]})
    # The hold-back rule keeps the medicine out (decision turn spoken by staff, not the doctor). The staff
    # speaker still appears on a kept-out provenance item, which is enough for the schema note.
    art = build_artifact(c, enc)
    assert check(art) == [], check(art)
    speakers = {p["speaker"] for p in art["provenance"]}
    assert "staff" in speakers and "attender" not in speakers
    v1 = to_v01(art)
    assert {p["speaker"] for p in v1["provenance"]} <= {"doctor", "patient", "attendant", "unknown"}
    assert all(p["speaker"] != "staff" for p in v1["provenance"])
    assert V.check(v1) == [], V.check(v1)
    # A raw v0.2 artifact handed to the v0.1 validator without projection must fail (staff is not in v0.1).
    raw = copy.deepcopy(art)
    raw["schema_version"] = "eta.freescript.v0.1"
    raw.pop("completion_required", None)
    raw.pop("clip_boundary", None)
    for p in raw["provenance"]:
        p["flags"] = [f for f in p["flags"] if f in V.SCHEMA["definitions"]["ProvenanceItem"]["properties"]["flags"]["items"]["enum"]]
        if p.get("speaker_source") == "role_track":
            p["speaker_source"] = "diarisation"
    raw["provenance"] = [p for p in raw["provenance"] if p["kind"] != "clip_boundary"]
    assert any("staff" in e or "enum" in e.lower() or "is not one of" in e for e in V.check(raw))


def test_other_speaker_also_projects_to_unknown():
    c = mk_consult([(0, 5, "0", "Take rest."), (6, 10, "1", "Okay.")], roles={"0": "other", "1": "patient"})
    art = build_artifact(c, empty_encounter(
        chief_complaint={"text": "Tired", "basis": "said", "source_turns": [0]},
        examination=[{"performed": "General", "finding": "well", "basis": "said", "source_turns": [0]}],
        advice=[{"text": "Take rest", "basis": "said", "source_turns": [0]}]))
    assert check(art) == []
    assert any(p["speaker"] == "other" for p in art["provenance"])
    v1 = to_v01(art)
    assert all(p["speaker"] != "other" for p in v1["provenance"]) and V.check(v1) == []


# --- (2) DurationUnit -------------------------------------------------------------

def test_vendored_duration_unit_enum_is_days_weeks_months_only():
    """Follow the enum file actually vendored, not Pulse's evenpb.DurationUnit (which has YEARS)."""
    unit = vendor()["definitions"]["LlmDuration"]["properties"]["unit"]
    assert unit["enum"] == ["DAYS", "WEEKS", "MONTHS"]
    assert "YEARS" not in unit["enum"]
    assert "MONTHS x 12" in unit["description"] or "MONTHS×12" in unit["description"]
    # v0.2 must not widen it — gp_extraction stays valid against the same LlmDuration.
    assert schema_v02()["definitions"]["LlmDuration"]["properties"]["unit"]["enum"] == ["DAYS", "WEEKS", "MONTHS"]
    assert "YEARS" not in json.dumps(schema_v02()["definitions"]["LlmDuration"])


def test_years_become_months_times_twelve_and_pass_schema():
    assert duration({"value": 5, "unit": "YEARS"}) == ({"value": 60, "unit": "MONTHS"}, None)
    assert duration({"value": 1, "unit": "YEARS"}) == ({"value": 12, "unit": "MONTHS"}, None)
    # Cap: 1–1000 in the vendored schema; 90 years → 1080 months is not representable.
    assert duration({"value": 90, "unit": "YEARS"}) == (None, "duration 90 YEARS not representable")
    c = mk_consult([(0, 3, "1", "I have had sugar for five years."),
                    (4, 8, "0", "Continue metformin. Come back after one month.")],
                   roles={"0": "doctor", "1": "patient"})
    art = build_artifact(c, empty_encounter(
        comorbidities=[{"name": "Diabetes mellitus", "duration": {"value": 5, "unit": "YEARS"}, "basis": "said",
                        "source_turns": [0]}],
        examination=[{"performed": "General", "finding": "well", "basis": "said", "source_turns": [1]}],
        prescription=[{"action": "continue", "decision_turn": 1, "generic": "metformin", "brand_as_said": None,
                       "strength": None, "frequency": None, "duration": None, "basis": "said", "confidence": 0.8,
                       "source_quote_turn": 1, "source_turns": [1]}],
        follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 1, "unit": "MONTHS"}, "basis": "said",
                   "source_turns": [1]}))
    assert art["gp_extraction"]["comorbidities"][0]["duration"] == {"value": 60, "unit": "MONTHS"}
    assert check(art) == [], check(art)
    assert V.check(to_v01(art)) == []


def test_years_unit_in_gp_extraction_fails_both_schemas():
    """A consumer that wrote YEARS into gp_extraction (Pulse's DurationUnit) would fail the vendored schema."""
    c = mk_consult([(0, 3, "1", "Sugar for years."), (4, 8, "0", "Continue.")], roles={"0": "doctor", "1": "patient"})
    art = build_artifact(c, empty_encounter(
        comorbidities=[{"name": "Diabetes mellitus", "duration": {"value": 2, "unit": "YEARS"}, "basis": "said",
                        "source_turns": [0]}],
        examination=[{"performed": "General", "finding": "well", "basis": "said", "source_turns": [1]}]))
    art["note_text"] = render_note(art["gp_extraction"], flags_by_pointer(art))
    assert art["gp_extraction"]["comorbidities"][0]["duration"]["unit"] == "MONTHS"
    bad = copy.deepcopy(art)
    bad["gp_extraction"]["comorbidities"][0]["duration"] = {"value": 5, "unit": "YEARS"}
    assert any("YEARS" in e or "is not one of" in e for e in check(bad))
    v1 = to_v01(bad)
    assert any("YEARS" in e or "is not one of" in e for e in V.check(v1))
