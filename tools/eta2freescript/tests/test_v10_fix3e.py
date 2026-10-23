"""FRX-V10 Fix3e (eta2freescript rulings 23 Oct 2026, refute 4): a medicine is named in the Medication section and the confirm prompts only; numeral one-edit forms and plurals are
homographs with no function-word exemption; a name never becomes a drug token; other-person cues are a pattern; unnamed rows keep their action; quarantined shingles never echo.
Nothing here loosens a veto, a slot bound, FRX-T1/T2 or the C4 projection."""
import datetime as dt
import json

import pytest

from conftest import build_artifact, empty_encounter, mk_consult
from tools.eta2freescript.v10 import data, drugs, finalize, names, numbers, words
from tools.eta2freescript.v10._build import make_homographs
from tools.eta2freescript.v10.gate import NumberGate

V = dt.date(2026, 10, 22)


def gate_of(*texts, drug_spans=(), quarantined=()):
    lines = [(i * 10, i * 10 + 4, "0", t) for i, t in enumerate(texts)]
    return NumberGate(mk_consult(lines, roles={"0": "doctor"}), visit=V, drug_spans=set(drug_spans), quarantined=set(quarantined))


def _note(line_by_heading: dict) -> str:
    return "\n".join(f"{h}: {line_by_heading.get(h, '')}".rstrip() for h in finalize.N.HEADINGS)


# --- 1: drug_outside_medication ----------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Continue Glycomet daily after food", "Telma at night", "Dolo SOS for fever", "Metformin is the usual medicine", "Rest well and take Zorbex"])
def test_a_detected_drug_outside_medication_is_unpostable(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


@pytest.mark.parametrize("t", ["Rest well and drink water", "Fever and cough for three days", "Review on Monday", "Haemoglobin level is low", "Avoid oily food"])
def test_ordinary_text_and_analytes_are_not_drug_talk(t):
    assert not gate_of("As told.").drug_outside(t, [0]), t


def test_a_drug_token_of_a_tagged_turn_is_drug_talk_wherever_it_stands():
    g = gate_of("Tell me.", "Take Calm at night", drug_spans={1})
    assert g.drug_outside("Calm helps", [0]) and g.drug_outside("Use Calm now", [0])  # the Stage A tagged turn names it, even in a unit citing another turn
    assert not g.drug_outside("stay calm", [0])                                          # a lower-case common word is English, not the brand
    assert not gate_of("Tell me.", "Take rest", drug_spans={1}).drug_outside("rest helps", [0])


def test_a_drug_class_phrase_with_a_dose_form_is_drug_talk_and_a_tagged_unit_with_a_dosing_word_is_too():
    plain, tagged = gate_of("As told."), gate_of("As told.", drug_spans={0})
    for t in ("the sugar tablet tens drops", "thyroid pill when tablets", "the injection day daily"):
        assert plain.drug_outside(t, [0]), t
    assert tagged.drug_outside("Drink water daily", [0]) and not plain.drug_outside("Drink water daily", [0])
    assert not plain.drug_outside("Rest and drink warm water", [0]) and not tagged.drug_outside("Rest at home", [0])


def test_the_gp_and_note_final_paths_withhold_it_with_its_own_reason_code():
    g = gate_of("Take Glycomet daily.")
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {"general_advice": "Glycomet daily after food"}, "provenance": []}
    failed = finalize.gp_final(g, art, g.c)
    assert failed and failed[0][1] == "drug_outside_medication" and "general_advice" not in art["gp_extraction"]
    out, bad = finalize.note_final(g, {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}, g.c, _note({"General Advice": "Telma at night"}))
    assert bad.get("General Advice") == "drug_outside_medication" and "Telma" not in out


def test_the_mapper_withholds_it_with_the_medication_prompt():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Take Glycomet daily. Drink water.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(advice=[{"text": "Take Glycomet daily", "basis": "said", "source_turns": [2]}, {"text": "drink water", "basis": "said", "source_turns": [2]}]))
    assert [w for w in a["withheld"] if w["reason_code"] == "drug_outside_medication"] and "Glycomet" not in json.dumps(a["gp_extraction"])
    assert any("confirm medicines in the Medication section" in str(e.get("prompt")) for e in a["completion_required"])


def test_doctor_words_and_red_flags_are_checked_at_the_final_path_too():
    g = gate_of("Take Glycomet daily.")
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": [],
           "doctor_words": [{"text_en": "Glycomet daily after food", "cited_spans": ["s0"]}, {"text_en": "Drink water", "cited_spans": ["s0"]}],
           "red_flags": [{"text_en": "Telma at night", "cited_spans": ["s0"], "must_carry": True}, {"text_en": "Come back if breathless", "cited_spans": ["s0"], "must_carry": True}]}
    failed = finalize.gp_final(g, art, g.c, remove=False)
    assert {(f[3], f[1]) for f in failed if f[2] == "served"} == {(("doctor_words", 0), "drug_outside_medication"), (("red_flags", 0), "drug_outside_medication")}
    finalize.drop_units(art, failed)
    assert [d["text_en"] for d in art["doctor_words"]] == ["Drink water"] and [d["text_en"] for d in art["red_flags"]] == ["Come back if breathless"]


# --- 2: H1b a note line that holds a tagged turn's drug word is judged against all tagged turns ---------------------------------------------------------------
def test_a_note_line_with_a_tagged_drug_word_is_read_against_every_tagged_turn():
    g = gate_of("Tell me.", "Take Fresh tu at night", "Nothing here", drug_spans={1})
    assert g.tagged_overlap("Fresh tu at night") and g.tagged_overlap("fresh tu") and not g.tagged_overlap("Review in clinic")
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": [{"json_pointer": "/presenting_complaints/symptoms", "evidence": [{"segment_ref": "synth-unit:2"}]}]}
    out, bad = finalize.note_final(g, art, g.c, _note({"Presenting Complaint": "Fresh tu at night"}))
    assert "Presenting Complaint" in bad


def test_two_words_in_a_row_of_a_tagged_turn_are_enough_and_a_prescription_row_word_is_a_drug_token():
    g = gate_of("Tell me.", "stay calm please", drug_spans={1})
    assert g.tagged_overlap("stay calm now") and not g.tagged_overlap("calm now stay")      # the pair, not the single common words
    g2 = gate_of("Tell me.", "take it at night", drug_spans={1})
    g2.rx_tokens.add("duo")
    assert g2.drug_outside("Duo helps", [0]) and not gate_of("Tell me.", "take it at night", drug_spans={1}).drug_outside("Duo helps", [0])


# --- 3: numeral one-edit forms and plurals; no function-word exemption for number homophones -----------------------------------------------------------------
@pytest.mark.parametrize("w", ["fife", "fiver", "calf", "twine", "twos", "fives", "eights", "hundreds", "thousands", "for", "too", "our", "are", "then", "new", "than", "per", "won", "ate", "fore"])
def test_numeral_forms_and_homophones_are_number_like(w):
    assert numbers.number_like(w), w


@pytest.mark.parametrize("w", ["for", "to", "too", "our", "then", "new", "per"])
def test_homophones_withhold_inside_a_drug_unit_and_are_free_outside(w):
    g = gate_of("As told.")
    assert g.collision_unit(f"Glycomet {w} as before", [0]), w
    assert not g.collision_unit(f"rest {w} well", [0]), w


def test_ordinary_words_still_pass_in_a_drug_unit():
    g = gate_of("As told.")
    assert not g.collision_unit("Glycomet and the rest as before", [0])


def test_the_homograph_list_is_the_output_of_the_script():
    d = json.load(open(data.NUMBER_HOMOGRAPHS, encoding="utf-8"))
    assert d["words"] == make_homographs.build()["words"] and {"fife", "twos", "hundreds", "calf"} <= set(d["words"])


# --- 4: names never become drug tokens ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Olmezest Dylan", "OLMEZEST DYLAN", "olmezest dylan"])
def test_a_given_name_is_never_kept_as_a_drug_token(t):
    out = names.detector_tokens(t) or ""
    assert "ylan" not in out.lower()


def test_a_fuzzy_hit_beside_a_drug_token_is_kept_only_when_it_is_an_exact_catalogue_name():
    out = (names.detector_tokens("Sompraz Sharma") or "").lower()
    assert "sharma" not in out
    d = names.drug_block({"brand_as_said": "Sompraz Sharma", "generic": None})
    assert "sharma" not in json.dumps(d).lower()


def test_the_drug_block_of_a_row_that_carries_a_name_shows_no_name():
    d = names.drug_block({"brand_as_said": "Olmezest Dylan", "generic": None})
    assert "ylan" not in json.dumps(d).lower() and "ylan" not in names.med_line(d).lower()


def test_an_exact_strong_catalogue_name_stays_a_drug_even_if_it_is_a_given_name():
    exact = sorted(n for n in drugs.strong_names() if n in words.given_names())
    if exact:
        assert exact[0] in (names.detector_tokens(exact[0].capitalize()) or "").lower()


# --- 5: other-person cues are a pattern ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Another patient", "The previous case", "Prior patient had it", "The patient who just left", "Last lady", "Earlier case", "That elderly man who left",
                               "Previous elderly gentleman", "Next person", "The lady who came before", "Ramesh's wife has it too", "That patient had wheezing", "The lady outside had wheezing", "Your neighbour had wheezing", "The man before you had wheezing"])
def test_other_person_cues(t):
    assert words.other_person(t) == "other_person", t


@pytest.mark.parametrize("t", ["The patient should rest", "Next visit in clinic", "Review the last report", "Other symptoms are absent", "Next one month", "Take the last dose", "The patient has fever", "He is a man with diabetes"])
def test_ordinary_text_is_not_an_other_person_cue(t):
    assert words.other_person(t) is None, t


# --- 6: unnamed / form-word rows keep their action -----------------------------------------------------------------------------------------------------------
def _rx(b, a):
    return {"action": a, "decision_turn": 2, "generic": None, "brand_as_said": b, "strength": None, "frequency": "twice a day", "duration": None, "basis": "said", "confidence": 0.85,
            "source_quote_turn": 2, "source_turns": [2]}


@pytest.mark.parametrize("action", ["change", "not_given", "hold", "Stop", "HOLD", "discontinue", "taper", "skip", "Change"])
def test_an_unnamed_row_never_becomes_a_start_prompt(action):
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Leave the tablet.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(prescription=[_rx("tablet", action)]))
    acts = {p["action"] for p in a["confirm_prompts"]}
    assert "start" not in acts and "continue" not in acts, (action, acts)


def test_an_unnamed_row_with_a_start_action_is_still_a_start_prompt():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Take the tablet.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(prescription=[_rx("tablet", "start")]))
    assert {p["action"] for p in a["confirm_prompts"]} == {"start"}


# --- 7: L1 quarantined shingles ----------------------------------------------------------------------------------------------------------------------------
def test_a_quarantined_turn_shingle_in_a_posted_unit_withholds_it():
    g = gate_of("Tell me.", "my aunt has a long standing thyroid problem since childhood", quarantined={1})
    assert g.quarantine_echo("Her aunt has a long thing") is False  # only 4 words in a row match ("aunt has a long")
    assert g.quarantine_echo("Notes: my aunt has a long standing thyroid") is True
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {"examination": "my aunt has a long standing"}, "provenance": []}
    failed = finalize.gp_final(g, art, g.c)
    assert failed and failed[0][1] == "quarantine_echo"
    out, bad = finalize.note_final(g, {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {}, "provenance": []}, g.c, _note({"Examination": "has a long standing thyroid problem since"}))
    assert bad.get("Examination") == "quarantine_echo"


# --- 8: L2 home-remedy herbs are drug names for the detector --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("w", "tulsi haldi ajwain hing jeera laung adrak lehsun saunf elaichi kesar".split())
def test_home_remedy_herbs_are_drug_words_not_counselling_vocabulary(w):
    assert w in data.load(data.DOSING_WORDS)["herbal_names"] and w not in words.extra_whitelist()
    assert any(f.token.lower() == w for f in drugs.flags(f"take {w} twice"))
