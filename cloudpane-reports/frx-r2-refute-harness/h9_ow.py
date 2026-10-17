import sys, json
sys.argv=[sys.argv[0]]
src=open(sys.path[0]+'/h2_d3.py').read().split('# ---- D3: 600 runs ----')[0]
exec(src)
for adv in ["Warm saline gargles twice a day", "Sitz bath twice a day", "Apply sunscreen when outdoors", "Calamine lotion for itching",
            "Hypertensive on telmisartan, continue own medicines"]:
    lines=[(0,4,"0","What is the problem?"),(5,10,"1","Sore throat for two days."),(11,15,"0","Throat is red."),
           (16,22,"0",f"Start amoxicillin 500 mg three times a day for five days. {adv}.")]
    c=mk_consult(lines,roles={"0":"doctor","1":"patient"}); c.uid="ow9-"+adv[:8]
    enc=empty_encounter(examination=[{"performed":"Throat","finding":"red","basis":"said","source_turns":[2]}],
        prescription=[rx("amoxicillin",None,3,"three times a day","5 days")],
        advice=[{"text":adv,"basis":"said","source_turns":[3]},{"text":"Drink warm water.","basis":"said","source_turns":[3]}])
    llm=note({"Examination":"Throat red","General Advice":f"{adv}; Drink warm water"})
    b=run(c,json.dumps(enc),llm,on=False); lg=run(c,json.dumps(enc),llm)
    ga=lambda x:[l for l in x["artifact"]["note_text"].split("\n") if l.startswith("General")]
    print(f"{adv!r}: base {ga(b)} | R3 {ga(lg)} | r1 { {k:v for k,v in (lg.get('r1') or {}).items() if v and k!='notes_only'} }")
