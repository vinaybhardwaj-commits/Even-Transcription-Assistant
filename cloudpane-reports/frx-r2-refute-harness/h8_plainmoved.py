import sys, json
sys.argv=[sys.argv[0]]
src=open(sys.path[0]+'/h2_d3.py').read().split('# ---- D3: 600 runs ----')[0]
exec(src)
for g, b in [("warfarin", None), ("insulin", None), ("thyroxine", None), ("progesterone", None), ("penicillin", None), ("metformin", "Met"),
             ("fluconazole", "Fluka"), ("paracetamol", "Pause"), ("saline nasal drops", None), ("ORS", None)]:
    for mention in [g, b] if b else [g]:
        body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days",
                "General Advice": f"Drink warm water and rest; continue {mention} as advised"}
        c, enc, llm = consult(f"pm-{g}-{mention}", g, b, b or g, body)
        lg = run(c, enc, llm); a = lg["artifact"]
        r1 = {k: v for k, v in (lg.get("r1") or {}).items() if v and k != "notes_only"}
        posted = [m["name"] for m in a["gp_extraction"].get("medicines") or []]
        print(f"moved={g}/{b} note says {mention!r}: r1={r1} posted={posted} written={lg['written']} visible={lg['written'] and mention.lower() in a['note_text'].lower()}")
