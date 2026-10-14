#!/usr/bin/env python3
"""v5_synthetic.py — INVENTED consults (no patient text; D1a-cleared fixtures) to trial the v5 imaging scope (ruling 164): plain CT IN; MRI, X-ray, ultrasound, echo, ECG, treadmill, blood tests OUT.
Each fixture is ~12 short lines. EXPECT = what the scope rule says the named / described answers should be (hi >= 0.5, lo < 0.5)."""
import u9, build_consult as bc, v4, v5

def consult(lines):
    return bc.state_text([{"i": i, "speaker": "Doctor" if i % 2 == 0 else "Speaker A", "en": t, "text": t, "lang": "en"} for i, t in enumerate(lines)])

FX = {
 "ct_plain_chest_advised": ({"n": "hi", "d": "hi"}, ["Your cough has been there for six weeks now.", "Yes doctor, and I get breathless on the stairs.", "The chest X-ray was not clear enough, so I want a CT scan of your chest.", "What is a CT scan?", "It is a scan where you lie on a table that slides through a large ring. It takes about ten minutes.", "Do I need an injection?", "No, this one is a plain CT, no contrast, so no injection and no need to fast.", "Any risk?", "A small amount of radiation, nothing more. Please do it in the next week at the radiology desk downstairs.", "Okay, I will go tomorrow."]),
 "ct_contrast_abdomen_explained": ({"n": "hi", "d": "hi"}, ["The pain on the right side keeps coming back.", "The ultrasound showed something near the liver.", "I would like a CT of the abdomen with contrast to look at it properly.", "Will it hurt?", "There is a needle for the dye, you may feel warm for a minute. Do not eat for four hours before.", "How long does it take?", "Twenty minutes in the department, the report the next day.", "Fine, book it please."]),
 "ct_named_only_mention": ({"n": "hi", "d": "lo"}, ["How is the knee now?", "Better with the exercises.", "Good. If it gets worse we can think of a CT scan sometime.", "Okay.", "For now continue the tablets and come back in a month.", "Thank you doctor."]),
 "ct_described_not_named": ({"n": "lo", "d": "hi"}, ["The headaches are worse in the mornings.", "Yes and I sometimes vomit.", "I want to take pictures of your head using the big ring machine that uses x-rays and goes round your head.", "Is it painful?", "You lie still on a bed that slides in for ten minutes, no injection today, and you can go home straight after.", "Okay, when?", "This week please."]),
 "ct_angio_heart_explained": ({"n": "hi", "d": "hi"}, ["You get the chest tightness on walking.", "Yes, especially uphill.", "I want a CT coronary angiogram to see the heart arteries.", "What is involved?", "A dye is given through a drip and a scanner takes pictures of the heart, you need a slow heart rate so I will give you a tablet the day before.", "How long?", "About thirty minutes in the department.", "Okay."]),
 "ct_head_plain_advised": ({"n": "hi", "d": "hi"}, ["The headaches are getting worse.", "Yes, and I feel dizzy.", "I am ordering a plain CT scan of the head, no contrast.", "Why?", "To check for bleeding or a swelling. It takes five minutes lying on the table, no injection.", "When?", "Today, at the radiology desk."]),
 "ct_report_reviewed_no_new_scan": ({"n": "hi", "d": "lo"}, ["You had the CT scan last month.", "Yes, here is the report.", "The report is normal, nothing needs to be done.", "So no more scans?", "No new scan is needed now.", "Thank you doctor."]),
 "mri_brain_optional": ({"n": "lo", "d": "lo"}, ["The dizziness is better now.", "Yes, only a little in the mornings.", "If you want reassurance we can do an MRI of the brain, it is optional.", "What is that?", "You lie in a tunnel for thirty minutes, noisy but painless.", "I will think about it.", "Or come back in three or four weeks."]),
 "mri_knee_advised": ({"n": "lo", "d": "lo"}, ["The knee still locks.", "I want an MRI of the knee to see the ligament.", "What is an MRI?", "You lie inside a tunnel with a strong magnet for thirty minutes, it is noisy and you must stay still.", "Any injection?", "No. Remove all metal, and tell them if you have a pacemaker.", "Okay I will book."]),
 "xray_chest_advised": ({"n": "lo", "d": "lo"}, ["The cough is not settling.", "Let us take a chest X-ray today.", "How is it done?", "You stand in front of the machine and hold your breath for a second. It takes two minutes.", "Is it safe?", "Yes, a very small dose. Go to the X-ray room on the ground floor now."]),
 "echo_advised": ({"n": "lo", "d": "lo"}, ["You get a fluttering in the chest.", "Yes, mostly at night.", "I will send you for an echocardiogram to look at the heart valves.", "How is that done?", "A probe with gel is moved on the chest for fifteen minutes, no injection, no radiation.", "Fine."]),
 "ultrasound_abdomen": ({"n": "lo", "d": "lo"}, ["The stomach pain again.", "Please get an ultrasound of the abdomen.", "Should I be fasting?", "Yes, six hours, and drink water so the bladder is full. It takes ten minutes with gel and a probe.", "Okay."]),
 "treadmill_ecg": ({"n": "lo", "d": "lo"}, ["The chest discomfort comes on when you walk fast.", "Yes.", "We will do a treadmill test with the ECG, you walk on a belt that goes faster every three minutes while we watch the heart tracing.", "Any risk?", "Very small; we stop if you feel unwell.", "Alright."]),
 "blood_tests_only": ({"n": "lo", "d": "lo"}, ["Your sugar was high last time.", "Yes doctor.", "Get fasting blood sugar, HbA1c and a lipid profile done, a small blood sample from the arm.", "Okay, morning?", "Yes, before breakfast."]),
 "septoplasty_control": ({"n": "hi", "d": "hi"}, ["What is the problem with your nose?", "It is blocked all the time and the spray did not help.", "Your septum is deviated, so I advise a septoplasty.", "What happens in it?", "Under general anaesthesia we straighten the septum through the nostril. You stay one night and rest for a week.", "Okay, we will plan it."]),
 "no_procedure_control": ({"n": "lo", "d": "lo"}, ["How is the sugar?", "Better.", "Continue the same tablets.", "Any giddiness?", "No.", "Come after two months."]),
}
if __name__ == "__main__":
    ok = 0; tot = 0
    for name, (exp, lines) in FX.items():
        st = consult(lines); res = {"v4n": [], "v4d": [], "v5n": [], "v5d": []}
        for _ in range(2):
            a = u9.ask(st, {"v4n": v4.A["named"], "v4d": v4.A["described"], "v5n": v5.A["named"], "v5d": v5.A["described"]})["answers"]
            for k in res:
                res[k].append(a[k]["noul"])
        m = {k: sum(v) / len(v) for k, v in res.items()}
        hit = lambda p, e: (p >= 0.5) == (e == "hi")
        r4 = hit(m["v4n"], exp["n"]) and hit(m["v4d"], exp["d"]); r5 = hit(m["v5n"], exp["n"]) and hit(m["v5d"], exp["d"])
        print(f"{name:32s} expect n={exp['n']} d={exp['d']} | v4 {m['v4n']:.2f}/{m['v4d']:.2f} {'ok ' if r4 else 'MISS'} | v5 {m['v5n']:.2f}/{m['v5d']:.2f} {'ok' if r5 else 'MISS'}", flush=True)
