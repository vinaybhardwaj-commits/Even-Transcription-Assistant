"""FRX-V10: each test pins one line of FRX-T1, the vetoes or the slot bounds that a mutant (build report) could otherwise remove unseen."""
import datetime as dt

from conftest import mk_consult
from tools.eta2freescript.v10.gate import NumberGate
from test_v10_core import VISIT, gate, slots, vetoed


def _posted(g=None):
    g = g or gate()
    r = g.check("Fever since 3 days", "symptoms", [1])
    txt, pos, errs = g.writeback(r.text)
    assert not errs
    return g, txt, pos


def test_t1_a_changed_slot_text_is_a_frame_violation():
    g, txt, pos = _posted()
    v = g.final_check(txt.replace("3 days", "4 days"), "symptoms", pos)
    assert v and v[0].code == "frame" and "changed" in v[0].detail


def test_t1_a_slot_not_allowed_in_the_field_names_the_field():
    g, txt, pos = _posted()
    v = g.final_check(txt, "advice", pos)
    assert v[0].code == "frame" and "not allowed in advice" in v[0].detail


def test_t1_vetoes_run_on_the_posted_text():
    g, txt, pos = _posted()
    v = g.final_check(txt + " tablets daily", "symptoms", pos)
    assert any(x.code.startswith("veto") for x in v)


def test_t1_a_drug_token_outside_the_allowed_set_is_a_violation():
    g, txt, pos = _posted()
    far = txt + ", the patient is otherwise well and rested quietly in the clinic. Calpol"  # outside the 3-token window of the number
    assert any(x.code == "veto_detector" and x.detail == "Calpol" for x in g.final_check(far, "symptoms", pos, allowed_drug_tokens=set()))
    assert not g.final_check(far, "symptoms", pos, allowed_drug_tokens={"calpol"})
    assert not any(x.code == "veto_detector" for x in g.final_check(txt, "symptoms", pos, allowed_drug_tokens=set()))


def test_veto_a_dose_unit_beside_a_number_is_refused():
    assert "veto_dosing_word" in vetoed("mg since 3 days", "symptoms")


def test_veto_a_multi_word_dosing_phrase_is_refused_though_each_word_is_plain():
    assert "veto_dosing_word" in vetoed("alternate day since 3 days", "symptoms")


def test_bound_a_calendar_date_must_lie_between_the_visit_and_two_years_on():
    assert slots("review on 28 November 2026", "follow_up")
    assert not slots("review on 28 November 2031", "follow_up")
    assert not slots("review on 1 January 2020", "follow_up")


def test_support_a_drug_span_turn_never_supports_a_number():
    lines = [(0, 4, "0", "Tell me."), (5, 9, "1", "I have fever since three days."), (30, 34, "0", "Review after two weeks.")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient"})
    assert NumberGate(c, visit=VISIT).check("Review after 2 weeks", "follow_up", [2]).ok
    g = NumberGate(c, visit=VISIT, drug_spans={2})
    assert g.check("Review after 2 weeks", "follow_up", [2]).reason == "veto_detector"
    assert g.check_structured("followup", 2.0, "weeks", "follow_up", [2]) == "veto_detector"
    assert g.check_date("2026-10-30", "follow_up", [2]) in ("frame", "veto_detector")


def test_support_an_order_field_needs_an_order_capable_turn_in_every_support_path():
    g = gate()
    assert g.check_structured("followup", 2.0, "weeks", "follow_up", [3]) is None
    assert g.check_structured("followup", 2.0, "weeks", "follow_up", [1]) == "frame"
    assert g.check("Review after 2 weeks", "follow_up", [1]).reason == "frame"


def test_bound_a_date_without_a_year_is_the_next_one_on_or_after_the_visit():
    from tools.eta2freescript.v10.slots import Ctx, find_slots
    d = find_slots("review on 5 October", Ctx(visit=VISIT), "follow_up")[0].meta["date"]
    assert d == "2027-10-05"  # 5 October 2026 is before the visit (22 Oct 2026)
    assert find_slots("review on 28 October", Ctx(visit=VISIT), "follow_up")[0].meta["date"] == "2026-10-28"


def test_support_a_non_doctor_saying_the_same_thing_never_supports_an_order_number():
    lines = [(0, 4, "0", "Tell me."), (5, 9, "1", "Review after two weeks."), (30, 34, "0", "Review after two weeks.")]
    g = NumberGate(mk_consult(lines, roles={"0": "doctor", "1": "patient"}), visit=VISIT)
    assert g.check("Review after 2 weeks", "follow_up", [1]).reason == "frame"
    assert g.check("Review after 2 weeks", "follow_up", [2]).ok
    assert g.check_structured("followup", 2.0, "weeks", "follow_up", [1]) == "frame"
    assert g.check_structured("followup", 2.0, "weeks", "follow_up", [2]) is None
    assert g.check_date("2026-11-05", "follow_up", [1]) == "frame"
