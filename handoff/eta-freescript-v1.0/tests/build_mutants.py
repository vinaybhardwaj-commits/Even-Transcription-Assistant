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
from validate_artifact import PLAN_LINE, med_line  # noqa: E402

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


def gate_off(a):
    a["qa"]["inputs"]["armc_gate"] = "off"
    for r in a["roster"]:
        r["armc"]["gate_flag"] = "off"


# ---- mutations (each returns nothing; mutates a) ----
def m_bad_unit(a): a["gp_extraction"]["comorbidities"][0]["duration"]["unit"] = "DECADES"
def m_hours_unit(a): a["gp_extraction"]["comorbidities"][0]["duration"] = dict(value=5, unit="HOURS")
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
def m_affirmed_dose(a): prompt(a, "p2")["attributes"]["dose"]["support"] = "supported"


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
def m_lime_juice(a): set_gx_and_note(a, "/general_advice", "Don't skip meals. Lime juice is fine.")
def m_plan_line_missing(a): set_gx_and_note(a, "/plan_of_management/management_plan", "Recheck sugars.")


RF = "If your breathing gets worse or your lips turn blue, go to the emergency department at once."


def m_rf_trimmed(a): set_gx_and_note(a, "/general_advice", "No steam for now, it can set off the wheeze. Avoid dust and smoke.")
def m_rf_not_first(a): set_gx_and_note(a, "/general_advice", "No steam for now, it can set off the wheeze. " + RF + " Avoid dust and smoke.")


def m_budget_over(a):
    set_gx_and_note(a, "/general_advice", RF + " No steam for now, it can set off the wheeze. Avoid dust and smoke. "
                    "Use the inhaler as shown. Sleep with the head raised. Keep the window open. Walk slowly.")


def m_budget_full(a):
    set_gx_and_note(a, "/general_advice", RF + " No steam for now, it can set off the wheeze. Avoid dust and smoke. "
                    "Use the inhaler as shown. Sleep with the head raised. Keep the window open.")


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


def _redrug(a, pid, line_old, **kw):
    d = prompt(a, pid)["drug"]
    d.update(kw)
    note_sub(a, line_old, med_line(d))


def m_acid_reflux(a):
    _redrug(a, "p2", "PARACETAMOL (Crocin) — confirm", spoken="acid reflux tablet", brand_recognised=None, generic="FOLIC ACID", base_molecule="folic")


def m_folic_spoken(a):
    _redrug(a, "p2", "PARACETAMOL (Crocin) — confirm", spoken="folic acid tablet", brand_recognised=None, generic="FOLIC ACID", base_molecule="folic")


def m_lasa_unflagged(a):
    p = prompt(a, "p2")
    p["drug"]["lasa_risk"] = dict(pair_with=None, note="not on the curated LASA list")
    p["doctor_confirm_reason"].remove("lasa")


def _pand(a, **kw):
    span(a, "s5")["quote_en"] = span(a, "s5")["quote_native"] = "take Pan-D once a day before breakfast"
    p = prompt(a, "p1")
    p["attributes"] = B.attrs(frequency=B.att("once a day", ["s5"]), instruction=B.att("before breakfast", ["s5"]))
    p["drug"] = dict(spoken="Pan-D", brand_recognised="Pan-D", form="capsule", strength_heard=None,
                     lasa_risk=dict(pair_with=None, note="not on the curated LASA list"), **kw)
    p["doctor_confirm_reason"] = ["notes_only", "combination_unexpanded"] if kw["generic"] is None else ["notes_only"]
    prov(a, "e6-amc").update(names=["Pan-D"], flags=[])
    note_sub(a, "AMOXICILLIN + CLAVULANIC ACID (Augmentin 625 Duo) — confirm", med_line(p["drug"]))


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
    ("V8_affirmed_from_patient_supports_dose", "ex1", m_affirmed_dose, "fail", "V8"),
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
