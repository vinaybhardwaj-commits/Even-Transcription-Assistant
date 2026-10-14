"""link3_judge.py: the content link question for P1 link 3 (P1-PREREG-v7.3.md) and its SYNTHETIC scale check.
Route (rulings 35, 42): both texts are de-identified locally (deid.py, then finalize.residual_identifiers) BEFORE any call; Jev only sees clean text.
This file contains no patient text: the scale check uses invented pairs. The wording below is frozen by v7.3.

  python3 link3_judge.py scale      runs the synthetic scale check (16 Jev calls), prints and writes results (no patient data)
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "2026-09-24-surgery-review-v2"))

LINK_QUESTION = {"same_visit": {"type": "noul", "instructions":
    "The state has two parts: a consultation transcript, and a prescription (its presenting complaints and its medications). Do they describe the same patient visit? "
    "Answer yes only if the transcript's main complaint matches the prescription's complaints AND the medications the doctor prescribes or discusses in the transcript are consistent with the prescription's medications. "
    "Answer no if the main complaint or the medications differ. Ignore any operation or procedure that is named; judge only the complaint and the medications."}}


def build_state(transcript, rx_text):
    return f"CONSULTATION TRANSCRIPT:\n{transcript.strip()}\n\nPRESCRIPTION - COMPLAINTS AND MEDICATIONS:\n{rx_text.strip()}"


def score(transcript, rx_text, ask=None):
    import u9
    ask = ask or u9.ask
    a = ask(build_state(transcript, rx_text), LINK_QUESTION)["answers"]["same_visit"]
    return float(a["noul"])


# ---- synthetic scale check: invented visits, no real people, no real text ----
T = {
 "fever": "Doctor: What brings you in? Patient: Fever for three days and a dry cough, and I feel very tired. Doctor: Any breathlessness? Patient: No. Doctor: Let me listen to your chest. Clear. I will give paracetamol for the fever and azithromycin for five days. Drink plenty of fluids.",
 "knee": "Doctor: Tell me about the knee. Patient: Right knee pain for two months, worse on stairs, no injury. Doctor: Swelling? Patient: A little in the evening. Doctor: I will prescribe etoricoxib for one week and a diclofenac gel, and send you for physiotherapy.",
 "urine": "Doctor: What is the problem? Patient: Burning while passing urine since yesterday and I pass urine very often. Doctor: Any fever? Patient: No. Doctor: This looks like a urine infection. I will send a urine test and start nitrofurantoin for five days. Drink more water.",
 "bp": "Doctor: This is your blood pressure review. Patient: Yes, I have had no headaches. Doctor: Readings are one forty over ninety. Continue amlodipine five milligrams every morning and reduce salt. Come back in a month.",
 "cough_cold": "Doctor: What is wrong? Patient: Runny nose and cough for four days, no fever. Doctor: No wheeze. I will give cetirizine at night and a cough syrup with honey and ginger. Steam inhalation twice daily.",
 "migraine": "Doctor: Describe the headache. Patient: Throbbing on the left side with nausea and light bothers me, twice a month. Doctor: This sounds like migraine. Take sumatriptan at the start of an attack and ondansetron for the nausea.",
 "gastritis": "Doctor: What is troubling you? Patient: Burning in the upper stomach after spicy food, worse when I skip meals. Doctor: Any vomiting? No. I will give pantoprazole before breakfast for two weeks and an antacid syrup after meals.",
 "back": "Doctor: Where is the pain? Patient: Lower back after lifting, no pain going down the leg. Doctor: Muscle strain. I will give a muscle relaxant, thiocolchicoside, and a short course of paracetamol, and advise hot fomentation.",
}
R = {
 "fever": "Complaints: fever 3 days, dry cough, fatigue. Medications: paracetamol; azithromycin 5 days.",
 "knee": "Complaints: right knee pain 2 months, worse on stairs, mild evening swelling. Medications: etoricoxib 1 week; diclofenac gel; physiotherapy referral.",
 "urine": "Complaints: burning micturition since 1 day, increased frequency. Medications: nitrofurantoin 5 days; urine routine test.",
 "bp": "Complaints: hypertension review, no symptoms. Medications: amlodipine 5 mg morning; low salt diet.",
 "cough_cold": "Complaints: runny nose and cough 4 days, no fever. Medications: cetirizine at night; honey-ginger cough syrup; steam inhalation.",
 "cough_wheeze": "Complaints: cough with wheeze and breathlessness at night for 1 week. Medications: salbutamol inhaler; montelukast at night.",
 "migraine": "Complaints: left-sided throbbing headache with nausea and photophobia, twice a month. Medications: sumatriptan at onset; ondansetron.",
 "tension": "Complaints: band-like headache both sides after long work hours, no nausea. Medications: paracetamol; neck stretching exercises.",
 "gastritis": "Complaints: upper abdominal burning after spicy food, worse when meals skipped. Medications: pantoprazole 2 weeks; antacid syrup.",
 "reflux": "Complaints: chest burning and sour taste on lying down at night, regurgitation. Medications: rabeprazole; domperidone; raise head of bed.",
 "back": "Complaints: lower back pain after lifting, no leg radiation. Medications: thiocolchicoside; paracetamol; hot fomentation.",
 "sciatica": "Complaints: lower back pain shooting down the left leg with tingling. Medications: pregabalin at night; diclofenac; physiotherapy.",
}
# A: clear matches (4); B: clear mismatches (4); C: transcript against its own Rx and a same-day near-decoy (4)
A = [("fever", "fever"), ("knee", "knee"), ("urine", "urine"), ("bp", "bp")]
B = [("fever", "urine"), ("knee", "bp"), ("urine", "migraine"), ("bp", "fever")]
C = [("cough_cold", "cough_cold", "cough_wheeze"), ("migraine", "migraine", "tension"), ("gastritis", "gastritis", "reflux"), ("back", "back", "sciatica")]
# pre-registered acceptance (v7.3 E2): A: p >= 0.70 for at least 3 of 4; B: p <= 0.30 for at least 3 of 4; C: own >= 0.50 and own - decoy >= 0.15 for at least 3 of 4


def scale_check(ask=None):
    res = {"A": [], "B": [], "C": []}
    for t, r in A: res["A"].append(dict(pair=f"{t}/{r}", p=score(T[t], R[r], ask)))
    for t, r in B: res["B"].append(dict(pair=f"{t}/{r}", p=score(T[t], R[r], ask)))
    for t, own, dec in C: res["C"].append(dict(pair=f"{t}: own {own} vs decoy {dec}", own=score(T[t], R[own], ask), decoy=score(T[t], R[dec], ask)))
    a_ok = sum(x["p"] >= 0.70 for x in res["A"]); b_ok = sum(x["p"] <= 0.30 for x in res["B"])
    c_ok = sum(x["own"] >= 0.50 and (x["own"] - x["decoy"]) >= 0.15 for x in res["C"])
    res["criteria"] = dict(A_matches_ge_0_70=f"{a_ok}/4", B_mismatches_le_0_30=f"{b_ok}/4", C_own_ge_0_50_and_margin_ge_0_15=f"{c_ok}/4", PASS=(a_ok >= 3 and b_ok >= 3 and c_ok >= 3))
    return res


# ---- HARD synthetic set (v7.3a): decoys that share the complaint or the medicines, or are near-identical routine follow-ups. Invented text only. ----
HT = {
 "knee2": "Doctor: How is the knee? Patient: Left knee pain for six weeks, stiff in the morning, worse after walking. Doctor: I will give etoricoxib for ten days, a diclofenac gel to rub in, and advise physiotherapy.",
 "gastric": "Doctor: What is the trouble? Patient: Burning in the stomach after meals for two weeks. Doctor: I will start pantoprazole before breakfast and an antacid syrup after meals, and avoid spicy food.",
 "htn": "Doctor: This is your blood pressure review. Patient: No symptoms. Doctor: One forty five over ninety five. Continue amlodipine five milligrams in the morning and cut down on salt.",
 "throat": "Doctor: Tell me about the throat. Patient: Sore throat and pain on swallowing for three days, no cough. Doctor: I will prescribe amoxicillin with clavulanic acid for five days, paracetamol for pain, and warm salt water gargles.",
 "headache": "Doctor: Describe the headache. Patient: A tight band around the head after long hours at the computer, no nausea, no vomiting. Doctor: This is a tension headache. Take paracetamol six fifty when it starts and rest your eyes.",
 "acidity": "Doctor: What is bothering you? Patient: Heartburn after meals and a sour taste, especially at night. Doctor: I will start pantoprazole forty milligrams before breakfast for two weeks.",
 "rhinitis": "Doctor: What is the problem? Patient: Sneezing, itchy eyes and a blocked nose every morning for two weeks, worse with dust. Doctor: This is allergic rhinitis. I will give cetirizine ten milligrams at night.",
 "knee_gel": "Doctor: Where is the pain? Patient: Right knee pain after climbing stairs for a month. Doctor: I will give diclofenac gel to apply twice daily and advise leg strengthening exercises.",
 "dm": "Doctor: Diabetes follow-up. Patient: Sugars are stable, no new problems. Doctor: Continue metformin five hundred milligrams twice daily with meals and keep the diet plan.",
 "htn2": "Doctor: Blood pressure check. Patient: I feel fine. Doctor: Readings are good. Continue amlodipine five milligrams every morning.",
 "thyroid": "Doctor: Thyroid review. Patient: No new symptoms. Doctor: Continue levothyroxine fifty micrograms on an empty stomach every morning and repeat the blood test in three months.",
 "uri": "Doctor: What is wrong? Patient: Cold and cough for three days, mild sore throat, no fever. Doctor: This is a viral cold. Paracetamol if needed, cetirizine at night, and warm fluids.",
}
HR = {
 "knee2": "Complaints: left knee pain 6 weeks, morning stiffness, worse after walking. Medications: etoricoxib 10 days; diclofenac gel; physiotherapy.",
 "knee2_d": "Complaints: knee pain for two months with stiffness. Medications: naproxen tablets twice daily; glucosamine; hot pack.",
 "gastric": "Complaints: burning in the stomach after meals, 2 weeks. Medications: pantoprazole before breakfast; antacid syrup after meals.",
 "gastric_d": "Complaints: burning in the upper stomach after meals for a week. Medications: famotidine at night; sucralfate suspension.",
 "htn": "Complaints: hypertension review, no symptoms. Medications: amlodipine 5 mg morning; low salt diet.",
 "htn_d": "Complaints: hypertension review, no symptoms. Medications: telmisartan 40 mg; hydrochlorothiazide 12.5 mg.",
 "throat": "Complaints: sore throat with painful swallowing 3 days, no cough. Medications: amoxicillin-clavulanate 5 days; paracetamol; salt water gargles.",
 "throat_d": "Complaints: sore throat and pain on swallowing for three days. Medications: azithromycin 3 days; throat lozenges.",
 "headache": "Complaints: band-like headache after long computer hours, no nausea. Medications: paracetamol 650 mg at onset; rest for eyes.",
 "headache_d": "Complaints: fever with body ache for two days. Medications: paracetamol 650 mg three times daily; fluids.",
 "acidity": "Complaints: heartburn after meals with sour taste, worse at night. Medications: pantoprazole 40 mg before breakfast 2 weeks.",
 "acidity_d": "Complaints: low back pain, on a painkiller course, stomach protection advised. Medications: pantoprazole 40 mg before breakfast 2 weeks.",
 "rhinitis": "Complaints: sneezing, itchy eyes, blocked nose every morning 2 weeks, dust allergy. Medications: cetirizine 10 mg at night.",
 "rhinitis_d": "Complaints: itchy skin rash with wheals for three days. Medications: cetirizine 10 mg at night.",
 "knee_gel": "Complaints: right knee pain after stairs for a month. Medications: diclofenac gel twice daily; leg strengthening exercises.",
 "knee_gel_d": "Complaints: left shoulder strain after lifting, one week. Medications: diclofenac gel twice daily; shoulder exercises.",
 "dm": "Complaints: type 2 diabetes follow-up, stable. Medications: metformin 500 mg twice daily with meals; diet plan.",
 "dm_d": "Complaints: routine review of type 2 diabetes, sugars controlled. Medications: metformin 500 mg twice a day after food; balanced diet.",
 "htn2": "Complaints: hypertension follow-up, feels well. Medications: amlodipine 5 mg every morning.",
 "htn2_d": "Complaints: hypertension follow-up, no symptoms. Medications: amlodipine 5 mg every morning.",
 "thyroid": "Complaints: hypothyroidism review, no new symptoms. Medications: levothyroxine 50 mcg empty stomach morning; TSH in 3 months.",
 "thyroid_d": "Complaints: underactive thyroid, routine review, doing well. Medications: levothyroxine 50 micrograms each morning before food; repeat TSH after three months.",
 "uri": "Complaints: cold and cough 3 days, mild sore throat, no fever. Medications: paracetamol if needed; cetirizine at night; warm fluids.",
 "uri_d": "Complaints: cold and cough for three days with mild sore throat. Medications: paracetamol if needed; cetirizine at night; warm fluids.",
}
# H1: same complaint, DIFFERENT medicines; H2: DIFFERENT complaint, SAME medicines; H3: both routine and near-identical (same complaint, same common medicines)
H1 = ["knee2", "gastric", "htn", "throat"]
H2 = ["headache", "acidity", "rhinitis", "knee_gel"]
H3 = ["dm", "htn2", "thyroid", "uri"]
# pre-registered (v7.3a F2): H1 and H2: own >= 0.50 and own - decoy >= 0.15 for at least 3 of 4 in EACH group. H3: DESCRIPTIVE ONLY (expected to tie): report own, decoy, margin and the tie rate (share of pairs with own - decoy < 0.15)


def hard_check(ask=None):
    res = {}
    for name, grp in (("H1_same_complaint_different_medicines", H1), ("H2_different_complaint_same_medicines", H2), ("H3_routine_near_identical", H3)):
        rows = []
        for k in grp:
            own = score(HT[k], HR[k], ask); dec = score(HT[k], HR[k + "_d"], ask)
            rows.append(dict(pair=k, own=own, decoy=dec, margin=round(own - dec, 3)))
        res[name] = rows
    ok = lambda rows: sum(r["own"] >= 0.50 and r["margin"] >= 0.15 for r in rows)
    h3 = res["H3_routine_near_identical"]
    res["criteria"] = dict(H1_separates=f"{ok(res['H1_same_complaint_different_medicines'])}/4", H2_separates=f"{ok(res['H2_different_complaint_same_medicines'])}/4",
                           H3_tie_rate=f"{sum(r['margin'] < 0.15 for r in h3)}/4 pairs with margin < 0.15 (descriptive)",
                           PASS_H1_H2=(ok(res["H1_same_complaint_different_medicines"]) >= 3 and ok(res["H2_different_complaint_same_medicines"]) >= 3))
    return res


def selftest():
    # a fake judge that returns high when the words overlap: checks the harness and criteria logic only (no network)
    def fake(state, q):
        t, r = state.split("PRESCRIPTION - COMPLAINTS AND MEDICATIONS:")
        tw, rw = set(t.lower().split()), set(r.lower().split())
        return {"answers": {"same_visit": {"type": "noul", "noul": min(0.99, len(tw & rw) / 12)}}}
    r = scale_check(ask=fake)
    assert set(r) == {"A", "B", "C", "criteria"} and len(r["A"]) == 4 and len(r["C"]) == 4
    assert "procedure" in LINK_QUESTION["same_visit"]["instructions"].lower() and "Ignore" in LINK_QUESTION["same_visit"]["instructions"]
    h = hard_check(ask=fake)
    assert set(h) == {"H1_same_complaint_different_medicines", "H2_different_complaint_same_medicines", "H3_routine_near_identical", "criteria"}
    assert all(len(v) == 4 for k, v in h.items() if k != "criteria")
    return "selftest ok (harness only, no network)"


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "hard":
        out = hard_check()
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "P1-LINK3-HARDCHECK.json")
        json.dump(out, open(p, "w"), indent=1)
        print(json.dumps(out, indent=1))
    elif len(sys.argv) > 1 and sys.argv[1] == "scale":
        out = scale_check()
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "P1-LINK3-SCALECHECK.json")
        json.dump(out, open(p, "w"), indent=1)
        print(json.dumps(out, indent=1))
    else:
        print(selftest())
