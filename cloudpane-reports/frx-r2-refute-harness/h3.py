"""Refuter harness 3: generalised D3 over brand+generic pairs; recall with a duplicate mention; safety-advice over-withholding."""
import sys, json, re, random, collections, importlib
which = sys.argv[1] if len(sys.argv) > 1 else "tools.eta2freescript"
sys.argv=[sys.argv[0], which]
src=open(sys.path[0]+'/h2_d3.py').read().split('# ---- D3: 600 runs ----')[0]
exec(src)
PAIRS=[("azithromycin","Azee"),("pantoprazole","Pan 40"),("pantoprazole","Pantocid"),("cetirizine","Cetzine"),("amoxicillin","Mox"),
       ("paracetamol","Dolo 650"),("paracetamol","Calpol"),("ibuprofen","Brufen"),("montelukast","Montair"),("metformin","Glycomet"),
       ("amlodipine","Amlong"),("domperidone","Domstal"),("ondansetron","Emeset"),("levocetirizine","Levocet"),("cefixime","Taxim-O")]
st=collections.Counter(); ex=[]
for seed in range(300):
    r=random.Random(seed+9100); g,b=r.choice(PAIRS); said=r.choice([g,b]); mention=r.choice([g,b])
    body={"Examination":"Throat red","Medication":"amoxicillin 500 mg three times a day x 5 days","General Advice":f"Drink warm water and rest; continue {mention} as advised"}
    if g=="amoxicillin": body["Medication"]=""
    c,enc,llm=consult(f"g3-{seed}",g,b,said,body)
    lg=run(c,enc,llm); a=lg["artifact"]; r1=lg.get("r1") or {}
    if not r1.get("r1_2_moved"): st["not_moved_by_r1"]+=1; continue
    st["moved"]+=1
    if lg["written"]:
        v=bool(re.search(r"(?i)\b"+re.escape(mention.split()[0]),a["note_text"]))
        st["visible"]+=v
        st[f"visible_said_{'generic' if said==g else 'brand'}_mention_{'generic' if mention==g else 'brand'}"]+=v
        if v and len(ex)<3: ex.append((g,b,said,mention))
    else: st["rejected"]+=1
print("GEN-D3", dict(st), ex)

# recall: doctor-confirmed drug + a non-doctor mention of the same molecule (another rx row)
rc=collections.Counter()
DOC=[("paracetamol","Dolo 650","650 mg"),("pantoprazole",None,"40 mg"),("cetirizine",None,"10 mg"),("amoxicillin",None,"500 mg"),("azithromycin",None,"500 mg")]
for seed in range(200):
    r=random.Random(seed+5500); g,b,stg=r.choice(DOC); dup=r.random()<0.5
    said=b or g
    lines=[(0,4,"0","What is the problem?"),(5,10,"1",("I was taking "+g+" at home. " if dup else "")+"Fever and cough for two days."),(11,15,"0","Throat is red."),
           (16,22,"0",f"Take {said} {stg} twice a day for three days."),(23,28,"0","Drink warm water and rest.")]
    c=mk_consult(lines,roles={"0":"doctor","1":"patient"}); c.uid=f"rc-{seed}"
    rxs=[rx(g,b,3,"twice a day","3 days",stg)]
    if dup: rxs.append(dict(rx(g,None,1,None,None,None),action="continue"))
    enc=empty_encounter(examination=[{"performed":"Throat","finding":"red","basis":"said","source_turns":[2]}],prescription=rxs,
                        advice=[{"text":"Drink warm water and rest.","basis":"said","source_turns":[4]}])
    llm=note({"Examination":"Throat red","Medication":f"{said} {stg} twice a day x 3 days","General Advice":"Drink warm water and rest"})
    base=run(c,json.dumps(enc),llm,on=False); lg=run(c,json.dumps(enc),llm)
    bp=[m["name"] for m in base["artifact"]["gp_extraction"].get("medicines") or []]
    p=[m["name"] for m in lg["artifact"]["gp_extraction"].get("medicines") or []]
    k="dup" if dup else "nodup"
    rc[k+"_n"]+=1; rc[k+"_base_posted"]+=bool(bp); rc[k+"_r2_posted"]+=bool(p); rc[k+"_r2_written_posted"]+=bool(p) and lg["written"]
    rc[k+"_r2_2b"]+=bool((lg.get("r1") or {}).get("r1_2b_rows_removed"))
print("RECALL", dict(rc))

# safety advice naming the moved drug
for g,b,adv,said_by in [("amoxicillin",None,"Do not take amoxicillin again; you had a rash with it.","1"),
                        ("ibuprofen",None,"Avoid ibuprofen because of the stomach ulcer.","2"),
                        ("metformin",None,"Stop metformin two days before the CT scan.","2"),
                        ("aspirin",None,"Do not stop aspirin before the procedure.","2")]:
    lines=[(0,4,"0","What is the problem?"),(5,10,said_by,f"Take {g} twice a day for three days."),(11,15,"0","Throat is red."),(16,22,"0",adv)]
    c=mk_consult(lines,roles={"0":"doctor","1":"patient","2":"unknown"}); c.uid=f"sa-{g}"
    enc=empty_encounter(examination=[{"performed":"Throat","finding":"red","basis":"said","source_turns":[2]}],prescription=[rx(g,b,1)],
                        advice=[{"text":adv,"basis":"said","source_turns":[3]}])
    llm=note({"Examination":"Throat red","General Advice":adv})
    base=run(c,json.dumps(enc),llm,on=False); lg=run(c,json.dumps(enc),llm); a=lg["artifact"]
    print(f"SAFE-ADV moved={g}: r1={ {k:v for k,v in (lg.get('r1') or {}).items() if v} } base_adv_in_note={adv[:20] in base['artifact']['note_text']} r2_adv_in_note={adv[:20] in a['note_text']} withheld={[p['text'] for p in a['provenance'] if 'field_withheld' in (p.get('flags') or [])]} written={lg['written']}")
