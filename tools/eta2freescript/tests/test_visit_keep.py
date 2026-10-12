"""Whole-visit keep, dose-change, and clinician re-score fixes. Synthetic fixtures only."""
from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.medication_safety import catalogue_hit, is_dose_change
from tools.eta2freescript.recover import recover_medicine_rules
from tools.eta2freescript.validate import check

from test_mapper import DOC, art_of, rx


def names(art):
    return [m["name"].lower() for m in art["gp_extraction"].get("medicines") or []]


def test_dose_change_lists_the_new_strength():
    assert is_dose_change(["Telma 20", "Stop Telma 20"], ["Telma 40"])
    assert not is_dose_change(["Telma 20"], ["Telma 20"])
    assert not is_dose_change(["Telma AM"], ["Telma 20"])
    lines = [(0, 8, "0", "Stop Telma 20 and start Telma 40 once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(action="stop", generic="Telma 20", brand_as_said="Telma 20", strength=None,
           frequency=None, duration=None, decision_turn=0, source_turns=[0]),
        rx(generic="Telma 40", brand_as_said="Telma 40", strength=None, frequency="once a day",
           duration=None, decision_turn=0, source_turns=[0]),
    ])
    assert any("40" in n for n in names(a))
    assert not any(n.startswith("telma 20") for n in names(a))
    assert check(a) == []


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


def test_withdrawn_and_unchanged_drugs_are_not_new_prescriptions():
    lines = [(0, 6, "0", "We should stop paracetamol.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(decision_turn=0, source_turns=[0], frequency=None, duration=None, strength=None),
    ])
    assert "paracetamol" not in " ".join(names(a))
    lines = [(0, 6, "0", "I am not changing any medicine now.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(generic="telmisartan", brand_as_said=None, strength="40 mg", frequency="once a day", duration=None,
           decision_turn=0, source_turns=[0]),
    ])
    assert names(a) == []
    lines = [(0, 10, "0", "I am not changing any medicine now. Start telmisartan 40 mg once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(generic="telmisartan", brand_as_said=None, strength="40 mg", frequency="once a day", duration=None,
           decision_turn=0, source_turns=[0]),
    ])
    assert names(a) == ["telmisartan 40 mg"]


def test_brand_letters_do_not_become_a_molecule_or_a_form():
    assert catalogue_hit("potassium") is None
    assert catalogue_hit("Clinda K") is None
    assert catalogue_hit("Atolip") is None
    lines = [(0, 8, "0", "Apply Clinda K twice a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="potassium", brand_as_said="Clinda K", strength=None, dosage_form="topical", route="topical",
        frequency="twice a day", duration=None, decision_turn=0, source_turns=[0],
    )])
    assert names(a) == []
    assert "potassium" not in " ".join(names(a))
    blob = " ".join(
        str(m.get("instructions") or "") + str(m.get("name") or "")
        for m in a["gp_extraction"].get("medicines") or []
    ).lower()
    assert "topical" not in blob
    assert a["slots"] and "unresolved_name" in a["slots"][0]["flags"]
    assert "clinda 1" not in " ".join(names(a))


def test_regimen_stays_on_the_drug_that_was_started():
    lines = [(0, 10, "0", "Start Mounjaro once a week Paracetamol SOS")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="tirzepatide", brand_as_said=None, strength=None, frequency="SOS", duration=None,
        decision_turn=0, source_turns=[0],
    )])
    med = a["gp_extraction"]["medicines"][0]
    assert med["name"].lower().startswith("mounjaro")
    assert med.get("frequency", "").lower() != "sos"
    assert "week" in med.get("frequency", "").lower()


def test_brand_suffix_resolves_and_a_dose_conflict_stays_held():
    assert catalogue_hit("Silodal 4 mg")
    assert catalogue_hit("Uni Enzyme")
    assert catalogue_hit("Menopace Iso")
    lines = [(0, 8, "0", "Start Menopace Iso once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Menopace", brand_as_said="Menopace Iso", strength=None, frequency="once a day", duration=None,
        decision_turn=0, source_turns=[0],
    )])
    assert "iso" in names(a)[0]
    lines = [(0, 8, "0", "Take Uni Enzyme twice a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Uni Enzyme", brand_as_said=None, strength=None, frequency="twice a day", duration=None,
        decision_turn=0, source_turns=[0],
    )])
    assert names(a) and "enzyme" in names(a)[0]
    lines = [(0, 8, "0", "Take Silodal 4 mg once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Silodal 4 mg", brand_as_said=None, strength=None, frequency="once a day", duration=None,
        decision_turn=0, source_turns=[0],
    )])
    assert "silodal" in names(a)[0] and "4" in names(a)[0]
    lines = [(0, 8, "0", "Take Silodal 4 once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Silodal", brand_as_said="Silodal 4", strength="8 mg", frequency="once a day", duration=None,
        decision_turn=0, source_turns=[0],
    )])
    assert "silodal" not in " ".join(names(a))
    assert any("dose_binding_conflict" in (s.get("flags") or []) for s in a["slots"])


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
    lines = [(0, 8, "0", "No surgery. I advise septoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[
        {"name": "surgery", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
        {"name": "septoplasty", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered"},
    ])
    recs = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"]
    assert [r["name"].lower() for r in recs] == ["septoplasty"]
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
    lines = [(0, 6, "0", "I advise septoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[])
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    lines = [(0, 6, "0", "I do not advise septoplasty.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "septoplasty", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
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


def test_one_unresolved_medicine_becomes_a_slot_and_the_visit_stays():
    a = _visit()
    a["gp_extraction"]["medicines"][0]["name"] = "Zzyzx 1 g"
    a["gp_extraction"]["medicines"][0]["raw_name"] = "Zzyzx 1 g"
    assert recover_medicine_rules(a)
    assert names(a) == ["telmisartan 40 mg"]
    assert a["gp_extraction"]["further_investigations"][0]["name"] == "Chest X-ray"
    assert "Drink water" in a["gp_extraction"]["general_advice"]
    slots = [s for s in a["slots"] if "unresolved_name" in (s.get("flags") or [])]
    assert len(slots) == 1
    assert sum(c["kind"] == "pick_drug" and c["item_id"] == slots[0]["slot_id"] for c in a["completion_required"]) == 1
    assert check(a) == []


def test_an_unresolved_alias_blanks_only_that_row():
    a = _visit()
    a["gp_extraction"]["medicines"][0]["aliases"] = ["Zzyzx"]
    recover_medicine_rules(a)
    assert names(a) == ["telmisartan 40 mg"]
    assert any("unresolved_name" in (s.get("flags") or []) for s in a["slots"])
    assert check(a) == []


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


def test_a_stale_medication_line_is_rerendered():
    a = _visit()
    before = list(names(a))
    lines = a["note_text"].split("\n")
    idx = next(i for i, line in enumerate(lines) if line.startswith("Medication:"))
    lines.insert(idx + 1, "extra tablet once a day")
    a["note_text"] = "\n".join(lines)
    assert any(e.startswith("G6 ") for e in check(a))
    recover_medicine_rules(a)
    assert names(a) == before
    assert check(a) == []
