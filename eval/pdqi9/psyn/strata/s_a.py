"""S-A (10): affect-only. 5 matched pairs: a flat control and a worried, confused or
hesitant patient, with identical doctor words. Expected: arm 4 adds nothing."""

import random

from .. import lexicon
from ..core import base_consult
from .common import lang_for, new_builder, pick_doctor, wrong_doctor

STRATUM, PREFIX, N = "S-A", "SA", 10
STATES = ("worried", "confused", "hesitant", "worried", "confused")
# ASSUMPTION: the two 2-2 split types are (state vs neutral) and (state vs other state).
DESIGNS = ("clear", "clear", "clear", "split_2_2_state_vs_neutral", "split_2_2_state_vs_state")
CUES = {
    "worried": {"en": "I am really worried, doctor.", "hi": "Mujhe bahut chinta ho rahi hai, doctor.",
                "kn": "Nanage tumba bhaya aagtide, doctor."},
    "confused": {"en": "Sorry, I did not quite follow.", "hi": "Maaf kijiye, samajh nahi aaya.",
                 "kn": "Kshamisi, artha aagalilla."},
    "hesitant": {"en": "Umm, well,", "hi": "Hmm, matlab,", "kn": "Hmm, adu,"},
}


def generate(seed, pool):
    out = []
    for i in range(N):
        k, m = divmod(i, 2)
        prng = random.Random(f"psyn-sa-pair|{seed}|{k}")
        mode, cs = lang_for(k)
        sb = new_builder(PREFIX, i, STRATUM, seed, pool, mode, cs)
        sb.split_group = f"SA-PAIR-{k + 1:02d}"
        sc = lexicon.SCENARIOS[(k * 3) % len(lexicon.SCENARIOS)]
        sb.scenario = sc["key"]
        pd = pick_doctor(prng)
        D = sb.add_speaker("treating_doctor", pseudo_doctor=pd, treating=True)
        P = sb.add_speaker("patient")
        state = STATES[k] if m == 1 else "flat"

        def before_close(ids, k=k):
            key, txt = lexicon.NON_DOCTOR_INSTRUCTIONS["patient"][k % 3]
            t = sb.say(P, txt + ".")
            sb.add_item("advice", f"advice:{key}", [{"name": "content", "value": f"advice:{key}", "surface": txt,
                                                     "turn_ids": [t]}], trap="patient_only_in_affect_scene")

        base_consult(sb, sc, doctor=D, patient=P, before_close=before_close)
        pturns = [t for t in sb.turns if t["speaker_id"] == P]
        if state != "flat":
            for t in pturns:
                t["text"] = f"{CUES[state][t['lang']]} {t['text']}"
                t["affect"] = state
                t["est_seconds"] = max(t["est_seconds"], round(len(t["text"].split()) / 2.6, 1))
        else:
            for t in pturns:
                t["affect"] = "flat"
        sb.affect_scenes.append({
            "scene_id": "A1", "speaker_id": P, "turn_ids": [t["turn_id"] for t in pturns],
            "intended_state": state, "agreement_design": DESIGNS[k] if m == 1 else "flat_control",
            "expected_arm4_effect": "reorder_or_emphasis_only" if (m == 1 and DESIGNS[k] == "clear") else "none",
            "new_items_allowed": 0,
        })
        sb.tag(f"affect:{state}")
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    return out
