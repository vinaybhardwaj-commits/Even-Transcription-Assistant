#!/usr/bin/env python3
"""Builds the seven INVENTED eta.freescript.v1.0 example artifacts (no real patient, doctor, room or id; all-zero UUIDs).
Deterministic: same input, byte-identical output. Usage: build_examples.py [OUT_DIR]   (default: this folder).
note_text is rendered only from posted gp_extraction, red_flags and doctor_words, as design section 9 requires."""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from validate_artifact import PLAN_LINE, base_of, render_note  # noqa: E402

Z = "0" * 64
DAY = "2026-10-15"
D, P = "speaker_0", "speaker_1"
TD = "treating_doctor"
ADVICE_CATS = {"lifestyle", "diet", "warning", "counselling", "test_prep", "other"}
MODELS = [dict(role="stageA", served_model_id="example-model-a-2026-10", provider="example-provider", zdr=True),
          dict(role="stageB", served_model_id="example-model-b-2026-10", provider="example-provider", zdr=True)]


def ts(mmss):
    return "%sT10:%s+05:30" % (DAY, mmss)


def rost(label, role, votes, talk, state="fail", cos=0.2, vp=False, oc=False, translator_of=None, gate="on"):
    v = dict(zip(["role_track", "clef", "jev"], votes))
    passed = state == "pass"
    return dict(label=label, talk_s=talk, role=role, role_votes=v, three_of_three=all(x == TD for x in votes),
                armc=dict(state=state, cos=cos, margin_next_label=0.21 if passed else None,
                          margin_runner_up_centroid=0.17 if passed else None, gate_flag=gate),
                voiceprint_match=vp, translator_of=translator_of, order_capable=oc)


def doc(talk=400):
    return rost(D, TD, [TD, TD, TD], talk, state="pass", cos=0.84, vp=True, oc=True)


def pat(talk=250, label=P):
    return rost(label, "patient", ["patient", "patient", "patient"], talk, cos=0.22)


def att(value=None, cited=(), support=None):
    return dict(value=value, cited_spans=list(cited), support=support or ("supported" if value is not None else "not_stated"))


def attrs(**kw):
    out = {k: att() for k in ["strength", "dose", "route", "frequency", "duration", "instruction"]}
    out.update(kw)
    return out


def drug(spoken, generic, brand=None, components=(), form="tablet", strength=None, lasa=None):
    base = " + ".join(base_of(c) for c in (components or generic.split("+")))
    return dict(spoken=spoken, brand_recognised=brand, generic=generic, components=list(components), base_molecule=base,
                form=form, strength_heard=strength,
                lasa_risk=dict(pair_with=lasa, note="curated LASA pair; confirm the molecule" if lasa else "not on the curated LASA list"))


class Consult:
    def __init__(self, n, langs, segs, roster, gate="on"):
        self.n, self.langs, self.segs, self.gate = n, langs, segs, gate
        self.roster = {r["label"]: r for r in roster}
        self.spans, self.prov, self.prompts, self.words, self.red_flags = [], [], [], [], []
        self.gx = {}

    def span(self, label, t0, t1, en, lang="en", native=None, relay_of=None, segcheck=None):
        r = self.roster[label]
        armc = self.gate == "on" and r["armc"]["state"] == "pass"
        src = "both" if r["three_of_three"] and armc else "3of3" if r["three_of_three"] else "armc" if armc else "none"
        sid = "s%d" % (len(self.spans) + 1)
        s = dict(span_id=sid, segment_refs=["EXAMPLE-W%d:%d" % (self.n, len(self.spans) + 1)], t0=ts(t0), t1=ts(t1), label=label,
                 lang=lang, quote_native=native if native is not None else en, quote_en=en, span_source=src,
                 order_capable=r["order_capable"], boundary_quarantined=False, relay_of=relay_of)
        if segcheck:
            s["segcheck"] = dict(cos=segcheck[0], rank_first=segcheck[1])
        self.spans.append(s)
        return sid

    def _src(self, cited):
        by = {s["span_id"]: s for s in self.spans}
        caps = [by[c]["span_source"] for c in cited if by[c]["order_capable"]]
        return caps[0] if caps else (by[cited[0]]["span_source"] if cited else "none")

    def item(self, iid, kind, text, status, cited, ptr=None, support="supported", prompt_id=None, names=None, negated=False,
             flags=(), withheld=None, alignment="aligned_code"):
        d = dict(item_id=iid, kind=kind, text=text)
        if names:
            d["names"] = names
        d.update(status=status, negated=negated, support=support, cited_spans=list(cited), alignment=alignment,
                 span_source=self._src(cited), json_pointer=ptr, prompt_id=prompt_id, withheld_reason=withheld, flags=list(flags))
        self.prov.append(d)

    def prompt(self, kind, action, who, reasons, attributes=None, drug_=None, name=None):
        pid = "p%d" % (len(self.prompts) + 1)
        p = dict(prompt_id=pid, kind=kind, action=action)
        if name:
            p["name"] = name
        if drug_:
            p["drug"] = drug_
        p.update(attributes=attributes or attrs(), who_said=dict(label=who, role=self.roster[who]["role"]),
                 doctor_confirm_reason=list(reasons))
        self.prompts.append(p)
        return pid

    def word(self, cat, text, cited, firmness="firm", final=True, superseded_by=None, emphasis=1, counselling=False):
        iid = "dw%d" % (len(self.words) + 1)
        self.words.append(dict(instruction_id=iid, category=cat, text_en=text, cited_spans=list(cited), firmness=firmness,
                               final_position=final, superseded_by=superseded_by, emphasis_count=emphasis, counselling=counselling))
        return iid

    def advice(self, budget_items=5, budget_chars=300):
        """Red flags first and never trimmed; then final, firm advice words by emphasis, within the budget."""
        rf = [f["text_en"] for f in self.red_flags]
        pool = sorted([w for w in self.words if w["category"] in ADVICE_CATS and w["final_position"] and w["text_en"] not in rf],
                      key=lambda w: -w["emphasis_count"])
        rest = []
        for w in pool:
            if len(rest) < budget_items and len(" ".join(rest + [w["text_en"]])) <= budget_chars:
                rest.append(w["text_en"])
        return " ".join(rf + rest)

    def build(self, withheld_reasons=None, models=MODELS, role_votes=True):
        withheld = bool(withheld_reasons)
        prov = self.prov
        a = dict(schema_version="eta.freescript.v1.0", artifact_id="00000000-0000-4000-8000-00000000000%d" % self.n, supersedes=None,
                 created_at="%sT10:30:00+05:30" % DAY,
                 emission=dict(state="withheld" if withheld else "full", reasons=list(withheld_reasons or [])),
                 policy=dict(medicine_policy="notes_only", advice_budget=dict(items=5, chars=300), inputs_mode="current"),
                 generator=dict(name="hand-authored-example", version="1.0", code_sha256=Z, prompt_sha256s=dict(stageA=Z, stageB=Z),
                                models=models, temperature=0, run_id="EXAMPLE-RUN-%d" % self.n),
                 encounter=dict(eta_encounter_id="EXAMPLE-ENC-%d" % self.n, room="EXAMPLE-ROOM", visit_date_ist=DAY,
                                window_start=ts("00:00"), window_end=ts("15:00"), languages=self.langs,
                                transcript=dict(segment_count=self.segs, diarised=True,
                                                english_source="native" if self.langs == ["en"] else "mt:example-mt-model",
                                                stt_engines=["example-stt-a"]),
                                doctor=dict(pulse_doctor_uid=None, specialty="General Practitioner")),
                 pulse_link=dict(type_of_prescription="HOSPITAL_GP", individual_uid=None, hospital_uid=None, consult_uid=None,
                                 prescription_uid=None, draft_exists="unknown", link_status="none", link_basis=None),
                 roster=list(self.roster.values()), spans=self.spans, gp_extraction=self.gx, confirm_prompts=self.prompts,
                 doctor_words=self.words, red_flags=self.red_flags, provenance=prov)
        if not withheld:
            a["note_text"] = render_note(a)
        a["qa"] = dict(
            floors=dict(untaped_drugs=0, invented_doses=0, dose_precedence_errors=0, clip_leakage=0, placeholders=0,
                        red_flags_missing=0, hallucinations_est=0.0, validator_pass=True),
            counts=dict(posted=sum(p["json_pointer"] is not None for p in prov), prompts=len(self.prompts),
                        withheld=sum(p["withheld_reason"] is not None for p in prov),
                        h_unattrib=sum(p["support"] == "h_unattrib" for p in prov),
                        unaligned=sum(p["alignment"] == "unaligned" for p in prov),
                        affirmed_from_patient=sum(p["support"] == "affirmed_from_patient" for p in prov)),
            inputs=dict(mode="current", role_votes_present=role_votes, armc_gate=self.gate, case7=False),
            models_served=[m["served_model_id"] for m in models], render_template="neutral-11h-v1")
        return a


def ex1():
    """Fever. The patient's own home drug (Crocin) is discussed_only: it lives only in provenance, with no prompt and no Medication line."""
    c = Consult(1, ["en", "hi"], 14, [doc(410), pat(260)])
    s1 = c.span(P, "00:40", "00:48", "I have had fever for two days and body pain", "hi", "do din se bukhar hai aur badan dard ho raha hai")
    s11 = c.span(P, "00:50", "00:55", "no other illness as such", "hi", "aur koi bimari nahi hai")
    s2 = c.span(P, "01:05", "01:10", "I took one Crocin last night", "hi", "kal raat ek Crocin li thi")
    s3 = c.span(D, "01:11", "01:12", "okay, fine")
    s4 = c.span(D, "01:20", "01:28", "so fever for two days with body ache")
    s5 = c.span(D, "03:10", "03:30", "temperature is 100.2, throat is a little red, chest is clear")
    s6 = c.span(D, "04:00", "04:05", "looks like a viral fever")
    s7 = c.span(D, "04:10", "04:22", "take Dolo 650 three times a day after food for three days, only if there is fever")
    s8 = c.span(D, "04:25", "04:28", "get a CBC done")
    s9 = c.span(D, "04:40", "04:45", "drink plenty of water and take rest")
    s10 = c.span(D, "05:00", "05:06", "if the fever does not go in three days, come back")
    c.word("lifestyle", "Drink plenty of water and take rest.", [s9], counselling=True)
    c.word("follow_up", "If the fever does not go in three days, come back.", [s10])
    c.gx = dict(
        presenting_complaints=dict(symptoms="Fever for 2 days with body ache.",
                                   diagnoses=[dict(diagnosis_or_impression="Acute viral fever", is_differential_diagnosis=True, raw_name="viral fever", aliases=["Viral fever"])]),
        examination="Temperature 100.2 F. Throat mildly congested. Chest clear.",
        medicines=[],
        further_investigations=[dict(name="Complete Blood Count", urgent=False, instruction="", raw_name="CBC", aliases=["CBC", "Haemogram"])],
        follow_up=dict(followup_type="IF_REQUIRED", follow_up_instructions="Come back if the fever lasts beyond 3 days."),
        general_advice=c.advice())
    p1 = c.prompt("medicine", "start", D, ["notes_only"], attrs(strength=att("650", [s7]), frequency=att("three times a day", [s7]),
                  duration=att("three days", [s7]), instruction=att("after food, only if there is fever", [s7])),
                  drug("Dolo 650", "PARACETAMOL", brand="Dolo 650", strength="650"))
    c.item("e1-sym", "symptoms", "fever 2 days, body ache", "prescribed", [s1, s4], "/presenting_complaints/symptoms", flags=["translation_uncertain"])
    c.item("e1-com", "comorbidity", "whole-value missing statement about other illness", "prescribed", [s11], support="not_stated",
           withheld="missing_value", flags=["field_withheld"], alignment="aligned_llm")
    c.item("e1-home", "medicine", "Crocin taken at home by the patient", "discussed_only", [s2, s3], support="affirmed_from_patient",
           names=["Crocin", "paracetamol"], flags=["affirmed_from_patient", "strength_unstated"], alignment="aligned_llm")
    c.item("e1-exam", "examination", "temp 100.2 F, throat congested, chest clear", "prescribed", [s5], "/examination")
    c.item("e1-dx", "diagnosis", "likely viral fever", "prescribed", [s6], "/presenting_complaints/diagnoses/0")
    c.item("e1-med", "medicine", "Dolo 650 three times a day for 3 days", "prescribed", [s7], prompt_id=p1, names=["Dolo 650", "paracetamol"])
    c.item("e1-cbc", "investigation", "CBC", "prescribed", [s8], "/further_investigations/0", names=["CBC", "Complete Blood Count"])
    c.item("e1-fu", "follow_up", "return if fever beyond 3 days", "prescribed", [s10], "/follow_up")
    c.item("e1-adv", "advice", "fluids and rest", "prescribed", [s9], "/general_advice")
    return c.build()


def ex2():
    """Negation: azithromycin and a chest X-ray are both not_given; neither is named in note_text."""
    c = Consult(2, ["en"], 11, [doc(380), pat(220)])
    s1 = c.span(P, "00:40", "00:50", "cough for five days, dry")
    s2 = c.span(P, "00:55", "01:02", "no fever, no chest pain, no problem breathing")
    s3 = c.span(D, "01:05", "01:15", "so dry cough five days, no fever, no chest pain, no breathlessness")
    s4 = c.span(D, "02:10", "02:20", "chest is clear, saturation 98")
    s5 = c.span(D, "03:00", "03:04", "this is a simple URTI")
    s6 = c.span(P, "03:05", "03:08", "can you give me azithromycin")
    s7 = c.span(D, "03:09", "03:15", "you don't need an antibiotic now, no azithromycin")
    s8 = c.span(D, "03:16", "03:22", "no need for a chest X-ray right now")
    s9 = c.span(D, "03:30", "03:40", "take levocetirizine 5 at night for five days")
    s10 = c.span(D, "03:45", "03:52", "do steam twice a day and warm water gargles")
    s11 = c.span(D, "03:53", "03:56", "symptomatic treatment for now")
    c.word("lifestyle", "Do steam twice a day and warm water gargles.", [s10], counselling=True)
    c.gx = dict(
        presenting_complaints=dict(symptoms="Dry cough for 5 days. No fever. No chest pain. No breathlessness.",
                                   diagnoses=[dict(diagnosis_or_impression="Acute upper respiratory tract infection", is_differential_diagnosis=False, raw_name="URTI", aliases=["Upper respiratory tract infection"])]),
        examination="Chest clear on auscultation. SpO2 98%.",
        medicines=[],
        plan_of_management=dict(management_plan="Symptomatic treatment. " + PLAN_LINE, requires_surgery_or_procedure=False),
        general_advice=c.advice())
    p1 = c.prompt("medicine", "start", D, ["notes_only"], attrs(strength=att("5", [s9]), frequency=att("at night", [s9]),
                  duration=att("five days", [s9])), drug("levocetirizine 5", "LEVOCETIRIZINE", strength="5"))
    p2 = c.prompt("medicine", "not_given", D, ["notes_only", "not_given"], drug_=drug("azithromycin", "AZITHROMYCIN"))
    p3 = c.prompt("investigation", "not_given", D, ["not_given"], name="Chest X-ray")
    c.item("e2-sym", "symptoms", "dry cough 5 days; denies fever, chest pain, breathlessness", "prescribed", [s1, s2, s3],
           "/presenting_complaints/symptoms", negated=True)
    c.item("e2-exam", "examination", "chest clear, SpO2 98", "prescribed", [s4], "/examination")
    c.item("e2-dx", "diagnosis", "URTI", "prescribed", [s5], "/presenting_complaints/diagnoses/0")
    c.item("e2-abx", "medicine", "Azithromycin", "not_given", [s6, s7], prompt_id=p2, negated=True, flags=["negation_cue_nearby"],
           names=["azithromycin", "Azithromycin 500", "Azithral", "Zithromax"])
    c.item("e2-cxr", "investigation", "Chest X-ray", "not_given", [s8], prompt_id=p3, negated=True, flags=["negation_cue_nearby"],
           names=["Chest X-ray", "CXR", "X-ray chest PA view"])
    c.item("e2-plan", "management_plan", "symptomatic; medication changes on the confirm list", "prescribed", [s11, s7],
           "/plan_of_management/management_plan")
    c.item("e2-med", "medicine", "Levocetirizine 5 mg at night for 5 days", "prescribed", [s9], prompt_id=p1, names=["levocetirizine"])
    c.item("e2-adv", "advice", "steam inhalation, gargles", "prescribed", [s10], "/general_advice")
    return c.build()


def ex3():
    """Stopped drug: glimepiride is a stop prompt, never named in note_text. Metformin is a change_dose prompt; levothyroxine
    is a patient-raised continue prompt whose values are affirmed_from_patient, never supported. Duration sent as YEARS."""
    c = Consult(3, ["en", "kn"], 19, [doc(450), pat(300)])
    s1 = c.span(P, "00:30", "00:36", "I have sugar for five years", "kn", "nanage aidu varshadinda sugar ide")
    s2 = c.span(D, "00:37", "00:40", "diabetes for five years")
    s3 = c.span(P, "00:40", "00:52", "for a week I feel giddy and sweat in the morning", "kn", "ondu vaaradinda beligge talesuttu, bevaru baruttade")
    s4 = c.span(D, "00:53", "01:00", "giddiness and sweating in the mornings for one week")
    s5 = c.span(D, "02:00", "02:15", "BP 128 by 82, pulse 88, sugar 72")
    s6 = c.span(D, "03:00", "03:06", "this could be low sugar from the glimepiride")
    s7 = c.span(D, "03:07", "03:15", "stop the glimepiride from today")
    s8 = c.span(D, "03:16", "03:24", "increase the metformin to 1000 twice a day after food")
    s9 = c.span(D, "03:25", "03:30", "keep glucose tablets with you, take one if you feel giddy")
    s10 = c.span(D, "04:00", "04:10", "do HbA1c and fasting sugar tomorrow morning")
    s11 = c.span(D, "04:12", "04:20", "don't skip meals")
    s12 = c.span(D, "04:30", "04:35", "come back with the reports")
    s13 = c.span(D, "04:36", "04:40", "we will recheck your sugars")
    s14 = c.span(P, "04:41", "04:46", "I also take levothyroxine 50 every morning")
    s15 = c.span(D, "04:47", "04:49", "yes, continue that")
    c.word("diet", "Don't skip meals.", [s11], counselling=True)
    c.word("follow_up", "Come back with the reports.", [s12])
    c.gx = dict(
        comorbidities=[dict(name="Type 2 Diabetes Mellitus", duration=dict(value=5, unit="YEARS"), raw_name="sugar", aliases=["T2DM", "Diabetes mellitus type 2"])],
        presenting_complaints=dict(symptoms="Giddiness and sweating in the mornings for 1 week.",
                                   diagnoses=[dict(diagnosis_or_impression="Hypoglycaemia", is_differential_diagnosis=True, raw_name="low sugar", aliases=["Hypoglycemia"])]),
        examination="BP 128/82. Pulse 88. Random blood sugar 72 mg/dL.",
        plan_of_management=dict(management_plan="Recheck sugars. " + PLAN_LINE, requires_surgery_or_procedure=False),
        medicines=[],
        further_investigations=[dict(name="HbA1c", urgent=False, instruction="", raw_name="HbA1c", aliases=["Glycated haemoglobin"]),
                                dict(name="Fasting Blood Sugar", urgent=False, instruction="fasting sample", raw_name="fasting sugar", aliases=["FBS"])],
        follow_up=dict(followup_type="FOLLOW_UP_WITH_REPORTS", follow_up_instructions="Come back with the reports."),
        general_advice=c.advice())
    p1 = c.prompt("medicine", "stop", D, ["notes_only", "stop_order"], drug_=drug("glimepiride", "GLIMEPIRIDE"))
    p2 = c.prompt("medicine", "change_dose", D, ["notes_only"], attrs(strength=att("1000", [s8]), frequency=att("twice a day", [s8]),
                  instruction=att("after food", [s8])), drug("metformin", "METFORMIN", strength="1000"))
    p3 = c.prompt("medicine", "start", D, ["notes_only"], attrs(dose=att("one", [s9]), instruction=att("if you feel giddy", [s9])),
                  drug("glucose tablets", "GLUCOSE"))
    c.item("e3-com", "comorbidity", "T2DM 5 years", "prescribed", [s1, s2], "/comorbidities/0", flags=["translation_uncertain"])
    c.item("e3-sym", "symptoms", "giddiness, sweating mornings 1 week", "prescribed", [s3, s4], "/presenting_complaints/symptoms")
    c.item("e3-exam", "examination", "BP 128/82, PR 88, RBS 72", "prescribed", [s5], "/examination")
    c.item("e3-dx", "diagnosis", "?hypoglycaemia", "prescribed", [s6], "/presenting_complaints/diagnoses/0")
    c.item("e3-glim", "medicine", "Glimepiride 1 mg", "stopped", [s7], prompt_id=p1, negated=True, flags=["negation_cue_nearby"],
           names=["glimepiride", "Glimepiride 1", "Amaryl"])
    af = "affirmed_from_patient"
    p4 = c.prompt("medicine", "continue", P, ["notes_only", "patient_reported", af],
                  attrs(strength=att("50", [s14, s15], af), frequency=att("every morning", [s14, s15], af)),
                  drug("levothyroxine 50", "LEVOTHYROXINE", strength="50"))
    c.item("e3-met", "medicine", "Metformin dose raised to 1000 BD", "continued", [s8], prompt_id=p2, names=["metformin", "Glycomet 500"])
    c.item("e3-thy", "medicine", "levothyroxine raised by the patient; doctor said continue", "continued", [s14, s15], support=af,
           prompt_id=p4, flags=[af], alignment="aligned_llm", names=["levothyroxine"])
    c.item("e3-glu", "medicine", "Glucose tablets when symptomatic", "prescribed", [s9], prompt_id=p3, flags=["duration_unstated"], names=["glucose"])
    c.item("e3-hba1c", "investigation", "HbA1c", "prescribed", [s10], "/further_investigations/0", names=["HbA1c"])
    c.item("e3-fbs", "investigation", "Fasting sugar", "prescribed", [s10], "/further_investigations/1", names=["Fasting Blood Sugar", "FBS"])
    c.item("e3-plan", "management_plan", "recheck; medication changes on the confirm list", "prescribed", [s13, s7], "/plan_of_management/management_plan")
    c.item("e3-fu", "follow_up", "review with reports", "prescribed", [s12], "/follow_up")
    c.item("e3-adv", "advice", "no skipped meals", "prescribed", [s11], "/general_advice")
    return c.build()


def ex4():
    """Fluid room: doctor, patient, attender, translator. The translator relay supports the dose; a translator-originated
    order (kidney scan) is never created: it stays a prompt with no supported attribute."""
    A, T = "speaker_2", "speaker_3"
    c = Consult(4, ["en", "kn"], 24, [
        doc(420), pat(90),
        rost(A, "attender", ["attender", "attender", "patient"], 160, cos=0.31),
        rost(T, "translator", ["translator", "translator", "unknown"], 210, cos=0.36, translator_of=D)])
    s1 = c.span(A, "00:30", "00:40", "she has burning when passing urine for three days", "kn", "ivarige mooru dinadinda moothra maaduvaaga uri")
    s2 = c.span(D, "00:41", "00:50", "burning while passing urine for three days, no fever")
    s3 = c.span(D, "02:00", "02:12", "abdomen soft, mild tenderness above the pubic bone")
    s4 = c.span(D, "03:00", "03:05", "likely a urinary tract infection")
    s5 = c.span(D, "03:06", "03:12", "get a urine routine and culture done")
    s6 = c.span(D, "03:20", "03:30", "nitrofurantoin 100 twice a day for five days after food")
    s7 = c.span(T, "03:31", "03:42", "doctor says nitrofurantoin 100, twice a day, five days, after food", "kn",
                "doctor heLtidaare nitrofurantoin nooru, dinakke eradu sala, aidu dina, oota aada mele", relay_of=s6)
    c.span(P, "03:43", "03:45", "twice a day?", "kn", "dinakke eradu sala?")
    s9 = c.span(D, "03:50", "03:56", "drink at least three litres of water a day")
    s10 = c.span(T, "03:57", "04:04", "doctor says drink at least three litres of water a day", "kn",
                 "doctor heLtidaare dinakke mooru litre neeru kudiyiri", relay_of=s9)
    s11 = c.span(T, "04:05", "04:10", "also get a kidney scan done", "kn", "kidney scan kooda maadisi")
    c.word("diet", "Drink at least three litres of water a day.", [s9, s10], emphasis=2, counselling=True)
    c.gx = dict(
        presenting_complaints=dict(symptoms="Burning while passing urine for 3 days. No fever.",
                                   diagnoses=[dict(diagnosis_or_impression="Urinary tract infection", is_differential_diagnosis=True, raw_name="urinary tract infection", aliases=["UTI"])]),
        examination="Abdomen soft. Mild suprapubic tenderness.",
        medicines=[],
        further_investigations=[dict(name="Urine Routine and Culture", urgent=False, instruction="", raw_name="urine routine and culture", aliases=["Urine R/M", "Urine C/S"])],
        general_advice=c.advice())
    rel = [s6, s7]
    p1 = c.prompt("medicine", "start", D, ["notes_only", "translator_relay"],
                  attrs(strength=att("100", rel), frequency=att("twice a day", rel), duration=att("five days", rel), instruction=att("after food", rel)),
                  drug("nitrofurantoin 100", "NITROFURANTOIN", strength="100"))
    p2 = c.prompt("investigation", "start", T, ["translator_relay", "not_order_capable"], name="Kidney scan")
    c.item("e4-sym", "symptoms", "dysuria 3 days, no fever", "prescribed", [s1, s2], "/presenting_complaints/symptoms", flags=["translation_uncertain"])
    c.item("e4-exam", "examination", "abdomen soft, suprapubic tenderness", "prescribed", [s3], "/examination")
    c.item("e4-dx", "diagnosis", "likely UTI", "prescribed", [s4], "/presenting_complaints/diagnoses/0")
    c.item("e4-urine", "investigation", "urine routine and culture", "prescribed", [s5], "/further_investigations/0", names=["Urine Routine and Culture"])
    c.item("e4-med", "medicine", "nitrofurantoin 100 BD x 5 days", "prescribed", rel, prompt_id=p1, flags=["translator_relay"], names=["nitrofurantoin"])
    c.item("e4-scan", "investigation", "kidney scan raised by the translator", "discussed_only", [s11], support="h_unattrib", prompt_id=p2,
           flags=["translator_relay", "not_order_capable"], alignment="unaligned", names=["Kidney scan"])
    c.item("e4-adv", "advice", "fluids", "prescribed", [s9, s10], "/general_advice")
    return c.build()


def ex5():
    """A staff voice gives instructions (its role votes are 3/3 doctor) while the doctor's voiceprint matches another
    label: section 2 conflict, so no label is order-capable and every order is a prompt."""
    S, DR = "speaker_1", "speaker_2"
    c = Consult(5, ["en"], 16, [
        pat(200, label="speaker_0"),
        rost(S, "staff", [TD, TD, TD], 140, cos=0.31),
        rost(DR, TD, ["other_clinician", TD, TD], 330, state="pass", cos=0.82, vp=True)])
    s1 = c.span("speaker_0", "00:30", "00:40", "my knee has been paining for two weeks since I slipped")
    s2 = c.span(DR, "00:41", "00:50", "right knee pain for two weeks after a slip, no swelling", segcheck=(0.79, True))
    s3 = c.span(DR, "02:00", "02:10", "mild tenderness on the inner side, full range of movement", segcheck=(0.77, True))
    s4 = c.span(DR, "03:00", "03:04", "this looks like a sprain", segcheck=(0.8, True))
    s5 = c.span(S, "03:10", "03:20", "take aceclofenac 100 twice a day after food for five days")
    s6 = c.span(S, "03:21", "03:25", "and get an X-ray of the right knee")
    s7 = c.span(DR, "03:30", "03:36", "apply ice for fifteen minutes three times a day", segcheck=(0.81, True))
    c.gx = dict(
        presenting_complaints=dict(symptoms="Right knee pain for 2 weeks after a slip. No swelling.",
                                   diagnoses=[dict(diagnosis_or_impression="Knee sprain", is_differential_diagnosis=True, raw_name="sprain", aliases=["Sprain of knee"])]),
        examination="Mild medial joint line tenderness. Full range of movement.",
        medicines=[])
    h = "h_unattrib"
    p1 = c.prompt("medicine", "start", S, ["notes_only", "not_order_capable"],
                  attrs(strength=att("100", [s5], h), frequency=att("twice a day", [s5], h), duration=att("five days", [s5], h),
                        instruction=att("after food", [s5], h)), drug("aceclofenac 100", "ACECLOFENAC", strength="100"))
    p2 = c.prompt("investigation", "start", S, ["not_order_capable"], name="X-ray right knee")
    c.item("e5-sym", "symptoms", "right knee pain 2 weeks after a slip", "prescribed", [s1, s2], "/presenting_complaints/symptoms")
    c.item("e5-exam", "examination", "medial tenderness, full ROM", "prescribed", [s3], "/examination")
    c.item("e5-dx", "diagnosis", "?knee sprain", "prescribed", [s4], "/presenting_complaints/diagnoses/0")
    c.item("e5-med", "medicine", "aceclofenac 100 BD x 5 days, said by a non-order-capable voice", "prescribed", [s5], support=h,
           prompt_id=p1, flags=["not_order_capable"], alignment="unaligned", names=["aceclofenac"])
    c.item("e5-xr", "investigation", "X-ray right knee, said by a non-order-capable voice", "prescribed", [s6], support=h,
           prompt_id=p2, flags=["not_order_capable"], alignment="unaligned", names=["X-ray right knee"])
    c.item("e5-ice", "advice", "ice three times a day; no order-capable voice in the room", "discussed_only", [s7], support=h,
           flags=["not_order_capable"], alignment="unaligned")
    return c.build()


def ex6():
    """Combination brand (Augmentin 625 Duo, attested) plus a LASA drug with strength unstated (prednisolone), a reversal
    resolved by final_position, and a red flag that must carry."""
    c = Consult(6, ["en"], 21, [doc(520), pat(240)])
    s1 = c.span(P, "00:30", "00:42", "I am breathless and wheezing for three days, and coughing yellow phlegm")
    s2 = c.span(D, "00:43", "00:52", "so wheeze and breathlessness for three days with yellow sputum")
    s3 = c.span(D, "02:00", "02:14", "wheeze on both sides, saturation 95, temperature 99.8")
    s4 = c.span(D, "03:00", "03:06", "this is an asthma flare with a chest infection")
    s5 = c.span(D, "03:10", "03:20", "take Augmentin 625 Duo twice a day after food for five days")
    s6 = c.span(D, "03:21", "03:32", "and prednisolone once a day in the morning after breakfast for five days")
    s7 = c.span(D, "03:40", "03:50", "if your breathing gets worse or your lips turn blue, go to the emergency department at once")
    s8 = c.span(D, "03:51", "04:00", "if your breathing gets worse or your lips turn blue, go to the emergency department at once, do not wait")
    s9 = c.span(D, "04:05", "04:08", "you may try steam inhalation")
    s10 = c.span(D, "04:09", "04:15", "actually, no steam for now, it can set off the wheeze")
    s11 = c.span(D, "04:16", "04:19", "avoid dust and smoke")
    s12 = c.span(D, "04:30", "04:34", "come back in five days")
    rf = "If your breathing gets worse or your lips turn blue, go to the emergency department at once."
    c.red_flags.append(dict(text_en=rf, cited_spans=[s7, s8], must_carry=True))
    c.word("warning", rf, [s7, s8], emphasis=2, counselling=True)
    c.word("lifestyle", "You may try steam inhalation.", [s9], firmness="hedged", final=False, superseded_by="dw3")
    c.word("lifestyle", "No steam for now, it can set off the wheeze.", [s10], counselling=True)
    c.word("lifestyle", "Avoid dust and smoke.", [s11], counselling=True)
    c.word("follow_up", "Come back in five days.", [s12])
    c.gx = dict(
        presenting_complaints=dict(symptoms="Breathlessness and wheeze for 3 days with yellow sputum.",
                                   diagnoses=[dict(diagnosis_or_impression="Acute exacerbation of asthma with lower respiratory tract infection",
                                                   is_differential_diagnosis=False, raw_name="asthma flare with a chest infection", aliases=["Asthma exacerbation"])]),
        examination="Bilateral wheeze. SpO2 95%. Temperature 99.8 F.",
        medicines=[],
        follow_up=dict(followup_type="MANDATORY_FOLLOW_UP", follow_up_instructions="Come back in five days."),
        general_advice=c.advice())
    p1 = c.prompt("medicine", "start", D, ["notes_only", "lasa"],
                  attrs(strength=att("625", [s5]), frequency=att("twice a day", [s5]), duration=att("five days", [s5]), instruction=att("after food", [s5])),
                  drug("Augmentin 625 Duo", "AMOXICILLIN + CLAVULANIC ACID", brand="Augmentin 625 Duo",
                       components=("AMOXICILLIN", "CLAVULANIC ACID"), strength="625", lasa="amoxiclav"))
    p2 = c.prompt("medicine", "start", D, ["notes_only", "lasa", "strength_unstated"],
                  attrs(frequency=att("once a day in the morning", [s6]), duration=att("five days", [s6]), instruction=att("after breakfast", [s6])),
                  drug("prednisolone", "PREDNISOLONE", lasa="prednisone"))
    c.item("e6-sym", "symptoms", "wheeze, breathlessness 3 days, yellow sputum", "prescribed", [s1, s2], "/presenting_complaints/symptoms")
    c.item("e6-exam", "examination", "bilateral wheeze, SpO2 95, T 99.8", "prescribed", [s3], "/examination")
    c.item("e6-dx", "diagnosis", "asthma exacerbation with LRTI", "prescribed", [s4], "/presenting_complaints/diagnoses/0")
    c.item("e6-amc", "medicine", "Augmentin 625 Duo BD x 5 days", "prescribed", [s5], prompt_id=p1, flags=["lasa"],
           names=["Augmentin 625 Duo", "amoxicillin", "clavulanic acid"])
    c.item("e6-pred", "medicine", "prednisolone OD x 5 days, strength unstated", "prescribed", [s6], prompt_id=p2,
           flags=["lasa", "strength_unstated"], names=["prednisolone"])
    c.item("e6-fu", "follow_up", "review in 5 days", "prescribed", [s12], "/follow_up")
    c.item("e6-adv", "advice", "red flag first; no steam; avoid dust and smoke", "prescribed", [s7, s8, s10, s11], "/general_advice")
    return c.build()


def ex7():
    """Withheld: the consult is in scope but has no role track. Empty gp_extraction, no note_text, one reason code."""
    c = Consult(7, ["en", "hi"], 18, [])
    return c.build(withheld_reasons=["no_role_track"], models=MODELS[:1], role_votes=False)


EXAMPLES = [("ex1-fever-patient-own-drug.json", ex1), ("ex2-negation-no-antibiotic-no-xray.json", ex2),
            ("ex3-stopped-glimepiride.json", ex3), ("ex4-fluid-room-translator-relay.json", ex4),
            ("ex5-staff-voice-voiceprint-conflict.json", ex5), ("ex6-combination-lasa-red-flag.json", ex6),
            ("ex7-withheld-no-role-track.json", ex7)]


def write(path, a):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(a, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main(out):
    os.makedirs(out, exist_ok=True)
    for name, fn in EXAMPLES:
        write(os.path.join(out, name), fn())
    print("written %d examples to %s" % (len(EXAMPLES), out))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else HERE)
