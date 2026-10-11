#!/usr/bin/env python3
"""Builds the three INVENTED example artifacts (no real patient, doctor, room or id)."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
Z = "0" * 64
GEN = dict(name="hand-authored-example", version="0.1", code_sha256=Z, prompt_sha256=Z, model="none (hand-authored)", model_provider="none", zdr=True, temperature=0)
NOTE = lambda d: "\n".join(("%s: %s" % (h, d.get(h, ""))).rstrip() for h in ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management", "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice"])

def ev(i, t0, t1, q, lang="en"):
    return dict(segment_ref="EXAMPLE-W1:%d" % i, t0="2026-09-20T10:%s+05:30" % t0, t1="2026-09-20T10:%s+05:30" % t1, quote_en=q, lang=lang)

def item(iid, kind, text, status, ptr, evs, conf=0.9, speaker="doctor", negated=False, flags=(), names=None):
    d = dict(item_id=iid, kind=kind, text=text)
    if names:
        d["names"] = names
    return dict(d, status=status, negated=negated, speaker=speaker, speaker_source="model_inferred",
                evidence=evs, confidence=conf, json_pointer=ptr, flags=list(flags))

def header(n, langs, segs):
    return dict(schema_version="eta.freescript.v0.1", artifact_id="00000000-0000-4000-8000-00000000000%d" % n, supersedes=None,
                created_at="2026-09-20T10:30:00+05:30", generator=GEN,
                encounter=dict(eta_encounter_id="EXAMPLE-ENC-%d" % n, room="EXAMPLE-ROOM", window_start="2026-09-20T10:00:00+05:30",
                               window_end="2026-09-20T10:15:00+05:30", languages=langs,
                               transcript=dict(segment_count=segs, diarised=False, english_source="native" if langs == ["en"] else "mt:gemini-3.8-flash"),
                               doctor=dict(pulse_doctor_uid=None, specialty="General Practitioner")),
                pulse_link=dict(type_of_prescription="HOSPITAL_GP", individual_uid=None, hospital_uid=None, consult_uid=None, prescription_uid=None,
                                draft_exists="unknown", link_status="none", link_basis=None))

# 1. Simple fever consult; the patient's own home paracetamol is discussed_only (kept out).
a1 = header(1, ["en", "hi"], 14)
a1["gp_extraction"] = dict(
    presenting_complaints=dict(symptoms="Fever for 2 days with body ache. Took paracetamol at home once.",
                               diagnoses=[dict(diagnosis_or_impression="Acute viral fever", is_differential_diagnosis=True, raw_name="viral fever", aliases=["Viral fever"])]),
    examination="Temperature 100.2 F. Throat mildly congested. Chest clear.",
    medicines=[dict(name="Paracetamol 650", frequency="TDS", duration="3 days", instructions="after food, only if fever", raw_name="Dolo 650", aliases=["Dolo 650", "Calpol 650"])],
    further_investigations=[dict(name="Complete Blood Count", urgent=False, instruction="", raw_name="CBC", aliases=["CBC", "Haemogram"])],
    follow_up=dict(followup_type="IF_REQUIRED", follow_up_instructions="come back if fever lasts beyond 3 days"),
    general_advice="Drink plenty of fluids. Rest.")
a1["note_text"] = NOTE({"Presenting Complaint": "Fever for 2 days with body ache. Took paracetamol at home once.", "Examination": "Temp 100.2 F. Throat mildly congested. Chest clear.",
                        "Diagnoses": "Likely viral fever", "Medication": "Dolo 650 TDS x 3 days after food, only if fever", "Further Investigation": "CBC",
                        "Follow up": "If required; come back if fever lasts beyond 3 days", "General Advice": "Plenty of fluids. Rest."})
a1["provenance"] = [
    item("e1-sym", "symptoms", "fever 2 days, body ache", "prescribed", "/presenting_complaints/symptoms", [ev(1, "01:05", "01:12", "I have had fever since two days and body pain", "hi")], 0.85, speaker="patient", flags=["translation_uncertain"]),
    item("e1-home", "medicine", "Paracetamol taken at home by patient", "discussed_only", None, [ev(2, "01:20", "01:24", "I took one paracetamol last night", "hi")], 0.8, speaker="patient"),
    item("e1-exam", "examination", "temp 100.2 F, throat congested, chest clear", "prescribed", "/examination", [ev(5, "03:10", "03:30", "temperature is 100.2, throat is a little red, chest is clear")]),
    item("e1-dx", "diagnosis", "likely viral fever", "prescribed", "/presenting_complaints/diagnoses/0", [ev(7, "04:00", "04:05", "looks like a viral fever")], 0.8),
    item("e1-med", "medicine", "Dolo 650 three times a day for 3 days", "prescribed", "/medicines/0", [ev(8, "04:10", "04:22", "take Dolo 650 three times a day after food for three days, only if there is fever")]),
    item("e1-cbc", "investigation", "CBC", "prescribed", "/further_investigations/0", [ev(9, "04:25", "04:28", "get a CBC done")]),
    item("e1-fu", "follow_up", "return if fever beyond 3 days", "prescribed", "/follow_up", [ev(11, "05:00", "05:06", "if fever does not go in three days come back")]),
    item("e1-adv", "advice", "fluids and rest", "prescribed", "/general_advice", [ev(10, "04:40", "04:45", "drink lots of water and take rest")]),
]

# 2. Negation case: antibiotic and X-ray explicitly NOT given; pertinent negative symptom kept as text.
a2 = header(2, ["en"], 11)
a2["gp_extraction"] = dict(
    presenting_complaints=dict(symptoms="Dry cough for 5 days. No fever. No chest pain. No breathlessness.",
                               diagnoses=[dict(diagnosis_or_impression="Acute upper respiratory tract infection", is_differential_diagnosis=False, raw_name="URTI", aliases=["Upper respiratory tract infection"])]),
    examination="Chest clear on auscultation. SpO2 98%.",
    medicines=[dict(name="Levocetirizine 5", frequency="HS", duration="5 days", instructions="at night", raw_name="levocetirizine 5", aliases=["Levocet", "Xyzal"])],
    plan_of_management=dict(management_plan="Symptomatic treatment. No antibiotics needed at present. Chest X-ray not needed now.", requires_surgery_or_procedure=False),
    general_advice="Steam inhalation twice daily. Warm water gargles.")
a2["note_text"] = NOTE({"Presenting Complaint": "Dry cough x 5 days. No fever, no chest pain, no breathlessness.", "Examination": "Chest clear. SpO2 98%.", "Diagnoses": "URTI",
                        "Plan of Management": "Symptomatic. No antibiotics needed at present. Chest X-ray not needed now.", "Medication": "Levocetirizine 5 mg HS x 5 days",
                        "General Advice": "Steam inhalation twice daily. Warm water gargles."})
a2["provenance"] = [
    item("e2-sym", "symptoms", "dry cough 5 days; denies fever, chest pain, breathlessness", "prescribed", "/presenting_complaints/symptoms",
         [ev(1, "00:40", "00:50", "cough for five days, dry"), ev(2, "00:55", "01:02", "no fever, no chest pain, no problem breathing")], 0.9, speaker="patient", negated=True),
    item("e2-exam", "examination", "chest clear, SpO2 98", "prescribed", "/examination", [ev(4, "02:10", "02:20", "chest is clear, saturation 98")]),
    item("e2-dx", "diagnosis", "URTI", "prescribed", "/presenting_complaints/diagnoses/0", [ev(6, "03:00", "03:04", "this is a simple URTI")]),
    item("e2-abx", "medicine", "Azithromycin", "not_given", None, [ev(7, "03:05", "03:15", "you asked for azithromycin but you don't need an antibiotic now")], 0.9, negated=True, flags=["negation_cue_nearby"], names=["azithromycin", "Azithromycin 500", "Azithral", "Zithromax"]),
    item("e2-cxr", "investigation", "Chest X-ray", "not_given", None, [ev(8, "03:16", "03:22", "no need for a chest X-ray right now")], 0.9, negated=True, flags=["negation_cue_nearby"], names=["Chest X-ray", "CXR", "X-ray chest PA view"]),
    item("e2-plan", "management_plan", "symptomatic; no antibiotic; no X-ray now", "prescribed", "/plan_of_management/management_plan", [ev(7, "03:05", "03:15", "you don't need an antibiotic now")], 0.85),
    item("e2-med", "medicine", "Levocetirizine 5 mg at night for 5 days", "prescribed", "/medicines/0", [ev(9, "03:30", "03:40", "take levocetirizine 5 at night for five days")]),
    item("e2-adv", "advice", "steam inhalation, gargles", "prescribed", "/general_advice", [ev(10, "03:45", "03:52", "do steam twice a day and warm water gargles")]),
]

# 3. Stopped-drug case: glimepiride stopped, metformin continued, one low-confidence item flagged but kept.
a3 = header(3, ["en", "kn"], 19)
a3["gp_extraction"] = dict(
    comorbidities=[dict(name="Type 2 Diabetes Mellitus", duration=dict(value=60, unit="MONTHS"), raw_name="sugar", aliases=["T2DM", "Diabetes mellitus type 2"])],
    presenting_complaints=dict(symptoms="Giddiness and sweating in the mornings for 1 week.",
                               diagnoses=[dict(diagnosis_or_impression="Hypoglycaemia", is_differential_diagnosis=True, raw_name="low sugar", aliases=["Hypoglycemia"])]),
    examination="BP 128/82. Pulse 88. Random blood sugar 72 mg/dL.",
    plan_of_management=dict(management_plan="Stop glimepiride. Continue metformin. Recheck sugars.", requires_surgery_or_procedure=False),
    medicines=[dict(name="Metformin 500", frequency="BD", duration="1 month", instructions="after food", raw_name="metformin 500", aliases=["Glycomet 500"]),
               dict(name="Glucose tablets", frequency="SOS", duration="", instructions="if giddy or sweating", raw_name="glucose", aliases=[])],
    further_investigations=[dict(name="HbA1c", urgent=False, instruction="", raw_name="HbA1c", aliases=["Glycated haemoglobin"]),
                            dict(name="Fasting Blood Sugar", urgent=False, instruction="fasting sample", raw_name="fasting sugar", aliases=["FBS"])],
    follow_up=dict(followup_type="FOLLOW_UP_WITH_REPORTS", follow_up_instructions="with sugar reports"),
    general_advice="Do not skip meals. Keep a sugar source with you.")
a3["note_text"] = NOTE({"Co-morbidities": "T2DM for 5 years", "Presenting Complaint": "Giddiness and sweating in mornings x 1 week.", "Examination": "BP 128/82, PR 88, RBS 72 mg/dL.",
                        "Diagnoses": "?Hypoglycaemia", "Plan of Management": "Stop glimepiride. Continue metformin. Recheck sugars.",
                        "Medication": "Metformin 500 BD x 1 month after food\nGlucose tablets SOS if giddy or sweating", "Further Investigation": "HbA1c\nFBS (fasting sample)",
                        "Follow up": "With reports", "General Advice": "Do not skip meals. Keep a sugar source with you."})
a3["provenance"] = [
    item("e3-com", "comorbidity", "T2DM 5 years", "prescribed", "/comorbidities/0", [ev(1, "00:30", "00:36", "I have sugar for five years", "kn")], 0.85, speaker="patient"),
    item("e3-sym", "symptoms", "giddiness, sweating mornings 1 week", "prescribed", "/presenting_complaints/symptoms", [ev(2, "00:40", "00:52", "for a week I feel giddy and sweat in the morning", "kn")], 0.8, speaker="patient", flags=["translation_uncertain"]),
    item("e3-exam", "examination", "BP 128/82, PR 88, RBS 72", "prescribed", "/examination", [ev(5, "02:00", "02:15", "BP 128 by 82, pulse 88, sugar 72")]),
    item("e3-dx", "diagnosis", "?hypoglycaemia", "prescribed", "/presenting_complaints/diagnoses/0", [ev(7, "03:00", "03:06", "this could be low sugar from the glimepiride")], 0.75),
    item("e3-glim", "medicine", "Glimepiride 1 mg", "stopped", None, [ev(8, "03:07", "03:15", "stop the glimepiride from today")], 0.95, negated=True, flags=["negation_cue_nearby"], names=["glimepiride", "Glimepiride 1", "Amaryl"]),
    item("e3-met", "medicine", "Metformin 500 BD", "continued", "/medicines/0", [ev(9, "03:16", "03:24", "continue metformin 500 twice a day after food")]),
    item("e3-glu", "medicine", "Glucose tablets when symptomatic", "prescribed", "/medicines/1", [ev(10, "03:25", "03:30", "keep glucose with you, take if you feel giddy", "kn")], 0.5, flags=["low_confidence", "translation_uncertain", "duration_unstated"]),
    item("e3-hba1c", "investigation", "HbA1c", "prescribed", "/further_investigations/0", [ev(12, "04:00", "04:04", "do HbA1c")]),
    item("e3-fbs", "investigation", "Fasting sugar", "prescribed", "/further_investigations/1", [ev(12, "04:04", "04:10", "and fasting sugar tomorrow morning")]),
    item("e3-plan", "management_plan", "stop glimepiride, continue metformin, recheck", "prescribed", "/plan_of_management/management_plan", [ev(8, "03:07", "03:15", "stop the glimepiride from today")]),
    item("e3-fu", "follow_up", "review with reports", "prescribed", "/follow_up", [ev(14, "04:30", "04:35", "come back with the reports")]),
    item("e3-adv", "advice", "no skipped meals, carry sugar", "prescribed", "/general_advice", [ev(13, "04:12", "04:20", "don't skip meals")]),
]

for n, a in [(1, a1), (2, a2), (3, a3)]:
    names = {1: "ex1-fever-patient-own-drug.json", 2: "ex2-negation-no-antibiotic-no-xray.json", 3: "ex3-stopped-glimepiride.json"}
    json.dump(a, open(os.path.join(HERE, names[n]), "w"), indent=2, ensure_ascii=False)
print("written")
