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


def test_dose_precedence_flag_and_raw_name():
    lines = [(0, 3, "1", "I took Dolo 650."), (4, 9, "0", "Take paracetamol 1 g three times a day for three days.")]
    c = mk_consult(lines, roles=DOC)
    a = art_of(c=c, examination=[], prescription=[rx(decision_turn=1, source_turns=[0, 1], brand_as_said="Dolo 650", strength="650 mg",
                                                     frequency="three times a day", duration="3 days")])
    m = a["gp_extraction"]["medicines"][0]
    assert m["name"] == "paracetamol 1 g" and m["raw_name"] == "paracetamol" and "aliases" not in m
    p = next(x for x in a["provenance"] if x["json_pointer"] == "/medicines/0")
    assert "doctor_dose_precedence" in p["flags"]
