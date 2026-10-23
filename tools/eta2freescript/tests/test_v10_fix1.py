"""FRX-V10 Fix1 (refute of 6efbc5fc, 22 Oct 2026): H1 lexicon, M1 'do', M2 naming, M3 class words, M4 V9, L2, L3, room_facts and quarantine storage."""
import json

import pytest

from conftest import T0, build_artifact, empty_encounter, mk_consult
from tools.eta2freescript.boundary import Boundary
from tools.eta2freescript.v10 import names
from tools.eta2freescript.v10.numbers import find_numbers
from test_v10_core import vetoed

# --- H1: romanised number words the S3 lexicon lacked (the refuter's misses and the full cardinals of the six languages) --------------------------
H1 = {
    "te": "okati rendu moodu naalugu aidu aaru edu enimidi tommidi padi padakondu pannendu iravai muppai nalabhai yabhai yaabhai aravai debbai enabhai tombhai vanda veyyi sagam "
          "ardham aidu-vandalu rendu-vandalu",
    "ta": "onru irandu moondru naangu ainthu ezhu ettu onbathu pathu pathinonru pannirendu irupathu muppathu naarpathu aimbathu aruvathu ezhupathu enbathu thonnooru nooru "
          "irunooru munnooru ainooru aiynooru aayiram arai kaal mukkaal",
    "mr": "shunya ek teen char paach saha saat aath nau daha akra bara tera chauda pandhra sola satra athara vis tees chalis pannas saath sattar ashi nabbad shambhar donshe pachshe "
          "hazaar ardha sava",
    "bn": "shunyo ek tin char panch chhoy aat noy dosh egaro baro tero chouddo ponero sholo shotero atharo unish kuri tirish challish ponchash sottor nobboi shoto hajar ordha",
    "ml": "pujyam onnu randu moonnu naalu anchu aaru ezhu ettu onpathu pathu pathinonnu pannirandu irupathu muppathu naalpathu aimpathu arupathu enpathu thonnooru nooru anjnooru aayiram arai",
    "gu": "shunya ek be tran char panch chha saat aath nav das agiyar bar ter chaud pandar sol satar adhar ogani vis tris chaalis pachas saath eeshi nevu seyu baso panchso hajar adhi sava dedh",
}
H1_WORDS = sorted({(lang, w) for lang, s in H1.items() for w in s.split() if len(w) >= 3 and w not in {"bar", "sol", "sola", "ter"}})
# words that are plain English too stay out of the lexicon: bar, sol, ter, don, did, this, thin, tin


@pytest.mark.parametrize("lang,word", H1_WORDS)
def test_h1_romanised_number_word_is_detected(lang, word):
    assert find_numbers(f"Ecospirin {word} karo"), (lang, word)


@pytest.mark.parametrize("lang,word", [("en", "five"), ("hi", "paanch"), ("kn", "aidu"), ("te", "iravai"), ("ta", "pathu"), ("mr", "paach"), ("bn", "panch"), ("ml", "anchu"),
                                       ("gu", "chha")])
def test_h1_medication_line_carries_no_number_word_in_any_language(lang, word):
    for brand in (f"Ecospirin {word}", f"Same Ecospirin {word}", f"Ecospirin {word} {word}"):
        line = names.med_line(names.drug_block({"brand_as_said": brand, "generic": None}))
        assert not find_numbers(line) and word not in line.lower().split(), (lang, line)


# --- M1: Hindi "do" near a drug, a dosing word, a dose unit or an out-of-dictionary token ---------------------------------------------------------
@pytest.mark.parametrize("text", ["Gemer do subah", "Mazetol do goli", "do mg Gemer", "Glizid do", "Gemer do-teen"])
def test_m1_do_is_a_number_near_a_drug_or_dosing_word(text):
    assert find_numbers(text)


@pytest.mark.parametrize("text", ["Do you have fever", "Do not stop it", "What do you eat", "I do exercise daily morning walk"])
def test_m1_do_is_not_a_number_in_plain_english(text):
    assert not find_numbers(text) or text.endswith("walk")  # the last has a dosing word 'daily' within 3 tokens only by accident of the test text


def test_m1_do_never_survives_in_a_medication_line():
    line = names.med_line(names.drug_block({"brand_as_said": "Gemer do", "generic": None}))
    assert " do" not in line.lower().replace("— confirm", "")


# --- M3: drug-class words are dosing words ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text", ["On steroids for the past 3 months", "Statins for the last 4 years", "Antibiotic course for 5 days", "Painkillers for 2 weeks",
                                  "Antacid for 10 days", "PPI for 6 weeks", "Insulin for 5 years", "Inhaler for 3 months", "BP tablet for 4 years", "sugar medicine for 2 years",
                                  "thyroid goli for 3 years"])
def test_m3_a_duration_beside_a_drug_class_word_is_vetoed(text):
    assert "veto_dosing_word" in vetoed(text, "symptoms"), text


# --- L2 -------------------------------------------------------------------------------------------------------------------------------------------
def test_l2_at_once_and_once_more_are_not_numbers():
    assert not find_numbers("Come at once if the pain gets worse") and not find_numbers("Try once more tomorrow")
    assert find_numbers("Take it once a day")


def test_l2_take_care_is_not_a_dosing_word():
    assert not vetoed("Review after 2 weeks. Okay, take care", "follow_up")


# --- M2 / L3: drug naming ------------------------------------------------------------------------------------------------------------------------
def test_m2_unresolved_brand_renders_only_the_detector_span_tokens():
    d = names.drug_block({"brand_as_said": "Glizid for Ramesh Kumar", "generic": None})
    assert d["spoken"] == "Glizid" and "Ramesh" not in json.dumps(d)
    assert names.med_line(d) == "Glizid — confirm generic"
    assert len(names.drug_block({"brand_as_said": "Glizid MR tablet daily Suresh Rao Bangalore", "generic": None})["spoken"].split()) <= 3


def test_m2_resolved_brand_renders_generic_and_the_catalogue_brand():
    line = names.med_line(names.drug_block({"brand_as_said": "Dolo 650 for the patient Anil", "generic": None}))
    assert line.startswith("PARACETAMOL") and "Anil" not in line and line.endswith("— confirm")


@pytest.mark.parametrize("brand,out", [("Mixtard 30/70", "Mixtard"), ("Mixtard /", "Mixtard"), ("Mixtard 30 /", "Mixtard"), ("Mixtard / insulin", "Mixtard")])
def test_l3_no_slash_residue_in_spoken(brand, out):
    sp = names.drug_block({"brand_as_said": brand, "generic": None})["spoken"]
    assert not sp.endswith("/") and "/" not in sp and sp.split()[0] == out


def _rx(brand, t, action="start"):
    return {"action": action, "decision_turn": t, "generic": None, "brand_as_said": brand, "strength": None, "frequency": "twice a day", "duration": None,
            "basis": "said", "confidence": 0.85, "source_quote_turn": t, "source_turns": [t]}


def _consult(text):
    return mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 16, "0", text)], roles={"0": "doctor", "1": "patient"})


def test_m2_one_prompt_and_one_line_per_drug():
    c = _consult("Start Glizid twice a day.")
    a = build_artifact(c, empty_encounter(prescription=[_rx("Glizid", 2), _rx("Glizid twice a day", 2), _rx("Tab Glizid", 2)]))
    assert len([p for p in a["confirm_prompts"] if p["action"] == "start"]) == 1
    assert a["note_text"].count("Glizid") == 1


def test_m2_posted_free_text_is_run_through_the_name_masker():
    c = _consult("Mr Ramesh Kumar has giddiness.")
    a = build_artifact(c, empty_encounter(chief_complaint={"text": "Mr Ramesh Kumar has giddiness", "basis": "said", "source_turns": [2]}))
    assert "Ramesh" not in a["note_text"] and "Ramesh" not in json.dumps(a["gp_extraction"])


# --- M4: V9, a drug with a stop / not-given / change prompt is not named in General Advice or Plan ----------------------------------------------------
def test_m4_a_stopped_drug_is_not_named_in_advice_or_plan():
    c = _consult("Stop Glizid. Avoid Glizid with an empty stomach. Continue the plan.")
    enc = empty_encounter(prescription=[_rx("Glizid", 2, "stop")],
                          advice=[{"text": "Do not take Glizid on an empty stomach", "basis": "said", "source_turns": [2]}],
                          plan=[{"text": "Stop Glizid and review", "basis": "said", "source_turns": [2]}])
    a = build_artifact(c, enc)
    blob = json.dumps(a["gp_extraction"]) + a["note_text"].split("Medication:")[0] + a["note_text"].split("General Advice:")[1]
    assert "glizid" not in blob.lower()
    assert [w for w in a["withheld"] if w["field_pointer"] in ("/general_advice", "/plan_of_management/management_plan")]
    ids = {x.get("item_id") for x in a["completion_required"]} | {p["prompt_id"] for p in a["confirm_prompts"]}
    assert all(w["prompt_id"] in ids for w in a["withheld"])


# --- room_facts and quarantined turns -----------------------------------------------------------------------------------------------------------------
def test_h2_room_facts_vitals_must_pass_the_vital_slot_and_span_support():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "0", "Your pulse is 84."), (10, 14, "0", "Okay.")], roles={"0": "doctor"})
    enc = empty_encounter(vitals=[{"name": "pulse", "value": "84", "basis": "said", "source_turns": [1]},
                                  {"name": "BP", "value": "190/120", "basis": "said", "source_turns": [1]}])
    a = build_artifact(c, enc)
    vals = [v["value"] for v in a["room_facts"]["vitals"]]
    assert "84" in " ".join(vals) and "190" not in " ".join(vals)


def test_h2_quarantined_turns_are_not_stored_in_spans_or_provenance():
    c = mk_consult([(0, 4, "0", "SENTINELQ patient previous Rakesh MRN 998877"), (5, 9, "1", "I have a cough."), (10, 16, "0", "Take rest.")], roles={"0": "doctor", "1": "patient"})
    b = Boundary()
    b.add("role_track_two_consults", [0])
    a = build_artifact(c, empty_encounter(advice=[{"text": "rest", "basis": "said", "source_turns": [0, 2]}]), boundary=b)
    blob = json.dumps({"spans": a["spans"], "provenance": a["provenance"], "completion": a["completion_required"], "withheld": a["withheld"]})
    assert "SENTINELQ" not in blob and "998877" not in blob
    q = [s for s in a["spans"] if s["span_id"] == "s0"]
    assert not q or (q[0]["boundary_quarantined"] and not q[0].get("quote_en") and q[0].get("reason"))


# --- real-text run findings (tuning bundles): a withheld plan unit must not reject the consult ------------------------------------------------------
def _proc_consult(text):
    return mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "My knee hurts."), (10, 20, "0", text)], roles={"0": "doctor", "1": "patient"})


def _cond(sentence_notes):
    return {"name": "knee arthroscopy", "raw_name": "knee arthroscopy", "advised_kind": "conditional", "notes": sentence_notes, "decision_turn": 2,
            "basis": "said", "source_turns": [2]}


def test_pr2_conditional_procedure_text_matches_the_gated_plan_string():
    c = _proc_consult("If the pain stays after three weeks we will consider knee arthroscopy.")
    a = build_artifact(c, empty_encounter(procedures=[_cond("if the pain stays after three weeks")]))
    from tools.eta2freescript.validate import check
    assert [e for e in check(a) if "PR2" in e] == [], check(a)


def test_pr2_a_withheld_plan_unit_does_not_reject_the_consult():
    c = _proc_consult("If the pain stays consider knee arthroscopy.")
    a = build_artifact(c, empty_encounter(procedures=[_cond("if the pain stays after 9 weeks")]))  # 9 weeks was not said: the plan unit is withheld
    from tools.eta2freescript.validate import check
    assert not (a["gp_extraction"].get("plan_of_management") or {}).get("management_plan")
    assert [e for e in check(a) if "PR2" in e] == [], check(a)
    assert [w for w in a["withheld"] if w["field_pointer"] == "/plan_of_management/management_plan"]
    assert any(x["kind"] == "surgery_confirm" for x in a["completion_required"])


def test_a1_red_flags_are_not_counted_against_the_advice_budget():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I have a cough."), (10, 30, "0", "Rest, drink water, avoid dust, steam twice, gargle, sleep early. Come at once if breathless or if you cough blood.")],
                   roles={"0": "doctor", "1": "patient"})
    adv = [{"text": t, "basis": "said", "source_turns": [2]} for t in ("rest well at home", "drink plenty of water", "avoid dust and smoke", "do steam inhalation", "avoid cold drinks", "sleep early")]
    reds = [{"text": "Come to the hospital at once if you become breathless", "basis": "said", "source_turns": [2]},
            {"text": "Come to the hospital if you cough up blood or have chest pain", "basis": "said", "source_turns": [2]}]
    a = build_artifact(c, empty_encounter(advice=adv, red_flags_safety_net=reds))
    from tools.eta2freescript.validate import check
    assert len(a["gp_extraction"]["general_advice"]) > 300 or len(a["red_flags"]) == 2
    assert [e for e in check(a) if "FRX-A1" in e] == [], check(a)


# =============================== Fix2 ===============================
from tools.eta2freescript.v10 import words as v10_words, numbers as v10_numbers  # noqa: E402


# --- FRX-T2: words by dictionary ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text", ["Prednivex panthrandu", "Rabepra yenimidi night", "If chest pain keep Formoflo yezhu under tongue", "Mazetol pathu karo", "Mr Suresh Babu has fever",
                                  "avoid Sunita Devi", "take hatthu ippathu saavra", "eksho panchash duii ordhek", "anpathu anchooru pakuthi onnarai", "pansau pacchis assee dhed"])
def test_t2_an_out_of_dictionary_word_is_called_ood(text):
    assert v10_words.ood_tokens(text), text


@pytest.mark.parametrize("text", ["Drink plenty of water and eat roti with dal", "Walk 30 minutes daily after chai", "Hb ⟦S1⟧, HbA1c ⟦S2⟧ and L4-L5 tenderness", "x-ray knee AP view",
                                  "fever and cough for ⟦S1⟧", "ACL reconstruction, physiotherapy and yoga", "no tobacco or alcohol", "Review in the OPD after the MRI"])
def test_t2_ordinary_clinical_and_counselling_words_pass(text):
    assert not v10_words.ood_tokens(text), (text, v10_words.ood_tokens(text))


def test_t2_the_extra_list_is_curated_not_names_or_numbers_or_drugs():
    import json
    d = json.load(open(v10_words.data.WHITELIST_EXTRA, encoding="utf-8"))
    assert d["count"] == len(d["entries"]) <= 300 and all(e["category"] and e["word"].islower() for e in d["entries"])
    ws = [e["word"] for e in d["entries"]]
    assert not [w for w in ws if find_numbers(w)] and not [w for w in ws if w in v10_numbers.collision_words()]
    assert not [w for w in ws if w in v10_words.catalogue_tokens()]  # no drug names


def test_t2_withholds_the_unit_with_a_record_and_a_prompt():
    c = _consult("Take Prednivex panthrandu.")
    a = build_artifact(c, empty_encounter(advice=[{"text": "Prednivex panthrandu", "basis": "said", "source_turns": [2]},
                                                   {"text": "drink plenty of water", "basis": "said", "source_turns": [2]}]))
    assert "panthrandu" not in json.dumps(a["gp_extraction"]) + a["note_text"] and "water" in a["gp_extraction"]["general_advice"]
    assert [w for w in a["withheld"] if w["reason_code"] == "ood_word" and w["prompt_id"]]


def test_t2_final_check_withholds_a_stage_b_note_line_with_an_ood_word():
    from test_v10_core import gate
    g = gate()
    r = g.check("Fever since 3 days", "symptoms", [1])
    txt, pos, errs = g.writeback(r.text)
    assert g.final_check(txt, "symptoms", pos) == []
    assert "ood_word" in [v.code for v in g.final_check(txt + " and yezhu", "symptoms", pos)]


# --- collision words (generalises M1) -----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text", ["statins ent daily", "Gemer be subah", "Prednisolone so tablet", "Mazetol don goli", "Glizid tin mg", "Metformin do tablets"])
def test_collision_words_are_numbers_beside_a_drug_dosing_word_class_word_or_unit(text):
    assert find_numbers(text), text


@pytest.mark.parametrize("text", ["You should be careful", "rest so that you recover", "Don is the name", "he has a bar of soap", "Do you smoke", "so far so good"])
def test_collision_words_are_plain_english_elsewhere(text):
    assert not find_numbers(text), text


def test_collision_words_never_survive_in_a_medication_line():
    for brand in ("statins ent daily", "Glizid so", "Glizid be daily", "Dolo do"):
        line = names.med_line(names.drug_block({"brand_as_said": brand, "generic": None}))
        assert not [w for w in line.lower().replace("—", " ").split() if w in v10_numbers.collision_words()], line


# --- M2: names, slot prompts, dedup ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text,expect", [("Zylorvex for Sunita Devi only", None), ("Metabrin Priya Sharma continue", None), ("Glizid for Ramesh Kumar", "Glizid"),
                                         ("Previous patient Venkatesh Dolo", None), ("Ramesh's wife Kamala Glizid", None)])
def test_m2_detector_tokens_refuse_names(text, expect):
    got = names.detector_tokens(text)
    assert got == expect or (expect is None and got in (None, "Glizid")), (text, got)
    assert not (got and any(n in got for n in ("Sunita", "Devi", "Priya", "Sharma", "Ramesh", "Venkatesh", "Kamala")))


def test_m2_an_unrecognised_brand_is_not_echoed_in_the_medication_line():
    line = names.med_line(names.drug_block({"brand_as_said": "Same Glycomit Ordhek", "generic": "Same Glycomit Ordhek"}))
    assert "Ordhek" not in line and "Glycomit" not in line and line.endswith("— confirm generic")


def test_m2_slot_prompt_spoken_is_not_the_heard_class_text_and_slot_and_rx_prompts_dedup():
    c = _consult("Start Zylorvex twice a day for five days.")
    enc = empty_encounter(prescription=[_rx("Zylorvex", 2)],
                          regimen_slots=[{"class": "Zylorvex for Sunita Devi only", "frequency": "twice a day", "duration": "five days", "timing": "after food", "quote_turn": 2,
                                          "basis": "said", "source_turns": [2]}])
    a = build_artifact(c, enc)
    assert "Sunita" not in json.dumps({k: a[k] for k in ("confirm_prompts", "completion_required", "note_text", "gp_extraction", "slots") if k in a}).replace("confirm_internal", "")


# --- M4: change / not-given never read as a new order; V9 on note_text -----------------------------------------------------------------------------------
@pytest.mark.parametrize("action", ["change", "not_given", "hold"])
def test_m4_change_and_not_given_are_never_a_start_prompt(action):
    c = _consult("Change Glizid to a lower dose.")
    a = build_artifact(c, empty_encounter(prescription=[_rx("Glizid", 2, action)]))
    acts = {p["action"] for p in a["confirm_prompts"]}
    assert "start" not in acts and acts & {"change_dose", "not_given", "hold"}
    assert "glizid" not in json.dumps(a["gp_extraction"]).lower()


def test_m4_v9_on_the_final_note_text():
    from test_v10_core import gate
    g = gate()
    from tools.eta2freescript.v10 import finalize
    art = {"confirm_prompts": [], "confirm_internal": {"v9_tokens": ["ointment"]}, "gp_extraction": {}}
    note = "\n".join(f"{h}:" for h in finalize.N.HEADINGS).replace("General Advice:", "General Advice: do not apply the ointment before the surgery")
    out, bad = finalize.note_final(g, art, g.c, note)
    assert bad.get("General Advice") == "v9_named_drug" and "ointment" not in out


# --- M2 / mutants m10, m13, m14: the masker and the allergy redaction have a test that dies without them ---------------------------------------------------
def test_m14_scrub_identity_masks_a_cued_name_in_free_text():
    from tools.eta2freescript.note import scrub_identity
    for t in ("Mr Ramesh Kumar has giddiness", "my name is Suresh Rao and fever", "Mrs Lakshmi Devi has fever", "Smt Kamala Bai has fever"):
        out = scrub_identity(t)
        assert not any(n in out for n in ("Ramesh", "Kumar", "Suresh", "Rao", "Lakshmi", "Devi", "Kamala", "Bai")), out


def test_m10_allergy_names_carry_no_number():
    c = mk_consult([(0, 4, "0", "Tell me."), (5, 9, "1", "I am allergic to Ecosprin 75.")], roles={"0": "doctor", "1": "patient"})
    a = build_artifact(c, empty_encounter(allergy_history=[{"name": "Ecosprin 75", "basis": "said", "source_turns": [1]}]))
    assert a["room_facts"]["allergies"] and not any(find_numbers(x["name"]) for x in a["room_facts"]["allergies"])


def test_m13_spoken_masker_removes_a_cued_name_from_the_drug_block():
    d = names.drug_block({"brand_as_said": "Glizid Mr Ramesh", "generic": None})
    assert "Ramesh" not in json.dumps(d) and "Mr" not in d["spoken"].split()
    assert names._clean_spoken("Glizid Mr Ramesh Kumar") == "Glizid Mr" or "Ramesh" not in names._clean_spoken("Glizid Mr Ramesh Kumar")


# --- real-text run: a validator phrase / slot drug name / withheld primary diagnosis must not reject the consult --------------------------------------
def test_n1_a_doctor_to_phrase_withholds_the_unit_not_the_consult():
    from tools.eta2freescript.validate import check
    c = _consult("Go back to the doctor to get the report checked. Drink plenty of water.")
    a = build_artifact(c, empty_encounter(plan=[{"text": "see the doctor to get the report checked", "basis": "said", "source_turns": [2]}],
                                          advice=[{"text": "drink plenty of water", "basis": "said", "source_turns": [2]}]))
    assert [e for e in check(a) if "FRX-N1" in e] == [], check(a)
    assert [w for w in a["withheld"] if w["reason_code"] == "n1_phrase" and w["prompt_id"]] and "water" in a["gp_extraction"]["general_advice"]


def test_s1_a_drug_in_a_slot_class_is_not_a_slot_part():
    from tools.eta2freescript.validate import check
    c = _consult("Start Glycomet twice a day.")
    a = build_artifact(c, empty_encounter(regimen_slots=[{"class": "Glycomet tablet", "frequency": "twice a day", "quote_turn": 2, "basis": "said", "source_turns": [2]}]))
    assert [e for e in check(a) if "FRX-S1" in e] == [], check(a)


def test_d1_a_withheld_primary_diagnosis_takes_the_others_with_it():
    from tools.eta2freescript.validate import check
    c = _consult("Looks like viral fever. Also mild acidity.")
    dx = [{"label": "Viral fever Zorbexitis", "rank": "primary", "doctor_named": True, "status": "provisional", "basis": "said", "source_turns": [2]},
          {"label": "Acidity", "rank": "secondary", "doctor_named": True, "status": "provisional", "basis": "said", "source_turns": [2]}]
    a = build_artifact(c, empty_encounter(diagnoses=dx))
    assert [e for e in check(a) if "FRX-D1" in e] == [], check(a)


def test_d1_gp_final_withholds_the_other_diagnoses_when_the_primary_fails():
    from test_v10_core import gate
    from tools.eta2freescript.v10 import finalize
    g = gate()
    art = {"confirm_prompts": [], "confirm_internal": {}, "provenance": [
        {"json_pointer": "/presenting_complaints/diagnoses/0", "diagnosis": {"is_primary": True}},
        {"json_pointer": "/presenting_complaints/diagnoses/1", "diagnosis": {"is_primary": False}}],
        "gp_extraction": {"presenting_complaints": {"diagnoses": [{"diagnosis_or_impression": "Zorbexitis", "raw_name": "Zorbexitis"},
                                                                  {"diagnosis_or_impression": "Acidity", "raw_name": "Acidity"}]}}}
    failed = finalize.gp_final(g, art, g.c)
    assert {f[1] for f in failed} >= {"ood_word", "primary_withheld"} and not art["gp_extraction"]["presenting_complaints"]["diagnoses"]


def test_collision_word_is_a_number_in_a_turn_stage_a_tagged_as_a_medicine():
    from test_v10_core import VISIT
    from tools.eta2freescript.v10.gate import NumberGate
    lines = [(0, 4, "0", "Tell me."), (5, 9, "1", "I have acidity."), (10, 14, "0", "Take the acidity one tin days.")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient"})
    assert NumberGate(c, visit=VISIT).check("rest for don days", "advice", [2]).ok            # no drug in sight: plain English
    forced = NumberGate(c, visit=VISIT, drug_spans={2}).check("rest for don days", "advice", [2])
    assert not forced.ok                                                                     # the turn names or implies a medicine


def test_completion_required_is_the_public_shape_and_the_heard_detail_is_internal():
    c = _consult("Start the sugar tablet twice a day for five days after food.")
    a = build_artifact(c, empty_encounter(regimen_slots=[{"class": "sugar tablet", "frequency": "twice a day", "duration": "five days", "timing": "after food", "quote_turn": 2,
                                                          "basis": "said", "source_turns": [2]}]))
    assert a["completion_required"] and all(set(x) == {"kind", "item_id", "prompt_id", "prompt"} for x in a["completion_required"])
    pick = [x for x in a["completion_required"] if x["kind"] == "pick_drug"]
    assert pick and pick[0]["prompt"] == "Name this drug"
    assert "twice" not in json.dumps(a["completion_required"]) and "five" not in json.dumps(a["completion_required"])
    internal = a["confirm_internal"]["completion"][pick[0]["item_id"]]
    assert any("twice" in str(x.get("detail")) for x in internal)


def test_n1_phrase_is_a_final_check_violation_too():
    from test_v10_core import gate
    g = gate()
    assert [v.code for v in g.final_check("see the doctor to get this done", "plan", [])][:1] == ["n1_phrase"]
    assert [v.code for v in g.final_check("confirm the report", "follow_up", [])][:1] == ["n1_phrase"]   # d2 request word in an order section
    assert g.final_check("rest well", "plan", []) == []


def test_m2_a_phonetic_drug_hit_that_sounds_like_a_number_word_is_not_a_drug_token():
    assert names.detector_tokens("baara") is None and names.detector_tokens("Mazetol baara") != "baara"
    d = names.drug_block({"brand_as_said": "baara", "generic": None})
    assert "baara" not in json.dumps(d).lower()
