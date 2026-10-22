"""Clinician re-score of a8a5920. Synthetic fixtures only: no patient identifiers."""
from conftest import build_artifact, mk_consult

from tools.eta2freescript.boundary import Boundary
from tools.eta2freescript.recover import soften_f2_m3
from tools.eta2freescript.validate import check, frx

from test_mapper import DOC, art_of, rx

PT = {"0": "doctor", "1": "patient"}


def names(art):
    return [m["name"].lower() for m in art["gp_extraction"].get("medicines") or []]


def test_garbled_history_is_not_released_with_a_guessed_strength():
    lines = [(0, 4, "1", "I was taking Atolip A."), (5, 9, "0", "Continue the diet.")]
    a = art_of(c=mk_consult(lines, roles=PT), examination=[], prescription=[rx(
        generic="Atolip A", brand_as_said="Atolip A", strength="10 mg", frequency=None, duration=None,
        decision_turn=1, source_quote_turn=0, source_turns=[0, 1])])
    blob = " ".join(m["name"] for m in a["gp_extraction"].get("medicines") or [])
    assert "atol" not in blob.lower() and "ator" not in blob.lower()
    assert "10" not in blob
    assert not any("10" in str(s.get("strength")) for s in a["slots"])


def test_a_patient_history_drug_is_not_a_new_prescription():
    lines = [(0, 4, "1", "I take Telma 40."), (5, 9, "0", "Your blood pressure is fine.")]
    a = art_of(c=mk_consult(lines, roles=PT), examination=[], prescription=[rx(
        generic="Telma 40", brand_as_said=None, strength="40 mg", frequency="once a day", duration=None,
        decision_turn=1, source_quote_turn=0, source_turns=[0, 1])])
    assert "telma" not in " ".join(names(a))


def test_surgery_flag_skips_ift_and_microscopy_and_still_finds_a_biopsy():
    lines = [(0, 8, "0", "Start IFT and send the sample for microscopy. I advise a skin biopsy.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[
        {"name": "IFT", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
        {"name": "Microscopy", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
    ])
    recs = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"]
    assert [r["name"].lower() for r in recs] == ["biopsy"]
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    lines = [(0, 6, "0", "Interferential therapy and urine microscopy only.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[
        {"name": "interferential therapy", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
        {"name": "microscopy", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
    ])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True


def test_a_second_advised_procedure_is_not_dropped():
    lines = [(0, 8, "0", "We will do an endoscopy. I advise septoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[
        {"name": "Endoscopy", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
    ])
    got = {r["name"].lower() for r in a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"]}
    assert "endoscopy" in got and "septoplasty" in got


def test_conditional_procedure_failure_keeps_the_rest_of_the_visit():
    lines = [
        (0, 4, "0", "Get a chest X-ray."),
        (5, 9, "0", "Drink water."),
        (10, 14, "0", "If it is not better we will do an endoscopy."),
        (15, 19, "0", "Come back after one week."),
    ]
    c = mk_consult(lines, roles=DOC)
    a = build_artifact(c, __import__("conftest").empty_encounter(
        examination=[],
        investigations=[{"name": "Chest X-ray", "order_status": "ordered", "basis": "said", "decision_turn": 0, "source_turns": [0]}],
        advice=[{"text": "Drink water", "basis": "said", "source_turns": [1]}],
        follow_up={"interval": {"value": 1, "unit": "WEEKS"}, "basis": "said", "source_turns": [3]},
        procedures=[{"name": "Endoscopy", "raw_name": "endoscopy", "advised_kind": "conditional",
                     "notes": "if not better", "basis": "said", "decision_turn": 2, "source_turns": [2]}],
    ))
    assert check(a) == []
    proc = next(p for p in a["provenance"] if p.get("kind") == "procedure" and p.get("status") == "conditional")
    proc["json_pointer"] = "/plan_of_management/surgery_or_procedure_recommendations/0"
    pom = a["gp_extraction"]["plan_of_management"]
    pom["management_plan"] = pom.get("management_plan", "").replace(proc["text"], "").strip()
    a["completion_required"] = [c for c in a["completion_required"] if c.get("kind") != "surgery_confirm"]
    assert any(e.startswith("FRX-PR2") for e in frx(a))
    assert soften_f2_m3(a)
    assert check(a) == []
    assert a["gp_extraction"]["further_investigations"][0]["name"] == "Chest X-ray"
    assert "Drink water" in a["gp_extraction"]["general_advice"]
    assert a["gp_extraction"]["follow_up"]["followup_date"]
    assert any(c["kind"] == "surgery_confirm" for c in a["completion_required"])
    assert proc["json_pointer"] is None


def test_a_crosstalk_referral_is_dropped_and_this_patients_referral_stays():
    lines = [(0, 6, "0", "I am referring you to ENT.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], referrals=[
        {"to": "ENT", "basis": "said", "for_this_patient": True, "source_turns": [0]},
    ])
    assert a["gp_extraction"]["referrals"][0]["speciality"] == "ENT"
    lines = [(0, 4, "0", "Your throat is red."), (5, 9, "2", "Refer him to cardiology.")]
    b = Boundary()
    b.add("other consult", [1])
    c = mk_consult(lines, roles={"0": "doctor", "2": "attendant"})
    art = build_artifact(c, __import__("conftest").empty_encounter(
        examination=[],
        referrals=[{"to": "Cardiology", "basis": "said", "for_this_patient": True, "source_turns": [1]}],
    ), b)
    assert "referrals" not in art["gp_extraction"]
    assert check(art) == []
    lines = [(0, 6, "0", "The blood pressure is fine.")]
    art = art_of(c=mk_consult(lines, roles=DOC), examination=[], referrals=[
        {"to": "Cardiology", "basis": "said", "for_this_patient": True, "source_turns": [0]},
    ])
    assert "referrals" not in art["gp_extraction"]
