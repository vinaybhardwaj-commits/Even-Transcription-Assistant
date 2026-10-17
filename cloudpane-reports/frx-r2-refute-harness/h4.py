import importlib, itertools
R2 = importlib.import_module("tools.eta2freescript.r1_floors")
R1B = importlib.import_module("eta2fs_r1b.r1_floors")

def owner(q, spk="doctor"):
    return {"evidence_state": "heard_in_room", "evidence": [{"speaker": spk, "quote_en": q, "quote": q}]}

def posts(mod, name, q, raw=None, aliases=()):
    return mod.name_on_tape({"name": name, "raw_name": raw or name, "aliases": list(aliases)}, owner(q))

# D5: verdict 7 + 20 own
D5 = [("folic acid", "You have acid reflux."), ("pantoprazole sodium", "Keep the diet low sodium."), ("vitamin D3", "Your vitamin levels are low."),
      ("potassium chloride", "Your potassium is low."), ("calcium carbonate", "Get calcium in milk."), ("Augmentin 625 Duo", "Take the Duo pack."),
      ("calcium", "Get calcium in milk.")]
OWN = [("sodium valproate", "Reduce sodium in food."), ("ferrous sulphate", "Iron sulphate levels fine."), ("zinc oxide", "Zinc levels are fine."),
       ("magnesium hydroxide", "Magnesium is normal."), ("vitamin B12", "Vitamin levels are low, B12 we will test."), ("methylcobalamin forte", "Take something forte."),
       ("metformin SR", "Take the SR one."), ("Dolo 650", "Six fifty is the dose."), ("Pan 40", "Pan masala stop."), ("Montair LC", "The LC one."),
       ("Calcium + Vitamin D3", "Calcium and vitamin are important."), ("Becosules", "B complex is fine."), ("Shelcal 500", "Calcium 500 daily."),
       ("Limcee", "Vitamin C daily."), ("Zincovit", "Zinc and vitamins."), ("Neurobion Forte", "Forte is ok."), ("ORS", "Drink salt and sugar water."),
       ("potassium citrate", "Citrate in lemon juice helps, potassium too."), ("ascorbic acid", "Acid reflux again."), ("iron sucrose", "Iron is low, sugar too.")]
for nm, tag in ((D5, "verdict"), (OWN, "own")):
    r2 = sum(posts(R2, n, q) for n, q in nm); r1 = sum(posts(R1B, n, q) for n, q in nm)
    print(f"D5 {tag}: posted R1b {r1}/{len(nm)}  R2 {r2}/{len(nm)}", [n for n, q in nm if posts(R2, n, q)])
# legit base-word acceptance (recall)
LEG = [("pantoprazole sodium", "Take pantoprazole 40 before breakfast."), ("folic acid", "Start folic acid 5 mg daily."),
       ("vitamin D3", "Take vitamin D3 sixty thousand weekly."), ("Augmentin 625 Duo", "Start Augmentin 625 twice daily."),
       ("calcium carbonate", "Calcium carbonate 500 daily."), ("potassium chloride", "Potassium chloride syrup 10 ml."),
       ("Dolo 650", "Dolo 650 when fever."), ("amoxicillin and clavulanic acid", "Amoxicillin clavulanic acid twice daily."),
       ("paracetamol", "Paracetamol 650 SOS."), ("Calcium + Vitamin D3", "Calcium with vitamin D3 daily."),
       ("Shelcal 500", "Shelcal once daily."), ("vitamin B12", "Vitamin B12 injection weekly."), ("Pan-D", "Pan D before food."),
       ("Montair LC", "Montair LC at night."), ("metformin SR", "Metformin 500 SR after dinner."), ("Augmentin 625 Duo", "Augmentin duo twice daily.")]
print("D5 legit recall R2", sum(posts(R2, n, q) for n, q in LEG), "/", len(LEG), "R1b", sum(posts(R1B, n, q) for n, q in LEG), [n + "|" + q for n, q in LEG if not posts(R2, n, q)])

# L2: 16 dangerous ordered pairs + 20 own look-alike pairs (ordered both ways = 40)
grp = [["prednisolone", "prednisone"], ["hydroxychloroquine", "hydroxyzine", "hydrochlorothiazide"], ["chloroquine", "chlorpheniramine", "chlorthalidone"],
       ["amoxicillin", "amoxiclav"]]
dang = [(a, b) for g in grp for a, b in itertools.permutations(g, 2)]
OWNP = [("metformin", "metronidazole"), ("cefixime", "cefuroxime"), ("cefuroxime", "ceftriaxone"), ("clonazepam", "clonidine"), ("glimepiride", "glipizide"),
        ("amlodipine", "amiloride"), ("telmisartan", "olmesartan"), ("metoprolol", "metoclopramide"), ("tramadol", "trazodone"), ("rabeprazole", "aripiprazole"),
        ("esomeprazole", "omeprazole"), ("methotrexate", "metolazone"), ("carbamazepine", "oxcarbazepine"), ("lamotrigine", "lamivudine"),
        ("hydralazine", "hydroxyzine"), ("norfloxacin", "ofloxacin"), ("ofloxacin", "levofloxacin"), ("cetirizine", "levocetirizine"),
        ("prednisolone", "methylprednisolone"), ("chloroquine", "hydroxychloroquine")]
ownp = OWNP + [(b, a) for a, b in OWNP]
for tag, pairs in (("dangerous16", dang), ("own40", ownp)):
    r2 = [(a, b) for a, b in pairs if posts(R2, a, f"Start {b} 200 mg twice daily.")]
    r1 = [(a, b) for a, b in pairs if posts(R1B, a, f"Start {b} 200 mg twice daily.")]
    print(f"L2 {tag}: false-accept R1b {len(r1)}/{len(pairs)}  R2 {len(r2)}/{len(pairs)}", r2)
# spaced / split spellings (ASR) of a longer look-alike
SPL = [("chloroquine", "Start hydroxy chloroquine 200 mg."), ("cetirizine", "Start levo cetirizine 5 mg."), ("prednisolone", "Start methyl prednisolone 4 mg."),
       ("omeprazole", "Start es omeprazole 40 mg."), ("floxacin", "x"), ("ofloxacin", "Start levo ofloxacin 500."), ("amoxicillin", "Start amoxicillin clavulanate 625."),
       ("thiazide", "x"), ("zine", "x")]
print("L2 split-spelling accepts R2:", [(a, q) for a, q in SPL if q != "x" and posts(R2, a, q)])

# L1: 10 negated / non-clinical; 16 routine hand set; 14 true red flags
NEG = ["No need to go to the emergency.", "You don't need to come back immediately.", "Go to ER? No, not needed.",
       "If you start feeling better, return to work.", "If you start feeling better, return to school.", "If you start feeling better, return to the gym.",
       "If the stomach settles, return to normal diet.", "There is no need to rush to hospital for this.", "You need not come back immediately, it is mild.",
       "It is not an emergency, so don't go to casualty."]
ROUT = ["Come back after one week with the reports.", "If the reports are normal, come back next month.", "If you feel better, continue the same diet.",
        "Return the form at the front desk.", "If you want, come back on Monday.", "If the cough continues, keep using steam.",
        "Come back in three days for review.", "If it is convenient, come back in the morning.", "If you start walking daily, the knee will improve.",
        "Go to the lab and give blood sample.", "If the blood test is normal, return next week.", "If sugar is controlled, come back after three months.",
        "If the pain reduces, return to office work.", "Report to the counter for billing.", "If the BP is fine, come again in a month.",
        "If you are travelling, come back after you return."]
RF = ["If the pain becomes severe or you start vomiting, come to emergency immediately.", "If he becomes drowsy, bring him to casualty immediately.",
      "If there is any bleeding, come back immediately.", "Come back immediately if the fever continues beyond three days.",
      "If the pain is not better in two days, come back.", "If breathing becomes difficult, rush to the hospital.", "In case of chest pain, go to the emergency.",
      "If the child stops feeding, come immediately.", "If you develop rash or swelling of lips, go to the emergency.", "If the fever continues, come back.",
      "If you start bleeding, come back immediately.", "If urine output reduces, come to the hospital at once.", "If you get fits, go to the ER.",
      "If the swelling increases, come back to us."]
for tag, s in (("neg10", NEG), ("routine16", ROUT), ("redflag14", RF)):
    f2 = [x for x in s if R2.red_flag_clauses(x)]; f1 = [x for x in s if R1B.red_flag_clauses(x)]
    print(f"L1 {tag}: fire R1b {len(f1)}/{len(s)} R2 {len(f2)}/{len(s)}")
    if tag != "redflag14":
        print("   R2 fires:", f2)
    else:
        print("   R2 misses:", [x for x in s if not R2.red_flag_clauses(x)])
