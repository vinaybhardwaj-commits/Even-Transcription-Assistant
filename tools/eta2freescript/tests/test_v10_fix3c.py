"""FRX-V10 Fix3c (eta2freescript rulings 23 Oct 2026): generated number homographs, any capitalised mid-sentence token in a drug-tagged unit is a brand, possible_name, and the 24 food
words stay out of the dictionary. Nothing here loosens a veto, a slot bound, FRX-T1/T2 or the C4 projection."""
import datetime as dt
import json

import pytest

from conftest import build_artifact, empty_encounter, mk_consult
from tools.eta2freescript.v10 import data, drugs, finalize, numbers, words
from tools.eta2freescript.v10._build import make_homographs
from tools.eta2freescript.v10.gate import NumberGate

V = dt.date(2026, 10, 22)


def gate_of(*texts, drug_spans=()):
    lines = [(i * 10, i * 10 + 4, "0", t) for i, t in enumerate(texts)]
    return NumberGate(mk_consult(lines, roles={"0": "doctor"}), visit=V, drug_spans=set(drug_spans))


# --- 1: the homograph list is generated, deterministic and committed ---------------------------------------------------------------------------------------
def test_homograph_list_is_the_output_of_the_committed_script_and_its_sha_is_in_c7():
    d = json.load(open(data.NUMBER_HOMOGRAPHS, encoding="utf-8"))
    fresh = make_homographs.build()
    assert fresh["words"] == d["words"] and fresh["count"] == d["count"] == len(d["words"]) > 5000
    assert d["lexicon_sha256"] == data.file_sha(data.NUMBER_LEXICON)       # regenerate when the lexicon changes
    assert data.provenance()["number_homographs_sha256"] == data.file_sha(data.NUMBER_HOMOGRAPHS)
    assert d["words"] == sorted(d["words"])


@pytest.mark.parametrize("w", ["now", "dash", "mood", "paddy", "path", "teas", "basso", "ond", "vandal", "more", "dead", "sow", "nave", "ell"])
def test_the_refuter_homographs_are_generated_not_listed(w):
    assert w in numbers.homographs() and numbers.number_like(w)


def test_a_homograph_withholds_inside_a_drug_unit_and_does_nothing_outside_one():
    g = gate_of("As told.")
    for w in ("now", "paddy", "nave", "more", "dead"):
        assert g.collision_unit(f"Glycomet {w} as before", [0]), w
        assert not g.collision_unit(f"rest {w} well", [0]), w                # no drug in the unit and the turn is not tagged
        assert gate_of("As told.", drug_spans={0}).collision_unit(f"rest {w} well", [0]), w


def test_everyday_function_and_dosing_words_are_not_held_out():
    g = gate_of("As told.")
    assert not g.collision_unit("Glycomet with the pain, take it after food and drink water", [0])


# --- 2: any capitalised mid-sentence token in a drug-tagged unit reads as a brand --------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Take Duo for 6 months", "He uses Rest for 6 years", "On Grace since 6 years", "Keep Calm for 5 days"])
def test_a_capitalised_mid_sentence_token_in_a_tagged_unit_is_a_brand_beside_a_duration(t):
    assert not gate_of("As told.", drug_spans={0}).check(t, "symptoms", [0]).ok, t
    lower = t.replace("Duo", "duo").replace("Rest", "rest").replace("Grace", "grace").replace("Calm", "calm")
    assert drugs.english_brand_spans(t) == []                                                      # untagged: the rule does not apply


def test_that_rule_leaves_clinical_words_abbreviations_alone():
    with numbers.force_collisions(True):
        assert drugs.english_brand_spans("Keep taking the MRI report") == []       # all-caps abbreviation
        assert drugs.english_brand_spans("Pain in the Cough since 6 days") == []   # a clinical-vocabulary word


# --- 3: possible_name ----------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Fever for Joy", "This is Joy, giddiness.", "Patient Daisy from Delhi has giddiness", "Ask Prince about the Rose", "Hope's mother Faith came"])
def test_a_capitalised_mid_sentence_word_that_is_not_clinical_withholds_the_unit(t):
    assert words.possible_name(t) == "possible_name", t


@pytest.mark.parametrize("t", ["Fever and cough", "Review on Monday 28 October", "Take rest. Drink water", "Hx - Fever and cough", "Type 2 Diabetes Mellitus", "Hb 9.5 g/dL, HbA1c 7.8% and L4-L5",
                               "Come back with MRI Knee", "COVID-19 and ECG normal", "Dolo for fever"])
def test_calendar_clinical_abbreviation_and_drug_words_are_not_names(t):
    assert words.possible_name(t) is None, t


def test_possible_name_withholds_through_the_mapper_and_the_final_check():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Ask Faith about it. Drink water.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(advice=[{"text": "Ask Faith about the cough", "basis": "said", "source_turns": [2]}, {"text": "drink water", "basis": "said", "source_turns": [2]}]))
    assert [w for w in a["withheld"] if w["reason_code"] == "possible_name"] and "Faith" not in a["note_text"] and "water" in a["gp_extraction"]["general_advice"]
    g = gate_of("As told.")
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}
    out, bad = finalize.note_final(g, art, g.c, "\n".join(f"{h}: {'Ask Faith about it' if h == 'General Advice' else ''}".rstrip() for h in finalize.N.HEADINGS))
    assert bad.get("General Advice") == "possible_name" and "Faith" not in out


# --- 4: the 24 food words stay out of the dictionary -------------------------------------------------------------------------------------------------------
FOODS = "rava thepla atta sattu makhan namkeen mithai methi dhania pudina dalchini tinda gobi aloo kaddu kela papita chikoo anaar vilom shakkar achar turp pcod".split()


@pytest.mark.parametrize("w", FOODS)
def test_removed_food_words_withhold_as_out_of_dictionary(w):
    assert w not in words.extra_whitelist() and words.ood_tokens(f"eat {w}") == [w]


def test_a_unit_withheld_in_the_mapper_still_marks_its_note_section_as_about_a_tagged_turn():
    """The refuter's t2blind: the gp unit 'Grace threes' was withheld by the mapper, so no provenance pointer was left, and the note (written by Stage B) kept the same words."""
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I feel giddy."), (10, 14, "0", "Grace threes")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(hpi=[{"text": "Grace threes", "basis": "said", "source_turns": [2]}], drug_mention_spans=[2]))
    assert 2 in a["confirm_internal"]["held_turns"].get("symptoms", []) or any(2 in v for v in a["confirm_internal"]["held_turns"].values())
    g = gate_of("a", "b", "Grace threes", drug_spans={2})
    art = {"confirm_prompts": [], "confirm_internal": a["confirm_internal"], "gp_extraction": {}, "provenance": []}
    note = "\n".join(f"{h}: {'Grace threes' if h == 'Presenting Complaint' else ''}".rstrip() for h in finalize.N.HEADINGS)
    out, bad = finalize.note_final(g, art, g.c, note)
    assert "Presenting Complaint" in bad and "threes" not in out  # held out by the force rule (reason unslotted or collision, whichever fires first)


def test_a_note_line_with_no_provenance_is_judged_against_every_tagged_turn():
    g = gate_of("a", "b", "x", drug_spans={2})
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}
    note = "\n".join(f"{h}: {'for BP Calm threes' if h == 'Diagnoses' else ''}".rstrip() for h in finalize.N.HEADINGS)
    out, bad = finalize.note_final(g, art, g.c, note)
    assert "Diagnoses" in bad and "threes" not in out


def test_two_letter_fragments_that_are_not_english_are_number_like_in_a_drug_unit():
    g = gate_of("As told.")
    for frag in ("ak", "ik", "ch"):
        assert numbers.number_like(frag), frag
        assert g.collision_unit(f"Glycomet {frag} as before", [0]), frag
    assert not numbers.number_like("is") and not g.collision_unit("Glycomet is as before", [0])


def test_tagged_unit_reads_a_capitalised_mid_sentence_word_as_a_brand_and_only_there():
    with numbers.force_collisions(True):
        s = drugs.english_brand_spans("Take Duo for now")
        assert len(s) == 1 and "Take Duo for now"[s[0][0]:s[0][1]] == "Duo"
        assert drugs.english_brand_spans("Duo for now") == []          # sentence-initial
        assert drugs.english_brand_spans("Take Duo. Rest now") == [(5, 8)]
    assert drugs.english_brand_spans("Take Duo for now") == []         # not tagged
