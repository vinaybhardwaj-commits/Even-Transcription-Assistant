#!/usr/bin/env python3
"""v6_trial.py — v5 (frozen) vs v6 DRAFT 1 on INVENTED fixtures (D1a-cleared; no patient text). Two runs each; prints named/described probabilities and stage-b status/category. Development only."""
import u9, v5, v6_draft as v6
from v5_synthetic import consult

FX = {  # name: (expect, lines)
 "ct_angio_advised": ({"cat": "intervention", "st": "proposed_now"}, ["You get chest tightness when you walk uphill.", "Yes for a month now.", "I want a CT coronary angiogram to look at the heart arteries.", "What is involved?", "A dye goes through a drip in the arm and the scanner takes pictures, about fifteen minutes, you must not eat for four hours.", "Okay doctor."]),
 "ct_angio_leg": ({"cat": "intervention", "st": "proposed_now"}, ["The leg pains when you walk a hundred steps.", "Yes and it goes away when I rest.", "We will do a CT angiogram of the legs to see which artery is narrow.", "Is it painful?", "Only the drip for the contrast dye. Drink plenty of water afterwards.", "All right."]),
 "ct_head_plain": ({"cat": "imaging_ct", "st": "proposed_now"}, ["The headaches are getting worse.", "Yes and I feel dizzy.", "I am ordering a plain CT scan of the head, no contrast.", "Why?", "To check for bleeding. It takes five minutes lying on the table.", "Okay."]),
 "ct_contrast_abdomen": ({"cat": "imaging_ct", "st": "proposed_now"}, ["The pain on the right side keeps coming back.", "The ultrasound showed something near the liver.", "I want a CT of the abdomen with contrast to look at it properly.", "Will it hurt?", "Only a drip for the dye. It takes twenty minutes.", "Fine."]),
 "calcium_score_ct": ({"n": "lo", "d": "lo"}, ["Your father had a heart attack at fifty.", "Yes doctor, so I worry.", "We can do a CT calcium score, a quick scan that counts the calcium in the heart arteries.", "Is it painful?", "No, ten minutes, no dye. It tells us your risk.", "Let me think about it."]),
 "manoeuvre_now": ({"st": "proposed_now"}, ["The room spins when I turn in bed.", "Let me check. Lie back with your head turned to the right.", "Stay there. I am now doing the repositioning manoeuvre for the crystals in your ear.", "It is spinning a lot.", "That is expected, it settles in a minute. Now the other side.", "Better now."]),
 "history_arthroscopy_elsewhere": ({"st": "history"}, ["Tell me about the knee.", "I had an arthroscopy two years ago at another hospital.", "And how did it go?", "Good for a year and then the pain came back.", "Then we will start physiotherapy and see you in a month.", "Okay."]),
 "history_gallbladder": ({"st": "history"}, ["Any past operations?", "My gallbladder was removed in 2019.", "Any problems since?", "No, everything is fine.", "Good, no need for anything else about that.", "Thank you."]),
 "general_explanation": ({"st": "mentioned_only"}, ["Many children get sore throats.", "Yes, my neighbour's son too.", "Sometimes doctors remove the tonsils in a small operation under anaesthesia, the child goes home the same day.", "Does my child need it?", "No, not at all. Just warm water gargles and the syrup.", "Okay."]),
 "conditional_ct": ({"st": "conditional"}, ["The cough has improved.", "Yes a little.", "Continue the medicines for two weeks.", "And if it does not go?", "If it persists after two weeks we will do a CT scan of the chest.", "Okay."]),
}

def main():
    for name, (exp, lines) in FX.items():
        st = consult(lines); rows = []
        for mod, tag in ((v5, "v5"), (v6, "v6")):
            r = []
            for _ in range(2):
                a = u9.ask(st, {**mod.A, **mod.B})["answers"]
                r.append((a["named"]["noul"], a["described"]["noul"], a["status"]["choice"], a["category"]["choice"]))
            rows.append((tag, r))
        def show(tag, r): return f"{tag} " + " / ".join(f"n{n:.2f} d{d:.2f} {s[:7]} {c[:7]}" for n, d, s, c in r)
        print(f"{name:30s} expect {exp} | " + " | ".join(show(t, r) for t, r in rows), flush=True)

if __name__ == "__main__":
    main()
