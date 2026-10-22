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
    from tools.eta2freescript.validate import completion_rows
    for item in completion_rows(art):  # the heard detail lives in confirm_internal (Fix2 H2)
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


def test_a_held_drug_keeps_the_heard_name():
    lines = [(0, 8, "0", "Start Telma 40 once a day.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[], prescription=[rx(
        generic="olmesartan", brand_as_said="Telma 40", strength="10 mg", frequency="once a day", duration=None,
        decision_turn=0, source_quote_turn=0, source_turns=[0],
    )])
    visible = listed(a) + " " + slot_text(a)
    assert "telma 40" in visible
    assert "drug" not in slot_text(a).split()


def test_a_declined_operation_and_a_pap_smear_do_not_flag_and_rhinoplasty_advised_does():
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
    lines = [(0, 6, "0", "Rhinoplasty advised.")]
    a = art_of(c=mk_consult(lines, roles=DOC), examination=[])
    assert a["gp_extraction"]["plan_of_management"]["requires_surgery_or_procedure"] is True
    recs = a["gp_extraction"]["plan_of_management"]["surgery_or_procedure_recommendations"]
    assert recs[0]["name"].lower() == "rhinoplasty"
