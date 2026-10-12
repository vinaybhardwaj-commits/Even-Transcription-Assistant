"""Mapper v2 rules: hold-back, coarse diagnoses, social drop, advice cap, sparse fields -> completion_required."""
import pytest
from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.boundary import Boundary
from tools.eta2freescript.mapper import ADVICE_MAX_CHARS, MAX_SECONDARY_DX, duration, near_duplicate
from tools.eta2freescript.validate import check

DOC = {"0": "doctor", "1": "patient", "2": "attendant"}
LINES = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and cough."), (11, 15, "2", "He takes amlodipine 5 mg."),
         (16, 20, "0", "Throat is red."), (21, 30, "0", "Take paracetamol 500 mg twice a day for three days."),
         (31, 35, "0", "Drink water and rest."), (36, 40, "0", "Come back after one week.")]


def consult(**kw):
    return mk_consult(LINES, roles=DOC, **kw)


def rx(**kw):
    base = {"action": "start", "decision_turn": 4, "generic": "paracetamol", "brand_as_said": None, "strength": "500 mg", "frequency": "twice a day",
            "duration": "3 days", "route": "oral", "basis": "said", "confidence": 0.85, "source_quote_turn": 4, "source_turns": [4]}
    base.update(kw)
    return base


def kept(art, tag):
    return [p for p in art["provenance"] if p["json_pointer"] is None and p["text"].startswith(tag)]


def kinds(art):
    return [c["kind"] for c in art["completion_required"]]


EXAM = [{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [3]}]


def art_of(c=None, b=None, **enc):
    enc.setdefault("examination", EXAM)
    a = build_artifact(c or consult(), empty_encounter(**enc), b)
    assert check(a) == [], check(a)
    return a


def test_said_order_with_doctor_decision_is_emitted():
    a = art_of(prescription=[rx()])
    assert [m["name"] for m in a["gp_extraction"]["medicines"]] == ["paracetamol 500 mg"]
    assert a["completion_required"] == []


@pytest.mark.parametrize("change,why", [({"basis": "inferred"}, "no doctor decision turn"), ({"decision_turn": None}, "no doctor decision turn"),
                                         ({"decision_turn": 2, "source_turns": [2]}, "decision not spoken by the doctor")])
def test_hold_back(change, why):
    a = art_of(prescription=[rx(**change)])
    assert "medicines" not in a["gp_extraction"]
    held = kept(a, "[held_back_inferred_order]")
    assert len(held) == 1 and why in held[0]["text"]


def test_non_doctor_decision_not_held_without_role_track():
    c = mk_consult(LINES, role_track=False)
    a = build_artifact(c, empty_encounter(examination=EXAM, prescription=[rx(decision_turn=2, source_turns=[2], strength="5 mg", generic="amlodipine",
                                                                                 frequency=None, duration=None)]))
    assert a["gp_extraction"]["medicines"][0]["raw_name"] == "amlodipine"


def test_stopped_drug_negated_and_kept_out():
    a = art_of(prescription=[rx(action="stop")])
    p = [x for x in a["provenance"] if x["status"] == "stopped"]
    assert p and p[0]["negated"] and "medicines" not in a["gp_extraction"]
    assert "Stop paracetamol." in a["gp_extraction"]["plan_of_management"]["management_plan"]


def dx(label, rank="secondary", named=False, turns=(1,)):
    return {"label": label, "rank": rank, "doctor_named": named, "status": "provisional", "basis": "said", "icd10_suggestion": None, "source_turns": list(turns)}


def test_one_primary_symptoms_are_not_diagnoses():
    a = art_of(diagnoses=[dx("Cough"), dx("Upper respiratory infection", "primary", True), dx("Back pain", named=True), dx("Fever")])
    labels = [d["diagnosis_or_impression"] for d in a["gp_extraction"]["presenting_complaints"]["diagnoses"]]
    assert labels == ["Upper respiratory infection", "Back pain"]
    assert {p["text"] for p in kept(a, "[symptom_not_separate_diagnosis]")} == {"[symptom_not_separate_diagnosis] Cough", "[symptom_not_separate_diagnosis] Fever"}


def test_secondary_diagnoses_capped_and_merged():
    sec = [dx(f"Condition {k}", named=True) for k in "ABCDE"]
    a = art_of(diagnoses=[dx("Hypertension", "primary", True), dx("hypertension", named=True)] + sec)
    assert len(a["gp_extraction"]["presenting_complaints"]["diagnoses"]) == 1 + MAX_SECONDARY_DX
    assert len(kept(a, "[diagnosis_capped]")) == 5 - MAX_SECONDARY_DX
    assert len(kept(a, "[diagnosis_merged]")) == 1


def test_social_and_place_detail_kept_out_unless_relevant():
    a = art_of(chief_complaint={"text": "Fever", "basis": "said", "source_turns": [1]},
               history=[{"type": "social", "text": "Runs a shop", "basis": "said", "clinically_relevant": False, "source_turns": [1]},
                        {"type": "place", "text": "Came by train", "basis": "said", "source_turns": [1]},
                        {"type": "occupation", "text": "Works with dust", "basis": "said", "clinically_relevant": True, "source_turns": [1]}])
    sym = a["gp_extraction"]["presenting_complaints"]["symptoms"]
    assert "shop" not in sym and "train" not in sym and "Hx - Works with dust" in sym
    assert len(kept(a, "[history:")) == 2


def adv(text, turn=5, basis="said"):
    return {"text": text, "basis": basis, "source_turns": [turn]}


def test_advice_merge_cap_and_said_aloud():
    a = art_of(advice=[adv("Drink plenty of water"), adv("Drink lots of water every day"), adv("Rest"), adv("Avoid cold drinks", basis="inferred"),
                       adv("Do not go to work", turn=2)] + [adv(t) for t in ("Avoid oily food", "Sleep early", "Gargle at night", "Wear a mask", "Steam inhalation")])
    ga = a["gp_extraction"]["general_advice"]
    assert ga.count("water") == 1 and len(ga) <= ADVICE_MAX_CHARS and len(ga.split("; ")) == 5
    assert kept(a, "[advice_not_said_aloud]") and kept(a, "[advice_not_by_doctor]") and kept(a, "[advice_capped]")


def test_advice_char_cap():
    long = "x" * 200
    a = art_of(advice=[adv("Rest at home " + long), adv("Walk daily " + long)])
    assert len(a["gp_extraction"]["general_advice"]) <= ADVICE_MAX_CHARS and kept(a, "[advice_capped]")


def test_near_duplicate():
    assert near_duplicate("Drink plenty of water", "drink plenty of water daily")
    assert near_duplicate("Drink plenty of water", "Drink lots of water")
    assert not near_duplicate("Avoid oily food", "Avoid climbing stairs")


def test_exam_missing_when_nothing_said():
    a = art_of(examination=[])
    assert kinds(a) == ["exam_missing"] and kept(a, "[exam_missing]")
    a = art_of(examination=[{"performed": "Abdomen", "finding": None, "basis": "said", "source_turns": [3]}])
    assert kinds(a) == ["exam_missing"] and a["completion_required"][0]["detail"] == "Abdomen"
    assert "examination" not in a["gp_extraction"]


def test_dose_unstated_review():
    c = mk_consult([(0, 3, "1", "Fever."), (4, 9, "0", "Take paracetamol twice a day.")], roles=DOC)
    a = art_of(c=c, examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [1]}],
               prescription=[rx(strength=None, duration=None, decision_turn=1, source_quote_turn=1, source_turns=[1])])
    assert a["gp_extraction"]["medicines"][0]["name"] == "paracetamol"
    c = a["completion_required"]
    assert kinds(a) == ["dose_unstated"] and "strength, duration" in c[0]["prompt"]


def test_unnamed_drug_becomes_regimen_slot_never_a_medicine():
    a = art_of(prescription=[rx(generic=None, brand_as_said="tablet", strength=None)],
               regimen_slots=[{"dosage_form": "cream", "frequency": "twice a day", "duration": None, "quote_turn": 4, "source_turns": [4]}])
    assert "medicines" not in a["gp_extraction"]
    assert kinds(a) == ["regimen_slot", "regimen_slot"]
    assert all(c["prompt"] == "Name this drug" for c in a["completion_required"])
    assert len(kept(a, "[regimen_slot] Name this drug")) == 2


def test_drug_history_continue_prompt_needs_a_doctor_signal():
    mentioned = [{"name_as_said": "amlodipine", "text": "Takes amlodipine", "current": True, "reported_by": "attendant", "source_turns": [2]}]
    a = art_of(drug_history=mentioned)
    assert "drug_history" not in kinds(a)
    discussed = [{"name_as_said": "amlodipine", "text": "Continue amlodipine", "current": True, "reported_by": "doctor", "source_turns": [4]}]
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever."), (11, 15, "2", "He takes amlodipine."),
             (16, 20, "0", "Throat is red."), (21, 30, "0", "Continue the amlodipine.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [3]}],
               drug_history=discussed)
    assert kinds(a) == ["drug_history"] and a["completion_required"][0]["prompt"] == "Continue amlodipine?"
    a = art_of(drug_history=mentioned, prescription=[rx(generic="amlodipine", brand_as_said="Amlong", strength="5 mg", decision_turn=4, source_turns=[2, 4])])
    assert "drug_history" not in kinds(a)


def test_follow_up_typed_and_unstated():
    a = art_of(follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 1, "unit": "WEEKS"}, "basis": "said", "source_turns": [6]})
    assert a["gp_extraction"]["follow_up"]["followup_type"] == "MANDATORY_FOLLOW_UP" and "followup_date" in a["gp_extraction"]["follow_up"]
    a = art_of(follow_up={"type": "MANDATORY_FOLLOW_UP", "basis": "said", "source_turns": [6]})
    assert kinds(a) == ["follow_up_unstated"]
    a = art_of(follow_up={"type": None, "condition": "if fever persists", "basis": "said", "source_turns": [6]})
    assert a["gp_extraction"]["follow_up"]["followup_type"] == "IF_REQUIRED" and a["completion_required"] == []


def test_boundary_quarantined_orders_kept_out_with_review():
    b = Boundary()
    b.add("role_track_two_consults", [2])
    a = art_of(b=b, prescription=[rx(generic="amlodipine", strength="5 mg", decision_turn=2, source_turns=[2])],
               investigations=[{"name": "ECG", "order_status": "ordered", "basis": "said", "decision_turn": 2, "source_turns": [2]}])
    gx = a["gp_extraction"]
    assert "medicines" not in gx and "further_investigations" not in gx
    q = [p for p in a["provenance"] if "boundary_quarantined" in p["flags"]]
    assert len(q) == 2 and all(p["json_pointer"] is None for p in q)
    assert kinds(a) == ["boundary_review"] and a["completion_required"][0]["item_id"] == q[0]["item_id"]
    assert a["clip_boundary"] == {"suspected": True, "quarantined_turns": [2], "reasons": ["role_track_two_consults"]}


def test_boundary_suspected_without_quarantine_gets_a_clip_item():
    b = Boundary()
    b.add("role_track_two_consults:no_gap")
    a = art_of(b=b)
    cb = [p for p in a["provenance"] if p["kind"] == "clip_boundary"]
    assert len(cb) == 1 and kinds(a) == ["boundary_review"]


def test_years_become_months_and_cap():
    assert duration({"value": 5, "unit": "YEARS"}) == ({"value": 60, "unit": "MONTHS"}, None)
    assert duration({"value": 3, "unit": "weeks"}) == ({"value": 3, "unit": "WEEKS"}, None)
    assert duration({"value": 90, "unit": "YEARS"})[0] is None
    assert duration({"value": "5", "unit": "DAYS"}) == (None, None)
    a = art_of(comorbidities=[{"name": "Hypertension", "duration": {"value": 2, "unit": "YEARS"}, "basis": "said", "source_turns": [2]}])
    assert a["gp_extraction"]["comorbidities"][0]["duration"] == {"value": 24, "unit": "MONTHS"}


def test_speaker_and_source_on_provenance():
    a = art_of(prescription=[rx()])
    med = next(p for p in a["provenance"] if p["json_pointer"] == "/medicines/0")
    assert med["speaker"] == "doctor" and med["speaker_source"] == "role_track" and "speaker_uncertain" not in med["flags"]
    assert a["encounter"]["transcript"]["speaker_source"] == "role_track"


def test_surgery_advised_sets_the_flag_and_the_procedure_name():
    lines = [(0, 6, "0", "I advise laparoscopic cholecystectomy."), (7, 9, "1", "Alright.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[], procedures=[{
        "name": "laparoscopic cholecystectomy", "decision_turn": 0, "basis": "said", "source_turns": [0],
    }])
    pom = a["gp_extraction"]["plan_of_management"]
    assert pom["requires_surgery_or_procedure"] is True
    assert pom["surgery_or_procedure_recommendations"][0]["name"] == "laparoscopic cholecystectomy"
    assert pom["surgery_or_procedure_recommendations"][0]["raw_name"] == "laparoscopic cholecystectomy"


def test_surgery_is_recovered_when_stage_a_omits_it():
    lines = [(0, 8, "0", "I advise laparoscopic cholecystectomy next week.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[])
    rec = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"][0]
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    assert "cholecystectomy" in rec["name"].lower()


def test_surgery_word_alone_does_not_invent_a_procedure():
    lines = [(0, 4, "0", "I advise surgery.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[])
    rec = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"][0]
    assert rec["name"].lower() == "surgery"


def test_a_past_operation_is_not_advised_surgery():
    lines = [(0, 5, "1", "I had a cholecystectomy last year."), (6, 9, "0", "The throat is red.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [1]}])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True


def test_combination_brand_splits_into_components_and_keeps_the_brand():
    lines = [(0, 8, "0", "Take Augmentin 625 twice a day for five days.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[], prescription=[rx(
        generic=None, brand_as_said="Augmentin 625", strength="625 mg", frequency="twice a day", duration="5 days",
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    meds = a["gp_extraction"]["medicines"]
    assert [m["name"] for m in meds] == ["amoxicillin 500 mg", "clavulanic acid 125 mg"]
    assert all(m["raw_name"] == "Augmentin 625" and m["aliases"] == ["Augmentin 625"] for m in meds)
    assert "dose_unstated" not in kinds(a)


def test_telma_am_and_a_generic_plus_split_and_ascoril_stays_one():
    lines = [(0, 6, "0", "Take Telma-AM once a day.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[], prescription=[rx(
        generic=None, brand_as_said="Telma-AM", strength=None, frequency="once a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert [m["name"] for m in a["gp_extraction"]["medicines"]] == ["telmisartan", "amlodipine"]
    assert all(m["raw_name"] == "Telma-AM" for m in a["gp_extraction"]["medicines"])
    assert "dose_unstated" in kinds(a)
    lines = [(0, 6, "0", "Take amoxicillin and clavulanic acid twice a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="amoxicillin and clavulanic acid", brand_as_said=None, strength=None, frequency="twice a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert [m["name"] for m in a["gp_extraction"]["medicines"]] == ["amoxicillin", "clavulanic acid"]
    lines = [(0, 6, "0", "Take Ascoril 5 ml twice a day for five days.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic=None, brand_as_said="Ascoril", strength="5 ml", frequency="twice a day", duration="5 days",
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert [m["name"] for m in a["gp_extraction"]["medicines"]] == ["Ascoril 5 ml"]


def test_over_split_diagnosis_keeps_the_coarser_parent():
    a = art_of(diagnoses=[dx("Osteoarthritis of the right knee", "primary", True), dx("Osteoarthritis", "secondary", True)])
    labels = [d["diagnosis_or_impression"] for d in a["gp_extraction"]["presenting_complaints"]["diagnoses"]]
    assert labels == ["Osteoarthritis"]
    assert kept(a, "[diagnosis_merged]")
    a = art_of(diagnoses=[dx("Osteoarthritis", "primary", True), dx("Osteoarthritis of the right knee", "secondary", True)])
    labels = [d["diagnosis_or_impression"] for d in a["gp_extraction"]["presenting_complaints"]["diagnoses"]]
    assert labels == ["Osteoarthritis"]


def test_unspoken_routine_panel_is_dropped_and_a_spoken_one_stays():
    a = art_of(investigations=[{"name": "CBC", "order_status": "ordered", "basis": "said", "decision_turn": 4, "source_turns": [4]}])
    assert "further_investigations" not in a["gp_extraction"]
    assert kept(a, "[routine_not_spoken]")
    lines = LINES + [(41, 45, "0", "Get a CBC today.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, investigations=[{"name": "CBC", "order_status": "ordered", "basis": "said", "decision_turn": 7, "source_turns": [7]}])
    assert a["gp_extraction"]["further_investigations"][0]["name"] == "CBC"


def test_spoken_regimen_is_carried_and_a_missing_one_is_completion_required():
    lines = [(0, 8, "0", "Take telmisartan twice a day for five days.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[], prescription=[rx(
        generic="telmisartan", brand_as_said=None, strength=None, frequency="BD", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    m = a["gp_extraction"]["medicines"][0]
    assert m["frequency"] == "twice a day" and m["duration"] == "for five days"
    dose = [c for c in a["completion_required"] if c["kind"] == "dose_unstated"]
    assert len(dose) == 1 and dose[0]["prompt"] == "Enter strength for telmisartan"
    lines = [(0, 4, "0", "Take telmisartan.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="telmisartan", brand_as_said=None, strength=None, frequency=None, duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    dose = [c for c in a["completion_required"] if c["kind"] == "dose_unstated"]
    assert len(dose) == 1 and "strength, frequency, duration" in dose[0]["prompt"]


def test_stage_a_prompt_names_surgery_combinations_and_routine_panels():
    from pathlib import Path
    text = Path("tools/eta2freescript/prompts/stageA-v2.md").read_text()
    assert "procedures" in text and "components" in text and "routine panel" in text
    assert "verbatim" in text and "coarser parent" in text


def test_dose_precedence_flag_and_raw_name():
    lines = [(0, 3, "1", "I took Dolo 650."), (4, 9, "0", "Take paracetamol 1 g three times a day for three days.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[], prescription=[rx(decision_turn=1, source_turns=[0, 1], brand_as_said="Dolo 650", strength="650 mg",
                                                     frequency="three times a day", duration="3 days")])
    m = a["gp_extraction"]["medicines"][0]
    assert m["name"] == "paracetamol 1 g" and m["raw_name"] == "paracetamol" and "aliases" not in m
    p = next(x for x in a["provenance"] if x["json_pointer"] == "/medicines/0")
    assert "doctor_dose_precedence" in p["flags"]
