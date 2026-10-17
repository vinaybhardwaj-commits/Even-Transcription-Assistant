"""Synthetic clinical lexicon for P-SYN scripts.

Everything here is invented for a synthetic bench. Scenarios are generic
outpatient templates, not clinical guidance and not drawn from any consult.
Code-switch surfaces (Hindi `hi`, Kannada `kn`) are rendered in Latin script.
"""

LANGS = ("en", "hi", "kn")

# Medicine attribute surfaces, keyed by canonical code.
FREQUENCY = {
    "OD": {"en": "once a day", "hi": "din mein ek baar", "kn": "dinakke ondu sala"},
    "BID": {"en": "twice a day", "hi": "din mein do baar", "kn": "dinakke eradu sala"},
    "TID": {"en": "three times a day", "hi": "din mein teen baar", "kn": "dinakke mooru sala"},
    "HS": {"en": "once at night", "hi": "raat ko ek baar", "kn": "raatri ondu sala"},
    "SOS": {"en": "only when needed", "hi": "zaroorat ho tab", "kn": "beku andaga matra"},
    "WEEKLY": {"en": "once a week", "hi": "hafte mein ek baar", "kn": "vaarakke ondu sala"},
}
ROUTE = {
    "PO": {"en": "by mouth", "hi": "muh se", "kn": "bayi mulaka"},
    "TOP": {"en": "on the skin", "hi": "skin par lagana", "kn": "charmada mele"},
    "INH": {"en": "by inhaler", "hi": "inhaler se", "kn": "inhaler mulaka"},
    "EYE": {"en": "in both eyes", "hi": "dono aankh mein", "kn": "eradu kannige"},
}
DURATION = {
    "3d": {"en": "for three days", "hi": "teen din tak", "kn": "mooru dina varege"},
    "5d": {"en": "for five days", "hi": "paanch din tak", "kn": "aidu dina varege"},
    "7d": {"en": "for seven days", "hi": "saat din tak", "kn": "elu dina varege"},
    "10d": {"en": "for ten days", "hi": "das din tak", "kn": "hattu dina varege"},
    "14d": {"en": "for two weeks", "hi": "do hafte tak", "kn": "eradu vaara varege"},
    "1mo": {"en": "for one month", "hi": "ek mahine tak", "kn": "ondu tingalu varege"},
    "8wk": {"en": "for eight weeks", "hi": "aath hafte tak", "kn": "entu vaara varege"},
}
DOSE = {
    "1tab": {"en": "one tablet", "hi": "ek goli", "kn": "ondu maatre"},
    "2tab": {"en": "two tablets", "hi": "do goli", "kn": "eradu maatre"},
    "halftab": {"en": "half a tablet", "hi": "aadhi goli", "kn": "ardha maatre"},
    "1cap": {"en": "one capsule", "hi": "ek capsule", "kn": "ondu capsule"},
    "2puff": {"en": "two puffs", "hi": "do puff", "kn": "eradu puff"},
    "1drop": {"en": "one drop", "hi": "ek boond", "kn": "ondu hani"},
    "thin": {"en": "a thin layer", "hi": "patli layer", "kn": "tellane padara"},
    "1sachet": {"en": "one sachet", "hi": "ek sachet", "kn": "ondu sachet"},
}
INSTRUCTION = {
    "after_food": {"en": "after food", "hi": "khane ke baad", "kn": "oota aada mele"},
    "before_food": {"en": "before breakfast", "hi": "nashte se pehle", "kn": "tindi munche"},
    "with_water": {"en": "with a full glass of water", "hi": "poore glass paani ke saath", "kn": "ondu lota neerinondige"},
    "wash_hands": {"en": "after washing your hands", "hi": "haath dhone ke baad", "kn": "kai tolada mele"},
    "rinse_mouth": {"en": "and rinse your mouth after", "hi": "aur baad mein kulla karna", "kn": "matte nantara bayi toleyiri"},
    "with_milk": {"en": "with milk", "hi": "doodh ke saath", "kn": "haalinondige"},
}

ATTR_TABLES = {
    "frequency": FREQUENCY,
    "route": ROUTE,
    "duration": DURATION,
    "dose": DOSE,
    "instruction": INSTRUCTION,
}

MED_ATTRS = ("drug", "strength", "dose", "route", "frequency", "duration", "instruction")

# Generic medicine names only (no brands). strength is spoken as written.
DRUGS = {
    "paracetamol": {"strength": "500 mg", "dose": "1tab", "route": "PO"},
    "cetirizine": {"strength": "10 mg", "dose": "1tab", "route": "PO"},
    "pantoprazole": {"strength": "40 mg", "dose": "1tab", "route": "PO"},
    "domperidone": {"strength": "10 mg", "dose": "1tab", "route": "PO"},
    "amoxicillin": {"strength": "500 mg", "dose": "1cap", "route": "PO"},
    "ibuprofen": {"strength": "400 mg", "dose": "1tab", "route": "PO"},
    "metformin": {"strength": "500 mg", "dose": "1tab", "route": "PO"},
    "amlodipine": {"strength": "5 mg", "dose": "1tab", "route": "PO"},
    "telmisartan": {"strength": "40 mg", "dose": "1tab", "route": "PO"},
    "salbutamol inhaler": {"strength": "100 mcg", "dose": "2puff", "route": "INH"},
    "montelukast": {"strength": "10 mg", "dose": "1tab", "route": "PO"},
    "moxifloxacin eye drops": {"strength": "0.5 percent", "dose": "1drop", "route": "EYE"},
    "diclofenac gel": {"strength": "1 percent", "dose": "thin", "route": "TOP"},
    "nitrofurantoin": {"strength": "100 mg", "dose": "1cap", "route": "PO"},
    "cholecalciferol": {"strength": "60000 units", "dose": "1sachet", "route": "PO"},
    "ondansetron": {"strength": "4 mg", "dose": "1tab", "route": "PO"},
    "levocetirizine": {"strength": "5 mg", "dose": "1tab", "route": "PO"},
    "azithromycin": {"strength": "500 mg", "dose": "1tab", "route": "PO"},
    "mupirocin ointment": {"strength": "2 percent", "dose": "thin", "route": "TOP"},
    "oral rehydration salts": {"strength": "standard sachet", "dose": "1sachet", "route": "PO"},
    "fluticasone nasal spray": {"strength": "50 mcg", "dose": "2puff", "route": "INH"},
    "loperamide": {"strength": "2 mg", "dose": "1cap", "route": "PO"},
    "famotidine": {"strength": "20 mg", "dose": "1tab", "route": "PO"},
    "naproxen": {"strength": "250 mg", "dose": "1tab", "route": "PO"},
}

# Lower or alternate strengths used for dose-correction and relay-change traps.
ALT_STRENGTH = {
    "paracetamol": "650 mg", "cetirizine": "5 mg", "pantoprazole": "20 mg",
    "domperidone": "20 mg", "amoxicillin": "250 mg", "ibuprofen": "200 mg",
    "metformin": "1000 mg", "amlodipine": "10 mg", "telmisartan": "20 mg",
    "salbutamol inhaler": "200 mcg", "montelukast": "4 mg",
    "moxifloxacin eye drops": "0.3 percent", "diclofenac gel": "2 percent",
    "nitrofurantoin": "50 mg", "cholecalciferol": "1000 units", "ondansetron": "8 mg",
    "levocetirizine": "2.5 mg", "azithromycin": "250 mg", "mupirocin ointment": "1 percent",
    "oral rehydration salts": "half sachet", "fluticasone nasal spray": "100 mcg",
    "loperamide": "4 mg", "famotidine": "40 mg", "naproxen": "500 mg",
}
ALT_DOSE = {"1tab": "2tab", "2tab": "1tab", "1cap": "1tab", "2puff": "1drop",
            "1drop": "2puff", "thin": "1sachet", "1sachet": "halftab", "halftab": "1tab"}

# Code-switch frames: doctor lines keep the clinical noun phrase in English.
CS_FRAME = {
    "hi": {"lead": "Dekhiye,", "tail": "theek hai?", "ask": "bataiye?", "take": "lijiye", "yes": "Haan ji.",
           "ok": "Theek hai, doctor."},
    "kn": {"lead": "Nodi,", "tail": "aaytha?", "ask": "heli?", "take": "tagoli", "yes": "Houdu.", "ok": "Sari, doctor."},
}

# Each scenario: patient lines per language, doctor content in English (code-
# switched by frame), and planted plan items. Instruction-like items carry a
# canonical_key (generic controlled phrase).
SCENARIOS = [
    {
        "key": "fever_cold",
        "complaint": {"en": "I have had fever and a running nose.", "hi": "Mujhe bukhar aur naak beh rahi hai.", "kn": "Nanage jwara mattu moogu soruttide."},
        "onset": {"en": "Since three days.", "hi": "Teen din se.", "kn": "Mooru dinadinda."},
        "onset_value": "three days", "onset_wrong": "three weeks",
        "assoc": {"en": "A little body ache, no breathing trouble.", "hi": "Thoda badan dard hai, saans ki taklif nahi.", "kn": "Swalpa mai novu, usiru kashta illa."},
        "exam": "Your temperature is mildly raised and the throat looks red, chest is clear",
        "diagnosis": "a viral upper respiratory infection",
        "reasoning": "it started with a running nose, the chest is clear and there is no breathing trouble",
        "meds": [("paracetamol", "TID", "3d", "after_food"), ("cetirizine", "HS", "5d", "after_food")],
        "investigation": ("cbc", "a complete blood count"),
        "referral": None,
        "advice": ("warm_fluids", "Drink plenty of warm fluids"),
        "counselling": ("viral_self_limiting", "This is a viral illness and it usually settles on its own in about a week"),
        "warning": ("breathless_return", "If you get breathless or the fever goes very high, come back the same day"),
        "lifestyle": ("rest_sleep", "Rest well and sleep early for the next few days"),
        "follow_up": ("review_5d", "Come back for review after five days"),
        "contingency": ("fever_beyond_3d", "If the fever does not settle in three days, get the blood test done first"),
        "outdated": ("antibiotic_for_cold", "I will also give an antibiotic just to be safe for the cold"),
        "jargon": "You have acute coryzal symptoms with pharyngeal erythema, likely viral URTI, no LRTI features",
        "inconsistent": ("The chest sounds a bit wheezy today", "since the chest is completely clear"),
        "absent_drug": "azithromycin",
    },
    {
        "key": "acidity",
        "complaint": {"en": "I get burning in the upper stomach after meals.", "hi": "Khane ke baad pet ke upar jalan hoti hai.", "kn": "Oota aada mele hotte mele uriyuttade."},
        "onset": {"en": "For about two weeks.", "hi": "Lagbhag do hafte se.", "kn": "Sumaaru eradu vaaradinda."},
        "onset_value": "two weeks", "onset_wrong": "two months",
        "assoc": {"en": "Sometimes sour burps, no vomiting.", "hi": "Kabhi khatti dakaar, ulti nahi.", "kn": "Kelavu sala huli tegu, vaanti illa."},
        "exam": "The upper abdomen is a little tender, the rest of the abdomen is soft",
        "diagnosis": "acid reflux with gastritis",
        "reasoning": "the burning comes after meals with sour burps and there are no warning signs",
        "meds": [("pantoprazole", "OD", "14d", "before_food"), ("domperidone", "TID", "5d", "before_food")],
        "investigation": ("usg_abdomen", "an ultrasound of the abdomen"),
        "referral": None,
        "advice": ("small_meals", "Eat smaller meals at regular times"),
        "counselling": ("reflux_triggers", "Spicy and oily food and late dinners make this burning worse"),
        "warning": ("black_stool_return", "If you vomit blood or pass black stools, come to emergency at once"),
        "lifestyle": ("dinner_early", "Finish dinner at least two hours before lying down"),
        "follow_up": ("review_2wk", "Come back after two weeks"),
        "contingency": ("no_relief_scope", "If there is no relief in two weeks, we will plan a scope test"),
        "outdated": ("milk_for_acid", "Drink cold milk whenever it burns, that will cure the acid"),
        "jargon": "This is dyspepsia with probable GERD and epigastric tenderness, no alarm features",
        "inconsistent": ("There is no tenderness anywhere", "because of that tenderness in the upper abdomen"),
        "absent_drug": "famotidine",
    },
    {
        "key": "bp_review",
        "complaint": {"en": "I came for my blood pressure check.", "hi": "Main BP check karwane aaya hoon.", "kn": "Naanu BP check maadisalu bandiddene."},
        "onset": {"en": "I was told it was high last month.", "hi": "Pichle mahine bataya tha ki high hai.", "kn": "Kaleda tingalu jaasti ide antha helidru."},
        "onset_value": "last month", "onset_wrong": "last year",
        "assoc": {"en": "Mild headache in the mornings.", "hi": "Subah halka sar dard hota hai.", "kn": "Beligge swalpa tale novu."},
        "exam": "Your blood pressure today is raised on both readings, heart sounds are normal",
        "diagnosis": "high blood pressure that needs treatment",
        "reasoning": "it has been high on two visits with morning headaches",
        "meds": [("telmisartan", "OD", "1mo", "with_water"), ("amlodipine", "OD", "1mo", "with_water")],
        "investigation": ("creatinine", "a serum creatinine test"),
        "referral": ("ophthalmology", "the eye clinic for a retina check"),
        "advice": ("home_bp_log", "Check your blood pressure at home and write it down"),
        "counselling": ("bp_lifelong", "Blood pressure medicine usually has to be taken every day, even when you feel fine"),
        "warning": ("chest_pain_return", "If you get chest pain or weakness on one side, go to emergency at once"),
        "lifestyle": ("less_salt", "Cut down the salt in your food"),
        "follow_up": ("review_4wk", "Come back after four weeks with your readings"),
        "contingency": ("dizzy_hold", "If you feel very dizzy on standing, call the clinic before the next dose"),
        "outdated": ("stop_when_normal", "Once the reading is normal you can stop the tablets yourself"),
        "jargon": "This is stage two essential hypertension, rule out target organ damage, check eGFR",
        "inconsistent": ("Your reading today is completely normal", "since the reading is high again today"),
        "absent_drug": "naproxen",
    },
    {
        "key": "diabetes_review",
        "complaint": {"en": "My sugar report came high.", "hi": "Meri sugar report high aayi hai.", "kn": "Nanna sugar report jaasti bandide."},
        "onset": {"en": "The test was done last week.", "hi": "Test pichle hafte hua tha.", "kn": "Test kaleda vaara maadisidde."},
        "onset_value": "last week", "onset_wrong": "six months ago",
        "assoc": {"en": "I feel thirsty and pass urine often.", "hi": "Pyaas zyada lagti hai, peshab baar baar.", "kn": "Baayarike jaasti, moothra jaasti sala."},
        "exam": "Weight is a little above the ideal, feet sensation is normal",
        "diagnosis": "type two diabetes",
        "reasoning": "the sugar report is high with thirst and frequent urine",
        "meds": [("metformin", "BID", "1mo", "after_food"), ("cholecalciferol", "WEEKLY", "8wk", "with_milk")],
        "investigation": ("hba1c", "an HbA1c test"),
        "referral": ("ophthalmology", "the eye clinic for a retina check"),
        "advice": ("sugar_diary", "Keep a sugar diary with fasting readings"),
        "counselling": ("diabetes_control", "Diabetes is controlled with medicine, diet and walking together"),
        "warning": ("low_sugar_signs", "If you get sweating, shaking or confusion, eat something sweet at once"),
        "lifestyle": ("daily_walk", "Walk for thirty minutes every day"),
        "follow_up": ("review_4wk", "Come back after four weeks with your readings"),
        "contingency": ("stomach_upset_call", "If the tablet upsets your stomach badly, call us before stopping it"),
        "outdated": ("no_fruit_ever", "Never eat any fruit at all from now on"),
        "jargon": "This is T2DM with osmotic symptoms, start biguanide, monitor HbA1c and renal function",
        "inconsistent": ("Your feet have lost sensation", "since your feet sensation is normal"),
        "absent_drug": "famotidine",
    },
    {
        "key": "back_strain",
        "complaint": {"en": "My lower back hurts after lifting a box.", "hi": "Box uthane ke baad kamar mein dard hai.", "kn": "Box etthida mele sonta novu ide."},
        "onset": {"en": "Since four days.", "hi": "Chaar din se.", "kn": "Naalku dinadinda."},
        "onset_value": "four days", "onset_wrong": "four months",
        "assoc": {"en": "No pain going down the legs.", "hi": "Pairon mein dard nahi jaata.", "kn": "Kaalige novu hoguvudilla."},
        "exam": "The lower back muscles are tight, leg power and reflexes are normal",
        "diagnosis": "a lower back muscle strain",
        "reasoning": "it began after lifting and the nerves to the legs are normal",
        "meds": [("ibuprofen", "BID", "5d", "after_food"), ("diclofenac gel", "TID", "7d", "wash_hands")],
        "investigation": ("xray_ls", "an X-ray of the lower spine"),
        "referral": ("physiotherapy", "physiotherapy for back exercises"),
        "advice": ("keep_moving", "Keep moving gently, do not stay in bed"),
        "counselling": ("strain_recovery", "Most back strains get better within two to three weeks"),
        "warning": ("numbness_return", "If you get numbness or trouble passing urine, come back the same day"),
        "lifestyle": ("lift_bend_knees", "Bend your knees when you lift anything heavy"),
        "follow_up": ("review_2wk", "Come back after two weeks"),
        "contingency": ("pain_worse_xray", "If the pain is worse after a week, get the X-ray done before coming"),
        "outdated": ("strict_bed_rest", "Take strict bed rest for two weeks without getting up"),
        "jargon": "This is mechanical low back pain with paraspinal spasm, no radiculopathy, SLR negative",
        "inconsistent": ("Your leg reflexes are reduced", "since the leg reflexes are normal"),
        "absent_drug": "naproxen",
    },
    {
        "key": "allergy_wheeze",
        "complaint": {"en": "I sneeze a lot and get wheezy at night.", "hi": "Bahut chheenk aati hai aur raat ko saans phoolti hai.", "kn": "Tumba seenu mattu raatri usiru kattuttade."},
        "onset": {"en": "Every winter, this time for ten days.", "hi": "Har sardi mein, is baar das din se.", "kn": "Prati chali kaaladalli, ee sala hattu dinadinda."},
        "onset_value": "ten days", "onset_wrong": "ten weeks",
        "assoc": {"en": "Itchy eyes, no fever.", "hi": "Aankhon mein khujli, bukhar nahi.", "kn": "Kannu turike, jwara illa."},
        "exam": "The nose lining is swollen and there is a mild wheeze on both sides",
        "diagnosis": "allergic rhinitis with mild wheeze",
        "reasoning": "it comes every winter with sneezing, itchy eyes and night wheeze",
        "meds": [("montelukast", "HS", "1mo", "with_water"), ("salbutamol inhaler", "SOS", "1mo", "rinse_mouth")],
        "investigation": ("spirometry", "a breathing test called spirometry"),
        "referral": ("pulmonology", "the chest clinic"),
        "advice": ("dust_avoid", "Keep the bedroom free of dust"),
        "counselling": ("inhaler_technique", "The inhaler works only if you breathe in slowly and hold your breath"),
        "warning": ("cannot_speak_return", "If you cannot finish a sentence because of breathlessness, go to emergency"),
        "lifestyle": ("no_smoke", "Stay away from smoke and incense"),
        "follow_up": ("review_4wk", "Come back after four weeks"),
        "contingency": ("inhaler_daily_call", "If you need the inhaler every day, call us and we will step up treatment"),
        "outdated": ("steam_cures", "Hot steam every hour will cure the allergy completely"),
        "jargon": "This is AR with reactive airways, mild bilateral rhonchi, start LTRA and SABA PRN",
        "inconsistent": ("The chest is completely clear", "since there is that wheeze on both sides"),
        "absent_drug": "azithromycin",
    },
    {
        "key": "urine_infection",
        "complaint": {"en": "Burning while passing urine.", "hi": "Peshab karte waqt jalan hoti hai.", "kn": "Moothra maaduvaaga uriyuttade."},
        "onset": {"en": "Since two days.", "hi": "Do din se.", "kn": "Eradu dinadinda."},
        "onset_value": "two days", "onset_wrong": "two weeks",
        "assoc": {"en": "Going often, no fever, no back pain.", "hi": "Baar baar jaana, bukhar nahi, kamar dard nahi.", "kn": "Jaasti sala hogodu, jwara illa, sonta novu illa."},
        "exam": "The lower abdomen is mildly tender, no tenderness over the kidneys",
        "diagnosis": "a simple bladder infection",
        "reasoning": "there is burning and frequency without fever or kidney pain",
        "meds": [("nitrofurantoin", "BID", "5d", "after_food"), ("paracetamol", "SOS", "3d", "after_food")],
        "investigation": ("urine_culture", "a urine culture test"),
        "referral": None,
        "advice": ("more_water", "Drink at least three litres of water a day"),
        "counselling": ("finish_course", "Finish the full antibiotic course even if the burning stops early"),
        "warning": ("fever_back_return", "If you get fever or back pain, come back the same day"),
        "lifestyle": ("no_holding", "Do not hold urine for long"),
        "follow_up": ("review_after_culture", "Come back with the culture report"),
        "contingency": ("culture_change", "If the culture shows resistance, we will change the tablet"),
        "outdated": ("cranberry_only", "Cranberry juice alone is enough, you do not really need the tablet"),
        "jargon": "This is uncomplicated cystitis, no pyelonephritis features, suprapubic tenderness, send MSU",
        "inconsistent": ("There is tenderness over the kidneys", "since there is no tenderness over the kidneys"),
        "absent_drug": "azithromycin",
    },
    {
        "key": "red_eye",
        "complaint": {"en": "Both my eyes are red and sticky.", "hi": "Dono aankhein laal aur chipchipi hain.", "kn": "Eradu kannu kempagive mattu antuttive."},
        "onset": {"en": "Since yesterday morning.", "hi": "Kal subah se.", "kn": "Ninne beligge inda."},
        "onset_value": "yesterday morning", "onset_wrong": "last month",
        "assoc": {"en": "Vision is fine, mild itching.", "hi": "Dikhai theek hai, halki khujli.", "kn": "Drushti sari ide, swalpa turike."},
        "exam": "Both eyes are red with sticky discharge, vision is normal, cornea is clear",
        "diagnosis": "infective conjunctivitis",
        "reasoning": "both eyes are sticky with normal vision and a clear cornea",
        "meds": [("moxifloxacin eye drops", "TID", "5d", "wash_hands"), ("levocetirizine", "HS", "3d", "after_food")],
        "investigation": None,
        "referral": ("ophthalmology", "the eye clinic if it does not improve"),
        "advice": ("own_towel", "Use your own towel and wash your hands often"),
        "counselling": ("spreads_easily", "This spreads easily to family members by touch"),
        "warning": ("vision_drop_return", "If your vision becomes blurred or the eye hurts badly, come back at once"),
        "lifestyle": ("no_lenses", "Do not wear contact lenses until it settles"),
        "follow_up": ("review_5d", "Come back for review after five days"),
        "contingency": ("no_better_eye_clinic", "If it is not better in five days, go to the eye clinic"),
        "outdated": ("rose_water", "Put rose water in the eyes, that is the best treatment"),
        "jargon": "This is bilateral mucopurulent conjunctivitis, VA normal, no keratitis, start topical FQ",
        "inconsistent": ("Your vision is reduced in the left eye", "since your vision is normal in both eyes"),
        "absent_drug": "naproxen",
    },
]

# Generic doctor filler (history and explanation, non-order) used to pad
# scripts to the doctor-turn counts the strata need.
DOCTOR_FILLER = [
    "Let me explain the plan once more",
    "I am writing all of this down for you",
    "Please tell me if anything is not clear",
    "Do you have any questions so far?",
    "Keep this prescription safely",
    "Bring this paper at the next visit",
    "That is all from my side for now",
    "We will go through the reports together next time",
    "There is nothing to be scared about",
    "You did the right thing by coming early",
    "Let me check that I have written everything",
    "Is there anything else that is worrying you?",
    "Please read the prescription once before you leave",
    "Okay, I understand",
    "That is helpful to know",
    "We will see how you respond",
    "Most people feel better with this plan",
    "Let me just note that down",
    "Your file is updated now",
    "I have explained everything I wanted to",
    "Good, we are almost done",
    "We have a clear plan now",
    "Thank you for explaining it so clearly",
    "Let me sign the prescription",
    "I know this is a lot to remember",
    "You are doing well so far",
    "Let me put the papers in order",
    "I hope that makes sense",
    "Nothing else is needed today",
    "Let me close the file now",
]

PATIENT_FILLER = {
    "en": ["Yes, doctor.", "Okay.", "No, nothing like that.", "I am not sure.", "It started slowly.", "Alright, I understand."],
    "hi": ["Haan ji, doctor.", "Theek hai.", "Nahi, aisa kuch nahi.", "Pata nahi.", "Dheere dheere shuru hua.", "Achha, samajh gaya."],
    "kn": ["Houdu, doctor.", "Sari.", "Illa, haage enu illa.", "Gottilla.", "Nidhaanavaagi shuru aaytu.", "Sari, artha aaytu."],
}

# Instruction-sounding lines for non-treating voices (decoy list in A4.4).
NON_DOCTOR_INSTRUCTIONS = {
    "attender": [
        ("attender_ginger_tea", "Ginger tea three times a day is what he needs"),
        ("attender_skip_tablet", "She should skip the night tablet if she feels sleepy"),
        ("attender_oil_massage", "Put warm oil on the back every night"),
        ("attender_double_dose", "Give two tablets if the pain is bad"),
    ],
    "patient": [
        ("patient_sleeping_pill", "Maybe I should take a sleeping pill at night"),
        ("patient_stop_bp", "I think I will stop the old tablet from tomorrow"),
        ("patient_home_remedy", "I will just take turmeric milk instead"),
    ],
    "staff": [
        ("staff_fasting_sample", "Come fasting tomorrow morning for the blood sample"),
        ("staff_injection_now", "Sit here, I will give you the injection now"),
        ("staff_bring_reports", "Bring all old reports next time"),
        ("staff_dressing_daily", "Change the dressing every day at home"),
    ],
}

# Order-like items a non-treating voice may say (merged/fluid-room traps).
NON_DOCTOR_ORDERS = [
    ("ondansetron", "TID", "3d", "before_food"),
    ("loperamide", "SOS", "3d", "with_water"),
    ("famotidine", "BID", "7d", "before_food"),
    ("oral rehydration salts", "TID", "3d", "with_water"),
    ("azithromycin", "OD", "3d", "after_food"),
    ("naproxen", "BID", "5d", "after_food"),
    ("fluticasone nasal spray", "OD", "14d", "with_water"),
    ("mupirocin ointment", "TID", "5d", "wash_hands"),
]
NON_DOCTOR_TESTS = [
    ("lipid_profile", "a lipid profile"),
    ("thyroid_test", "a thyroid test"),
    ("chest_xray", "a chest X-ray"),
    ("ecg", "an ECG"),
]
NON_DOCTOR_REFERRALS = [
    ("dermatology", "the skin clinic"),
    ("cardiology", "the heart clinic"),
    ("ent", "the ENT clinic"),
    ("neurology", "the nerve clinic"),
]

# Decoy claim pool: canonical claims never planted in any script of the kind
# they are offered for (the builder re-checks against each script's text).
DECOY_CLAIMS = [
    ("drug:prednisolone", "the doctor prescribed prednisolone"),
    ("drug:atorvastatin", "the doctor prescribed atorvastatin"),
    ("drug:clopidogrel", "the doctor prescribed clopidogrel"),
    ("drug:warfarin", "the doctor prescribed warfarin"),
    ("drug:insulin_glargine", "the doctor prescribed insulin glargine"),
    ("drug:levothyroxine", "the doctor prescribed levothyroxine"),
    ("test:mri_brain", "the doctor ordered an MRI of the brain"),
    ("test:ct_abdomen", "the doctor ordered a CT scan of the abdomen"),
    ("test:echo", "the doctor ordered an echocardiogram"),
    ("ref:surgery", "the doctor referred to general surgery"),
    ("ref:psychiatry", "the doctor referred to psychiatry"),
    ("advice:fasting_48h", "the doctor advised fasting for two days"),
    ("advice:cold_bath", "the doctor advised a cold bath every night"),
    ("fu:review_6mo", "the doctor asked for review after six months"),
    ("warn:stop_all", "the doctor said to stop all medicines"),
    ("proc:suturing", "the doctor did a suturing procedure"),
]

# Enrolment grammar: non-clinical reading sentences; words chosen to stay out
# of every consult template above.
ENROL_SUBJECTS = ["The lighthouse keeper", "A copper kettle", "The orchard gate", "An old tram conductor",
                  "The violet kite", "A patient heron", "The bakery clock", "A wooden canoe",
                  "The harbour bell", "A striped umbrella", "The marble fountain", "A sleepy owl"]
ENROL_VERBS = ["polished", "carried", "painted", "counted", "folded", "whistled past", "circled",
               "admired", "repaired", "balanced"]
ENROL_OBJECTS = ["seven brass lanterns", "the crooked weathervane", "a basket of plums", "the northern ridge",
                 "eleven paper boats", "the quiet library steps", "a field of sunflowers", "the spiral staircase",
                 "the railway bridge", "a jar of marbles", "the moonlit pier", "twelve blue tiles"]
ENROL_TAILS = ["before the evening tide", "while the festival drums played", "beside the granite wall",
               "under a lavender sky", "near the abandoned windmill", "after the autumn fair",
               "along the cobbled lane", "during the long monsoon drive"]
