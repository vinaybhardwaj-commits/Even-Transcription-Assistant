"""Held-out sets for R3 (not shown to the builder): split spellings, posting recall, red flags, allowlist over-withholding."""
import importlib
R = importlib.import_module("tools.eta2freescript.r1_floors")
def owner(q): return {"evidence_state": "heard_in_room", "evidence": [{"speaker": "doctor", "quote_en": q, "quote": q}]}
def posts(name, q, raw=None): return R.name_on_tape({"name": name, "raw_name": raw or name, "aliases": []}, owner(q))
# F3-class held-out: false accepts must be 0
FA = [("cetirizine", "Start levocetirizine 5 mg at night."), ("thyroxine", "Start levo thyroxine 50 mcg."), ("amlodipine", "Start s amlodipine 2.5 mg."),
      ("pantoprazole", "Start es pantoprazole 40."), ("salbutamol", "Use levo salbutamol inhaler."), ("floxacin", "Start oflo xacin."),
      ("prednisone", "Start predni sone 10 mg."), ("prednisolone", "Start methyl-prednisolone 8 mg."), ("chloroquine", "Start hydroxy-chloroquine 200."),
      ("hydroxyzine", "Start hydroxy zine 25 at night."), ("metformin", "Start metformin glimepiride combination."),
      ("clonidine", "Start clonazepam 0.5 at night."), ("tramadol", "Start tramadol paracetamol combination, one tablet."),
      ("losartan", "Start losartan hydrochlorothiazide 50."), ("amoxicillin", "Start amoxicillin plus clavulanic acid 625."),
      ("cefixime", "Start cefixime ofloxacin twice a day."), ("glimepiride", "Start glimepiride metformin one tablet."),
      ("Pan 40", "Stop pan and tobacco."), ("Dolo 650", "Dolo is not needed now."), ("Azee 500", "Azee course is over already.")]
print("HELD F3/F6 false-accept:", [n + "|" + q for n, q in FA if posts(n, q)], f"{sum(posts(n, q) for n, q in FA)}/{len(FA)}")
# recall held-out: doctor-confirmed, should post
OK = [("paracetamol", "Paracetamol 650 if fever, don't exceed four a day."), ("amlodipine", "Don't skip the amlodipine 5 mg."),
      ("metformin", "Continue metformin 500 twice daily."), ("Pan 40", "Pan 40 before breakfast."), ("Pan 40", "Tablet Pan once daily."),
      ("Dolo 650", "Dolo 650 thrice daily for three days."), ("cetirizine", "Cetirizine 10 mg at night, no driving after it."),
      ("amoxicillin", "Amoxicillin 500 thrice daily, not with milk."), ("pantoprazole", "Pantoprazole 40 empty stomach, avoid spicy food."),
      ("azithromycin", "Azithromycin 500 once daily for three days."), ("Azee 500", "Azee 500 once daily for three days."),
      ("levocetirizine", "Levocetirizine 5 mg at night."), ("montelukast and levocetirizine", "Montelukast levocetirizine at night."),
      ("ibuprofen", "Ibuprofen 400 after food, stop if acidity."), ("ondansetron", "Ondansetron 4 mg if vomiting, not more than thrice."),
      ("Mox 500", "Mox 500 thrice daily."), ("domperidone", "Domperidone 10 before food."), ("vitamin D3", "Vitamin D3 60000 weekly."),
      ("Calcium + Vitamin D3", "Calcium plus vitamin D3 once daily."), ("thyroxine", "Thyroxine 50 mcg empty stomach.")]
print("HELD recall:", f"{sum(posts(n, q) for n, q in OK)}/{len(OK)}", "missed:", [n + "|" + q for n, q in OK if not posts(n, q)])
RF = ["If she becomes unconscious, take her to the hospital at once.", "If the bleeding does not stop, go to casualty.",
      "If he has a fit, rush him to the ER.", "If you feel breathless, come back immediately.", "If the stools turn black, come to emergency.",
      "If the headache becomes unbearable, see a doctor urgently.", "If the swelling keeps increasing, come back here.",
      "If vomiting persists, come to the hospital.", "If the baby is drowsy, come immediately.", "If chest pain comes, go to the emergency."]
NO = ["If the cough persists, continue the syrup.", "If fever continues, keep taking the syrup.", "No need to rush to the emergency for a cold.",
      "If it is not better, we can change the cream.", "If you vomit once, don't worry, drink ORS.", "Take him home; he does not need casualty.",
      "If the pain continues after exercise, rest the knee.", "If symptoms persist, we will repeat the test next week.",
      "Bring the reports when you come back next month.", "If drowsy after the tablet, take it at night instead."]
print("HELD red flags fire:", f"{sum(bool(R.red_flag_clauses(s)) for s in RF)}/{len(RF)}", "miss:", [s for s in RF if not R.red_flag_clauses(s)])
print("HELD non-red fire:", f"{sum(bool(R.red_flag_clauses(s)) for s in NO)}/{len(NO)}", [s for s in NO if R.red_flag_clauses(s)])
# allowlist over-withholding: legit clinical strings with NO posted medicine; mention = would be withheld
art = {"gp_extraction": {"medicines": []}, "provenance": []}
PLAIN = ["Fever with chills for three days", "Viral fever", "Acute pharyngitis", "Acid peptic disease", "Type 2 diabetes mellitus",
 "Essential hypertension", "Hypothyroidism", "Allergic rhinitis", "Bronchial asthma", "Urinary tract infection", "Acute gastroenteritis",
 "Iron deficiency anaemia", "Vitamin D deficiency", "Low back pain", "Osteoarthritis of both knees", "Migraine without aura",
 "Tension type headache", "Seasonal influenza", "Dengue fever, platelets normal", "Typhoid fever suspected", "Lumbar spondylosis",
 "Cervical spondylosis", "Plantar fasciitis", "Frozen shoulder", "Tinea cruris", "Scabies", "Acne vulgaris", "Psoriasis vulgaris",
 "Conjunctivitis", "Otitis media", "Sinusitis", "Tonsillitis", "Gastritis", "Constipation", "Haemorrhoids", "Anal fissure",
 "Kidney stone, right side", "Fatty liver grade 1", "PCOS", "Dysmenorrhoea", "Anxiety", "Insomnia",
 "Drink plenty of water", "Salt restriction, less than 5 g a day", "Avoid oily and spicy food", "Steam inhalation twice a day",
 "Warm saline gargles", "Sitz bath twice a day", "Brisk walk 30 minutes daily", "Reduce sugar and sweets", "Sleep by 11 pm",
 "Apply ice pack to the knee", "Keep the area dry", "Wear loose cotton clothes", "Avoid cold drinks and ice cream", "Eat fibre-rich food",
 "Stop smoking and alcohol", "Diabetic diet", "Low fat diet", "Use a mosquito net", "Wash hands often", "Throat congested, tonsils enlarged",
 "Chest clear, no wheeze", "Abdomen soft, mild epigastric tenderness", "BP 140/90, pulse 88", "SpO2 98 percent on room air",
 "Knee crepitus present", "Pallor present", "Pedal oedema absent", "CBC, LFT, KFT", "HbA1c and lipid profile", "Thyroid profile",
 "Urine routine and culture", "USG abdomen", "X-ray chest PA view", "ECG", "Dengue NS1 antigen", "Widal test", "Vitamin B12 level",
 "Serum ferritin", "Follow up after one week with reports", "Review in 3 days if fever persists", "Refer to ENT", "Refer to orthopaedics",
 "Physiotherapy for the knee", "Ortho consult", "Dietician consult", "Cold compress", "Saline nasal drops", "Coconut oil for dry skin",
 "Honey and warm water for cough", "Turmeric milk at night", "ORS solution after each loose stool", "Glucose water for weakness",
 "Electral powder in water", "Calamine lotion for itching", "Petroleum jelly for cracks", "Sunscreen when outdoors",
 "Eye drops as needed", "Ear plugs while swimming", "Neck collar for two weeks", "Knee cap support", "Lumbar belt while travelling"]
hit = [(s, R.drug_mentions(s, [])) for s in PLAIN]
print("OW plain corpus:", f"{sum(bool(h) for s, h in hit)}/{len(PLAIN)} would be withheld:", [(s, h) for s, h in hit if h])
HIST = ["Diabetic on insulin for 5 years", "Hypertensive on telmisartan", "Hypothyroid on thyroxine 50 mcg", "Known asthmatic, uses inhaler",
        "Allergic to sulpha drugs", "Allergic to penicillin", "NSAID-induced gastritis", "Steroid-induced hyperglycaemia",
        "On warfarin, INR 2.5", "Post-COVID, on aspirin 75"]
print("OW history/allergy:", [(s, R.drug_mentions(s, [])) for s in HIST])
