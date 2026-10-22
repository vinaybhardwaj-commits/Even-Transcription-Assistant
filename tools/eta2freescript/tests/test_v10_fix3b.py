"""FRX-V10 Fix3b (refute 3 rulings, 23 Oct 2026): H1 force on the note path, H2 unconditional lexicon numbers + English-word brands as drug mentions, H3 number homographs inside a drug
unit, M1 brand + duration and class abbreviations, M2 other-person cues, M3 unresolved change/not-given never a start prompt, M4 herbals/names off the counselling list, and a test for every
mutant survivor of refute 3. Nothing here weakens a veto, a slot bound, FRX-T1/T2 or the C4 projection."""
import datetime as dt
import json

import pytest

from conftest import build_artifact, empty_encounter, mk_consult
from tools.eta2freescript.v10 import data, drugs, finalize, names, numbers, words
from tools.eta2freescript.v10.gate import NumberGate
from tools.eta2freescript.v10.numbers import find_numbers

V = dt.date(2026, 10, 22)


def gate_of(*texts, drug_spans=()):
    lines = [(i * 10, i * 10 + 4, "0", t) for i, t in enumerate(texts)]
    return NumberGate(mk_consult(lines, roles={"0": "doctor"}), visit=V, drug_spans=set(drug_spans))


# --- H2: the S3 lexicon numbers are numbers everywhere; an English-word brand is a drug mention -----------------------------------------------------------
@pytest.mark.parametrize("w", ["ek", "tin", "dui", "noy", "nav", "dos", "bis", "saw", "wis", "bees", "teen"])
def test_h2_lexicon_numbers_stay_numbers_everywhere(w):
    assert find_numbers(f"rest {w} days") and find_numbers(w)


@pytest.mark.parametrize("t", ["Pan ek", "Pan don", "Alex don only", "Duo tin", "Stick with Relent noy", "He is on Lite dos", "Dart for ek"])
def test_h2_an_english_word_brand_makes_a_collision_word_a_number(t):
    assert find_numbers(t), t


def test_h2_plain_english_around_a_capitalised_word_is_untouched():
    for t in ("Rest so that you recover", "Doctor said do not worry", "So be it", "We will see"):
        assert not [n for n in find_numbers(t) if n.text.lower() in ("so", "do", "be")], t


# --- H1: the Stage A drug-turn rule holds on the note path too ---------------------------------------------------------------------------------------------
def _art_with_advice_turn(turn):
    return {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": [
        {"json_pointer": "/general_advice", "evidence": [{"segment_ref": f"synth-unit:{turn}"}]}]}


def _note(advice):
    return "\n".join(f"{h}: {advice if h == 'General Advice' else ''}".rstrip() for h in finalize.N.HEADINGS)


def test_h1_final_note_check_forces_collisions_in_a_drug_tagged_turn():
    art = _art_with_advice_turn(0)
    g = gate_of("Take it as told.", "x", drug_spans={0})
    out, bad = finalize.note_final(g, art, g.c, _note("Rest well, don only"))
    assert bad.get("General Advice") and "don only" not in out
    g2 = gate_of("Take it as told.", "x")                         # not tagged: 'don' is plain English here
    out2, bad2 = finalize.note_final(g2, art, g2.c, _note("Rest well, don only"))
    assert not bad2.get("General Advice")


def test_h1_gp_final_forces_collisions_in_a_drug_tagged_turn():
    art = {"confirm_prompts": [], "confirm_internal": {}, "provenance": [{"json_pointer": "/general_advice", "evidence": [{"segment_ref": "synth-unit:0"}]}],
           "gp_extraction": {"general_advice": "Rest well, don only"}}
    g = gate_of("Take it as told.", drug_spans={0})
    assert {f[1] for f in finalize.gp_final(g, art, g.c)} >= {"unslotted"} or finalize.gp_final(g, dict(art, gp_extraction={"general_advice": "Rest well, don only"}), g.c)


# --- H3: number homographs inside a drug-tagged or drug-flagged unit ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("w", ["mood", "path", "dash", "teas", "basso", "ond", "vandal"])
def test_h3_a_homograph_in_a_drug_flagged_unit_is_held_out(w):
    g = gate_of("Glycomet as told.")
    assert g.collision_unit(f"Glycomet {w} as before", [0]), w
    if w != "ond":                                                           # "Ond" is itself a catalogue brand
        assert g.collision_unit(f"rest {w}", [0]) is False                   # no drug in this unit and the turn is not tagged
    assert gate_of("As told.", drug_spans={0}).collision_unit(f"rest {w}", [0])   # a tagged turn makes any unit about a medicine


def test_h3_ordinary_words_in_a_drug_unit_are_not_held_out():
    g = gate_of("Glycomet as told.")
    for t in ("Glycomet for fever and cough", "take the tablet after food", "Glycomet has helped, the pain is done"):
        assert not g.collision_unit(t, [0]), t


def test_h3_through_the_mapper_the_unit_is_withheld_with_a_collision_record():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Glycomet ond as before and rest.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(advice=[{"text": "Glycomet ond as before", "basis": "said", "source_turns": [2]}, {"text": "drink water", "basis": "said", "source_turns": [2]}]))
    assert [w for w in a["withheld"] if w["reason_code"] in ("collision", "veto_detector", "ood_word")] and "ond" not in a["note_text"]
    assert "water" in a["gp_extraction"].get("general_advice", "")


# --- M1: English-word brand + slot duration; class abbreviations -------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t,fld", [("Dart for the last 6 months", "symptoms"), ("On Candid since 6 years", "symptoms"), ("Take Relent for 5 days", "advice")])
def test_m1_english_word_brand_beside_a_duration_is_drug_adjacent(t, fld):
    assert not gate_of(t).check(t, fld, [0]).ok, t


@pytest.mark.parametrize("abbr", ["ARB", "ACE", "ACEI", "NSAID", "PPI", "SSRI", "SNRI", "TCA", "DMARD", "OCP", "AED", "ASM", "CCB", "BB", "DOAC", "NOAC", "LMWH"])
def test_m1_class_abbreviations_are_class_words(abbr):
    assert words.is_dosing_word(abbr.lower())
    assert not gate_of(f"On {abbr} for 3 months").check(f"On {abbr} for 3 months", "symptoms", [0]).ok


# --- M2 / M4: the counselling list has no names, places or herbal medicines; other-person cues ---------------------------------------------------------------
NAMES_PLACES = {"surya", "palak", "gulab", "seena", "puri", "ramesh", "suresh", "kumar", "lakshmi", "kamala", "anil", "sunita", "priya", "venkatesh", "geeta", "rani", "raja", "mohan",
                "ganga", "kaveri", "yamuna", "krishna", "rama", "shiva", "hubli", "mysore", "pune", "delhi", "mumbai", "chennai", "kolkata", "bangalore", "jayanagar", "madurai", "goa"}
HERBALS = {"triphala", "giloy", "mulethi", "kadha", "kashayam", "neem", "amla"}


def test_m4_whitelist_extra_has_no_name_place_or_herbal_and_the_detector_owns_the_herbals():
    d = json.load(open(data.WHITELIST_EXTRA, encoding="utf-8"))
    ws = {e["word"] for e in d["entries"]}
    assert d["count"] == len(d["entries"]) == len(ws) <= 300
    assert not ws & NAMES_PLACES and not ws & HERBALS
    assert not [w for w in ws if drugs.flags(w)]                                          # nothing on the list is a drug to the detector (any arm)
    for h in HERBALS:
        assert drugs.flags(f"keep {h} daily"), h
    assert "mood" not in ws and not words.ood_tokens("drink water") and words.ood_tokens("keep giloy tonight") == ["giloy"]


@pytest.mark.parametrize("t", ["Previous patient Rose had fever", "Last patient Prince, BP high", "Hope's mother has diabetes", "Kamala's wife has cough", "the previous patient said so"])
def test_m2_other_person_cues_withhold_the_unit(t):
    assert words.other_person(t) == "other_person"
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", t)], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(advice=[{"text": t, "basis": "said", "source_turns": [2]}]))
    assert [w for w in a["withheld"] if w["reason_code"] == "other_person"] and t.split()[0] not in a["note_text"].split("General Advice:")[1]


def test_m2_ordinary_possessives_and_patient_words_are_untouched():
    for t in ("The patient should rest", "Rest at the patient's home", "Take his mother along", "Drink water"):
        assert words.other_person(t) is None, t


# --- M3: unresolved change / not_given / hold are never a start prompt --------------------------------------------------------------------------------------
def _rx(b, a):
    return {"action": a, "decision_turn": 2, "generic": None, "brand_as_said": b, "strength": None, "frequency": "twice a day", "duration": None, "basis": "said", "confidence": 0.85,
            "source_quote_turn": 2, "source_turns": [2]}


@pytest.mark.parametrize("brand,action", [("Zylorvex", "change"), ("Zylorvex", "not_given"), ("Zylorvex", "hold"), ("Pan", "not_given"), ("Pan", "change"), ("Glizid", "hold")])
def test_m3_unresolved_change_not_given_hold_rows_are_not_start_prompts(brand, action):
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Change it to a lower dose.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(prescription=[_rx(brand, action)]))
    acts = {p["action"] for p in a["confirm_prompts"]}
    assert acts and "start" not in acts and acts <= {"change_dose", "not_given"}, acts
    assert "Unrecognised drug" not in a["note_text"] and f"{brand} — confirm" not in a["note_text"]


# --- refute 3 mutant survivors ------------------------------------------------------------------------------------------------------------------------------
def test_mut_note_masker_masks_a_cued_name_in_the_final_note():
    g = gate_of("As told.")
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}
    for line in ("Mrs Kamala has fever", "Same as Mr Joseph yesterday"):
        out, bad = finalize.note_final(g, art, g.c, _note(line))
        assert not any(n in out for n in ("Kamala", "Joseph")), out


def test_mut_collision_is_only_for_common_english_not_every_dictionary_lexicon_word():
    c = numbers.collision_words()
    for w in ("vanda", "tees", "padi", "bees", "teen", "ek", "tin", "saw"):
        assert w not in c and find_numbers(f"rest {w}"), w          # unconditional lexicon numbers
    assert {"do", "be", "so", "don", "ent"} <= c


def test_mut_non_latin_letters_are_out_of_dictionary():
    assert words.ood_tokens("दवा लें") and words.ood_tokens("औषधि") and not words.t2_allowed("दवा")


def test_mut_a_dosing_phrase_makes_a_collision_word_a_number():
    assert find_numbers("rest moor after food") and find_numbers("keep ent before meals")
    assert not find_numbers("walked beside the moor in the evening")


def test_mut_section_units_returns_the_gp_units_behind_a_dropped_section():
    art = {"gp_extraction": {"further_investigations": [{"name": "CBC"}, {"name": "X-ray"}], "referrals": [{"speciality": "Cardiology"}]}}
    units = finalize.section_units(art, {"Further Investigation": "ood_word", "Refer to": "ood_word"})
    assert {(u[0], u[3]) for u in units} == {("investigations", ("further_investigations", 0)), ("investigations", ("further_investigations", 1)), ("referrals", ("referrals", 0))}
    assert finalize.section_units(art, {}) == []


def test_mut_a_change_prompt_feeds_the_plan_line_with_a_cited_turn():
    from tools.eta2freescript.validate import check
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Change Glizid to a lower dose.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(prescription=[_rx("Glizid", "change")]))
    assert names.PLAN_LINE in a["gp_extraction"]["plan_of_management"]["management_plan"]
    assert [e for e in check(a) if "FRX-P2" in e] == [], check(a)


# --- the final check (gp and note path) has its own tests: reason codes pin which rule fired ----------------------------------------------------------------
def _gp_art(field, text, turn=0):
    return {"confirm_prompts": [], "confirm_internal": {}, "provenance": [{"json_pointer": f"/{field}", "evidence": [{"segment_ref": f"synth-unit:{turn}"}]}],
            "gp_extraction": {field: text}}


def test_h1_the_forced_collision_word_reads_as_a_number_on_both_final_paths():
    g = gate_of("As told.", drug_spans={0})
    _o, bad = finalize.note_final(g, _art_with_advice_turn(0), g.c, _note("Rest well, don only"))
    assert bad.get("General Advice") == "unslotted"                         # 'don' is read as a number in a tagged turn: no slot covers it
    assert [f[1] for f in finalize.gp_final(g, _gp_art("general_advice", "Rest well, don only"), g.c)] == ["unslotted"]
    g2 = gate_of("As told.")
    assert not finalize.note_final(g2, _art_with_advice_turn(0), g2.c, _note("Rest well, don only"))[1]
    assert finalize.gp_final(g2, _gp_art("general_advice", "Rest well, don only"), g2.c) == []


def test_h3_final_check_holds_out_homographs_in_a_drug_unit_on_both_paths():
    g = gate_of("As told.", drug_spans={0})
    _o, bad = finalize.note_final(g, _art_with_advice_turn(0), g.c, _note("Rest well, mood good"))
    assert bad.get("General Advice") == "collision"
    assert [f[1] for f in finalize.gp_final(g, _gp_art("general_advice", "Rest well, mood good"), g.c)] == ["collision"]
    g2 = gate_of("As told.")
    assert not finalize.note_final(g2, _art_with_advice_turn(0), g2.c, _note("Rest well, mood good"))[1]


def test_m2_final_check_withholds_other_person_cues_on_both_paths():
    g = gate_of("As told.")
    _o, bad = finalize.note_final(g, _art_with_advice_turn(0), g.c, _note("Previous patient Rose had fever"))
    assert bad.get("General Advice") == "other_person"
    assert [f[1] for f in finalize.gp_final(g, _gp_art("general_advice", "Kamala's wife has cough"), g.c)] == ["other_person"]
