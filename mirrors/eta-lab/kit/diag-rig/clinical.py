"""CLINICAL SELFTEST set (W33.1, S1 scale-up): invented doctor-patient consults with exact truth. 8 cases x 8 language modes
(en, hi, kn, ta, te, ml, hi-en, kn-en). Every dialogue names 2-4 drugs with doses, one diagnosis and one investigation, so the router can be
scored on clinical content, not only on words. INVENTED patients only (no names, no ages, no real records); real drug names are fine.
Diagnosis / investigation / drug names are spoken in English inside the native frames (as clinics do). Frames are fixed strings; the case table is
the only variable content. CLINICAL_SHA pins frames + cases (part of every manifest)."""
import hashlib
import json

CASES = [   # dx, investigation, days of complaint, follow-up days, drugs (name, dose value, unit)
    dict(dx="diabetes", inv="HbA1c test", days=10, back=14, drugs=[("Metformin", 500, "mg"), ("Glimepiride", 1, "mg")]),
    dict(dx="high blood pressure", inv="ECG", days=7, back=30, drugs=[("Amlodipine", 5, "mg"), ("Telmisartan", 40, "mg"), ("Atorvastatin", 10, "mg")]),
    dict(dx="asthma", inv="chest X-ray", days=5, back=7, drugs=[("Montelukast", 10, "mg"), ("Prednisolone", 20, "mg")]),
    dict(dx="urine infection", inv="urine culture", days=3, back=5, drugs=[("Nitrofurantoin", 100, "mg"), ("Paracetamol", 500, "mg")]),
    dict(dx="migraine", inv="MRI brain", days=15, back=21, drugs=[("Sumatriptan", 50, "mg"), ("Domperidone", 10, "mg"), ("Propranolol", 20, "mg")]),
    dict(dx="thyroid problem", inv="TSH test", days=30, back=45, drugs=[("Levothyroxine", 50, "mcg"), ("Calcium", 500, "mg")]),
    dict(dx="gastritis", inv="endoscopy", days=6, back=10, drugs=[("Pantoprazole", 40, "mg"), ("Domperidone", 10, "mg"), ("Ondansetron", 4, "mg"), ("Paracetamol", 500, "mg")]),
    dict(dx="anaemia", inv="haemoglobin test", days=20, back=30, drugs=[("Ferrous sulphate", 200, "mg"), ("Folic acid", 5, "mg"), ("Vitamin B12", 1500, "mcg")]),
]

CONFIRM_CASES = [   # confirm1 (fresh, not in CASES): used for the language-judge confirmation suite; doses/days stay inside the scorer's number tables
    dict(dx="typhoid fever", inv="Widal test", days=5, back=3, drugs=[("Cefixime", 200, "mg"), ("Paracetamol", 500, "mg")]),
    dict(dx="vitamin D deficiency", inv="vitamin D level", days=30, back=45, drugs=[("Calcium", 500, "mg"), ("Cholecalciferol", 50, "mcg")]),
    dict(dx="arthritis", inv="knee X-ray", days=20, back=14, drugs=[("Aceclofenac", 100, "mg"), ("Pantoprazole", 40, "mg")]),
    dict(dx="skin allergy", inv="allergy test", days=6, back=7, drugs=[("Cetirizine", 10, "mg"), ("Prednisolone", 20, "mg")]),
    dict(dx="chest infection", inv="sputum test", days=7, back=5, drugs=[("Azithromycin", 500, "mg"), ("Paracetamol", 500, "mg")]),
    dict(dx="kidney stone", inv="ultrasound scan", days=3, back=7, drugs=[("Diclofenac", 50, "mg"), ("Ondansetron", 4, "mg")]),
    dict(dx="back pain", inv="spine MRI", days=15, back=21, drugs=[("Thiocolchicoside", 4, "mg"), ("Pantoprazole", 40, "mg")]),
    dict(dx="ear infection", inv="hearing test", days=5, back=10, drugs=[("Amoxicillin", 500, "mg"), ("Paracetamol", 500, "mg")]),
]
MIX_BASES = ("hi", "kn", "ta", "te", "ml", "hi", "kn", "ta")   # 8 truly mixed dialogues (each Indic base at least once): sentence-level switching base <-> en, truth = mixed
MIX_CASE = (0, 1, 2, 3, 4, 5, 6, 7)
CONFIRM3_CASES = [   # confirm3 (fresh: no diagnosis/investigation shared with clinical1 or confirm2; drugs avoid the babble lines' Metformin/Amlodipine/Montelukast)
    dict(dx="dengue fever", inv="platelet count", days=5, back=3, drugs=[("Paracetamol", 500, "mg"), ("Ondansetron", 4, "mg")]),
    dict(dx="high cholesterol", inv="lipid profile", days=30, back=45, drugs=[("Rosuvastatin", 10, "mg"), ("Ezetimibe", 10, "mg")]),
    dict(dx="sinusitis", inv="CT scan", days=7, back=10, drugs=[("Levocetirizine", 5, "mg"), ("Amoxicillin", 500, "mg")]),
    dict(dx="piles", inv="proctoscopy", days=15, back=14, drugs=[("Diosmin", 500, "mg"), ("Pantoprazole", 40, "mg")]),
    dict(dx="gout", inv="uric acid test", days=3, back=7, drugs=[("Febuxostat", 40, "mg"), ("Prednisolone", 20, "mg")]),
    dict(dx="pneumonia", inv="blood culture", days=6, back=5, drugs=[("Cefuroxime", 500, "mg"), ("Levofloxacin", 500, "mg")]),
    dict(dx="hernia", inv="abdominal ultrasound", days=20, back=30, drugs=[("Tramadol", 50, "mg"), ("Ondansetron", 4, "mg")]),
    dict(dx="depression", inv="vitamin B12 level", days=30, back=21, drugs=[("Escitalopram", 10, "mg"), ("Propranolol", 20, "mg")]),
]

# frames: greet (doctor), pt (patient), dx, inv, rx (first two drugs are joined by the frame's own "and"-less list: DRUG1 DOSE1 ... ), more (each extra drug), confirm, back
FRAMES = {
    "en": dict(greet="Good morning, tell me, what is the problem?", pt="Doctor, it has been {days} days.", dx="You have {dx}.", inv="Please get {inv} done.",
               rx="Take {d1} {q1} twice a day after food.", more="Also take {d} {q} once a day at night.", confirm="So {d1} {q1} after food, right?", back="Come back after {back} days."),
    "hi": dict(greet="नमस्ते, बताइए, क्या तकलीफ है?", pt="डॉक्टर साहब, यह {days} दिन से है।", dx="आपको {dx} है।", inv="{inv} करवा लीजिए।",
               rx="{d1} {q1} दिन में दो बार खाने के बाद लीजिए।", more="और {d} {q} रात को एक बार लीजिए।", confirm="तो {d1} {q1} खाने के बाद, ठीक है?", back="{back} दिन बाद दोबारा आइए।"),
    "kn": dict(greet="ನಮಸ್ಕಾರ, ಹೇಳಿ, ಏನು ತೊಂದರೆ?", pt="ಡಾಕ್ಟರ್, ಇದು {days} ದಿನಗಳಿಂದ ಇದೆ.", dx="ನಿಮಗೆ {dx} ಇದೆ.", inv="{inv} ಮಾಡಿಸಿಕೊಳ್ಳಿ.",
               rx="{d1} {q1} ದಿನಕ್ಕೆ ಎರಡು ಬಾರಿ ಊಟದ ನಂತರ ತೆಗೆದುಕೊಳ್ಳಿ.", more="ಜೊತೆಗೆ {d} {q} ರಾತ್ರಿ ಒಂದು ಬಾರಿ ತೆಗೆದುಕೊಳ್ಳಿ.", confirm="ಹಾಗಾದರೆ {d1} {q1} ಊಟದ ನಂತರ, ಹೌದಲ್ಲವೇ?", back="{back} ದಿನಗಳ ನಂತರ ಮತ್ತೆ ಬನ್ನಿ."),
    "ta": dict(greet="வணக்கம், சொல்லுங்கள், என்ன பிரச்சினை?", pt="டாக்டர், இது {days} நாட்களாக இருக்கிறது.", dx="உங்களுக்கு {dx} இருக்கிறது.", inv="{inv} எடுத்துக் கொள்ளுங்கள்.",
               rx="{d1} {q1} தினமும் இரண்டு முறை உணவுக்குப் பிறகு சாப்பிடுங்கள்.", more="மேலும் {d} {q} இரவு ஒரு முறை சாப்பிடுங்கள்.", confirm="அப்படியானால் {d1} {q1} உணவுக்குப் பிறகு, சரியா?", back="{back} நாட்களுக்குப் பிறகு மீண்டும் வாருங்கள்."),
    "te": dict(greet="నమస్కారం, చెప్పండి, ఏమి ఇబ్బంది?", pt="డాక్టర్, ఇది {days} రోజులుగా ఉంది.", dx="మీకు {dx} ఉంది.", inv="{inv} చేయించుకోండి.",
               rx="{d1} {q1} రోజుకు రెండు సార్లు భోజనం తర్వాత వేసుకోండి.", more="అలాగే {d} {q} రాత్రి ఒకసారి వేసుకోండి.", confirm="అయితే {d1} {q1} భోజనం తర్వాత, కదా?", back="{back} రోజుల తర్వాత మళ్ళీ రండి."),
    "ml": dict(greet="നമസ്കാരം, പറയൂ, എന്താണ് പ്രശ്നം?", pt="ഡോക്ടർ, ഇത് {days} ദിവസമായി തുടങ്ങിയിട്ട്.", dx="നിങ്ങൾക്ക് {dx} ആണ്.", inv="{inv} എടുക്കണം.",
               rx="{d1} {q1} ദിവസം രണ്ടു നേരം ഭക്ഷണത്തിനു ശേഷം കഴിക്കണം.", more="കൂടാതെ {d} {q} രാത്രി ഒരു തവണ കഴിക്കണം.", confirm="അപ്പോൾ {d1} {q1} ഭക്ഷണത്തിനു ശേഷം, ശരിയല്ലേ?", back="{back} ദിവസം കഴിഞ്ഞു വീണ്ടും വരൂ."),
    "hi-en": dict(greet="नमस्ते, बताइए, क्या problem है?", pt="Doctor, ये {days} days से है।", dx="आपको {dx} है।", inv="{inv} करवा लीजिए।",
                  rx="{d1} {q1} twice a day after food लीजिए।", more="और {d} {q} once a day at night लीजिए।", confirm="तो {d1} {q1} after food, ठीक है?", back="{back} days बाद वापस आइए।"),
    "kn-en": dict(greet="ನಮಸ್ಕಾರ, ಹೇಳಿ, ಏನು problem?", pt="Doctor, ಇದು {days} days ಇಂದ ಇದೆ.", dx="ನಿಮಗೆ {dx} ಇದೆ.", inv="{inv} ಮಾಡಿಸಿ.",
                  rx="{d1} {q1} twice a day after food ತೆಗೆದುಕೊಳ್ಳಿ.", more="ಜೊತೆಗೆ {d} {q} once a day at night ತೆಗೆದುಕೊಳ್ಳಿ.", confirm="ಹಾಗಾದರೆ {d1} {q1} after food, ಸರಿನಾ?", back="{back} days ಆದ ಮೇಲೆ ಮತ್ತೆ ಬನ್ನಿ."),
}
LANGS = tuple(FRAMES)


def _q(v, unit):
    return "%d %s" % (v, unit)


def build(lang, k, cases=None, prefix="clin", turn_langs=None, skip_pt=False):
    """-> (name, turns [(speaker, lang, text)], items). Case k; the attendant (S3) confirms in odd cases (3 voices), else the patient (S2).
    turn_langs: optional per-turn language list (sentence-level switching, mixed dialogues): each turn is rendered with THAT language's frame."""
    cases = CASES if cases is None else cases
    c = cases[k]
    f = FRAMES[lang]
    FR = lambda i: FRAMES[turn_langs[i]] if turn_langs else f
    (d1, v1, u1) = c["drugs"][0]
    turns, items = [], []

    def add(spk, text):
        turns.append((spk, turn_langs[len(turns)] if turn_langs else lang, text))
        return len(turns) - 1

    add("S1", FR(len(turns))["greet"])
    if not skip_pt:                                                       # confirm suites drop the complaint turn: dialogues stay <= ~31 s (the judge's cut)
        add("S2", FR(len(turns))["pt"].format(days=c["days"]))
    i = add("S1", FR(len(turns))["dx"].format(dx=c["dx"]))
    items.append(dict(type="diagnosis", value=c["dx"], turn=i))
    i = add("S1", FR(len(turns))["inv"].format(inv=c["inv"]))
    items.append(dict(type="investigation", value=c["inv"], turn=i))
    i = add("S1", FR(len(turns))["rx"].format(d1=d1, q1=_q(v1, u1)))
    items.append(dict(type="drug", name=d1, dose_value=v1, dose_unit=u1, turn=i))
    for (d, v, u) in c["drugs"][1:]:
        i = add("S1", FR(len(turns))["more"].format(d=d, q=_q(v, u)))
        items.append(dict(type="drug", name=d, dose_value=v, dose_unit=u, turn=i))
    add("S3" if k % 2 else "S2", FR(len(turns))["confirm"].format(d1=d1, q1=_q(v1, u1)))
    i = add("S1", FR(len(turns))["back"].format(back=c["back"]))
    items.append(dict(type="follow_up_days", value=c["back"], turn=i))
    return "%s_%s_%d" % (prefix, lang, k + 1), turns, items


def build_confirm(lang, k):
    return build(lang, k, CONFIRM_CASES, "conf", skip_pt=True)


def build_mixed(base, j, cases=None, prefix="mix"):
    """j-th mixed dialogue: sentence-level switching base <-> en (even turns base, odd turns en); truth language = mixed."""
    cases = CONFIRM_CASES if cases is None else cases
    k = MIX_CASE[j]
    n = 5 + len(cases[k]["drugs"])                          # greet, dx, inv, first drug, extra drugs, confirm, follow-up (no complaint turn)
    tl = [base if i % 2 == 0 else "en" for i in range(n)]
    name, turns, items = build(base, k, cases, prefix, turn_langs=tl, skip_pt=True)
    assert len(turns) == n, (len(turns), n)
    return "%s_%s_%d" % (prefix, base, j + 1), turns, items


def build_confirm3(lang, k):
    return build(lang, k, CONFIRM3_CASES, "cf3", skip_pt=True)


def build_mixed3(base, j):
    return build_mixed(base, j, CONFIRM3_CASES, "mx3")


def crowd_lang(base_langs, k, draw):
    """other-language crowd for OTHER babble draw 1/2 of case k: two different languages, never the dialogue's own (nor English for mixed items); rotates so
    English consults sit over every Indic crowd."""
    cand = [l for l in ("en", "hi", "kn", "ta", "te", "ml") if l not in base_langs]
    return cand[(k + (0 if draw == 1 else 2)) % len(cand)]


def confirm3_canonical():
    return json.dumps({"confirm3_cases": CONFIRM3_CASES, "mix_bases": MIX_BASES, "mix_case": MIX_CASE, "frames": FRAMES}, sort_keys=True, ensure_ascii=False)


CONFIRM3_SHA = hashlib.sha256(confirm3_canonical().encode("utf-8")).hexdigest()


def confirm_canonical():
    return json.dumps({"confirm_cases": CONFIRM_CASES, "mix_bases": MIX_BASES, "mix_case": MIX_CASE, "frames": FRAMES}, sort_keys=True, ensure_ascii=False)


CONFIRM_SHA = hashlib.sha256(confirm_canonical().encode("utf-8")).hexdigest()


def canonical():
    return json.dumps({"cases": CASES, "frames": FRAMES}, sort_keys=True, ensure_ascii=False)


CLINICAL_SHA = hashlib.sha256(canonical().encode("utf-8")).hexdigest()


def all_dialogues(langs=LANGS):
    for lang in langs:
        for k in range(len(CASES)):
            yield build(lang, k)


def unique_chars(langs=LANGS):
    seen = {}
    for _n, turns, _i in all_dialogues(langs):
        for spk, lang, text in turns:
            seen[(lang, spk, text)] = len(text)
    return sum(seen.values()), len(seen)
