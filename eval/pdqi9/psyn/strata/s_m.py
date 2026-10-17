"""S-M (18): merged-label diarisation (spec A2.1 [v6, v7], A4.1a.8).

The treating doctor and one other voice share one intended diarisation label
(6 patient, 4 attender, 4 junior clinician, 4 translator). The other voice
speaks drug, dose, test and referral items inside the merged label. [v7] In all
6 patient-merged scripts and in 2 of the 4 attender-merged scripts the other
voice also speaks route, frequency and duration on its own segment, each a
separate truth-sheet attribute. The doctor also speaks one medicine with drug,
strength and dose on very short segments.
"""

from .. import lexicon
from ..core import base_consult
from .common import new_builder, pick_doctor, scenario, standard_roster, wrong_doctor

STRATUM, PREFIX, N = "S-M", "SM", 18
SUBTYPES = (("patient", 6), ("attender_fdr", 2), ("attender_plain", 2), ("junior", 4), ("translator", 4))
MERGED_LABEL = "L0"
CONTRADICTION_SHARE_MAX = 0.2  # A4.1a.5; the generator keeps other-voice seconds on L_c below it
PAD_TARGET_SHARE = 0.17
MIN_DOCTOR_TURNS = 20

ROLE = {"patient": "patient", "attender_fdr": "attender", "attender_plain": "attender",
        "junior": "other_clinician", "translator": "translator"}
ASK = {
    "en": "Can I also take {drug} {strength}, {dose}?",
    "hi": "Kya {drug} {strength} bhi le sakte hain, {dose}?",
    "kn": "{drug} {strength} kooda tagobahuda, {dose}?",
}
FDR = {
    "en": "{route}, {frequency}, {duration}, that is how it is usually taken.",
    "hi": "{route}, {frequency}, {duration}, aise hi lete hain.",
    "kn": "{route}, {frequency}, {duration}, haage tagotaare.",
}
TEST = {"en": "Should we also get {t}?", "hi": "Kya {t} bhi karwa lein?", "kn": "{t} kooda maadisbeka?"}
REF = {"en": "Maybe we should also see {r}.", "hi": "Shayad {r} bhi dikhana chahiye.", "kn": "Bahusha {r} kooda nodbeku."}


def plan():
    for sub, n in SUBTYPES:
        for j in range(n):
            yield sub, j


def merged_share(sb, other):
    lab = [t for t in sb.turns if t["intended_diar_label"] == MERGED_LABEL and t["clip_region"] == "in_clip"]
    tot = sum(t["est_seconds"] for t in lab)
    oth = sum(t["est_seconds"] for t in lab if t["speaker_id"] == other)
    return oth / tot if tot else 0.0


def generate(seed, pool):
    out = []
    for i, (sub, j) in enumerate(plan()):
        translator = sub == "translator"
        if translator:
            sb = new_builder(PREFIX, i, STRATUM, seed, pool, "cs", "hi" if j % 2 == 0 else "kn")
            sb.doctor_lang = "en"
        else:
            sb = new_builder(PREFIX, i, STRATUM, seed, pool)
        sb.split_cell = sub
        sc = scenario(sb, i)
        role = ROLE[sub]
        if role == "patient":
            pd = pick_doctor(sb.rng)
            D = sb.add_speaker("treating_doctor", pseudo_doctor=pd, treating=True, diar_label=MERGED_LABEL)
            P = sb.add_speaker("patient", diar_label=MERGED_LABEL, note="merged_with_treating_doctor")
            O = P
        else:
            D, P, pd = standard_roster(sb, patient_lang=sb.cs_lang if translator else None)
            sb.speaker(D)["intended_diar_label"] = MERGED_LABEL
            sb.speaker(P)["intended_diar_label"] = "L1"
            O = sb.add_speaker(role, diar_label=MERGED_LABEL, note="merged_with_treating_doctor",
                               language=sb.cs_lang if translator else (sb.dlang if role == "other_clinician" else None))
        fdr = sub in ("patient", "attender_fdr")
        olang = sb.speaker(O)["language"]

        def after_meds(ids, O=O, olang=olang, fdr=fdr, j=j):
            used = {m[0] for m in sc["meds"]}
            others = [o for o in lexicon.NON_DOCTOR_ORDERS if o[0] not in used]
            drug, fq, du, ins = others[j % len(others)]
            spec = sb.med_spec(drug, fq, du, ins)
            s = sb.surfaces(spec, olang)
            t1 = sb.say(O, ASK[olang].format(drug=drug, strength=s["strength"], dose=s["dose"]))
            attrs = [a for a in sb.med_attrs(spec, [t1], lang=olang) if a["name"] in ("drug", "strength", "dose")]
            if fdr:
                t2 = sb.say(O, FDR[olang].format(route=s["route"], frequency=s["frequency"], duration=s["duration"]))
                attrs += [a for a in sb.med_attrs(spec, [t2], lang=olang) if a["name"] in ("route", "frequency", "duration")]
            sb.add_item("medicine", f"med:{drug}", attrs, trap="merged_other_voice")
            tk, ttxt = lexicon.NON_DOCTOR_TESTS[j % 4]
            t = sb.say(O, TEST[olang].format(t=ttxt))
            sb.add_item("investigation", f"test:{tk}", [{"name": "test", "value": f"test:{tk}", "surface": ttxt,
                                                         "turn_ids": [t]}], trap="merged_other_voice")
            rk, rtxt = lexicon.NON_DOCTOR_REFERRALS[j % 4]
            t = sb.say(O, REF[olang].format(r=rtxt))
            sb.add_item("referral", f"ref:{rk}", [{"name": "referral", "value": f"ref:{rk}", "surface": rtxt,
                                                   "turn_ids": [t]}], trap="merged_other_voice")
            sb.say(sb.treating, sb.dline("Let us stay with the plan I have given"))
            # doctor order on very short segments: drug, strength, dose each on its own segment
            single = [d for d in lexicon.DRUGS if " " not in d and d not in used and d != drug
                      and lexicon.DRUGS[d]["dose"] != "halftab"]
            sdrug = single[(j * 5 + 3) % len(single)]
            sspec = sb.med_spec(sdrug, "OD", "5d", "after_food")
            ss = sb.surfaces(sspec)
            ta = sb.say(sb.treating, f"{sdrug.capitalize()}.", short=True)
            tb = sb.say(sb.treating, f"{ss['strength']}.", short=True)
            tc = sb.say(sb.treating, f"{ss['dose'].capitalize()}.", short=True)
            td = sb.say(sb.treating, sb.dline(f"{ss['route']}, {ss['frequency']}, {ss['duration']}, {ss['instruction']}"))
            attrs = sb.med_attrs(sspec, [td])
            for a, t in zip(attrs[:3], (ta, tb, tc)):
                a["turn_ids"] = [t]
            sb.add_item("medicine", f"med:{sdrug}", attrs, trap="doctor_short_segment")
            if translator:
                for iid in ids["meds"]:
                    it = sb.item(iid)
                    dt = it["attributes"][0]["turn_ids"][0]
                    spec_d = {a["name"]: a["value"] for a in it["attributes"]}
                    rt = sb.say(O, sb.med_text(spec_d, lang=olang), relay_of=dt)
                    for a in it["attributes"]:
                        a["relay_turn_ids"].append(rt)
                    sb.relays.append({"relay_turn_id": rt, "of_turn_id": dt, "item_id": iid, "changes_value": False,
                                      "adds_content": False, "changed_attribute": None, "relay_value": None,
                                      "doctor_value": None, "expected_event": "relay"})

        def before_close(ids, O=O):
            sb.pad_doctor(MIN_DOCTOR_TURNS - 1, patient=None)
            filler = list(lexicon.DOCTOR_FILLER)
            n = 0
            while merged_share(sb, O) > PAD_TARGET_SHARE:
                sb.say(sb.treating, sb.dline(filler[n % len(filler)]))
                n += 1

        base_consult(sb, sc, doctor=D, patient=P, after_meds=after_meds, before_close=before_close)
        share = merged_share(sb, O)
        assert share <= CONTRADICTION_SHARE_MAX, (sb.script_id, share)
        sb.notes.update({"merged_label": MERGED_LABEL, "merged_other_speaker_id": O, "merged_other_role": role,
                         "patient_attender_fdr_rule": fdr, "est_other_voice_share_of_label": round(share, 3)})
        sb.tag(f"sm:{sub}")
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    assert len(out) == N
    return out
