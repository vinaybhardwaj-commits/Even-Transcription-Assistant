"""printable-v1 (spec 7.3, 8.2): note_text carries no placeholder, marker or instruction to the doctor. Synthetic text only."""
import itertools

import pytest
from conftest import CONSULTS, build_artifact, stage_a

from tools.eta2freescript.boundary import Boundary
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.note import BRACKET_SPAN, HEADINGS, render_note, sanitize_note
from tools.eta2freescript.validate import check, frx_n


def note(**sections):
    return "\n".join(f"{h}: {sections[h]}".rstrip() if h in sections else f"{h}:" for h in HEADINGS)


def n1(text, completion=None, gx=None):
    art = {"note_text": text, "completion_required": completion or [], "gp_extraction": gx or {}}
    return [e for e in frx_n(art) if e.startswith("FRX-N1")]


PASS_CASES = [
    {"Plan of Management": "Confirm diagnosis with USG abdomen"},
    {"General Advice": "Check blood sugar fasting and PP"},
    {"Medication": "Tab Dolo 650 1-0-1 x 5 days after food"},
    {"Plan of Management": "if BP > 140 repeat in 1 week"},
    {"Medication": "Paracetamol 650 SOS for pain"},
    {"Diagnoses": "?Migraine"},
    {"Follow up": "Review with reports"},
    {"Examination": "BP 130/80 mm Hg"},
    {"Medication": "Paracetamol 650 TDS x 3 days"},
    {"Plan of Management": "if BP < 140 continue"},
    {"Plan of Management": "if BP <140 continue"},
    {"Medication": "Syrup Cremaffin 10 ml HS x 7 days"},
    {"Medication": "Ointment to be applied twice daily"},
    {"Medication": "Tablet to be taken after food"},
    {"Presenting Complaint": "Cause unknown"},
    {"Co-morbidities": "No known drug allergies"},
    {"Follow up": "mandatory follow up; 2026-10-25; Review after 2 weeks"},
    {"Refer to": "Cardiology - for ECHO"},
    {"Further Investigation": "HbA1c (fasting not required)"},
    {"Diagnoses": "Fever of unknown origin"},
    {"Diagnoses": "Abdominal pain, cause unclear"},
    {"Plan of Management": "Diagnosis unclear, observe"},
    {"Plan of Management": "Decide on surgery after MRI"},
    {"General Advice": "BP to be checked weekly"},
    {"General Advice": "Sugar to be monitored twice daily"},
    {"General Advice": "Dressing to be changed daily"},
    {"General Advice": "Wound to be kept out of water"},
    {"General Advice": "Keep leg kept outstretched"},
    {"Further Investigation": "sample to be given fasting"},
    {"Medication": "Tab Dolorem 1 BD x 3 days"},
    {"Presenting Complaint": "Fall at home, exact date unknown"},
    {"Co-morbidities": "Not a known diabetic"},
]


@pytest.mark.parametrize("sections", PASS_CASES)
def test_n1_false_positive_list_passes(sections):
    assert n1(note(**sections)) == []


def test_n1_full_width_brackets_are_brackets():
    assert n1(note(Medication="Tab A 1 OD ［x］"))


def test_n1_diagnosis_continuation_line_may_start_with_question_mark():
    assert n1("Diagnoses: ?Migraine\n? Acute gastritis\nPlan of Management:") == []


FAIL_CASES = [
    ("Medication", "Paracetamol 650 BD [dose not stated — doctor to verify]"),
    ("Medication", "Amlodipine 5 OD [?]"),
    ("Medication", "Pantoprazole 40 OD x ? days"),
    ("Medication", "Dose: to be confirmed"),
    ("Examination", "Not documented"),
    ("Plan of Management", "{{GP_EXTRACTION}}"),
    ("Medication", "an unnamed drug 1 OD"),
    ("Medication", "placeholder text"),
    ("Plan of Management", "an unnamed drug 1 OD"),
    ("Plan of Management", "placeholder text"),
    ("General Advice", "dose not stated"),
    ("General Advice", "held_back item"),
    ("General Advice", "Kept Out"),
    ("General Advice", "REDACTED"),
    ("General Advice", "Lorem ipsum"),
    ("Medication", "Dose TBD"),
    ("Follow up", "unspecified"),
    ("Medication", "will VERIFY later"),
    ("Medication", "Paracetamol 650 BD (doctor to confirm)"),
    ("Medication", "Paracetamol 650 (dose to be decided)"),
    ("Medication", "Paracetamol 650 BD - please confirm dose"),
    ("Medication", "Paracetamol 650 BD (needs verification)"),
    ("Medication", "Paracetamol 650 BD (frequency not mentioned)"),
    ("Medication", "Paracetamol 650 BD x duration not stated"),
    ("Medication", "Paracetamol 650 BD, dose unknown"),
    ("Medication", "Paracetamol 650 BD x <duration>"),
    ("Medication", "{dose}"),
    ("Medication", "Paracetamol 650 BD x __ days"),
    ("Medication", "XX mg"),
    ("Medication", "Paracetamol 650 BD x days"),
    ("Medication", "Paracetamol 650 BD x？days"),
    ("Medication", "Amlodipine 5 OD (to be decided)"),
    ("Follow up", "Review date unknown"),
    ("Medication", "Dose: missing"),
    ("Medication", "Kindly add strength"),
    ("Plan of Management", "Review dr to advise"),
    ("Follow up", "Frequency of review unclear"),
    ("Medication", "Amlodipine 5 OD unconfirmed"),
    ("Medication", "Amlodipine pending"),
    ("Medication", "Amlodipine ?5 OD"),          # "?" not at the start of a Diagnoses entry
    ("Plan of Management", "?cause"),            # "?" outside Diagnoses
    ("Diagnoses", "Migraine?"),                  # "?" not first in a Diagnoses entry
    ("Diagnoses", "??Migraine"),
    ("Medication", "【dose】"),
    ("Medication", "XXX mg"),
    ("Medication", "dose N/A"),
    ("Medication", "duration nil"),
    ("Medication", "Missing: dose of paracetamol"),
    ("Medication", "frequency not clearly stated"),
    ("Medication", "duration wasn't mentioned"),
    ("Medication", "duration wasn\u2019t mentioned"),
    ("Medication", "dose is not given"),
    ("Medication", "no dose given"),
    ("Medication", "dose: ask doctor"),
    ("Medication", "Paracetamol 650 BD, dose to be confirmed"),
    ("Follow up", "date unknown"),
]


@pytest.mark.parametrize("head,body", FAIL_CASES)
def test_n1_fail_list(head, body):
    assert n1(note(**{head: body}))


def test_n1_fails_unheaded_lines_and_filler_lines():
    assert n1("Medication: Tab A 1 OD\nTab B [x]\nPlan of Management:")
    assert n1("Medication: Tab A 1 OD\nnil\nPlan of Management:")
    assert n1("Medication: Tab A 1 OD\nPlan of Management: N/A")


def test_n1_question_mark_after_non_diagnosis_heading_does_not_leak_into_next_section():
    # "?" continuation is allowed only while the current section is Diagnoses.
    assert n1("Diagnoses: ?Migraine\nPlan of Management: ?x")
    assert n1("Medication: Tab A 1 OD\n?Migraine\nDiagnoses:")


def test_n1_completion_prompt_in_note_fails_and_short_prompts_are_ignored():
    comp = [{"kind": "pick_drug", "item_id": "x1", "prompt": "Name this drug"}]
    errs = n1(note(Medication="name this DRUG 1 OD"), comp)
    assert errs and all("Name this drug" not in e for e in errs)
    assert n1(note(Medication="Tab A 1 OD"), comp) == []
    short = [{"kind": "pick_drug", "item_id": "x1", "prompt": "Dose?"}]
    assert n1(note(Medication="Dose 5 mg"), short) == []


def test_n2_empty_note_with_content_fails_and_empty_gp_passes():
    gx = {"medicines": [{"name": "Tab A"}], "general_advice": ""}
    empty = note()
    assert any(e.startswith("FRX-N2") for e in frx_n({"note_text": empty, "gp_extraction": gx}))
    assert not any(e.startswith("FRX-N2") for e in frx_n({"note_text": note(Medication="Tab A"), "gp_extraction": gx}))
    assert not any(e.startswith("FRX-N2") for e in frx_n({"note_text": empty, "gp_extraction": {"medicines": [], "general_advice": " ", "follow_up": {}}}))
    assert not any(e.startswith("FRX-N2") for e in frx_n({"note_text": empty, "gp_extraction": {}}))


def test_n2_unheaded_body_counts_as_content():
    gx = {"general_advice": "rest"}
    assert not any(e.startswith("FRX-N2") for e in frx_n({"note_text": "Co-morbidities:\nrest\nExamination:", "gp_extraction": gx}))


def gx_with(m):
    return {"medicines": [m]}


FIELDS = {"frequency": "1-0-1", "duration": "5 days", "instructions": "after food"}


@pytest.mark.parametrize("subset", [s for r in range(4) for s in itertools.combinations(FIELDS, r)])
def test_renderer_medicine_line_uses_only_fields_present(subset):
    m = {"name": "Tab Dolo 650", **{k: FIELDS[k] for k in subset}}
    line = render_note(gx_with(m)).split("Medication: ")[1].split("\n")[0]
    want = " ".join(x for x in [m["name"], m.get("frequency", ""), ("x " + m["duration"]) if "duration" in m else "", m.get("instructions", "")] if x)
    assert line == want
    assert "[" not in line and "?" not in line and "verify" not in line


def test_renderer_ignores_low_confidence_flag_and_keeps_differential_prefix():
    gx = {"medicines": [{"name": "Tab A", "frequency": "OD"}],
          "presenting_complaints": {"diagnoses": [{"diagnosis_or_impression": "Migraine", "is_differential_diagnosis": True},
                                                  {"diagnosis_or_impression": "Gastritis"}]}}
    out = render_note(gx, {"/medicines/0": ["low_confidence"]})
    assert "Medication: Tab A OD\n" in out + "\n"
    assert "Diagnoses: ?Migraine\nGastritis" in out
    assert out.count("?") == 1


def test_sanitize_strips_bracket_spans_and_drops_emptied_lines():
    raw = note(Medication="Tab A 1 OD [dose not stated — doctor to verify] [?]", Examination="[not examined]") + "\nTab B 5 [low confidence]\n[only marker]"
    out = sanitize_note(raw)
    assert "[" not in out and "]" not in out
    assert "Medication: Tab A 1 OD" in out.split("\n")
    assert "Examination:" in out.split("\n")
    assert "Tab B 5" in out.split("\n")
    assert "only marker" not in out
    assert BRACKET_SPAN.sub("", "x  [y]") == "x"


def test_sanitize_keeps_existing_filler_and_headings():
    out = sanitize_note(note(Examination="Not documented", Medication="Tab A 1 OD"))
    assert "Examination:" in out.split("\n") and "Medication: Tab A 1 OD" in out.split("\n")
    assert out.count("\n") == 10


@pytest.mark.parametrize("uid", sorted(p.name for p in CONSULTS.iterdir()))
def test_all_fixtures_render_without_n1_n2(uid):
    c = load_consult(CONSULTS, uid)
    art = build_artifact(c, stage_a(uid), Boundary())
    assert [e for e in frx_n(art)] == []
    assert not [e for e in check(art) if e.startswith(("FRX-N1", "FRX-N2"))]
