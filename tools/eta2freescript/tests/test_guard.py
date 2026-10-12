"""Dose guard: doctor dose precedence, numeric support, number words."""
from conftest import empty_encounter, mk_consult

from tools.eta2freescript.guard import guard, norm_strength, numerals, strengths

DOC, PT = {"0": "doctor", "1": "patient"}, None


def rx(**kw):
    base = {"action": "start", "decision_turn": 1, "generic": "paracetamol", "brand_as_said": None, "strength": None, "frequency": None,
            "duration": None, "route": None, "basis": "said", "confidence": 0.8, "source_quote_turn": 1, "source_turns": [0, 1]}
    base.update(kw)
    return base


def consult(patient_line, doctor_line):
    return mk_consult([(0, 3, "1", patient_line), (4, 9, "0", doctor_line)], roles={"0": "doctor", "1": "patient"})


def test_doctor_strength_beats_patient_brand_strength():
    c = consult("I took Dolo 650 at home.", "Take paracetamol 1 g three times a day for three days.")
    enc = guard(empty_encounter(prescription=[rx(brand_as_said="Dolo 650", strength="650 mg", frequency="three times a day", duration="3 days")]), c.turns)
    r = enc["prescription"][0]
    assert r["strength"] == "1 g"
    assert r["strength_model_value"] == "650 mg"
    assert r["brand_as_said"] == "Dolo" and r["brand_as_said_as_heard"] == "Dolo 650"
    assert r["_dose_precedence"] is True
    assert any("precedence" in i for i in enc["_guard"]["issues"])


def test_doctor_strength_filled_when_model_left_it_null():
    c = consult("Fever since yesterday.", "Take paracetamol 500 mg twice a day for two days.")
    r = guard(empty_encounter(prescription=[rx()]), c.turns)["prescription"][0]
    assert r["strength"] == "500 mg"


def test_patient_only_strength_is_nulled_and_brand_number_stripped():
    c = consult("I take Dolo 650 when I have fever.", "Continue Dolo when you have fever.")
    r = guard(empty_encounter(prescription=[rx(action="continue", generic=None, brand_as_said="Dolo 650", strength="650 mg")]), c.turns)["prescription"][0]
    assert r["strength"] is None and r["strength_model_value"] == "650 mg"
    assert r["brand_as_said"] == "Dolo"
    assert "strength" in r["missing_fields"]


def test_matching_strengths_are_left_alone():
    c = consult("I took Dolo 650.", "Yes, continue Dolo 650 twice a day.")
    r = guard(empty_encounter(prescription=[rx(action="continue", generic=None, brand_as_said="Dolo 650", strength="650 mg")]), c.turns)["prescription"][0]
    assert r["strength"] == "650 mg" and r["brand_as_said"] == "Dolo 650" and not r.get("_dose_precedence")


def test_ambiguous_doctor_strengths_null_an_unlisted_model_strength():
    c = mk_consult([(0, 3, "0", "Pantoprazole 40 mg in the morning and paracetamol 500 mg at night."), (4, 6, "0", "That is all.")], roles=DOC)
    r = guard(empty_encounter(prescription=[rx(decision_turn=1, source_turns=[0, 1], strength="650 mg")]), c.turns)["prescription"][0]
    assert r["strength"] is None


def test_unknown_roles_keep_prototype_behaviour():
    c = mk_consult([(0, 3, "1", "I took Dolo 650."), (4, 9, "0", "Take Dolo 650 twice daily.")], role_track=False)
    r = guard(empty_encounter(prescription=[rx(generic=None, brand_as_said="Dolo 650", strength="650 mg", frequency="twice daily")]), c.turns)["prescription"][0]
    assert r["strength"] == "650 mg" and r["brand_as_said"] == "Dolo 650"


def test_a_code_is_replaced_by_the_spoken_regimen():
    c = consult("Cough.", "Take this twice a day for five days.")
    r = guard(empty_encounter(prescription=[rx(frequency="BD", duration=None)]), c.turns)["prescription"][0]
    assert r["frequency"] == "twice a day" and r["duration"] == "for five days"
    assert "frequency" not in r["missing_fields"] and "duration" not in r["missing_fields"]


def test_no_spoken_regimen_stays_empty():
    c = consult("Cough.", "Take this syrup.")
    r = guard(empty_encounter(prescription=[rx(frequency="BD", duration="5 days")]), c.turns)["prescription"][0]
    assert r["frequency"] is None and r["duration"] is None
    assert r["missing_fields"] == ["strength", "frequency", "duration"]


def test_numeric_support_nulls_invented_values():
    c = consult("Cough.", "Take this syrup twice a day.")
    r = guard(empty_encounter(prescription=[rx(generic="ambroxol", frequency="twice a day", duration="5 days")]), c.turns)["prescription"][0]
    assert r["duration"] is None and r["duration_model_value"] == "5 days"
    assert r["frequency"] == "twice a day"


def test_number_words_count_as_digits():
    assert numerals("for three days") == "for 3 days"
    assert strengths("one gram at night")[0][1] == ("mass", 1000.0)
    assert norm_strength("1 g") == norm_strength("1000 mg")
    assert norm_strength("650") == ("mass", 650.0)


def test_hindi_number_words_only_on_non_english_turns():
    assert numerals("paanch din, teen baar", "hi") == "5 din, 3 baar"
    assert numerals("do the test", "en") == "do the test"


def test_native_turn_frequency_wording_is_not_nulled():
    c = mk_consult([(0, 5, "0", "Ascoril syrup 5 ml din mein teen baar, paanch din.")], roles=DOC, lang="hi")
    r = guard(empty_encounter(prescription=[rx(decision_turn=0, source_turns=[0], generic=None, brand_as_said="Ascoril", strength="5 ml",
                                               frequency="three times a day", duration="5 days")]), c.turns)["prescription"][0]
    assert r["frequency"] == "three times a day" and r["duration"] == "5 days" and r["strength"] == "5 ml"


def test_regimen_slot_numbers_must_be_on_tape():
    c = mk_consult([(0, 5, "0", "Apply this gel twice a day.")], roles=DOC)
    s = guard(empty_encounter(regimen_slots=[{"dosage_form": "gel", "frequency": "twice a day", "duration": "10 days", "quote_turn": 0, "source_turns": [0]}]), c.turns)["regimen_slots"][0]
    assert s["duration"] is None and s["frequency"] == "twice a day"


def test_out_of_range_citations_dropped():
    c = consult("Fever.", "Take paracetamol 500 mg.")
    enc = guard(empty_encounter(advice=[{"text": "Rest", "basis": "said", "source_turns": [7, 1]}]), c.turns)
    assert enc["advice"][0]["source_turns"] == [1]
