#!/usr/bin/env python3
"""Builds the mutant artifacts and tests/expected.tsv from the INVENTED examples. Deterministic.
Each mutant changes one thing. 'fail' rows name the V-rule whose failure line must appear; 'pass' rows are fair controls.
Usage: build_mutants.py [OUT_DIR]   (default: tests/mutants beside this file; expected.tsv goes to OUT_DIR/..)."""
import copy, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "examples"))
import build_examples as B  # noqa: E402
from validate_artifact import PLAN_LINE, render_note  # noqa: E402

BASE = {n: fn for n, fn in [("ex1", B.ex1), ("ex2", B.ex2), ("ex3", B.ex3), ("ex4", B.ex4), ("ex5", B.ex5), ("ex6", B.ex6), ("ex7", B.ex7)]}


def prov(a, iid):
    return next(p for p in a["provenance"] if p["item_id"] == iid)


def prompt(a, pid):
    return next(p for p in a["confirm_prompts"] if p["prompt_id"] == pid)


def span(a, sid):
    return next(s for s in a["spans"] if s["span_id"] == sid)


def note_sub(a, old, new):
    assert old in a["note_text"], old
    a["note_text"] = a["note_text"].replace(old, new, 1)


def set_gx_and_note(a, path, new):
    """Replace a posted string in gp_extraction and the same text in note_text."""
    cur = a["gp_extraction"]
    keys = path.strip("/").split("/")
    for k in keys[:-1]:
        cur = cur[k]
    old = cur[keys[-1]]
    cur[keys[-1]] = new
    note_sub(a, old, new)


def recount(a):
    pv = a["provenance"]
    a["qa"]["counts"].update(posted=sum(p["json_pointer"] is not None for p in pv), prompts=len(a["confirm_prompts"]),
                             withheld=sum(p["withheld_reason"] is not None for p in pv),
                             h_unattrib=sum(p["support"] == "h_unattrib" for p in pv),
                             unaligned=sum(p["alignment"] == "unaligned" for p in pv),
                             affirmed_from_patient=sum(p["support"] == "affirmed_from_patient" for p in pv))


def add_span(a, label, t0, t1, en):
    sid = "s%d" % (len(a["spans"]) + 1)
    src = a["spans"][0] if label == a["spans"][0]["label"] else next(s for s in a["spans"] if s["label"] == label)
    a["spans"].append(dict(src, span_id=sid, segment_refs=["MUT:%d" % len(a["spans"])], t0=B.ts(t0), t1=B.ts(t1), quote_native=en,
                           quote_en=en, lang="en", relay_of=None))
    a["spans"][-1].pop("segcheck", None)
    return sid


def add_investigation(a, name, raw, cited, iid, names=None, status="prescribed"):
    lst = a["gp_extraction"].setdefault("further_investigations", [])
    lst.append(dict(name=name, urgent=False, instruction="", raw_name=raw, aliases=[]))
    a["provenance"].append(dict(item_id=iid, kind="investigation", text=name, names=names or [name], status=status, negated=False,
                                support="supported", cited_spans=cited, alignment="aligned_code", span_source="both",
                                json_pointer="/further_investigations/%d" % (len(lst) - 1), prompt_id=None, withheld_reason=None, flags=[]))
    lines = a["note_text"].split("\n")
    i = next(k for k, l in enumerate(lines) if l.startswith("Follow up:"))
    if len(lst) == 1:
        j = next(k for k, l in enumerate(lines) if l.startswith("Further Investigation:"))
        lines[j] = "Further Investigation: " + name
    else:
        lines.insert(i, name)
    a["note_text"] = "\n".join(lines)
    recount(a)


def rerender(a):
    a["note_text"] = render_note(a)


def set_plan(a, text):
    a["gp_extraction"]["plan_of_management"]["management_plan"] = text
    rerender(a)


def set_gx(a, path, value):
    cur = a["gp_extraction"]
    keys = path.strip("/").split("/")
    for k in keys[:-1]:
        cur = cur[int(k)] if isinstance(cur, list) else cur[k]
    cur[keys[-1] if isinstance(cur, dict) else int(keys[-1])] = value
    rerender(a)


def add_word(a, text, mmss):
    """An advice instruction the treating doctor said: a span, a doctor_words entry and the advice text."""
    sid = add_span(a, "speaker_0", mmss, mmss[:3] + "%02d" % (int(mmss[3:]) + 3), text.lower().rstrip("."))
    a["doctor_words"].append(dict(instruction_id="dw%d" % (len(a["doctor_words"]) + 1), category="lifestyle", text_en=text,
                                  cited_spans=[sid], firmness="firm", final_position=True, superseded_by=None,
                                  emphasis_count=1, counselling=False))
    a["gp_extraction"]["general_advice"] += " " + text
    rerender(a)


def gate_off(a):
    a["qa"]["inputs"]["armc_gate"] = "off"
    for r in a["roster"]:
        r["armc"]["gate_flag"] = "off"


# ---- mutations (each returns nothing; mutates a) ----
def m_bad_unit(a): a["gp_extraction"]["comorbidities"][0]["duration"]["unit"] = "DECADES"
def m_hours_unit(a): a["gp_extraction"]["comorbidities"][0]["duration"] = dict(value=5, unit="HOURS"); rerender(a)
def m_ptr_unresolved(a): prov(a, "e1-cbc")["json_pointer"] = "/further_investigations/5"
def m_ptr_twice(a): prov(a, "e1-adv")["json_pointer"] = "/examination"
def m_prov_reversed(a): a["provenance"].reverse()
def m_drop_fbs(a): a["provenance"].remove(prov(a, "e3-fbs")); recount(a)
def m_drop_met(a): a["provenance"].remove(prov(a, "e3-met")); recount(a)
def m_counts(a): a["qa"]["counts"]["posted"] += 1


def m_xray_in_list(a):
    add_investigation(a, "Chest X-ray PA view", "chest X-ray", ["s8"], "e2-cxr-post", names=["Chest X-ray PA view"])


def m_unrelated_test(a):
    sid = add_span(a, "speaker_0", "03:57", "04:00", "get a throat swab done")
    add_investigation(a, "Throat swab", "throat swab", [sid], "e2-swab")


def m_dx_no_spans(a): prov(a, "e1-dx")["cited_spans"] = []
def m_keptout_no_spans(a): prov(a, "e1-com")["cited_spans"] = []; prov(a, "e1-com")["span_source"] = "none"
def m_bad_heading(a): note_sub(a, "\nFollow up:", "\nFollow-up:")
def m_heading_twice(a): note_sub(a, "\nGeneral Advice:", "\nRefer to:\nGeneral Advice:")
def m_extra_inv_line(a): note_sub(a, "\nFasting Blood Sugar\n", "\nFasting Blood Sugar\nLipid profile\n")
def m_med_line_order(a): note_sub(a, "PARACETAMOL (Dolo 650) — confirm", "PARACETAMOL (Dolo 650) 650 three times a day for three days")
def m_no_draft_line(a): note_sub(a, "Medication: Draft list, not a prescription; the treating doctor checks each drug.\n", "Medication: ")


def m_med_posted(a):
    a["gp_extraction"]["medicines"] = [dict(name="Paracetamol 650", frequency="TDS", duration="3 days", instructions="after food",
                                            raw_name="Dolo 650", aliases=["Dolo 650"])]
    prov(a, "e1-med")["json_pointer"] = "/medicines/0"
    recount(a)


def m_med_no_prompt(a): prov(a, "e3-glim")["prompt_id"] = None
def m_affirmed_dose(a): prompt(a, "p4")["attributes"]["strength"]["support"] = "supported"


def m_patient_freq(a):
    prompt(a, "p1")["attributes"]["frequency"] = dict(value="three times a day", cited_spans=["s3"], support="supported")


def m_translator_order(a):
    a["confirm_prompts"] = [p for p in a["confirm_prompts"] if p["prompt_id"] != "p2"]
    a["provenance"].remove(prov(a, "e4-scan"))
    add_investigation(a, "Kidney scan", "kidney scan", ["s11"], "e4-scan", names=["Kidney scan"])


def m_relay_with_doctor(a): prov(a, "e4-urine")["cited_spans"] = ["s5", "s7"]
def m_posted_unsupported(a): prov(a, "e5-dx")["support"] = "h_unattrib"; recount(a)


def m_stop_in_plan(a):
    set_gx_and_note(a, "/plan_of_management/management_plan", "Stop glimepiride. Recheck sugars. " + PLAN_LINE)


def m_split_spelling(a): set_gx_and_note(a, "/general_advice", "Don't skip meals. Glime piride is stopped.")
def m_brand_alias(a): set_gx_and_note(a, "/examination", "BP 128/82. Pulse 88. Random blood sugar 72 mg/dL. On Amaryl.")
def m_xray_in_plan(a): set_gx_and_note(a, "/plan_of_management/management_plan", "Symptomatic treatment. No chest X-ray. " + PLAN_LINE)
def m_lime_juice(a): add_word(a, "Lime juice is fine.", "05:10")
def m_plan_line_missing(a): set_gx_and_note(a, "/plan_of_management/management_plan", "Recheck sugars.")


RF = "If your breathing gets worse or your lips turn blue, go to the emergency department at once."


def m_rf_trimmed(a): set_gx_and_note(a, "/general_advice", "No steam for now, it can set off the wheeze. Avoid dust and smoke.")
def m_rf_not_first(a): set_gx_and_note(a, "/general_advice", "No steam for now, it can set off the wheeze. " + RF + " Avoid dust and smoke.")


EXTRA = ["Rest with the window open.", "Sleep with the head raised.", "Keep the window open.", "Walk slowly."]


def m_budget_over(a):
    for i, x in enumerate(EXTRA):
        add_word(a, x, "05:%02d" % (10 + 5 * i))


def m_budget_full(a):
    for i, x in enumerate(EXTRA[:3]):
        add_word(a, x, "05:%02d" % (10 + 5 * i))


def m_tbd(a): set_gx_and_note(a, "/follow_up/follow_up_instructions", "TBD")
def m_repr(a): set_gx_and_note(a, "/presenting_complaints/symptoms", "{'symptom': 'fever', 'duration': '2 days'}")
def m_frxn1(a): set_gx_and_note(a, "/examination", "Temperature 100.2 F. Doctor to check BP.")
def m_missing_only(a): set_gx_and_note(a, "/examination", "Not recorded")
def m_parens_ok(a): set_gx_and_note(a, "/examination", "Temperature 100.2 F (oral). Throat mildly congested. Chest clear.")
def m_span_outside(a): span(a, "s11")["t1"] = B.ts("16:00")
def m_span_unresolved(a): prov(a, "e1-cbc")["cited_spans"] = ["s99"]
def m_span_quarantined(a): span(a, "s9")["boundary_quarantined"] = True


def m_uncited_outside(a):
    sid = add_span(a, "speaker_0", "15:30", "15:40", "next patient please")
    assert sid


def m_two_capable(a):
    a["roster"][2]["order_capable"] = True


def m_gate_off_both(a): gate_off(a)


def m_gate_off_control(a):
    gate_off(a)
    for s in a["spans"]:
        if s["span_source"] == "both":
            s["span_source"] = "3of3"


def m_gate_off_armc_only(a):
    gate_off(a)
    a["roster"][0]["role_votes"]["jev"] = None
    a["roster"][0]["three_of_three"] = False
    for s in a["spans"]:
        if s["label"] == "speaker_0":
            s["span_source"] = "none"


def m_translator_capable(a):
    a["roster"][3]["order_capable"] = True
    for s in a["spans"]:
        if s["label"] == "speaker_3":
            s["order_capable"] = True


def m_conflict_ignored(a):
    a["roster"][1]["order_capable"] = True
    for s in a["spans"]:
        if s["label"] == "speaker_1":
            s["order_capable"] = True


def _redrug(a, pid, **kw):
    p = prompt(a, pid)
    p["drug"].update(kw)
    p["attributes"] = B.attrs()
    rerender(a)


def m_acid_reflux(a):
    _redrug(a, "p1", spoken="acid reflux tablet", brand_recognised=None, generic="FOLIC ACID", base_molecule="folic acid", strength_heard=None)


def m_folic_spoken(a):
    _redrug(a, "p1", spoken="folic acid tablet", brand_recognised=None, generic="FOLIC ACID", base_molecule="folic acid", strength_heard=None)


def m_lasa_unflagged(a):
    p = prompt(a, "p2")
    p["drug"]["lasa_risk"] = dict(pair_with=None, note="not on the curated LASA list")
    p["doctor_confirm_reason"].remove("lasa")


def _pand(a, **kw):
    span(a, "s5")["quote_en"] = span(a, "s5")["quote_native"] = "take Pan-D once a day before breakfast"
    p = prompt(a, "p1")
    p["attributes"] = B.attrs(frequency=B.att("once a day", ["s5"]), instruction=B.att("before breakfast", ["s5"]))
    p["drug"] = dict(spoken="Pan-D", brand_recognised="Pan-D", form="capsule", strength_heard=None,
                     lasa_risk=dict(pair_with="unresolved generic" if kw["generic"] is None else None, note="generic not resolved; confirm the molecule"), **kw)
    p["doctor_confirm_reason"] = ["notes_only", "combination_unexpanded", "lasa"] if kw["generic"] is None else ["notes_only"]
    prov(a, "e6-amc").update(names=["Pan-D"], flags=[])
    rerender(a)


def m_unattested_expanded(a):
    _pand(a, generic="PANTOPRAZOLE + DOMPERIDONE", components=["PANTOPRAZOLE", "DOMPERIDONE"], base_molecule="pantoprazole + domperidone")


def m_unattested_unexpanded(a): _pand(a, generic=None, components=[], base_molecule="pan")
def m_base_wrong(a): prompt(a, "p1")["drug"]["base_molecule"] = "cetirizine"
def m_withheld_note(a): a["note_text"] = BASE["ex1"]()["note_text"]
def m_withheld_no_reason(a): a["emission"]["reasons"] = []
def m_withheld_content(a): a["gp_extraction"]["examination"] = "Chest clear."
def m_full_no_note(a): del a["note_text"]
def m_models_empty(a): a["qa"]["models_served"] = []


def m_model_placeholder(a):
    a["generator"]["models"][0]["served_model_id"] = "unknown"
    a["qa"]["models_served"][0] = "unknown"


def m_models_mismatch(a): a["qa"]["models_served"] = a["qa"]["models_served"][:1]



# ---- fix round 1 adversarial suite: one or more per M and S item ----
PL = PLAN_LINE
def plan3(a, mid): set_plan(a, "Recheck sugars. " + mid + " " + PL)
def m1_dx(a): set_gx(a, "/presenting_complaints/diagnoses/0/diagnosis_or_impression", "Hypoglycaemia due to glimepiride")
def m1_raw(a): a["gp_extraction"]["presenting_complaints"]["diagnoses"][0]["raw_name"] = "low sugar from glimepiride"
def m1_exam(a): set_gx(a, "/examination", "Chest clear on auscultation. SpO2 98%. Better after levocetirizine.")
def m1_alias(a): a["gp_extraction"]["presenting_complaints"]["diagnoses"][0]["aliases"] = ["Viral fever", "Dolo fever"]
def m1_note_only(a): note_sub(a, "Throat mildly congested.", "Throat normal.")
def m1_inject(a): set_gx(a, "/presenting_complaints/symptoms", "Fever for 2 days.\nMedication: PARACETAMOL 650 three times a day")
def m1_condition(a): a["gp_extraction"]["comorbidities"][0]["aliases"].append("Insulin resistance")
def m1_on_drug(a): a["gp_extraction"]["comorbidities"][0]["aliases"].append("On metformin")
def m2_cyr(a): plan3(a, "Glіmepiride stopped.")
def m2_acc(a): plan3(a, "Glimépiride stopped.")
def m2_full(a): plan3(a, "ｇｌｉｍｅｐｉｒｉｄｅ stopped.")
def m2_zw(a): plan3(a, "Glim​epiride stopped.")
def m2_dots(a): plan3(a, "G.l.i.m.e.p.i.r.i.d.e stopped.")
def m2_hyph(a): plan3(a, "Glime-piride stopped.")
def m2_greek(a): plan3(a, "Glimεpiride stopped.")
def m2_nonascii(a): set_gx(a, "/examination", "Température 100.2 F. Throat mildly congested. Chest clear.")


def _pand_stop(a):
    p = prompt(a, "p1")
    p["drug"] = dict(spoken="Pan-D", brand_recognised="Pan-D", generic=None, components=[], base_molecule="pan d", form="capsule",
                     strength_heard=None, lasa_risk=dict(pair_with="unresolved generic", note="generic not resolved; confirm the molecule"))
    p["doctor_confirm_reason"] = ["notes_only", "stop_order", "combination_unexpanded", "lasa"]
    prov(a, "e3-glim").update(text="Pan-D", names=["Pan-D"])


def m3_dom(a): _pand_stop(a); plan3(a, "Domperidone stopped.")
def m3_panto(a): _pand_stop(a); plan3(a, "Pantoprazole stopped.")
def m3_ctrl(a): _pand_stop(a); rerender(a)


def m3_part(a):
    prompt(a, "p1")["action"] = "stop"
    a["gp_extraction"]["plan_of_management"] = dict(management_plan="Clavulanic acid stopped. " + PL, requires_surgery_or_procedure=False)
    a["provenance"].append(dict(prov(a, "e6-dx"), item_id="e6-plan", kind="management_plan", json_pointer="/plan_of_management/management_plan"))
    recount(a)
    rerender(a)


def m4_no_entry(a): a["red_flags"] = []
def m4_flag(a): a["doctor_words"][0]["red_flag"] = True


def m5_reason(a):
    p = prompt(a, "p4")
    p["who_said"] = dict(label="speaker_0", role="treating_doctor")
    p["attributes"]["strength"] = dict(value="50", cited_spans=["s15"], support="supported")
    span(a, "s15")["quote_en"] = span(a, "s15")["quote_native"] = "yes, continue the levothyroxine 50"
    rerender(a)


def m5_who(a): prompt(a, "p1")["attributes"]["strength"]["support"] = "supported"; rerender(a)


def m5_unnamed(a):
    add_span(a, "speaker_1", "05:08", "05:09", "how often")
    sid = add_span(a, "speaker_0", "05:10", "05:12", "take it three times a day")
    prompt(a, "p1")["attributes"]["frequency"]["cited_spans"] = [sid]


def m5_same_turn(a):
    sid = add_span(a, "speaker_0", "05:10", "05:12", "remember, three times a day")
    prompt(a, "p1")["attributes"]["frequency"]["cited_spans"] = [sid]


def m5_oc(a): a["roster"][0]["role"] = "other_clinician"
def m6_tbd(a): prompt(a, "p1")["drug"]["strength_heard"] = "TBD"
def m6_d1(a): prompt(a, "p1")["drug"]["brand_recognised"] = "Dolo not specified"; rerender(a)
def m6_q(a): prompt(a, "p2")["drug"]["brand_recognised"] = "Wysolone?"; rerender(a)
def m6_d4(a): prompt(a, "p2")["drug"]["brand_recognised"] = "Wysolone dose unknown"; rerender(a)


def m7_prompt(a):
    a["confirm_prompts"].append(dict(prompt_id="p2", kind="medicine", action="continue",
                                     drug=B.drug("Crocin", "PARACETAMOL", brand="Crocin"), attributes=B.attrs(),
                                     who_said=dict(label="speaker_1", role="patient"),
                                     doctor_confirm_reason=["notes_only", "patient_reported"]))
    prov(a, "e1-home")["prompt_id"] = "p2"
    recount(a)
    rerender(a)


def m8_missing(a): note_sub(a, "METFORMIN 1000 — dose change discussed — confirm\n", "")
def m8_shown(a): prompt(a, "p2")["attributes"]["dose"]["support"] = "h_unattrib"
def m8_hidden(a): m8_shown(a); rerender(a)
def m9(text): return lambda a: set_gx(a, "/examination", text)
def m9_fu(text): return lambda a: set_gx(a, "/follow_up/follow_up_instructions", text)
def v12_who(a): prompt(a, "p1")["who_said"]["label"] = "speaker_9"
def m2_deva(a): plan3(a, "\u0917\u094d\u0932\u093f\u092e\u0947\u092a\u093f\u0930\u093e\u0907\u0921 stopped.")
def m1_crlf(a): a["note_text"] = a["note_text"].replace("\n", "\r\n")
def s1_leet(a): plan3(a, "Gl1mepiride stopped.")
def m4_superseded(a): set_gx_and_note(a, "/general_advice", a["gp_extraction"]["general_advice"] + " You may try steam inhalation.")
def s1_fuzzy(a): plan3(a, "Glimepride stopped.")
def s1_spaced(a): plan3(a, "G l i m e p i r i d e stopped.")


def s1_xarelto(a):
    prompt(a, "p1")["drug"].update(spoken="rivaroxaban", generic="RIVAROXABAN", base_molecule="rivaroxaban")
    prov(a, "e3-glim").update(text="rivaroxaban", names=["rivaroxaban"])
    plan3(a, "Xarelto stopped.")


def s1_ctrl(a): plan3(a, "Glimpse at the reports.")
def s2_unnamed(a): prov(a, "e1-cbc")["cited_spans"] = ["s7"]


def s3_semicolon(a):
    set_gx_and_note(a, "/general_advice", RF + " " + "; ".join(["No steam for now, it can set off the wheeze", "Avoid dust and smoke"] * 3) + ".")


def s4_null(a):
    p = prompt(a, "p1")
    p["drug"].update(generic=None, components=[], base_molecule="augmentin")
    p["doctor_confirm_reason"] = ["notes_only", "lasa", "combination_unexpanded"]
    rerender(a)


def s4_unflagged(a):
    p = prompt(a, "p1")
    p["drug"]["lasa_risk"] = dict(pair_with=None, note="not on the curated LASA list")
    p["doctor_confirm_reason"] = ["notes_only"]


def s5(mid): return lambda a: (a["generator"]["models"][0].update(served_model_id=mid), a["qa"]["models_served"].__setitem__(0, mid))
def s6_salt(spoken): return lambda a: _redrug(a, "p1", spoken=spoken, brand_recognised=None, generic="POTASSIUM CHLORIDE", base_molecule="potassium chloride", strength_heard=None)


def _folic_stop(a):
    prompt(a, "p1")["drug"].update(spoken="folic acid", generic="FOLIC ACID", base_molecule="folic acid")
    prov(a, "e3-glim").update(text="folic acid", names=["folic acid"])


def s6_held(a): _folic_stop(a); plan3(a, "Folic acid stopped.")
def s6_ctrl(a): _folic_stop(a); plan3(a, "Acid reflux reviewed.")



# ---- fix round 2: R1-R6 ----
def set_word(a, idx, text):
    old = a["doctor_words"][idx]["text_en"]
    a["doctor_words"][idx]["text_en"] = text
    a["gp_extraction"]["general_advice"] = a["gp_extraction"]["general_advice"].replace(old, text)
    rerender(a)


def set_rf(a, text):
    old = a["red_flags"][0]["text_en"]
    a["red_flags"][0]["text_en"] = text
    set_word(a, 0, text)
    a["gp_extraction"]["general_advice"] = a["gp_extraction"]["general_advice"].replace(old, text)
    rerender(a)


def r3_dose_only(a):
    p = prompt(a, "p1")
    p["drug"].update(spoken="650", brand_recognised=None, generic=None, base_molecule="650",
                     lasa_risk=dict(pair_with="unresolved generic", note="generic not resolved"))
    p["doctor_confirm_reason"] = ["notes_only", "combination_unexpanded", "lasa"]
    p["attributes"] = B.attrs()
    rerender(a)


def r3_advice(a): add_word(a, "Take zorvix daily.", "05:10")


def r4_fallback(a, render=False):
    p = prompt(a, "p2")
    p["attributes"]["dose"] = B.att()
    p["attributes"]["strength"] = B.att("1000", ["s8"])
    if render:
        rerender(a)


def r4_heard(a):
    p = prompt(a, "p2")
    p["attributes"]["dose"]["support"] = "h_unattrib"
    p["drug"]["strength_heard"] = "500"
    note_sub(a, "METFORMIN 1000 — dose", "METFORMIN 500 — dose")


def _stop_dolo(a):
    prompt(a, "p1")["drug"].update(spoken="Dolo 650", brand_recognised="Dolo 650", generic="PARACETAMOL", base_molecule="paracetamol")
    prov(a, "e3-glim").update(text="Dolo 650", names=["Dolo 650"])


def r5_dollo(a): _stop_dolo(a); plan3(a, "Dollo stopped.")
def r5_solo(a): _stop_dolo(a); plan3(a, "Solo visit next week.")
def r5_pamd(a): _pand_stop(a); plan3(a, "Pamd stopped.")
def r5_band(a): _pand_stop(a); plan3(a, "Band of pain reviewed.")


def r6(pair, reasons):
    def f(a):
        _pand(a, generic=None, components=[], base_molecule="pan")
        p = prompt(a, "p1")
        p["drug"]["lasa_risk"]["pair_with"] = pair
        p["doctor_confirm_reason"] = reasons
        rerender(a)
    return f


# name, base, mutation, expected verdict, rule that must be named on failure ("-" for pass)
MUTANTS = [
    ("V0_bad_duration_unit", "ex3", m_bad_unit, "fail", "V0"),
    ("V0_control_hours_unit", "ex3", m_hours_unit, "pass", "-"),
    ("V1_pointer_unresolved", "ex1", m_ptr_unresolved, "fail", "V1"),
    ("V1_pointer_claimed_twice", "ex1", m_ptr_twice, "fail", "V1"),
    ("V1_control_provenance_reordered", "ex1", m_prov_reversed, "pass", "-"),
    ("V2_entry_without_provenance", "ex3", m_drop_fbs, "fail", "V2"),
    ("V2_prompt_without_provenance", "ex3", m_drop_met, "fail", "V2"),
    ("V2_counts_mismatch", "ex1", m_counts, "fail", "V2"),
    ("V3_notgiven_test_in_list", "ex2", m_xray_in_list, "fail", "V3"),
    ("V3_control_unrelated_test", "ex2", m_unrelated_test, "pass", "-"),
    ("V4_posted_without_spans", "ex1", m_dx_no_spans, "fail", "V4"),
    ("V4_control_keptout_without_spans", "ex1", m_keptout_no_spans, "pass", "-"),
    ("V5_bad_heading", "ex1", m_bad_heading, "fail", "V5"),
    ("V5_heading_twice", "ex1", m_heading_twice, "fail", "V5"),
    ("V6_extra_investigation_line", "ex3", m_extra_inv_line, "fail", "V6"),
    ("V6_medication_line_as_order", "ex1", m_med_line_order, "fail", "V6"),
    ("V6_draft_line_missing", "ex6", m_no_draft_line, "fail", "V6"),
    ("V7_medicine_in_gp_extraction", "ex1", m_med_posted, "fail", "V7"),
    ("V7_medicine_provenance_without_prompt", "ex3", m_med_no_prompt, "fail", "V7"),
    ("V8_affirmed_from_patient_supports_dose", "ex3", m_affirmed_dose, "fail", "V8"),
    ("V8_translator_created_order", "ex4", m_translator_order, "fail", "V8"),
    ("V8_patient_span_supports_frequency", "ex1", m_patient_freq, "fail", "V8"),
    ("V8_posted_unsupported", "ex5", m_posted_unsupported, "fail", "V8"),
    ("V8_control_relay_cited_with_doctor", "ex4", m_relay_with_doctor, "pass", "-"),
    ("V9_stopped_drug_named_in_plan", "ex3", m_stop_in_plan, "fail", "V9"),
    ("V9_split_spelling_of_stopped_drug", "ex3", m_split_spelling, "fail", "V9"),
    ("V9_brand_alias_of_stopped_drug", "ex3", m_brand_alias, "fail", "V9"),
    ("V9_notgiven_test_named_in_plan", "ex2", m_xray_in_plan, "fail", "V9"),
    ("V9_plan_line_missing", "ex3", m_plan_line_missing, "fail", "V9"),
    ("V9_control_lime_juice", "ex3", m_lime_juice, "pass", "-"),
    ("V10_red_flag_trimmed_by_budget", "ex6", m_rf_trimmed, "fail", "V10"),
    ("V10_red_flag_not_first", "ex6", m_rf_not_first, "fail", "V10"),
    ("V10_advice_over_budget", "ex6", m_budget_over, "fail", "V10"),
    ("V10_control_budget_full", "ex6", m_budget_full, "pass", "-"),
    ("V11_tbd", "ex1", m_tbd, "fail", "V11"),
    ("V11_repr_in_symptoms", "ex1", m_repr, "fail", "V11"),
    ("V11_frxn1_phrase", "ex1", m_frxn1, "fail", "V11"),
    ("V11_missing_value_only", "ex1", m_missing_only, "fail", "V11"),
    ("V11_control_round_brackets", "ex1", m_parens_ok, "pass", "-"),
    ("V12_cited_span_outside_window", "ex1", m_span_outside, "fail", "V12"),
    ("V12_cited_span_unresolved", "ex1", m_span_unresolved, "fail", "V12"),
    ("V12_cited_span_quarantined", "ex1", m_span_quarantined, "fail", "V12"),
    ("V12_control_uncited_span_outside", "ex1", m_uncited_outside, "pass", "-"),
    ("V13_two_order_capable_labels", "ex4", m_two_capable, "fail", "V13"),
    ("V13_gate_off_armc_contributing", "ex1", m_gate_off_both, "fail", "V13"),
    ("V13_gate_off_armc_only_label", "ex1", m_gate_off_armc_only, "fail", "V13"),
    ("V13_translator_order_capable", "ex4", m_translator_capable, "fail", "V13"),
    ("V13_voiceprint_conflict_ignored", "ex5", m_conflict_ignored, "fail", "V13"),
    ("V13_control_gate_off_3of3", "ex1", m_gate_off_control, "pass", "-"),
    ("V14_acid_reflux_matched_to_folic_acid", "ex1", m_acid_reflux, "fail", "V14"),
    ("V14_lasa_unflagged", "ex6", m_lasa_unflagged, "fail", "V14"),
    ("V14_unattested_combination_expanded", "ex6", m_unattested_expanded, "fail", "V14"),
    ("V14_base_molecule_wrong", "ex2", m_base_wrong, "fail", "V14"),
    ("V14_control_folic_acid_spoken", "ex1", m_folic_spoken, "pass", "-"),
    ("V14_control_unattested_combination_unexpanded", "ex6", m_unattested_unexpanded, "pass", "-"),
    ("V15_withheld_with_note_text", "ex7", m_withheld_note, "fail", "V15"),
    ("V15_withheld_without_reason", "ex7", m_withheld_no_reason, "fail", "V15"),
    ("V15_withheld_with_gp_content", "ex7", m_withheld_content, "fail", "V15"),
    ("V15_full_without_note_text", "ex1", m_full_no_note, "fail", "V15"),
    ("V16_models_served_empty", "ex1", m_models_empty, "fail", "V16"),
    ("V16_model_id_placeholder", "ex1", m_model_placeholder, "fail", "V16"),
    ("V16_models_served_mismatch", "ex1", m_models_mismatch, "fail", "V16"),
    ("M1_held_drug_in_diagnosis", "ex3", m1_dx, "fail", "V9"),
    ("M1_held_drug_in_raw_name_only", "ex3", m1_raw, "fail", "V9"),
    ("M1_medicine_in_examination", "ex2", m1_exam, "fail", "V7"),
    ("M1_medicine_in_diagnosis_alias", "ex1", m1_alias, "fail", "V7"),
    ("M1_note_line_differs_from_source", "ex1", m1_note_only, "fail", "V6"),
    ("M1_heading_injection_line_break", "ex1", m1_inject, "fail", "V11"),
    ("M1_medicine_in_comorbidity_without_condition", "ex3", m1_on_drug, "fail", "V7"),
    ("M1_control_condition_named", "ex3", m1_condition, "pass", "-"),
    ("M2_cyrillic_homoglyph_held", "ex3", m2_cyr, "fail", "V9"),
    ("M2_greek_homoglyph_held", "ex3", m2_greek, "fail", "V9"),
    ("M2_accented_held", "ex3", m2_acc, "fail", "V9"),
    ("M2_fullwidth_held", "ex3", m2_full, "fail", "V9"),
    ("M2_zero_width_held", "ex3", m2_zw, "fail", "V9"),
    ("M2_dotted_held", "ex3", m2_dots, "fail", "V9"),
    ("M2_hyphenated_held", "ex3", m2_hyph, "fail", "V9"),
    ("M2_non_ascii_letter_in_note", "ex1", m2_nonascii, "fail", "V11"),
    ("M3_pand_stop_domperidone_named", "ex3", m3_dom, "fail", "V9"),
    ("M3_pand_stop_pantoprazole_named", "ex3", m3_panto, "fail", "V9"),
    ("M3_combination_part_named", "ex6", m3_part, "fail", "V9"),
    ("M3_control_pand_stop_unnamed", "ex3", m3_ctrl, "pass", "-"),
    ("M4_warning_without_red_flag_entry", "ex6", m4_no_entry, "fail", "V10"),
    ("M4_red_flag_marked_without_entry", "ex1", m4_flag, "fail", "V10"),
    ("M5_affirmed_reason_supported", "ex3", m5_reason, "fail", "V8"),
    ("M5_who_not_order_capable_supported", "ex5", m5_who, "fail", "V8"),
    ("M5_value_on_span_not_naming_drug", "ex1", m5_unnamed, "fail", "V8"),
    ("M5_other_clinician_supports_order", "ex1", m5_oc, "fail", "V8"),
    ("M5_control_value_in_same_doctor_turn", "ex1", m5_same_turn, "pass", "-"),
    ("M6_strength_heard_tbd", "ex1", m6_tbd, "fail", "V11"),
    ("M6_brand_missing_value_phrase", "ex1", m6_d1, "fail", "V11"),
    ("M6_medication_line_question_mark", "ex6", m6_q, "fail", "V11"),
    ("M6_medication_line_dose_unknown", "ex6", m6_d4, "fail", "V11"),
    ("M7_discussed_only_drug_prompted", "ex1", m7_prompt, "fail", "V7"),
    ("M8_change_dose_line_missing", "ex3", m8_missing, "fail", "V6"),
    ("M8_change_dose_unsupported_value_shown", "ex3", m8_shown, "fail", "V6"),
    ("M8_control_unsupported_value_hidden", "ex3", m8_hidden, "pass", "-"),
    ("M9_guillemets", "ex1", m9("Temperature «100.2» F."), "fail", "V11"),
    ("M9_angle_quotes", "ex1", m9("Temperature ‹value› F."), "fail", "V11"),
    ("M9_fullwidth_brackets", "ex1", m9("Temperature ［pending］ F."), "fail", "V11"),
    ("M9_cjk_angle_brackets", "ex1", m9("Temperature 〈value〉 F."), "fail", "V11"),
    ("M9_whole_value_NA_dots", "ex1", m9_fu("N.A."), "fail", "V11"),
    ("M9_whole_value_not_applicable", "ex1", m9_fu("Not applicable"), "fail", "V11"),
    ("M9_whole_value_not_known", "ex1", m9_fu("Not known"), "fail", "V11"),
    ("M9_whole_value_pending", "ex1", m9_fu("Pending"), "fail", "V11"),
    ("M9_whole_value_nil", "ex1", m9_fu("Nil"), "fail", "V11"),
    ("M9_whole_value_unknown", "ex1", m9_fu("Unknown"), "fail", "V11"),
    ("M1_note_crlf_line_ends", "ex1", m1_crlf, "fail", "V6"),
    ("M2_devanagari_held", "ex3", m2_deva, "fail", "V11"),
    ("M4_superseded_word_rendered", "ex6", m4_superseded, "fail", "V10"),
    ("M9_tab_control_character", "ex1", m9("Throat\tred."), "fail", "V11"),
    ("S1_leetspeak_held", "ex3", s1_leet, "fail", "V9"),
    ("V12_who_said_not_in_roster", "ex1", v12_who, "fail", "V12"),
    ("S1_fuzzy_misspelt_held", "ex3", s1_fuzzy, "fail", "V9"),
    ("S1_spaced_letters_held", "ex3", s1_spaced, "fail", "V9"),
    ("S1_brand_map_alias_held", "ex3", s1_xarelto, "fail", "V9"),
    ("S1_control_lookalike_word", "ex3", s1_ctrl, "pass", "-"),
    ("S2_posted_test_not_named_in_span", "ex1", s2_unnamed, "fail", "V8"),
    ("S3_semicolon_items_over_budget", "ex6", s3_semicolon, "fail", "V10"),
    ("S4_lasa_brand_generic_null", "ex6", s4_null, "fail", "V14"),
    ("S4_lasa_combination_unflagged", "ex6", s4_unflagged, "fail", "V14"),
    ("S5_model_id_default", "ex1", s5("default"), "fail", "V16"),
    ("S5_model_id_latest", "ex1", s5("latest"), "fail", "V16"),
    ("S5_model_id_empty", "ex1", s5(""), "fail", "V16"),
    ("S6_salt_word_only_match", "ex1", s6_salt("potassium tablet"), "fail", "V14"),
    ("S6_control_salt_full_phrase", "ex1", s6_salt("potassium chloride syrup"), "pass", "-"),
    ("S6_held_salt_drug_named", "ex3", s6_held, "fail", "V9"),
    ("S6_control_salt_word_alone", "ex3", s6_ctrl, "pass", "-"),
    ("R1_word_reordered_doctor_words", "ex1", lambda a: set_word(a, 0, "Take rest and drink plenty of water."), "fail", "V17"),
    ("R1_negator_dropped", "ex3", lambda a: set_word(a, 0, "Skip meals."), "fail", "V17"),
    ("R1_red_flag_action_truncated", "ex6", lambda a: set_rf(a, "If your breathing gets worse or your lips turn blue."), "fail", "V17"),
    ("R1_red_flag_reworded", "ex6", lambda a: set_rf(a, "If breathing worsens, come to emergency."), "fail", "V17"),
    ("R1_control_contiguous_part", "ex4", lambda a: set_word(a, 0, "Drink at least three litres of water."), "pass", "-"),
    ("R1_control_case_only", "ex1", lambda a: set_word(a, 0, "Drink Plenty Of Water And Take Rest."), "pass", "-"),
    ("R2_unknown_brand_dose_in_plan", "ex3", lambda a: plan3(a, "Zorvix 10 mg at night."), "fail", "V18"),
    ("R2_frequency_token_in_follow_up", "ex1", lambda a: set_gx(a, "/follow_up/follow_up_instructions", "Return after the Zorvix BD course."), "fail", "V18"),
    ("R2_regimen_in_follow_up", "ex1", lambda a: set_gx(a, "/follow_up/follow_up_instructions", "Review after the 1-0-1 course."), "fail", "V18"),
    ("R2_times_days_in_plan", "ex3", lambda a: plan3(a, "Course x 5 days."), "fail", "V18"),
    ("R2_number_word_tablets_in_examination", "ex1", lambda a: set_gx(a, "/examination", "Took two tablets at home. Chest clear."), "fail", "V18"),
    ("R2_dotted_frequency_in_plan", "ex3", lambda a: plan3(a, "Zorvix B.D. after food."), "fail", "V18"),
    ("R2_hourly_frequency_in_follow_up", "ex1", lambda a: set_gx(a, "/follow_up/follow_up_instructions", "Return if Zorvix q8h does not help."), "fail", "V18"),
    ("R2_condition_word_not_adjacent", "ex3", lambda a: a["gp_extraction"]["comorbidities"][0]["aliases"].append("Insulin resistance on metformin"), "fail", "V7"),
    ("R2_control_lab_values", "ex1", lambda a: set_gx(a, "/examination", "Temperature 100.2 F. Hb 12 g/dL. SpO2 98%."), "pass", "-"),
    ("R2_control_iso_date", "ex1", lambda a: a["gp_extraction"]["follow_up"].update(followup_date="2026-10-20"), "pass", "-"),
    ("R2_control_condition_adjacent", "ex3", lambda a: a["gp_extraction"]["comorbidities"][0]["aliases"].append("Metformin-induced lactic acidosis"), "pass", "-"),
    ("R3_unknown_name_in_plan", "ex3", lambda a: plan3(a, "Start Zorvix tomorrow."), "fail", "V18"),
    ("R3_unknown_name_in_advice", "ex3", r3_advice, "fail", "V18"),
    ("R3_dose_without_name_in_medication", "ex1", r3_dose_only, "fail", "V18"),
    ("R3_control_plain_object", "ex3", lambda a: plan3(a, "Start walking daily."), "pass", "-"),
    ("R4_change_dose_falls_back_to_strength", "ex3", r4_fallback, "fail", "V6"),
    ("R4_change_dose_shows_heard_strength", "ex3", r4_heard, "fail", "V6"),
    ("R4_control_change_dose_no_number", "ex3", lambda a: r4_fallback(a, render=True), "pass", "-"),
    ("R5_edit1_four_letter_brand", "ex3", r5_dollo, "fail", "V9"),
    ("R5_edit1_combination_brand", "ex3", r5_pamd, "fail", "V9"),
    ("R5_control_common_word_solo", "ex3", r5_solo, "pass", "-"),
    ("R5_control_common_word_band", "ex3", r5_band, "pass", "-"),
    ("R6_null_generic_without_lasa_risk", "ex6", r6(None, ["notes_only", "combination_unexpanded", "lasa"]), "fail", "V14"),
    ("R6_null_generic_without_lasa_reason", "ex6", r6("unresolved generic", ["notes_only", "combination_unexpanded"]), "fail", "V14"),
    ("R6_control_null_generic_flagged", "ex6", r6("unresolved generic", ["notes_only", "combination_unexpanded", "lasa"]), "pass", "-"),
]


def main(out):
    os.makedirs(out, exist_ok=True)
    rows = ["mutant\tbase\texpected\trule"]
    for name, base, fn, exp, rule in MUTANTS:
        a = copy.deepcopy(BASE[base]())
        fn(a)
        B.write(os.path.join(out, name + ".json"), a)
        rows.append("\t".join([name, base, exp, rule]))
    with open(os.path.join(os.path.dirname(out.rstrip("/")), "expected.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(rows) + "\n")
    print("written %d mutants to %s" % (len(MUTANTS), out))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "mutants"))
