import sys, json, re, random, collections
sys.argv=[sys.argv[0]]
src=open(sys.path[0]+'/h2_d3.py').read().split('# ---- D3: 600 runs ----')[0]
exec(src)
from tools.eta2freescript.r1_floors import apply_r1_ex
PAIRS=[("azithromycin","Azee"),("pantoprazole","Pan 40"),("pantoprazole","Pantocid"),("cetirizine","Cetzine"),("amoxicillin","Mox"),
       ("paracetamol","Dolo 650"),("paracetamol","Calpol"),("ibuprofen","Brufen"),("montelukast","Montair"),("metformin","Glycomet"),
       ("amlodipine","Amlong"),("domperidone","Domstal"),("ondansetron","Emeset"),("levocetirizine","Levocet"),("cefixime","Taxim-O")]
seen=set()
for seed in range(300):
    r=random.Random(seed+9100); g,b=r.choice(PAIRS); said=r.choice([g,b]); mention=r.choice([g,b])
    if not (said==b and mention==b) or (g,b) in seen: continue
    body={"Examination":"Throat red","Medication":"amoxicillin 500 mg three times a day x 5 days","General Advice":f"Drink warm water and rest; continue {mention} as advised"}
    if g=="amoxicillin": body["Medication"]=""
    c,enc,llm=consult(f"g3-{seed}",g,b,said,body)
    lg=run(c,enc,llm); a=lg["artifact"]; r1=lg.get("r1") or {}
    if not r1.get("r1_2_moved") or not lg["written"]: continue
    if re.search(r"(?i)\b"+re.escape(mention.split()[0]),a["note_text"]):
        seen.add((g,b)); mv=[p for p in a["provenance"] if p["kind"]=="medicine" and not p.get("json_pointer")]
        print(g,b,"| prov names",[p.get("names") for p in mv],"texts",[p["text"] for p in mv][:2])
# multi-advice
lines=[(0,4,"0","What is the problem?"),(5,10,"2","Take ibuprofen twice a day for three days."),(11,15,"0","Throat is red."),(16,22,"0","Avoid ibuprofen because of the ulcer. Drink warm water. If you vomit blood, go to the emergency immediately.")]
c=mk_consult(lines,roles={"0":"doctor","1":"patient","2":"unknown"}); c.uid="ma"
enc=empty_encounter(examination=[{"performed":"Throat","finding":"red","basis":"said","source_turns":[2]}],prescription=[rx("ibuprofen",None,1)],
   advice=[{"text":"Avoid ibuprofen because of the ulcer.","basis":"said","source_turns":[3]},{"text":"Drink warm water.","basis":"said","source_turns":[3]},{"text":"If you vomit blood, go to the emergency immediately.","basis":"said","source_turns":[3]}])
llm=note({"Examination":"Throat red","General Advice":"Avoid ibuprofen because of the ulcer; Drink warm water; If you vomit blood, go to the emergency immediately"})
b0=run(c,json.dumps(enc),llm,on=False); lg=run(c,json.dumps(enc),llm)
print("MULTI base GA:",repr(b0["artifact"]["gp_extraction"].get("general_advice"))[:200])
print("MULTI r2 GA:",repr(lg["artifact"]["gp_extraction"].get("general_advice")), [l for l in lg["artifact"]["note_text"].split("\n") if l.startswith("General")], lg["written"], {k:v for k,v in (lg.get("r1") or {}).items() if v})
