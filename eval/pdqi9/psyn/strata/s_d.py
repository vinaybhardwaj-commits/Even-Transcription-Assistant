"""S-D (20): doctor's-words recall. 10 firm/hedged pairs matched on content.

Every script carries one instruction per category (advice, counselling,
warning, lifestyle, follow_up, contingency); across the stratum each category
appears firm and hedged. Plus a reversal chain (final firm stance wins, a hedged
last stance does not override), repeated emphasis, an explicit doctor priority
order, counselling-heavy and contingency items, and the plan-2 role traps.
"""

import random

from .. import lexicon
from ..core import base_consult, decap
from .common import lang_for, new_builder, pick_doctor, wrong_doctor

STRATUM, PREFIX, N = "S-D", "SD", 20
CATS = ("advice", "counselling", "warning", "lifestyle", "follow_up", "contingency")
REVERSALS = [
    [("2d", "firm"), ("1d", "firm")],
    [("2d", "firm"), ("3d", "firm"), ("1d", "firm")],
    [("2d", "firm"), ("1d", "hedged")],
    [("3d", "firm"), ("2d", "firm"), ("1d", "hedged")],
]
DAYS = {"1d": "one day", "2d": "two days", "3d": "three days"}
RAISED = {"en": "Should I avoid cold drinks, doctor?", "hi": "Kya mujhe thanda peena band karna chahiye, doctor?",
          "kn": "Naanu tannage kudiyodu bidbeka, doctor?"}


def final_value(stances):
    firm = [s for s in stances if s["strength"] == "firm"]
    return (firm or stances)[-1]["value"]


def render(sb, content, strength, lang=None):
    c = content.rstrip(".")
    if strength == "firm":
        return sb.dline(f"{c}, this is a must", lang)
    return sb.dline(f"If you can, maybe {decap(c)}, but only if it suits you", lang)


def generate(seed, pool):
    out = []
    for i in range(N):
        k, m = divmod(i, 2)
        prng = random.Random(f"psyn-sd-pair|{seed}|{k}")
        mode, cs = lang_for(k)
        sb = new_builder(PREFIX, i, STRATUM, seed, pool, mode, cs)
        sb.split_group = f"SD-PAIR-{k + 1:02d}"
        sc = lexicon.SCENARIOS[k % len(lexicon.SCENARIOS)]
        sb.scenario = sc["key"]
        pd = pick_doctor(prng)
        D = sb.add_speaker("treating_doctor", pseudo_doctor=pd, treating=True)
        P = sb.add_speaker("patient")
        strengths = {c: ("firm" if (j + k) % 2 == 0 else "hedged") for j, c in enumerate(CATS)}
        flipped = (CATS[k % 6], CATS[(k + 3) % 6])
        if m == 1:
            for c in flipped:
                strengths[c] = "hedged" if strengths[c] == "firm" else "firm"
        cs_turn_lang = "hi" if k % 4 == 0 else "kn"

        def before_close(ids, sc=sc, strengths=strengths, k=k, cs_turn_lang=cs_turn_lang):
            plang = sb.speaker(P)["language"]
            for c in CATS:
                key, txt = sc[c]
                lang = cs_turn_lang if (c == "lifestyle" and sb.lang == "en") else None
                t = sb.say(D, render(sb, txt, strengths[c], lang), lang=lang)
                ids[c] = sb.add_item(c, f"{c}:{key}", [{"name": "content", "value": f"{c}:{key}", "surface": txt,
                                                        "turn_ids": [t]}], strength=strengths[c],
                                     trap="codeswitch_turn" if lang else None)
            # counselling-heavy extra
            t = sb.say(D, sb.dline("These tablets can cause mild stomach upset in the first few days, that is expected"))
            sb.add_item("counselling", "counselling:side_effects_expected",
                        [{"name": "content", "value": "counselling:side_effects_expected",
                          "surface": "mild stomach upset in the first few days is expected", "turn_ids": [t]}])
            # emphasis on the warning
            w = sb.item(ids["warning"])
            for _ in range(1 + k % 2):
                t = sb.say(D, sb.dline("I will say it again, " + decap(w["attributes"][0]["surface"])))
                w["attributes"][0]["turn_ids"].append(t)
                w["emphasis"]["repeat_count"] += 1
            w["emphasis"]["stressed"] = k % 3 == 0
            if w["emphasis"]["stressed"]:
                t = sb.say(D, sb.dline("This is very, very important"))
                w["attributes"][0]["turn_ids"].append(t)
            # reversal chain on days off work
            chain = REVERSALS[k % len(REVERSALS)]
            stances = []
            for j, (v, st) in enumerate(chain):
                lead = "Take" if j == 0 else "Actually, take"
                body = f"{lead} {DAYS[v]} off work"
                t = sb.say(D, sb.dline(body) if st == "firm" else render(sb, body, "hedged"))
                stances.append({"turn_id": t, "value": v, "strength": st})
            fv = final_value(stances)
            fin = next(s for s in stances if s["value"] == fv and s["strength"] == "firm")
            sb.add_item("advice", "advice:days_off_work",
                        [{"name": "content", "value": f"days_off:{fv}", "surface": f"{DAYS[fv]} off work",
                          "turn_ids": [fin["turn_id"]],
                          "forbidden_values": [{"value": f"days_off:{s['value']}", "turn_ids": [s["turn_id"]],
                                                "label": "precedence_error"} for s in stances if s["value"] != fv]}],
                        trap="reversal", stances=stances)
            # explicit priority order
            order = [("warning", "warning"), ("lifestyle", "lifestyle"), ("advice", "advice")]
            prng2 = random.Random(f"psyn-sd-prio|{k}")
            prng2.shuffle(order)
            names = [sb.item(ids[c])["attributes"][0]["surface"].rstrip(".") for c, _ in order]
            t = sb.say(D, sb.dline(f"The most important thing is: {decap(names[0])}. Second, {decap(names[1])}. "
                                   f"Third, {decap(names[2])}"))
            for r, (c, _) in enumerate(order, 1):
                it = sb.item(ids[c])
                it["priority_rank"] = r
                it["attributes"][0]["turn_ids"].append(t)
                it["emphasis"]["repeat_count"] += 1
            # role traps: patient-only instruction; doctor affirms a patient-raised item
            key, txt = lexicon.NON_DOCTOR_INSTRUCTIONS["patient"][k % 3]
            t = sb.say(P, txt + ".")
            sb.add_item("advice", f"advice:{key}", [{"name": "content", "value": f"advice:{key}", "surface": txt,
                                                     "turn_ids": [t]}], trap="non_doctor_only")
            tp = sb.say(P, RAISED[plang])
            td = sb.say(D, sb.dline("Yes, avoid cold drinks for now"))
            sb.add_item("advice", "advice:avoid_cold_drinks",
                        [{"name": "content", "value": "advice:avoid_cold_drinks", "surface": "avoid cold drinks",
                          "turn_ids": [td], "context_turn_ids": [tp]}], affirmed_patient_raised=True,
                        trap="doctor_affirms_patient_raised")

        base_consult(sb, sc, doctor=D, patient=P, opts={"custom_instructions": True}, before_close=before_close)
        sb.notes["pair_flipped_categories"] = list(flipped)
        sb.tag("sd:pair_member_" + "ab"[m])
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    return out
