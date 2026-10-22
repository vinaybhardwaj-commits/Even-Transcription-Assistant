"""Writes the FRX-V10 versioned data files under tools/eta2freescript/data/. Run: python -m tools.eta2freescript.v10._build.make_data
The files are the artefacts; this script only keeps their construction reviewable. A change to any file needs a refuted spec change (rule 3)."""
import json
from pathlib import Path

D = Path(__file__).resolve().parents[2] / "data"


def dump(name, obj):
    p = D / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=False) + "\n", encoding="utf-8")


def u(canon, spell, lo, hi):
    return {"canon": canon, "spell": spell, "range": [lo, hi]}


GL = ["mg/dl", "mg per dl", "mg per deciliter", "milligram per deciliter", "milligrams per deciliter", "mg%"]
A = []


def an(key, name, aliases, units, shadow=False, bare=None, result_only=False):
    A.append({"key": key, "name": name, "aliases": aliases, "shadow": shadow, "units": units,
              "bare_range": bare if bare is not None else units[0]["range"] if units else None})


# alias-level shadow: an alias in "shadow_aliases" needs a unit AND a result word (rules 2, 21, C2)
an("hb", "Hb", ["hb", "hgb", "haemoglobin", "hemoglobin"], [u("g/dL", ["g/dl", "gm/dl", "g per dl", "gm per dl", "gm%", "g%"], 1, 25)])
an("hba1c", "HbA1c", ["hba1c", "hb a1c", "a1c", "glycated haemoglobin", "glycated hemoglobin"],
   [u("%", ["%", "percent", "per cent"], 3, 20), u("mmol/mol", ["mmol/mol", "mmol per mol"], 10, 200)])
an("glucose", "Blood glucose", ["fbs", "ppbs", "rbs", "ppg", "fbg", "rbg", "fasting blood sugar", "fasting sugar", "fasting glucose",
                                "post prandial sugar", "postprandial sugar", "random blood sugar", "random sugar", "blood sugar", "blood glucose", "sugar", "glucose"],
   [u("mg/dL", GL, 20, 1000), u("mmol/L", ["mmol/l", "mmol per l", "mmol per litre"], 1, 55)], bare=[20, 1000])
an("tsh", "TSH", ["tsh"], [u("mIU/L", ["miu/l", "miu per l", "uiu/ml", "µiu/ml", "μiu/ml", "miu/ml"], 0.005, 500)], shadow=True)
an("t3", "T3", ["t3"], [u("ng/dL", ["ng/dl", "ng per dl"], 10, 800), u("pg/mL", ["pg/ml", "pg per ml"], 0.5, 30), u("nmol/L", ["nmol/l"], 0.3, 12)])
an("t4", "T4", ["t4"], [u("µg/dL", ["µg/dl", "μg/dl", "mcg/dl", "ug/dl", "mcg per dl"], 0.3, 40), u("ng/dL", ["ng/dl", "ng per dl"], 0.1, 8)], shadow=True)
an("creatinine", "Creatinine", ["creatinine", "creat"], [u("mg/dL", GL, 0.1, 30)])
an("urea", "Urea", ["urea", "blood urea"], [u("mg/dL", GL, 3, 600)])
an("egfr", "eGFR", ["egfr", "gfr"], [u("mL/min", ["ml/min", "ml per min", "ml per minute"], 1, 200)])
an("sodium", "Sodium", ["sodium", "na"], [u("mEq/L", ["meq/l", "meq per l", "mmol/l"], 90, 200)])
an("potassium", "Potassium", ["potassium"], [u("mEq/L", ["meq/l", "meq per l", "mmol/l"], 1, 12)], shadow=True)
an("platelets", "Platelets", ["platelets", "platelet count", "plt"],
   [u("/cumm", ["/cumm", "/cu mm", "per cumm", "per cu mm", "/mm3", "/µl", "/μl"], 1000, 3000000), u("lakh", ["lakh", "lakhs"], 0.1, 30)])
an("tlc", "TLC", ["tlc", "wbc", "wbc count", "total leucocyte count", "total leukocyte count", "white cell count"],
   [u("/cumm", ["/cumm", "/cu mm", "per cumm", "per cu mm", "/mm3", "/µl", "/μl"], 300, 500000), u("×10³/µL", ["×10³/µl", "x10^3/ul", "x10³/µl", "x10^3/µl"], 0.3, 500)])
an("esr", "ESR", ["esr"], [u("mm/hr", ["mm/hr", "mm/h", "mm per hour", "mm in first hour", "mm/hour"], 0, 200)])
an("crp", "CRP", ["crp"], [u("mg/L", ["mg/l", "mg per l"], 0, 700)])
an("inr", "INR", ["inr"], [], bare=[0.5, 10])
an("ldl", "LDL", ["ldl", "ldl cholesterol"], [u("mg/dL", GL, 5, 600)])
an("hdl", "HDL", ["hdl", "hdl cholesterol"], [u("mg/dL", GL, 5, 200)])
an("triglycerides", "Triglycerides", ["triglycerides", "triglyceride", "tg"], [u("mg/dL", GL, 10, 5000)])
an("cholesterol", "Total cholesterol", ["total cholesterol", "cholesterol"], [u("mg/dL", GL, 30, 1000)])
an("uric_acid", "Uric acid", ["uric acid"], [u("mg/dL", GL, 0.5, 30)])
an("bilirubin", "Bilirubin", ["bilirubin", "total bilirubin"], [u("mg/dL", GL, 0.05, 60)])
an("alt", "SGPT/ALT", ["sgpt", "alt"], [u("U/L", ["u/l", "iu/l", "units per litre", "u per l"], 1, 10000)])
an("ast", "SGOT/AST", ["sgot", "ast"], [u("U/L", ["u/l", "iu/l", "units per litre", "u per l"], 1, 10000)])
an("albumin", "Albumin", ["albumin", "serum albumin"], [u("g/dL", ["g/dl", "gm/dl", "g per dl", "gm per dl", "gm%", "g%"], 0.5, 8)], shadow=True)
an("vitamin_d", "Vitamin D", ["vitamin d", "vit d", "25 oh vitamin d", "25-oh vitamin d"],
   [u("ng/mL", ["ng/ml", "ng per ml"], 1, 500), u("nmol/L", ["nmol/l"], 2.5, 1250)], shadow=True)
an("b12", "Vitamin B12", ["b12", "vitamin b12", "vit b12"], [u("pg/mL", ["pg/ml", "pg per ml"], 20, 10000), u("pmol/L", ["pmol/l"], 15, 7500)], shadow=True)
an("ferritin", "Ferritin", ["ferritin"], [u("ng/mL", ["ng/ml", "ng per ml", "µg/l", "μg/l", "mcg/l"], 1, 20000)])
an("calcium", "Calcium", ["calcium", "serum calcium"], [u("mg/dL", GL, 3, 20), u("mmol/L", ["mmol/l"], 0.7, 5)], shadow=True)
an("psa", "PSA", ["psa"], [u("ng/mL", ["ng/ml", "ng per ml"], 0, 2000)])
an("magnesium", "Magnesium", ["magnesium", "serum magnesium"], [u("mg/dL", GL, 0.3, 10), u("mEq/L", ["meq/l"], 0.3, 8)], shadow=True)
an("zinc", "Zinc", ["zinc", "serum zinc"], [u("µg/dL", ["µg/dl", "μg/dl", "mcg/dl", "ug/dl"], 5, 600)], shadow=True)
an("folate", "Folate", ["folate", "folic acid", "serum folate"], [u("ng/mL", ["ng/ml", "ng per ml"], 0.3, 100)], shadow=True)
dump("slots/analytes.v1.json", {
    "version": "analytes.v1",
    "spec": "rule 16 (list), rule 28 (magnesium, zinc, folate), rule 2 and C2 (shadow analytes), rule 17 (INR), rule 18 (units)",
    "result_words": ["report", "level", "levels", "came", "value", "result", "results"],
    "fillers": ["is", "was", "of", ":", "="],
    "shadow_note": "A shadow analyte also names a drug. It posts only with a unit AND a result word, and the frame 'for <analyte>' is always vetoed (rule 2, C2). "
                   "In a full lab frame (analyte + unit + result word) the detector's catalogue hit on the analyte word is ignored (rule 21).",
    "shadow_aliases_only": ["sugar", "glucose", "blood sugar", "blood glucose", "fasting blood sugar", "fasting sugar", "fasting glucose", "random blood sugar",
                            "random sugar", "post prandial sugar", "postprandial sugar"],
    "inr_rule": "INR posts only as INR + a result word + a value from 0.5 to 10; no unit needed (rule 17)",
    "analytes": A,
})

dump("slots/slot_bounds.v1.json", {
    "version": "slot-bounds.v1",
    "spec": "the slot table; rules 10, 11, 17",
    "vital": {"bp_sys": [50, 260], "bp_dia": [30, 160], "pulse": [20, 250], "pulse_implied": [40, 200], "spo2": [50, 100], "temp_f": [90, 110], "temp_f_implied": [95, 108],
              "temp_c": [32, 43], "rr": [4, 60], "weight_kg": [1, 300], "height_cm": [30, 230]},
    "followup_interval_max": {"days": 365, "weeks": 52, "months": 24, "years": 5},
    "date_years_ahead": 2,
    "illness_duration_years_max": 80,
    "advice_duration_days_max": 365,
    "age": [0, 120],
    "lifting_kg": [1, 50],
    "daily": {"glasses": 20, "litres": 6, "meals": 8, "minutes": 180, "km": 20, "steps": 20000, "ml_water": 5000},
    "inr": [0.5, 10],
    "pain_score": [0, 10],
    "stage": [1, 5], "grade": [1, 4],
})

dump("detector_thresholds.v1.json", {
    "version": "detector-thresholds.v1",
    "window_tokens": 3,
    "adjacent_segment_gap_s": 2.0,
    "fuzzy": {"min_len_similarity": 6, "similarity": 0.85, "short_len_min": 4, "short_len_max": 5, "short_max_edits": 1, "exact_only_max_len": 3},
    "english_word_brand_cue_window": 3,
    "min_catalogue_token_len": 3,
    "max_short_dictionary_len": 2,
    "note": "the thresholds are the contract's V9 matching limits (similarity 0.85 for names of 6+ letters, one edit for 4-5, exact for 3 or fewer)",
})

dose_units = ["mg", "mgs", "mcg", "mcgs", "µg", "μg", "ug", "g", "gm", "gms", "gram", "grams", "gramme", "milligram", "milligrams", "microgram", "micrograms",
              "iu", "unit", "units", "u", "k", "ml", "mls", "millilitre", "millilitres", "milliliter", "milliliters", "cc"]
dosing = ["daily", "od", "bd", "tds", "morning", "night", "subah", "raat", "tablet", "tab", "capsule", "syrup", "injection", "drops", "drop", "puff", "sachet",
          "dose", "wali", "waali", "take", "le", "lena",
          "apply", "use",
          "weekly", "once", "twice", "thrice", "hs", "sos", "qid", "bedtime", "breakfast", "lunch", "dinner", "give", "dena", "wala", "goli", "dawa", "dawai",
          "inj", "cap", "spray", "strip", "gram", "maatre", "beligge", "ratri",
          "medicine", "medication", "pill", "drug", "tabs", "caps", "dosage", "prn", "tid", "bid", "syp", "ointment", "cream", "gel"]
dump("dosing_words.v1.json", {
    "version": "dosing-words.v1",
    "spec": "global vetoes bullet 3, precise rule 3, C1; matching uses stems and plurals",
    "dose_units": dose_units,
    "lab_unit_exempt_note": "rule 6/18: mg/dL, g/dL, mL/min, mmol/L, mEq/L, %, mIU/L, µIU/mL, pg/mL, ng/mL, U/L, IU/L, mg/L, mm/hr, /cumm, lakh and ×10³/µL are exempt from the dose-unit veto only when attached to an analyte; bare mg, g, IU, units, K never are",
    "words": dosing,
    "phrases": ["before food", "after food", "khane ke baad", "khane se pehle", "empty stomach", "on waking", "alternate day", "alternate days", "ki goli", "ki dawa", "ki dawai",
                "before meals", "after meals", "with food", "at night", "per day", "a day"],
    "irregular_forms": {"take": ["takes", "taking", "taken", "took"], "give": ["gives", "giving", "given", "gave"], "use": ["uses", "used", "using"],
                        "apply": ["applies", "applied", "applying"], "dose": ["doses", "dosed", "dosing"], "continue": ["continues", "continued", "continuing"],
                        "prescribe": ["prescribes", "prescribed", "prescribing"], "night": ["nights", "nightly", "overnight"], "morning": ["mornings"],
                        "tablet": ["tablets"], "capsule": ["capsules"], "medicine": ["medicines"], "pill": ["pills"], "drug": ["drugs"], "medication": ["medications"],
                        "injection": ["injections"], "sachet": ["sachets"], "puff": ["puffs"], "daily": ["everyday"]},
    "stems_extra": ["continue", "prescribe", "prescription", "regimen"],
    "brand_cue_words": ["took", "prescribed", "taking", "started", "start", "giving"],
    "daily_exempt_note": "rule 10: 'daily' is allowed only inside an exercise frame ('walk 30 minutes daily')",
})

dump("clinical_whitelist.v1.json", {
    "version": "clinical-whitelist.v1",
    "spec": "rule 7, rule 20; the whitelist wins over the catalogue for analyte names",
    "name_tokens": ["B12", "B-12", "T3", "T4", "HbA1c", "Hb A1c", "A1c", "S1S2", "S1", "S2", "S3", "S4", "T2DM", "T1DM", "OMEGA-3", "Omega 3", "COVID-19", "COVID19", "H1N1",
                    "SpO2", "SpO₂", "CO2", "O2", "IL-6", "2D Echo", "2D-Echo", "G6PD", "CD4", "CA-125", "CA 125", "CA 19-9", "CA 15-3", "HLA-B27", "NT-proBNP", "H3N2", "COX-2",
                    "L4-L5", "C5-6", "L5-S1"],
    "analyte_words": ["hb", "hgb", "haemoglobin", "hemoglobin", "hba1c", "a1c", "glycated", "fbs", "ppbs", "rbs", "ppg", "fbg", "rbg", "tsh", "t3", "t4", "thyroid", "creatinine",
                      "creat", "urea", "egfr", "gfr", "sodium", "potassium", "platelet", "platelets", "plt", "tlc", "wbc", "leucocyte", "leukocyte", "esr", "crp", "inr", "ldl", "hdl",
                      "triglycerides", "triglyceride", "tg", "cholesterol", "uric", "acid", "bilirubin", "sgpt", "alt", "sgot", "ast", "albumin", "vitamin", "vit", "b12", "ferritin",
                      "calcium", "psa", "magnesium", "zinc", "folate", "folic", "sugar", "glucose", "insulin", "iron", "serum", "fasting", "random", "postprandial", "prandial", "post",
                      "level", "levels", "report", "value", "result", "results", "came", "count", "total"],
    "vital_words": ["bp", "pressure", "blood", "pulse", "heart", "rate", "hr", "spo2", "saturation", "oxygen", "temperature", "temp", "fever", "rr", "respiratory", "weight",
                    "wt", "height", "ht", "bmi", "mmhg", "bpm", "min", "minute", "minutes", "fahrenheit", "celsius", "kg", "kgs", "kilo", "kilos", "kilogram", "kilograms", "cm",
                    "centimeter", "centimetre", "centimeters", "centimetres", "breaths", "beats", "per", "mm", "hg", "degrees", "degree"],
    "unit_words": ["dl", "ml", "l", "mmol", "meq", "miu", "uiu", "iu", "pg", "ng", "mm", "hr", "hrs", "cumm", "cu", "lakh", "lakhs", "µl", "ul", "mol", "u", "g", "mg", "gm", "gms",
                   "percent", "cent", "litre", "litres", "liter", "liters", "glass", "glasses", "meal", "meals", "steps", "km", "walk", "walking"],
    "time_words": ["day", "days", "week", "weeks", "month", "months", "year", "years", "hour", "hours", "yr", "yrs", "wk", "wks", "din", "hafte", "hafta", "mahine", "mahina", "saal",
                   "baad", "after", "since", "past", "last", "ago", "old", "age", "aged"],
    "clinical_abbreviations": ["ecg", "ekg", "ent", "cbc", "mri", "ct", "xray", "x-ray", "usg", "echo", "tmt", "opd", "ipd", "icu", "dm", "htn", "cad", "copd", "ckd", "uti", "urti",
                               "lrti", "gerd", "pcos", "bph", "ra", "oa", "ibs", "gi", "cvs", "cns", "rs", "pa", "ap", "lat", "lft", "rft", "kft", "pft", "fnac", "ivf", "lscs", "ent"],
    "indic_romanized_function_words": ["se", "ka", "ki", "ke", "ko", "me", "mein", "mai", "hai", "hain", "ho", "hoga", "hogi", "tha", "thi", "the", "aur", "ya", "nahi", "nahin",
                                       "bhi", "to", "toh", "par", "pe", "ye", "yeh", "wo", "woh", "kya", "kal", "aaj", "abhi", "din", "hafte", "hafta", "mahine", "mahina", "saal",
                                       "baad", "pehle", "bukhar", "dard", "khansi", "sardi", "pet", "sar", "seena", "badan", "pair", "haath", "raha", "rahi", "rahe", "hua", "hui",
                                       "bahut", "thoda", "thodi", "kuch", "koi", "mujhe", "mereko", "aap", "aapko", "main", "hum"],
    "note": "word lists are additions to the English dictionary; the catalogue's single-token names that are not English words are subtracted from the dictionary",
})
print("written", sorted(str(p.relative_to(D)) for p in D.rglob("*.json")))
