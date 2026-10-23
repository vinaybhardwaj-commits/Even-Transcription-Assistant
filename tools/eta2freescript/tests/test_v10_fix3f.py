"""FRX-V10 Fix3f (eta2freescript rulings 23 Oct 2026): a dose-form or medicine noun is a drug signal by itself outside Medication; the given-name list covers all countries and a census surname
list applies in free text. Nothing here loosens another rule."""
import datetime as dt
import json

import pytest

from conftest import mk_consult
from tools.eta2freescript.v10 import data, finalize, names, words
from tools.eta2freescript.v10.gate import NumberGate

V = dt.date(2026, 10, 22)


def gate_of(*texts, drug_spans=()):
    return NumberGate(mk_consult([(i * 10, i * 10 + 4, "0", t) for i, t in enumerate(texts)], roles={"0": "doctor"}), visit=V, drug_spans=set(drug_spans))


NOUNS = "tablet tab capsule cap syrup injection inj drops ointment cream gel inhaler puff sachet medicine medication dawai dawa goli capsool".split()


def test_the_noun_list_is_committed_data_with_plurals():
    assert set(NOUNS) <= set(data.load(data.DOSING_WORDS)["dose_form_nouns"])
    assert {"tablets", "capsules", "medicines", "puffs", "drops"} <= words.dose_form_nouns()


@pytest.mark.parametrize("n", NOUNS)
def test_a_dose_form_noun_is_drug_talk_even_in_an_untagged_unit_with_no_drug_name(n):
    assert gate_of("As told.").drug_outside(f"Keep the {n} handy", [0]), n


@pytest.mark.parametrize("t", ["the pressure medicine twos is enough", "BP tablet", "thyroid tablet", "the sugar tablet", "Continue the pressure medicine for"])
def test_class_phrases_are_drug_talk(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


def test_the_code_written_plan_and_draft_lines_are_not_drug_talk_and_plain_text_is_free():
    g = gate_of("As told.")
    assert not g.drug_outside(names.PLAN_LINE, [0]) and not g.drug_outside(names.DRAFT_LINE, [0])
    assert not g.drug_outside("Rest at home and drink water", [0])


def test_the_noun_rule_withholds_through_the_final_checks():
    g = gate_of("As told.")
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {"general_advice": "Take the pressure medicine"}, "provenance": []}
    failed = finalize.gp_final(g, art, g.c)
    assert failed and failed[0][1] == "drug_outside_medication"
    note = "\n".join(f"{h}: {'sugar tablet at night' if h == 'General Advice' else ''}".rstrip() for h in finalize.N.HEADINGS)
    out, bad = finalize.note_final(g, {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}, g.c, note)
    assert bad.get("General Advice") == "drug_outside_medication"


# --- c: names ----------------------------------------------------------------------------------------------------------------------------------------
def test_surname_list_provenance_and_size():
    d = data.load(data.SURNAMES)
    assert d["source"]["licence"].startswith("public domain") and d["source"]["url"].startswith("https://www2.census.gov/") and len(d["source_sha256"]) == 64
    assert d["min_count"] == 100 and d["count"] == len(d["names"]) > 100000 and set(d["frequent"]) <= set(d["names"])
    assert data.provenance()["surnames_sha256"] == data.file_sha(data.SURNAMES)
    g = json.load(open(data.GIVEN_NAMES, encoding="utf-8"))
    assert g["count"] > 30000 and "honey" in g["names"]


@pytest.mark.parametrize("t", ["Sharma came today", "SHARMA came today", "Fever for Patel", "KHAN has fever", "Rose has fever", "Singh and Reddy", "Seen with Iyer"])
def test_capitalised_and_all_caps_names_on_either_list_withhold(t):
    assert words.possible_name(t) == "possible_name", t


@pytest.mark.parametrize("t", ["Patient has fever", "Chest pain since morning", "Pain in knee", "Knee pain", "Age 45 years", "Review on Monday", "Fever and cough", "sharma"[:0] + "rest well"])
def test_clinical_words_that_a_list_also_holds_stay_words(t):
    assert words.possible_name(t) is None, t


def test_a_lowercase_list_token_withholds_only_when_it_is_not_a_dictionary_word():
    assert words.possible_name("seen with sharma today") == "possible_name"
    assert words.possible_name("seen with rose today") is None and words.possible_name("seen with young people") is None


def test_surnames_are_never_kept_as_drug_tokens():
    assert "sharma" not in (names.detector_tokens("Sompraz Sharma") or "").lower()
    assert "sharma" not in json.dumps(names.drug_block({"brand_as_said": "Sompraz Sharma", "generic": None})).lower()


def test_all_caps_clinical_words_that_a_list_also_holds_stay_words_and_all_caps_names_do_not():
    assert words.possible_name("GAIT normal") is None and words.possible_name("AGE 45 years") is None
    assert words.possible_name("SHARMA came") == "possible_name"


def test_the_medication_line_never_carries_a_surname():
    g = gate_of("As told.")
    d = {"spoken": "Sharma", "brand_recognised": None, "generic": None, "components": [], "base_molecule": "sharma", "form": None, "lasa_risk": {"pair_with": None, "note": ""}}
    art = {"confirm_prompts": [{"prompt_id": "p1", "kind": "medicine", "action": "start", "drug": d, "cited_spans": [], "doctor_confirm_reason": []}], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}
    out, bad = finalize.note_final(g, art, g.c, "\n".join(f"{h}:" for h in finalize.N.HEADINGS))
    assert bad.get("Medication") == "possible_name" and "Sharma" not in out


def test_rare_surname_and_low_frequency_given_name_dictionary_words_open_a_unit_but_a_frequent_one_is_a_name():
    assert words.possible_name("General - BP 130/80") is None and words.possible_name("X-ray Both Knees") is None and words.possible_name("Pain in knee") is None
    assert words.possible_name("Khan has fever") == "possible_name" and words.possible_name("Singh came") == "possible_name"
    assert "khan" in words.frequent_surnames() and "patient" not in words.frequent_surnames() and "general" not in words.given_core()


def test_all_caps_function_words_that_a_list_also_holds_stay_words():
    for t in ("DONE well", "HIS wife", "WILL review", "HAS fever"):
        assert words.possible_name(t) is None, t
