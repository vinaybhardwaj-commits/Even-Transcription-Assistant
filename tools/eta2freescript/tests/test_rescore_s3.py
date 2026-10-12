"""Clinician re-score of a8a5920. Synthetic fixtures only: no patient identifiers."""
from conftest import build_artifact, mk_consult

from tools.eta2freescript.boundary import Boundary
from tools.eta2freescript.recover import soften_f2_m3
from tools.eta2freescript.validate import check, frx

from test_mapper import DOC, art_of, rx

PT = {"0": "doctor", "1": "patient"}


def names(art):
    return [m["name"].lower() for m in art["gp_extraction"].get("medicines") or []]


def test_glycomet_trio_uses_catalogue_composition_not_the_model_guess():
    lines = [(0, 8, "0", "Start Glycomet Trio 2 once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="pioglitazone", brand_as_said="Glycomet Trio 2", strength=None, frequency="once a day", duration=None,
        components=[{"generic": "metformin"}, {"generic": "glimepiride"}, {"generic": "pioglitazone"}],
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert names(a) == ["metformin", "glimepiride", "voglibose"]
    assert all(m["raw_name"] == "Glycomet Trio 2" for m in a["gp_extraction"]["medicines"])
    assert "pioglitazone" not in names(a)


def test_combination_without_a_catalogue_composition_stays_the_brand():
    lines = [(0, 6, "0", "Take Ascoril 5 ml twice a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic=None, brand_as_said="Ascoril", strength="5 ml", frequency="twice a day", duration=None,
        components=[{"generic": "pioglitazone"}, {"generic": "metformin"}],
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert len(a["gp_extraction"]["medicines"]) == 1
    assert "ascoril" in names(a)[0]
    assert "pioglitazone" not in names(a)


def test_duonase_is_not_reduced_to_one_component():
    lines = [(0, 6, "0", "Start Duonase nasal spray twice a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="fluticasone", brand_as_said="Duonase", strength=None, frequency="twice a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert names(a) == ["azelastine", "fluticasone"]
    assert all("Duonase" in (m.get("aliases") or []) or m["raw_name"] == "Duonase" for m in a["gp_extraction"]["medicines"])


def test_a_combination_and_its_component_list_the_molecule_once():
    lines = [(0, 8, "0", "Start Glycomet Trio 2 once a day and continue metformin.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(generic=None, brand_as_said="Glycomet Trio 2", strength=None, frequency="once a day", duration=None,
           decision_turn=0, source_quote_turn=0, source_turns=[0]),
        rx(generic="metformin", brand_as_said=None, strength=None, frequency="once a day", duration=None,
           decision_turn=0, source_quote_turn=0, source_turns=[0]),
    ])
    assert names(a).count("metformin") == 1
    assert "glimepiride" in names(a) and "voglibose" in names(a)


def test_spoken_bd_is_not_rewritten_as_before_breakfast():
    lines = [(0, 8, "0", "Take telmisartan BD. Paracetamol before breakfast.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="telmisartan", brand_as_said=None, strength=None, frequency="before breakfast", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    med = next(m for m in a["gp_extraction"]["medicines"] if m["name"].lower().startswith("telmisartan"))
    assert med.get("frequency", "").lower() == "bd"
    assert "breakfast" not in med.get("frequency", "").lower()
    assert "breakfast" not in med.get("instructions", "").lower()


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


def test_mounjaro_telma_and_daflon_resolve_without_an_invented_strength():
    cases = [
        ("Start Mounjaro once a week.", "tirzepatide", "Mounjaro", "once a week"),
        ("Start Daflon one tablet twice a day.", "diosmin", "Daflon", None),
    ]
    for line, generic, brand, freq in cases:
        lines = [(0, 8, "0", line)]
        a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
            generic=generic, brand_as_said=brand, strength="10 mg", frequency=freq, duration=None,
            decision_turn=0, source_quote_turn=0, source_turns=[0])])
        med = a["gp_extraction"]["medicines"][0]
        assert med["name"].lower().startswith(brand.split()[0].lower())
        assert "10" not in med["name"]
        assert "unresolved_name" not in (a["slots"][0]["flags"] if a["slots"] else [])
    lines = [(0, 8, "0", "Take Telma 40 once a day.")]
    held = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="olmesartan", brand_as_said="Telma 40", strength="10 mg", frequency=None, duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert "medicines" not in held["gp_extraction"]
    assert any("dose_binding_conflict" in (s.get("flags") or []) for s in held["slots"])
    listed = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="olmesartan", brand_as_said="Telma 40", strength=None, frequency="once a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    assert listed["gp_extraction"]["medicines"][0]["name"].lower().startswith("telma 40")


def test_unresolved_model_name_releases_when_the_doctor_said_the_catalogue_brand():
    lines = [(0, 8, "0", "Start Mounjaro once a week.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="tirzepatide", brand_as_said=None, strength="2.5 mg", frequency=None, duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    med = a["gp_extraction"]["medicines"][0]
    assert med["name"].lower().startswith("mounjaro")
    assert "2.5" not in med["name"] and "10" not in med["name"]


def test_regimen_does_not_bleed_across_drugs():
    lines = [(0, 10, "0", "Start rivaroxaban once a day. Paracetamol only if pain.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(generic="rivaroxaban", brand_as_said=None, strength=None, frequency="once a day", duration=None,
           instructions="only if pain", decision_turn=0, source_quote_turn=0, source_turns=[0]),
        rx(generic="paracetamol", brand_as_said=None, strength=None, frequency=None, duration=None,
           instructions="only if pain", decision_turn=0, source_quote_turn=0, source_turns=[0]),
    ])
    riva = next(m for m in a["gp_extraction"]["medicines"] if m["name"].lower().startswith("rivaroxaban"))
    para = next(m for m in a["gp_extraction"]["medicines"] if m["name"].lower().startswith("paracetamol"))
    assert "pain" not in (riva.get("instructions") or "").lower()
    assert "pain" not in (riva.get("frequency") or "").lower()
    assert "pain" in (para.get("instructions") or "").lower()
    lines = [(0, 10, "0", "Start Mounjaro once a week. Paracetamol SOS.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Mounjaro", brand_as_said=None, strength=None, frequency="SOS", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0])])
    med = a["gp_extraction"]["medicines"][0]
    assert med.get("frequency", "").lower() != "sos"
    assert "week" in med.get("frequency", "").lower()


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
