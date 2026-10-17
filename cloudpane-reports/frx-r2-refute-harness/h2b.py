import sys, json, re, random, collections
sys.argv=[sys.argv[0]]
src=open(sys.path[0]+'/h2_d3.py').read().split('# ---- D3: 600 runs ----')[0]
exec(src)
NAMES = ["paracetamol", "Paracetamol 650", "PARACETAMOL", "Calpol", "Calpol 500", "Dolo 650", "Dolo-650", "DOLO650", "dolo", "PCM","Crocin", "Crocin Advance", "Tab. Dolo 650", "pcm 500mg"]
BRANDS = [None, "Calpol", "Dolo 650", "Crocin", "PCM", "Dolo"]
VIS = re.compile(r"(?i)(paracetamol|calpol|dolo|pcm|crocin)")
HEADS = ["General Advice", "Plan of Management", "Diagnoses", "Presenting Complaint", "Examination", "Follow up", "Co-morbidities"]
cat=collections.Counter(); shown=0
for seed in range(600):
    r = random.Random(seed + 7000)
    brand = r.choice(BRANDS); said = brand or "paracetamol"; nm = r.choice(NAMES)
    head = r.choice(HEADS if seed % 2 else ["General Advice", "Plan of Management"])
    body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days","General Advice": "Drink warm water and rest", "Diagnoses": "Viral fever"}
    body[head] = (body.get(head, "") + "; " if body.get(head) else "") + r.choice([f"continue {nm} as advised", f"{nm} SOS for fever",f"take {nm} if temperature above 100", f"was given {nm}"])
    adv = [{"text": f"Take {r.choice(NAMES)} if fever.", "basis": "said", "source_turns": [5]}] if r.random() < 0.4 else None
    gen = "paracetamol" if r.random() < 0.8 else None
    c, enc, llm = consult(f"rf-d3-{seed}", gen, brand, said, body, adv)
    lg = run(c, enc, llm); a = lg["artifact"]
    if lg["written"] and VIS.search(a["note_text"]):
        r1 = lg.get("r1") or {}
        picks=[x.get("detail") for x in a["completion_required"] if x["kind"]=="pick_drug"]
        line=[l for l in a["note_text"].split("\n") if VIS.search(l)]
        key=(r1.get("r1_2_moved",0), gen, brand, lg["note_source"])
        cat[key]+=1
        if shown<4: shown+=1; print(seed, key, "picks",picks, "line",line, "gxvis", bool(VIS.search(json.dumps(a["gp_extraction"]))))
print(cat)
