"""FRX-V10: span registry, number detector, slot grammar, vetoes, drug detector, gate (spec rules 1-28)."""
import datetime as dt

import pytest

from conftest import mk_consult
from tools.eta2freescript.v10 import drugs, spans, vetoes
from tools.eta2freescript.v10.gate import NumberGate
from tools.eta2freescript.v10.numbers import find_numbers, norm
from tools.eta2freescript.v10.slots import Ctx, find_slots

VISIT = dt.date(2026, 10, 22)


def slots(t, field=None):
    return [(s.kind, norm(t)[s.start:s.end]) for s in find_slots(t, Ctx(visit=VISIT), field)]


def vetoed(t, field=None):
    t = norm(t)
    sl = find_slots(t, Ctx(visit=VISIT), field)
    return {v.code for s in sl for v in vetoes.window_vetoes(t, (s.nums[0][0], s.nums[-1][1]), sl)}


# --- spans -------------------------------------------------------------------------------------------------------------------
def test_span_ids_and_citation_rewrite():
    assert spans.span_index("s12") == 12 and spans.span_index(3) == 3 and spans.span_index(True) is None and spans.span_index("x") is None
    enc = {"advice": [{"source_turns": ["s3", 4, "bad"]}], "prescription": [{"decision_turn": "s2", "strength_turn": "S5"}]}
    out = spans.cite_to_turns(enc)
    assert out["advice"][0]["source_turns"] == [3, 4, "bad"] and out["prescription"][0]["decision_turn"] == 2 and out["prescription"][0]["strength_turn"] == 5


def test_order_capable_is_the_role_track_doctor_label_only():
    lines = [(0, 3, "0", "hello"), (4, 6, "1", "fever"), (7, 9, "2", "second doctor")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "doctor"})
    reg = spans.registry(c)
    assert [s["order_capable"] for s in reg["spans"]] == [True, False, True]
    assert all(r["second_doctor"] for r in reg["roster"] if r["order_capable"])
    assert reg["spans"][0]["span_id"] == "s0" and reg["spans"][0]["span_source"] == "none"
    c2 = mk_consult(lines, roles={"0": "doctor"}, role_track=False)  # model-inferred roles never order (D7)
    assert not any(s["order_capable"] for s in spans.registry(c2)["spans"])
    c3 = mk_consult(lines, roles={"1": "patient"})
    assert not spans.any_order_capable(c3)


# --- detector ----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text,n", [("BP 130/80", 2), ("Dolo650 SOS", 1), ("five hundred mg", 1), ("paanch sau", 1), ("a gram of x", 1), ("fivehundred", 1),
                                    ("½ tablet", 1), ("Calpol ६५०", 1), ("Patient sat down", 1), ("B12 and HbA1c and T4 and L4-L5 and COVID-19", 0),
                                    ("I do nothing", 0), ("do sau", 1), ("double vision", 0)])
def test_number_detector(text, n):
    assert len(find_numbers(text)) == n


# --- slots -------------------------------------------------------------------------------------------------------------------
def test_slot_table_frames_post():
    assert slots("BP 130/80 mmHg, pulse 84, SpO2 98%, temp 100.2 F", "examination") == [
        ("vital", "130/80 mmHg"), ("vital", "84"), ("vital", "98%"), ("vital", "100.2 F")]
    assert slots("Hb 9.5 g/dL", "examination") == [("lab", "9.5 g/dL")]
    assert slots("review after two weeks", "follow_up") == [("followup", "two weeks")]
    assert slots("fever since 3 days", "symptoms") == [("illness", "3 days")]
    assert slots("rest for 3 days", "advice") == [("advice", "3 days")]
    assert slots("65 years old", "symptoms") and slots("age 40", "symptoms")
    assert slots("no lifting over 5 kg", "advice") and slots("Drink 8 glasses of water", "advice") and slots("walk 30 minutes daily", "advice")
    assert slots("Type 2 diabetes, stage 3, pain score 6 out of 10") == [("label", "2"), ("label", "3"), ("label", "6 out of 10")]
    assert slots("come on 15 November 2026", "follow_up")[0][0] == "date"


@pytest.mark.parametrize("text,field", [("Calpol 650 twice a day", "advice"), ("Hb 9 mg", "examination"), ("BP 300/80", "examination"), ("pulse 500", "examination"),
                                        ("sugar 210", "examination"), ("TSH 8", "examination"), ("TSH level 8", "examination"), ("INR 2.5", "examination"),
                                        ("Albumin 20%", "examination"), ("review after 400 days", "follow_up"), ("for 3 days", "advice"),
                                        ("review after 2 weeks", "plan"), ("BP 130/80", "advice"), ("come on 15 November 2029", "follow_up"),
                                        ("no lifting over 80 kg", "advice"), ("Drink 30 glasses of water", "advice"), ("Type 3 diabetes", "diagnoses")])
def test_out_of_frame_or_bounds_is_unslotted(text, field):
    t = norm(text)
    cover = [(s.start, s.end) for s in find_slots(t, Ctx(visit=VISIT), field)]
    assert any(not any(a <= n.start and n.end <= b for a, b in cover) for n in find_numbers(t))


def test_shadow_analytes_need_unit_and_result_word():
    assert slots("TSH came 8 mIU/L", "examination") and slots("B12 level 180 pg/mL", "examination") and slots("INR came 2.5", "examination")
    assert not slots("B12 180 pg/mL", "examination") and not slots("calcium level 9.2", "examination") and slots("calcium level 9.2 mg/dL", "examination")
    assert not slots("zinc 80 ug/dL", "examination") and not slots("albumin 20 %", "examination")


# --- vetoes ------------------------------------------------------------------------------------------------------------------
def test_vetoes():
    assert "veto_ood" in vetoed("Warf, since 5 days", "symptoms") and "veto_ood" in vetoed("Metolar since 2 days", "symptoms")
    assert "veto_dosing_word" in vetoed("BP medicine since 2 years", "symptoms")
    assert "veto_dosing_word" in vetoed("Review after 2 weeks, continue tablets", "follow_up")
    assert "veto_dosing_word" in vetoed("BP ki goli since 2 years", "symptoms")
    assert "veto_detector" in vetoed("Dolo since 2 days", "symptoms") or "veto_dosing_word" in vetoed("Dolo since 2 days", "symptoms")
    assert not vetoed("Hb 9.5 g/dL, creatinine 1.2 mg/dL", "examination") and not vetoed("fever since 3 days and cough", "symptoms")
    assert not vetoed("walk 30 minutes daily", "advice") and "veto_dosing_word" in vetoed("rest for 3 days daily", "advice")
    assert "veto_detector" in vetoed("calcium since 2 weeks", "symptoms") or "veto_dosing_word" in vetoed("calcium since 2 weeks", "symptoms")
    assert not vetoed("calcium level 9.2 mg/dL", "examination")  # rule 21: the analyte's catalogue hit is ignored inside a full lab frame


def test_drug_detector_arms():
    assert [f.reason for f in drugs.flags("Take Calpol")] == ["catalogue"]
    assert [f.reason for f in drugs.flags("Metfromin")] == ["fuzzy"]
    assert drugs.flags("I took Dart") and not drugs.flags("the dart game")
    assert drugs.flags("Pan 40 before food") and not drugs.flags("a pan of water")


# --- gate --------------------------------------------------------------------------------------------------------------------
def gate():
    lines = [(0, 4, "0", "Tell me."), (5, 9, "1", "I have fever since three days."), (10, 14, "0", "BP is 130 by 80, pulse 84."),
             (30, 34, "0", "Review after two weeks."), (60, 64, "0", "Take Warf 5 daily."), (80, 84, "0", "Hb is 9.5 g/dL")]
    return NumberGate(mk_consult(lines, roles={"0": "doctor", "1": "patient"}), visit=VISIT)


def test_gate_tokens_support_and_writeback():
    g = gate()
    r = g.check("Fever since 3 days", "symptoms", [1])
    assert r.ok and r.text == "Fever since ⟦S1⟧"
    assert g.writeback(r.text)[0] == "Fever since 3 days"
    assert g.check("BP 130/80 mmHg", "examination", [2]).ok
    assert g.check("Review after 2 weeks", "follow_up", [3]).ok
    assert g.check("Fever since 4 days", "symptoms", [1]).reason == "frame"          # the cited span says 3
    assert g.check("Review after 2 weeks", "follow_up", [1]).reason == "frame"       # the patient is not order-capable
    assert g.check("Warf 5 daily", "advice", [4]).reason == "unslotted"
    assert g.check("Hb 9.5 g/dL", "advice", [5]).reason in ("frame", "bounds")
    assert g.check("Hb 9.5 g/dL", "examination", [5]).ok
    assert g.check("no numbers here", "plan", [1]).text == "no numbers here"


def test_final_check_frx_t1():
    g = gate()
    r = g.check("Fever since 3 days", "symptoms", [1])
    txt, pos, errs = g.writeback(r.text)
    assert not errs and g.final_check(txt, "symptoms", pos) == []
    assert g.final_check(txt + " and 500", "symptoms", pos)[0].code == "unslotted"            # a number at no slot
    assert g.final_check(txt, "advice", pos)[0].code == "frame"                              # slot not allowed in this field
    assert g.final_check("Medication: PARACETAMOL 500", None, [])[0].code == "unslotted"      # Medication holds no number
    assert g.writeback("x ⟦S99⟧")[2]
