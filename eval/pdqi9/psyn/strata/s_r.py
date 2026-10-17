"""S-R (30): Rx floor traps, 5 scripts per trap (ASSUMPTION: equal share of the 30).

Traps (spec A2.1): drug said then retracted; dose corrected; drug only by
attender or patient; drug never said; clip-bleed phrase; placeholder-prone field.
"""

from .. import lexicon
from ..core import base_consult
from .common import new_builder, scenario, standard_roster, wrong_doctor

STRATUM, PREFIX, N = "S-R", "SR", 30
TRAPS = ("retracted", "dose_corrected", "non_doctor_only", "never_said", "clip_bleed", "placeholder_prone")


def _extra_drug(sb, sc):
    used = {m[0] for m in sc["meds"]} | {sc["absent_drug"]}
    return sb.rng.choice([o for o in lexicon.NON_DOCTOR_ORDERS if o[0] not in used])


def generate(seed, pool):
    out = []
    for i in range(N):
        trap = TRAPS[i % len(TRAPS)]
        sb = new_builder(PREFIX, i, STRATUM, seed, pool)
        sb.split_cell = trap
        sc = scenario(sb, i)
        D, P, pd = standard_roster(sb)
        A = None
        hooks = {}

        if trap == "retracted":
            drug, fq, du, ins = _extra_drug(sb, sc)

            def after_meds(ids, drug=drug, fq=fq, du=du, ins=ins):
                spec = sb.med_spec(drug, fq, du, ins)
                t1 = sb.say(D, sb.med_text(spec))
                t2 = sb.say(D, sb.dline(f"No, actually, leave the {drug}, you do not need it"))
                sb.add_item("medicine", f"med:{drug}", sb.med_attrs(spec, [t1]), trap="retracted",
                            stances=[{"turn_id": t1, "value": "start", "strength": "firm"},
                                     {"turn_id": t2, "value": "retracted", "strength": "firm"}])
            hooks["after_meds"] = after_meds

        elif trap == "dose_corrected":
            def after_meds(ids):
                it = sb.item(ids["meds"][0])
                st = next(a for a in it["attributes"] if a["name"] == "strength")
                drug = it["canonical_key"][4:]
                alt = lexicon.ALT_STRENGTH[drug]
                t2 = sb.say(D, sb.dline(f"Sorry, correction, the {drug} should be {alt}, not {st['value']}"))
                st["forbidden_values"].append({"value": st["value"], "turn_ids": list(st["turn_ids"]),
                                               "label": "precedence_error"})
                it["stances"] = [{"turn_id": st["turn_ids"][0], "value": st["value"], "strength": "firm"},
                                 {"turn_id": t2, "value": alt, "strength": "firm"}]
                st.update(value=alt, surface=alt, turn_ids=[t2])
                it["trap"] = "dose_corrected"
            hooks["after_meds"] = after_meds

        elif trap == "non_doctor_only":
            if i % 2:
                A = sb.add_speaker("attender")
            who = A or P
            drug, fq, du, ins = _extra_drug(sb, sc)
            lang = sb.speaker(who)["language"]

            def before_close(ids, who=who, drug=drug, fq=fq, du=du, ins=ins, lang=lang):
                spec = sb.med_spec(drug, fq, du, ins)
                s = sb.surfaces(spec, lang)
                t = sb.say(who, f"We also have {drug} {s['strength']} at home, {s['dose']} {s['route']}, "
                                f"{s['frequency']}, {s['duration']}.")
                attrs = [a for a in sb.med_attrs(spec, [t], lang=lang) if a["name"] != "instruction"]
                sb.add_item("medicine", f"med:{drug}", attrs, trap="non_doctor_only")
                sb.say(D, sb.dline("Please take only the medicines I have written"))
            hooks["before_close"] = before_close

        elif trap == "never_said":
            def before_close(ids):
                sb.say(P, "Do I need any other medicine, doctor?" if sb.lang == "en"
                       else lexicon.PATIENT_FILLER[sb.lang][3])
                sb.say(D, sb.dline("No, what I have written is enough"))
                sb.add_item("medicine", f"med:{sc['absent_drug']}",
                            [{"name": "drug", "value": sc["absent_drug"], "surface": None, "turn_ids": []}],
                            trap="never_said")
            hooks["before_close"] = before_close

        elif trap == "clip_bleed":
            prev = sb.add_speaker("patient", note="previous_consult_patient")
            drug, fq, du, ins = _extra_drug(sb, sc)
            spec = sb.med_spec(drug, fq, du, ins)
            region = "pre_bleed" if i % 2 == 0 else "post_bleed"
            if region == "pre_bleed":
                t = sb.say(D, sb.med_text(spec), clip="pre_bleed")
                sb.say(prev, "Thank you, doctor.", clip="pre_bleed")
                sb.add_item("medicine", f"med:{drug}", sb.med_attrs(spec, [t]), trap="clip_bleed")
            sb.notes["bleed_region"] = region

        elif trap == "placeholder_prone":
            drug, fq, du, ins = _extra_drug(sb, sc)

            def after_meds(ids, drug=drug, fq=fq, ins=ins):
                spec = sb.med_spec(drug, fq, "3d", ins)
                s = sb.surfaces(spec)
                t = sb.say(D, sb.dline(f"Also {drug} {s['strength']}, {s['dose']} {s['route']}, {s['frequency']}, "
                                       f"{s['instruction']}, how many days I will tell you after the report"))
                attrs = sb.med_attrs(spec, [t])
                for a in attrs:
                    if a["name"] == "duration":
                        a.update(value=None, surface=None)
                sb.add_item("medicine", f"med:{drug}", attrs, trap="placeholder_prone")
                t2 = sb.say(D, sb.dline("The next visit date I will fix once the report comes"))
                sb.add_item("follow_up", "follow_up:date_after_report",
                            [{"name": "content", "value": None, "surface": None, "turn_ids": [t2]}],
                            trap="placeholder_prone")
            hooks["after_meds"] = after_meds

        base_consult(sb, sc, doctor=D, patient=P, **hooks)

        if trap == "clip_bleed" and sb.notes["bleed_region"] == "post_bleed":
            sb.speaker(prev)["note"] = "next_consult_patient"
            sb.say(D, sb.dline("Please come in, let me see, you were on this already"), clip="post_bleed")
            t2 = sb.say(D, sb.med_text(spec), clip="post_bleed")
            sb.add_item("medicine", f"med:{drug}", sb.med_attrs(spec, [t2]), trap="clip_bleed")
        sb.tag(f"rx:{trap}")
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    return out
