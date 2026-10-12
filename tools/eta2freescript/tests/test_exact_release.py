"""Exact-or-alias release. Synthetic fixtures only: instruction words and truncated stems must not become drugs."""
from conftest import mk_consult

from tools.eta2freescript.medication_safety import catalogue_hit, instruction_only, norm_tokens

from test_mapper import DOC, art_of, rx


def names(art):
    return [m["name"].lower() for m in art["gp_extraction"].get("medicines") or []]


def listed(art):
    return " ".join(names(art))


def slot_text(art):
    bits = []
    for slot in art["slots"]:
        for field in ("form", "frequency", "duration", "timing", "class", "indication", "strength"):
            part = slot.get(field) if isinstance(slot.get(field), dict) else {}
            if part.get("text"):
                bits.append(str(part["text"]))
    for item in art["completion_required"]:
        if item.get("kind") == "pick_drug" and item.get("detail"):
            bits.append(str(item["detail"]))
    return " ".join(bits).lower()


def _alpha(text):
    return tuple(t for t in norm_tokens(text) if not t.isdigit())


def test_pause_is_not_tranexamic_acid():
    assert instruction_only("pause")
    assert catalogue_hit("pause") is None
    assert catalogue_hit("Pause 500") is None
    for word in ("stop", "continue", "start", "drug", "tablet", "syrup"):
        assert catalogue_hit(word) is None
    lines = [(0, 8, "0", "Pause the medicine for a week.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="tranexamic acid", brand_as_said="Pause", strength=None, frequency=None, duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    assert "tranexamic" not in listed(a)
    assert "pause" not in listed(a)
    assert "tranexamic" not in slot_text(a)


def test_daflon_is_not_truncated_to_daflo():
    hit = catalogue_hit("Daflon")
    assert hit and _alpha(hit) == ("daflon",)
    assert "deflazacort" not in hit.lower()
    assert catalogue_hit("Daflo") is None
    assert catalogue_hit("Daflo 6")
    lines = [(0, 8, "0", "Start Daflon one tablet twice a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="deflazacort", brand_as_said="Daflo", strength="6 mg", frequency="twice a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    assert any(n.startswith("daflon") for n in names(a))
    assert "deflazacort" not in listed(a)
    assert not any(n == "daflo" or n.startswith("daflo ") for n in names(a))


def test_prefix_and_one_token_short_do_not_release():
    assert catalogue_hit("Telvas 40") is None
    assert catalogue_hit("Silodal") is None
    assert catalogue_hit("Sompras") is None
    assert catalogue_hit("Atolip") is None
    lines = [(0, 8, "0", "Take Telvas 40 once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="telmisartan", brand_as_said="Telvas 40", strength=None, frequency="once a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    assert names(a) == []
    assert "telvas" in slot_text(a)
    assert "telvas h" not in slot_text(a)


def test_overheld_brands_resolve_by_exact_or_alias_only():
    for spoken, alpha in (
        ("Menopace Iso", ("menopace", "iso")),
        ("Silodal 4", ("silodal",)),
        ("Mounjaro", ("mounjaro",)),
        ("Sompraz", ("sompraz",)),
    ):
        hit = catalogue_hit(spoken)
        assert hit and _alpha(hit) == alpha
    lines = [(0, 8, "0", "Start Sompraz once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Sompraz", brand_as_said=None, strength=None, frequency="once a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    assert names(a)[0].startswith("sompraz")
    assert "sompraz d" not in names(a)[0]


def test_a_held_drug_keeps_the_heard_name():
    lines = [(0, 8, "0", "Start Telma 40 once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="olmesartan", brand_as_said="Telma 40", strength="10 mg", frequency="once a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    visible = listed(a) + " " + slot_text(a)
    assert "telma 40" in visible
    assert "drug" not in slot_text(a).split()


def test_combination_components_keep_the_spoken_schedule():
    for schedule in ("BD", "1-0-1"):
        lines = [(0, 8, "0", f"Start Glycomet Trio 2 {schedule}.")]
        a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
            generic=None, brand_as_said="Glycomet Trio 2", strength=None, frequency="after breakfast", duration=None,
            decision_turn=0, source_quote_turn=0, source_turns=[0],
        )])
        meds = a["gp_extraction"]["medicines"]
        assert [m["name"] for m in meds] == ["metformin", "glimepiride", "voglibose"]
        assert {m.get("frequency", "").lower() for m in meds} == {schedule.lower()}
        assert all("breakfast" not in (m.get("frequency") or "").lower() for m in meds)


def test_galvus_met_keeps_1_0_1():
    lines = [(0, 8, "0", "Take Galvus Met 1-0-1 after breakfast.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="Galvus Met", brand_as_said=None, strength=None, frequency="after breakfast", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    med = a["gp_extraction"]["medicines"][0]
    assert med["name"].lower().startswith("galvus met")
    assert med.get("frequency") == "1-0-1"
    assert "breakfast" not in med.get("frequency", "").lower()


def test_sos_stays_on_unienzyme_and_frequencies_stay_on_their_drugs():
    lines = [(0, 16, "0", "Start Mounjaro once a week and Unienzyme SOS. Ecosprin AV once a day. Ultra Magnesium BD.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[
        rx(generic="Mounjaro", brand_as_said=None, strength=None, frequency="SOS", duration=None,
           decision_turn=0, source_quote_turn=0, source_turns=[0]),
        rx(generic="Unienzyme", brand_as_said=None, strength=None, frequency=None, duration=None,
           decision_turn=0, source_quote_turn=0, source_turns=[0]),
        rx(generic="Ecosprin AV", brand_as_said=None, strength=None, frequency=None, duration=None,
           decision_turn=0, source_quote_turn=0, source_turns=[0]),
        rx(generic="Ultra Magnesium", brand_as_said=None, strength=None, frequency=None, duration=None,
           decision_turn=0, source_quote_turn=0, source_turns=[0]),
    ])
    meds = {m["name"].lower().split()[0]: m for m in a["gp_extraction"]["medicines"]}
    assert "sos" not in (meds["mounjaro"].get("frequency") or "").lower()
    assert "week" in (meds["mounjaro"].get("frequency") or "").lower()
    assert (meds["unienzyme"].get("frequency") or "").lower() == "sos"
    assert "day" in (meds["ecosprin"].get("frequency") or "").lower()
    assert (meds["ultra"].get("frequency") or "").lower() == "bd"


def test_a_declined_operation_and_a_pap_smear_do_not_flag_and_septoplasty_advised_does():
    lines = [(0, 6, "0", "The patient declined surgery.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "surgery", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
    }])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True
    lines = [(0, 6, "0", "Pap smear advised.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], procedures=[{
        "name": "Pap smear", "basis": "said", "decision_turn": 0, "source_turns": [0], "advised_kind": "ordered",
    }])
    assert a["gp_extraction"].get("plan_of_management", {}).get("requires_surgery_or_procedure") is not True
    lines = [(0, 6, "0", "Septoplasty advised.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[])
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    recs = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"]
    assert recs[0]["name"].lower() == "septoplasty"
