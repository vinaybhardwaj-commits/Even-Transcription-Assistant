"""Whole-visit keep, dose-change, and clinician re-score fixes. Synthetic fixtures only."""
from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.medication_safety import catalogue_hit, is_dose_change
from tools.eta2freescript.recover import recover_medicine_rules
from tools.eta2freescript.validate import check

from test_mapper import DOC, art_of, rx


def names(art):
    return [m["name"].lower() for m in art["gp_extraction"].get("medicines") or []]


def test_same_strength_stop_and_list_blanks_that_medicine_only():
    lines = [
        (0, 6, "0", "Stop paracetamol."),
        (7, 14, "0", "Take paracetamol 500 mg twice a day for three days."),
        (15, 20, "0", "Get a chest X-ray."),
        (21, 26, "0", "Drink water."),
        (27, 32, "0", "Come back after one week."),
    ]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(action="stop", generic="paracetamol", strength=None, frequency=None, duration=None,
           decision_turn=0, source_turns=[0]),
        rx(decision_turn=1, source_turns=[1], source_quote_turn=1),
    ], investigations=[{
        "name": "Chest X-ray", "order_status": "ordered", "basis": "said", "decision_turn": 2, "source_turns": [2],
    }], advice=[{"text": "Drink water", "basis": "said", "source_turns": [3]}], follow_up={
        "interval": {"value": 1, "unit": "WEEKS"}, "basis": "said", "source_turns": [4],
    })
    assert "paracetamol" not in " ".join(names(a))
    assert a["gp_extraction"]["further_investigations"][0]["name"] == "Chest X-ray"
    assert "Drink water" in a["gp_extraction"]["general_advice"]
    assert a["gp_extraction"]["follow_up"]["followup_date"]


def test_surgery_negation_and_a_scan_conditional_do_not_confirm():
    lines = [(0, 6, "0", "No surgery.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "surgery", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
    }])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True
    lines = [(0, 6, "0", "Surgery is not needed.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "surgery", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
    }])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True
    lines = [(0, 8, "0", "No surgery. I advise rhinoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[
        {"name": "surgery", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
        {"name": "rhinoplasty", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
    ])
    recs = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"]
    assert [r["name"].lower() for r in recs] == ["rhinoplasty"]
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    lines = [(0, 8, "0", "EVLT if the Doppler shows reflux.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "EVLT", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
        "notes": "if the Doppler shows reflux",
    }])
    pom = a["gp_extraction"]["plan_of_management"]
    assert pom.get("requires_surgery_or_procedure") is not True
    assert "surgery_or_procedure_recommendations" not in pom
    assert any(c["kind"] == "surgery_confirm" for c in a["completion_required"])
    lines = [(0, 6, "0", "I advise rhinoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[])
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    lines = [(0, 6, "0", "I do not advise rhinoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "rhinoplasty", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
    }])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True


def _visit():
    lines = [
        (0, 8, "0", "Take paracetamol 500 mg twice a day for three days."),
        (9, 16, "0", "Take telmisartan 40 mg once a day."),
        (17, 22, "0", "Get a chest X-ray."),
        (23, 28, "0", "Drink water."),
        (29, 34, "0", "Come back after one week."),
    ]
    return art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(decision_turn=0, source_turns=[0]),
        rx(generic="telmisartan", brand_as_said=None, strength="40 mg", frequency="once a day", duration=None,
           decision_turn=1, source_turns=[1]),
    ], investigations=[{
        "name": "Chest X-ray", "order_status": "ordered", "basis": "said", "decision_turn": 2, "source_turns": [2],
    }], advice=[{"text": "Drink water", "basis": "said", "source_turns": [3]}], follow_up={
        "interval": {"value": 1, "unit": "WEEKS"}, "basis": "said", "source_turns": [4],
    })


def test_a_schema_error_still_rejects_the_artefact():
    a = _visit()
    before = list(names(a))
    a["schema_version"] = "eta.freescript.v9"
    recover_medicine_rules(a)
    assert names(a) == before
    errs = check(a)
    assert errs and any(e.startswith("schema") or "schema_version" in e or e.startswith("FRX-E1") for e in errs)
    b = _visit()
    b["slots"] = [{"not": "a slot"}]
    recover_medicine_rules(b)
    assert names(b) == before
    assert check(b)

