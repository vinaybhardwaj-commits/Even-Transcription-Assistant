"""FRX-V10 Fix3h (eta2freescript rulings 23 Oct 2026, refute 6): timing is the signal in instruction fields; history fields withhold a timing expression beside a drug signal; the lab frame binds the
analyte in its own clause; class and dose-form lists come from the WHO ATC and EDQM Standard Terms; more other-person cues; lemmatised quarantine echo. Also kills refute-6 mutants f02 f04 f05 f07 f10 f11."""
import json

import pytest

from conftest import build_artifact, empty_encounter, mk_consult
from tools.eta2freescript.v10 import data, finalize, words
from test_v10_fix3g import gate_of


# --- 1: timing in instruction fields -------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Take it at bedtime", "Once daily", "Tab BD", "SOS if pain", "As and when needed", "Every 8 hours", "Twice a day", "Alternate days", "Subah shaam", "For a fortnight", "Till some weeks",
                               "Only lifelong", "For a month", "Whenever needed", "At midnight", "With meals", "Before breakfast", "Take Zorbexa", "Continue the plan", "Apply cream"])
def test_instruction_fields_withhold_any_timing_or_regimen_expression(t):
    g = gate_of("As told.")
    assert g.timing_outside(t, "advice") and g.timing_outside(t, "plan") and g.timing_outside(t, "follow_up")
    assert not g.timing_outside(t, "symptoms") and not g.timing_outside(t, "examination")


@pytest.mark.parametrize("t", ["Rest and drink water", "Review with reports", "Avoid oily food", "Come back if breathless"])
def test_instruction_text_without_timing_stays(t):
    assert not gate_of("As told.").timing_outside(t, "advice")


def test_the_code_written_lines_stay():
    from tools.eta2freescript.v10 import names
    assert not gate_of("As told.").timing_outside(names.PLAN_LINE, "plan") and not gate_of("As told.").timing_outside(names.DRAFT_LINE, "advice")


def test_the_final_unit_check_reports_timing_outside_medication_for_instruction_fields_only():
    g = gate_of("As told.")
    assert [v.code for v in finalize._unit_violations(g, "Come back every week", set(), "advice")] == ["timing_outside_medication"]
    assert finalize._unit_violations(g, "Come back every week", set(), "symptoms") == []
    art = {"gp_extraction": {"general_advice": "Rest every day"}, "doctor_words": [{"text_en": "Come back every week", "cited_spans": ["s0"]}], "red_flags": [], "provenance": []}
    failed = finalize.gp_final(g, art, g.c)
    assert {f[1] for f in failed} == {"timing_outside_medication"} and {f[2] for f in failed} == {"field", "served"}


# --- 2: history fields ---------------------------------------------------------------------------------------------------------------------------------------
def test_a_token_of_a_tagged_turn_beside_timing_withholds_in_history_fields_any_case_any_position():
    g = gate_of("As told.", "Ultra. Yes, continue that.", drug_spans={1})
    assert g.drug_outside("Ultra daily", [0], "symptoms") and g.drug_outside("continue ultra at night", [0], "symptoms")
    assert g.drug_outside("Ultra at night", [0], "symptoms") and g.drug_outside("ultra before breakfast", [0], "examination")
    assert not g.drug_outside("Knee pain since two days", [0], "symptoms")


def test_a_master_brand_head_beside_timing_withholds_but_symptom_timing_stays():
    g = gate_of("As told.")
    heads = words.med_master_heads()
    assert len(heads) > 3000 and "pain" not in heads and "elbow" not in heads
    h = sorted(heads)[len(heads) // 2]
    assert g.drug_outside(f"{h.capitalize()} before breakfast", [0], "symptoms")
    assert not g.drug_outside("Breathlessness on climbing, worse in the morning", [0], "symptoms")


# --- 3: the lab frame binds the analyte in its own clause -----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Take Magnesium after food; check report", "Copper value low, Copper at night", "Sodium SOS till level normal", "Iodine daily till level normal", "Ferritin ng every morning"])
def test_a_dose_does_not_hide_behind_a_lab_word(t):
    assert gate_of("As told.").drug_outside(t, [0], "symptoms"), t


@pytest.mark.parametrize("t", ["Calcium level is low", "Haemoglobin level is low", "Potassium report is low. Review soon"])
def test_a_lab_statement_clause_without_timing_is_free(t):
    assert not gate_of("As told.").drug_outside(t, [0], "investigations"), t


def test_iu_is_not_a_lab_unit():
    assert "iu" not in data.load(data.DOSING_WORDS)["lab_frame_units"] and not words.lab_frame("Vitamin D 1000 iu")


# --- 4: lists from published sources ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["the antidepressant for a fortnight", "anticonvulsant only for a month", "the steroid for some weeks", "antimalarial at night", "mucolytic daily", "a bronchodilator SOS", "beta blocker every morning",
                               "contraceptive daily", "the biologic monthly", "anti-inflammatory after food", "anti-hypertensive daily", "BP wale daily", "sugar-wali at night", "sugar vaali daily", "thyroid waale daily", "BPwale daily",
                               "proton pump inhibitor daily", "calcium channel blocker at night"])
def test_class_words_and_suffix_spellings_with_timing_are_drug_talk(t):
    assert gate_of("As told.").drug_outside(t, [0], "symptoms"), t


def test_class_and_form_lists_are_published_data_with_provenance():
    cf = data.load(data.CLASS_FORMS)
    assert "WHO ATC" in cf["sources"]["atc"] and "EDQM" in cf["sources"]["edqm"] and len(cf["sources"]["atc_csv_sha256"]) == 64 and len(cf["sources"]["edqm_json_sha256"]) == 64
    assert data.provenance()["class_forms_sha256"] == data.file_sha(data.CLASS_FORMS)
    assert len(words.class_words()) > 300 and len(words.dose_form_nouns()) > 200


@pytest.mark.parametrize("n", ["IV", "drip", "infusion", "bottle", "balm", "tube", "mouthwash", "gargle", "implant", "depot", "dropper", "tincture", "wafer", "chewable", "dispersible", "effervescent", "wash", "liniment", "lozenge", "film", "gel"])
def test_the_ruled_dose_form_nouns_are_signals(n):
    assert gate_of("As told.").drug_outside(f"Stop {n} after lunch", [0], "symptoms") and n.lower() in words.dose_form_nouns()


# --- 5: other person -----------------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["The twins have fever", "The elderly couple came", "The driver has cough", "The landlord has pain", "The teacher has cold", "Her employer has pain", "The old case was fine", "The postop case was fine",
                               "The referred case was fine", "Patients before had fever", "The patient in the next room has pain", "The other doctor's patient has pain", "Mrs Rao's case was similar", "Mr Rao's patient is stable"])
def test_more_other_person_cues_fix3h(t):
    assert words.other_person(t), t


def test_occupation_alone_is_not_an_other_person_cue():
    assert not words.other_person("Works as a driver") and not words.other_person("Patient is a teacher")


# --- 6: quarantine echo --------------------------------------------------------------------------------------------------------------------------------------
def test_the_echo_is_lemmatised_and_a_shared_token_counts_beside_two_quarantined_ones():
    g = gate_of("Knee pain here.", "Swelling of knees, icing helps.", quarantined={1})
    assert g.quarantine_echo("Knee swelling, icing", [0])      # knee shared with the current turn; swelling and icing (icing / ice) come from the quarantined turn
    assert g.quarantine_echo("Knees swelling and ice", [0])
    assert not g.quarantine_echo("Knee pain", [0])
    assert g.echo_k2("Swelling icing only", [0]) is True


# --- mutants f02 f04 f05 f07 f10 f11 (refute 6) ---------------------------------------------------------------------------------------------------------------
def test_f02_an_english_word_brand_in_a_unit_that_cites_a_tagged_turn_is_a_drug():
    assert gate_of("As told.", drug_spans={0}).drug_outside("He says Duo is fine", [0], "symptoms")
    assert not gate_of("As told.").drug_outside("He says Duo is fine", [0], "symptoms")


def test_f04_a_capitalised_mid_sentence_word_of_a_tagged_turn_is_a_drug_token():
    g = gate_of("As told.", "Then Vorlin.", drug_spans={1})
    assert "vorlin" in g._tagged_index()[0] and g.tagged_overlap("Vorlin helps")


def test_f05_a_drug_token_in_the_native_text_of_a_tagged_turn_counts():
    g = gate_of("As told.", "hello", drug_spans={1}, native={1: "Then Zorbexa works."})
    assert g.tagged_overlap("Zorbexa helps")


def test_f07_a_served_item_is_read_against_the_tagged_turns():
    g = gate_of("Tell me.", "Use Qwelmoxin.", drug_spans={1})
    art = {"gp_extraction": {}, "doctor_words": [{"text_en": "Take Qwelmoxin", "cited_spans": ["s0"]}], "red_flags": [], "provenance": []}
    failed = finalize.gp_final(g, art, g.c)
    assert any(f[2] == "served" for f in failed)


@pytest.mark.parametrize("t", ["The woman who left was fine", "Pain started. That one who left", "He who left had fever"])
def test_f10_a_bare_who_left_cue(t):
    assert words.other_person(t)


def test_f11_uncle_is_an_other_person_noun():
    assert words.other_person("The uncle was here") and words.other_person("Another uncle has fever") and words.other_person("The previous uncle left")
