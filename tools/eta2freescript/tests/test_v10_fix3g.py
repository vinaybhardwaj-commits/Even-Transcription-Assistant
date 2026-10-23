"""FRX-V10 Fix3g (eta2freescript rulings 23 Oct 2026, refute 5): the Pulse medicine master is a drug signal; an analyte-named drug or a drug-class word beside a timing word is drug talk outside
Medication; the dosing-word arm reads every tagged turn; the dose-form noun list is the whole dose-form set; short quarantine echoes; more other-person cues; weak-name opening. Nothing loosens."""
import datetime as dt
import gzip
import json

import pytest

from conftest import build_artifact, empty_encounter, mk_consult
from tools.eta2freescript.v10 import data, drugs, finalize, names, words
from tools.eta2freescript.v10._build import make_med_master
from tools.eta2freescript.v10.gate import NumberGate

V = dt.date(2026, 10, 22)


def gate_of(*texts, drug_spans=(), quarantined=(), native=None):
    lines = [(i * 10, i * 10 + 4, "0", t) + ((native[i],) if native and native.get(i) else ()) for i, t in enumerate(texts)]
    return NumberGate(mk_consult(lines, roles={"0": "doctor"}), visit=V, drug_spans=set(drug_spans), quarantined=set(quarantined))


def _note(line_by_heading: dict) -> str:
    return "\n".join(f"{h}: {line_by_heading.get(h, '')}".rstrip() for h in finalize.N.HEADINGS)


# --- 1: the medicine master ---------------------------------------------------------------------------------------------------------------------------------
def test_the_master_name_list_is_committed_data_with_provenance_in_c7():
    d = data.load(data.MED_MASTER)
    assert d["count"] == len(d["names"]) > 10000 and len(d["source_sha256"]) == 64 and "usage" not in json.dumps(d["names"][:50])
    assert data.provenance()["med_master_sha256"] == data.file_sha(data.MED_MASTER)
    assert len(gzip.open(data.MED_MASTER).read()) > 100000 and data.MED_MASTER.stat().st_size < 1024 * 1024 and data.SURNAMES.stat().st_size < 1024 * 1024


def test_the_master_generator_keeps_enabled_names_with_usage(tmp_path):
    src = tmp_path / "m.csv"
    src.write_text("src,name,usage,rows_n,all_disabled\nbrand,Zorbexo 5 Tablet,10,1,false\nbrand,Unused Thing,0,1,false\nbrand,Off Thing,9,1,true\ngeneric,Fish Oil,3,1,false\n")
    d = make_med_master.build(src)
    assert d["names"] == ["fish oil", "zorbexo 5 tablet"]


@pytest.mark.parametrize("t", ["Multivitamin", "keep to MULTIVITAMIN for now", "Zinc", "Folic acid", "Calcium"])
def test_an_exact_master_name_is_drug_talk_outside_medication(t):
    d = data.load(data.MED_MASTER)["names"]
    assert words.med_master_hit(t) and gate_of("As told.").drug_outside(t, [0]), (t, len(d))


def test_the_master_signal_is_whole_name_and_whole_token():
    assert not words.med_master_hit("multi") and not words.med_master_hit("zincs") and not words.med_master_hit("Rest and drink water")
    assert not gate_of("As told.").drug_outside("Rest at home and drink water", [0])


# --- 2: H1 analyte-named drugs with a timing word --------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Insulin at bedtime", "Continue insulin morning and night", "Iron daily", "Folic acid daily", "Zinc daily", "Potassium after food", "Sodium bicarbonate before breakfast"])
def test_analyte_named_drugs_with_a_timing_word_are_drug_talk(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


@pytest.mark.parametrize("t", ["Check potassium level daily", "Sodium report every week", "Review the iron test result in the morning", "Zinc range at night", "Ferritin in mmol after food"])
def test_a_lab_frame_is_a_lab_word_or_a_lab_unit(t):
    assert words.lab_frame(t)


def test_analyte_with_lab_frame_is_free_and_insulin_never():
    g = gate_of("As told.")
    assert not g.drug_outside("Haemoglobin level is low", [0]) and words.lab_frame("Haemoglobin level daily") and g.drug_outside("Haemoglobin level daily", [0])
    assert g.drug_outside("Insulin level at bedtime", [0])
    assert not g.drug_outside("Potassium is normal", [0])  # an analyte with no timing word is the lab talk it always was


def test_timing_words_are_data_and_phrases_count():
    assert {"daily", "bedtime", "sos", "every", "alternate"} <= {w for w in data.load(data.DOSING_WORDS)["timing_words"]}
    assert words.timing_present("after food") and words.timing_present("on empty stomach") and not words.timing_present("review on the visit")


# --- 3: H2 dosing words in a unit that overlaps a tagged turn; class words in any unit --------------------------------------------------------------------
def test_a_unit_that_overlaps_a_tagged_turn_and_holds_a_dosing_word_is_drug_talk():
    g = gate_of("Tell me.", "Take Qwelmoxin after food", "Nothing", drug_spans={1})
    assert g.drug_outside("Continue Qwelmoxin after food", [2]) and g.drug_outside("Qwelmoxin SOS", [0])
    assert not gate_of("Tell me.", "Nothing here", "Nothing").drug_outside("Review in clinic", [0])
    assert not g.drug_outside("Review in clinic", [2])


@pytest.mark.parametrize("t", ["the antibiotic on empty stomach", "blood thinner before food", "painkiller every day", "steroid at night", "ARB in the morning", "NSAID after food", "the water pill daily",
                               "sugar wali subah", "BP ki raat ko", "thyroid wali subah", "pressure ka subah"])
def test_class_words_with_a_timing_word_are_drug_talk_in_any_unit(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


def test_class_words_data_and_untimed_plain_text():
    assert {"arb", "nsaid", "antibiotic", "steroid", "thinner"} <= {w for w in data.load(data.DOSING_WORDS)["class_words"]}
    g = gate_of("As told.")
    assert not g.drug_outside("Sugar is controlled", [0]) and not g.drug_outside("Thyroid is normal", [0])


# --- 4: H3 the whole dose-form set ---------------------------------------------------------------------------------------------------------------------------
FORMS = "pill drop spray strip lotion syp nebulisation nebulization neb rotacap respules suspension lozenge patch pen powder ampoule vial vaccine shot jab".split()


@pytest.mark.parametrize("n", FORMS)
def test_every_dose_form_is_a_noun_signal(n):
    assert n in words.dose_form_nouns() and gate_of("As told.").drug_outside(f"Give the {n} every day", [0]), n


def test_every_dose_form_entry_of_the_dosing_words_is_a_noun():
    d = data.load(data.DOSING_WORDS)
    forms = {"tablet", "tab", "capsule", "syrup", "injection", "drops", "drop", "puff", "sachet", "goli", "dawa", "dawai", "inj", "cap", "spray", "strip", "medicine", "medication", "pill", "tabs", "caps", "syp", "ointment", "cream", "gel", "lotion", "inhaler"}
    assert forms <= set(d["words"]) and forms <= set(d["dose_form_nouns"]) and {"pills", "sprays", "strips", "patches", "boxes"} - {"boxes"} <= words.dose_form_nouns()


# --- 5: M1 quarantine echo by content tokens -----------------------------------------------------------------------------------------------------------------
def test_three_content_tokens_of_a_quarantined_turn_not_in_a_cited_turn_withhold():
    g = gate_of("Tell me.", "knee swelling for two days, apply ice and rest the leg", "Ankle is fine", quarantined={1})
    assert g.quarantine_echo("Knee swelling, apply ice", [2]) and g.quarantine_echo("Knee swelling, apply ice")


def test_content_tokens_cited_in_a_current_turn_do_not_count_and_two_do_not_withhold():
    g = gate_of("Knee swelling ice noted today", "knee swelling for two days apply ice", quarantined={1})
    assert not g.quarantine_echo("Knee swelling, ice", [0])
    assert g.quarantine_echo("Knee swelling, ice", [])
    g2 = gate_of("Tell me.", "knee swelling for two days apply ice", quarantined={1})
    assert not g2.quarantine_echo("Knee swelling", [0]) and not g2.quarantine_echo("Rest the leg", [0])


def test_the_content_token_echo_reads_the_native_text_of_a_quarantined_turn():
    g = gate_of("Tell me.", "ok", quarantined={1}, native={1: "knee swelling apply ice crepe"})
    assert g.quarantine_echo("Knee swelling, apply ice", [0])


def test_the_content_token_echo_withholds_through_the_final_checks():
    g = gate_of("Tell me.", "knee swelling for two days apply ice", quarantined={1})
    art = {"confirm_prompts": [], "confirm_internal": {}, "gp_extraction": {"examination": "Knee swelling, apply ice"}, "provenance": []}
    failed = finalize.gp_final(g, art, g.c)
    assert failed and failed[0][1] == "quarantine_echo"


def test_content_tokens_drop_function_dosing_and_short_words():
    assert words.content_tokens("The knee is swollen, take it daily") == {"knee", "swollen"}


# --- 6: M2 other-person nouns -------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["That boy had wheezing", "That girl was crying", "That child cough", "That kid had fever", "The guy before had it", "The fellow outside coughed", "That chap had pain", "The earlier visitor", "The attender coughed",
                               "The new admission is stable", "Yesterday's patient had it", "This morning's case was worse", "Today's earlier patient", "Someone else had it", "The person waiting outside", "Another kid", "The previous guy"])
def test_more_other_person_cues(t):
    assert words.other_person(t) == "other_person", t.lower()


@pytest.mark.parametrize("t", ["The child has fever", "The boy has cough", "The patient should rest", "Visitor policy was explained", "Admission advised", "Review in a week"])
def test_the_patient_themselves_is_not_an_other_person_cue(t):
    assert words.other_person(t) is None, t


@pytest.mark.parametrize("t", ["Your neighbour had wheezing", "A friend had it", "Her colleague too", "Their relative has it", "My cousin has it", "The coworker had it"])
def test_neighbour_friend_and_relative_cues(t):
    assert words.other_person(t) == "other_person", t


# --- 7: M3 weak names -------------------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["Bunty has fever", "Precious was here", "Rain came on"])
def test_a_non_core_given_name_that_opens_a_unit_is_withheld(t):
    assert words.possible_name(t) == "possible_name", t


@pytest.mark.parametrize("t", ["Patient has fever", "General examination normal", "Both knees swollen"])
def test_an_ordinary_word_that_is_only_a_rare_census_surname_still_opens_a_unit(t):
    assert words.possible_name(t) is None, t


def test_the_opening_exemption_is_only_for_census_surnames_that_are_on_no_given_name_list():
    ex = [w for w in words.surnames() - words.frequent_surnames() - words.given_names() if w in words.dictionary() and len(w) >= 5]
    assert ex


# --- L2: the refuter's surviving mutants ---------------------------------------------------------------------------------------------------------------------
def test_m04_a_lowercase_uncommon_word_of_a_tagged_turn_is_a_drug_token():
    g = gate_of("Tell me.", "Take Qwelmoxin now", drug_spans={1})
    assert "qwelmoxin" in g._tagged_index()[0]
    assert g.drug_outside("buy qwelmoxin tomorrow", [0]) and not g.drug_outside("buy bread tomorrow", [0])


def test_m08_a_shingle_that_is_only_in_the_native_text_of_a_quarantined_turn_echoes():
    g = gate_of("Tell me.", "ok", quarantined={1}, native={1: "my aunt has a long standing thyroid problem"})
    assert g.quarantine_echo("my aunt has a long standing") is True


def test_m12_a_given_name_is_never_a_drug_token_even_when_the_detector_flags_it():
    for tok in ("Dylan", "Sharma", "Ramesh"):
        out = names.detector_tokens(f"Olmezest {tok}") or ""
        assert tok.lower() not in out.lower(), (tok, out)
    assert names.detector_tokens("Dylan") in (None, "") or "ylan" not in (names.detector_tokens("Dylan") or "").lower()


def test_m13_a_second_token_is_kept_only_when_it_is_an_exact_strong_name():
    a = names.detector_tokens("Olmezest Telma") or ""
    assert "olmezest" in a.lower()
    b = names.detector_tokens("Sompraz Pantocid Zorbexa") or ""
    assert "zorbexa" not in b.lower()


def test_m18_a_prescription_row_word_is_a_drug_token_outside_medication():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Use Qwelmoxin twice a day.")], roles={"0": "doctor", "1": "patient"})
    enc = empty_encounter(prescription=[{"action": "start", "decision_turn": 2, "generic": None, "brand_as_said": "Qwelmoxin", "strength": None, "frequency": "twice a day", "duration": None, "basis": "said", "confidence": 0.85, "source_quote_turn": 2, "source_turns": [2]}])
    a = build_artifact(c, enc)
    assert "qwelmoxin" not in json.dumps(a["gp_extraction"]).lower().replace("medication", "")


def test_m20_a_capitalised_stop_action_is_a_stop():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Stop Glycomet now.")], roles={"0": "doctor", "1": "patient"})
    rx = {"action": "STOP", "decision_turn": 2, "generic": None, "brand_as_said": "Glycomet", "strength": None, "frequency": None, "duration": None, "basis": "said", "confidence": 0.85, "source_quote_turn": 2, "source_turns": [2]}
    a = build_artifact(c, empty_encounter(prescription=[rx]))
    assert "start" not in {p["action"] for p in a["confirm_prompts"]}


def test_m27_a_later_hold_on_the_same_unnamed_regimen_wins_over_an_earlier_start():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Leave the tablet.")], roles={"0": "doctor", "1": "patient"})
    rx = lambda a: {"action": a, "decision_turn": 2, "generic": None, "brand_as_said": "tablet", "strength": None, "frequency": "twice a day", "duration": None, "basis": "said", "confidence": 0.85, "source_quote_turn": 2, "source_turns": [2]}
    a = build_artifact(c, empty_encounter(prescription=[rx("start"), rx("hold")]))
    acts = {p["action"] for p in a["confirm_prompts"]}
    assert "start" not in acts and "continue" not in acts, acts


# --- r5 residue closed in the same pass --------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("t", ["He takes Fish oil after dinner", "Omega 3 to be taken before breakfast", "Keep the Glucose morning and night", "Give Albumin alternate days", "Insulin only with milk", "Insulin"])
def test_supplements_unflagged_analyte_words_and_insulin_are_drug_talk_outside_medication(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


@pytest.mark.parametrize("t", ["the pump only after lunch", "He takes the dose daily", "pessary to be taken before breakfast", "Take elixir at bedtime", "the solution weekly", "Start granules before sleeping", "Give the paste after lunch", "Haemoglobin tonic at night"])
def test_more_dose_form_nouns(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


@pytest.mark.parametrize("t", ["BP wali when needed", "the antibiotic to be taken if pain", "He takes antihypertensive with milk", "Keep the NSAID if pain", "Restart gas wali when needed"])
def test_class_words_with_a_regimen_verb_or_a_timing_phrase(t):
    assert gate_of("As told.").drug_outside(t, [0]), t


def test_a_word_next_to_a_dosing_word_in_a_tagged_turn_is_a_drug_token():
    g = gate_of("Tell me.", "Care tablet SOS", "Walk daily", drug_spans={1})
    assert "care" in g._tagged_index()[0] and g.drug_outside("Same Care SOS", [2])
    assert not g.drug_outside("Review in clinic", [2])


@pytest.mark.parametrize("t", ["The girl before had wheezing", "The child before you had wheezing", "The boy outside had wheezing", "That lady waiting had it"])
def test_the_noun_before_or_outside_is_another_person(t):
    assert words.other_person(t) == "other_person", t


def test_a_tagged_unit_with_only_a_timing_word_is_drug_talk():
    g = gate_of("Tell me.", "ultra tablet every day", "Walk daily", drug_spans={1})
    assert g.drug_outside("ultra every day", [2]) and not g.drug_outside("Walk in the park", [2])


# --- L2 round two: m08 (native shingle alone), m18 (prescription word), m20 (action case) --------------------------------------------------------------------
def test_m08_a_shingle_of_function_words_only_in_native_text_echoes_by_the_shingle_alone():
    g = gate_of("Tell me.", "ok", quarantined={1}, native={1: "my aunt has a long"})
    assert words.content_tokens("my aunt has a long") == {"aunt", "long"}  # under three content tokens: only the 5-word shingle can catch it
    assert g.quarantine_echo("my aunt has a long", [0]) is True


def test_m18_a_prescription_row_word_is_a_drug_token_in_a_unit_that_overlaps_a_tagged_turn():
    rx = {"action": "start", "decision_turn": 2, "generic": None, "brand_as_said": "Duo", "strength": None, "frequency": "twice a day", "duration": None, "basis": "said", "confidence": 0.85,
          "source_quote_turn": 2, "source_turns": [2]}
    adv = {"text": "Duo helps your pain", "basis": "said", "source_turns": [3]}
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Take it twice a day."), (17, 20, "0", "Rest well and sleep.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(prescription=[rx], advice=[adv], drug_mention_spans=["s2"]))
    assert "general_advice" not in a["gp_extraction"] and "drug_outside_medication" in {w["reason_code"] for w in a["withheld"]}


def test_m20_the_action_is_case_insensitive_every_way_it_is_read():
    rx = {"action": "start", "decision_turn": 2, "generic": None, "brand_as_said": "Glycomet", "strength": None, "frequency": None, "duration": None, "basis": "said", "confidence": 0.85, "source_quote_turn": 2, "source_turns": [2]}
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", "Stop Glycomet now.")], roles={"0": "doctor", "1": "patient"})
    outs = []
    for act in ("stop", "STOP", "Stop"):
        a = build_artifact(c, empty_encounter(prescription=[dict(rx, action=act)]))
        outs.append(json.dumps({k: v for k, v in a.items() if k not in ("artifact_id", "created_at", "run")}, sort_keys=True, default=str).replace(a.get("run_id", "x"), ""))
        assert {p["action"] for p in a["confirm_prompts"]} == {"stop"}
    assert len({len(o) for o in outs}) == 1


@pytest.mark.parametrize("t", ["He takes antihypertensive", "Restart the antibiotic", "Continue steroid"])
def test_a_class_word_with_a_regimen_verb_and_no_timing_word_is_drug_talk(t):
    assert not words.timing_present(t) and gate_of("As told.").drug_outside(t, [0]), t
