"""Refuter harness 2: D3 (own 600-run setup), qualifier-only moved drugs, over-withholding end to end."""
import json, random, re, sys, tempfile, collections, copy
from pathlib import Path
import importlib
MOD = sys.argv[1] if len(sys.argv) > 1 else "tools.eta2freescript"
P = importlib.import_module(MOD + ".pipeline")
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import HEADINGS
from conftest import mk_consult, empty_encounter

tmp = Path(tempfile.mkdtemp())


def rx(generic, brand, t, freq="twice a day", dur="3 days", st="500 mg"):
    return {"action": "start", "decision_turn": t, "generic": generic, "brand_as_said": brand, "strength": st, "frequency": freq,
            "duration": dur, "route": "oral", "basis": "said", "confidence": 0.85, "source_quote_turn": t, "source_turns": [t]}


def note(body):
    return "\n".join(f"{h}: {body.get(h, '')}".rstrip() for h in HEADINGS)


def consult(uid, moved_generic, moved_brand, said, llm_body, advice_extra=None, cc="Fever", dx="Viral fever", dx_turn_text=None):
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", f"{cc} and body ache for two days."), (11, 15, "0", "Throat is red."),
             (16, 22, "2", f"Take {said} 500 mg twice a day for three days."),
             (23, 30, "0", "Start amoxicillin 500 mg three times a day for five days."), (31, 35, "0", "Drink warm water and rest."),
             (36, 40, "0", dx_turn_text or f"This looks like {dx.lower()}.")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "unknown"})
    c.uid = uid
    adv = [{"text": "Drink warm water and rest.", "basis": "said", "source_turns": [5]}] + (advice_extra or [])
    enc = empty_encounter(chief_complaint={"text": cc, "duration": "2 days", "basis": "said", "source_turns": [1]},
                          examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
                          diagnoses=[{"label": dx, "rank": "primary", "doctor_named": True, "status": "provisional", "basis": "said",
                                      "source_turns": [6]}],
                          prescription=[rx(moved_generic, moved_brand, 3), rx("amoxicillin", None, 4, "three times a day", "5 days")],
                          advice=adv)
    return c, json.dumps(enc), note(llm_body)


def run(c, enc, llm, on=True):
    return P.run_consult(c, FakeClient({"stageA": enc, "stageB": llm}), tmp, P.Options(notes_only=on))


# ---- D3: 600 runs ----
NAMES = ["paracetamol", "Paracetamol 650", "PARACETAMOL", "Calpol", "Calpol 500", "Dolo 650", "Dolo-650", "DOLO650", "dolo", "PCM",
         "Crocin", "Crocin Advance", "Tab. Dolo 650", "pcm 500mg"]
BRANDS = [None, "Calpol", "Dolo 650", "Crocin", "PCM", "Dolo"]
VIS = re.compile(r"(?i)(paracetamol|calpol|dolo|pcm|crocin)")
HEADS = ["General Advice", "Plan of Management", "Diagnoses", "Presenting Complaint", "Examination", "Follow up", "Co-morbidities"]
st = collections.Counter()
ex = {}
for seed in range(600):
    r = random.Random(seed + 7000)
    brand = r.choice(BRANDS)
    said = brand or "paracetamol"
    nm = r.choice(NAMES)
    head = r.choice(HEADS if seed % 2 else ["General Advice", "Plan of Management"])
    body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days",
            "General Advice": "Drink warm water and rest", "Diagnoses": "Viral fever"}
    body[head] = (body.get(head, "") + "; " if body.get(head) else "") + r.choice([f"continue {nm} as advised", f"{nm} SOS for fever",
                                                                                    f"take {nm} if temperature above 100", f"was given {nm}"])
    adv = [{"text": f"Take {r.choice(NAMES)} if fever.", "basis": "said", "source_turns": [5]}] if r.random() < 0.4 else None
    c, enc, llm = consult(f"rf-d3-{seed}", "paracetamol" if r.random() < 0.8 else None, brand, said, body, adv)
    lg = run(c, enc, llm)
    a = lg["artifact"]
    st["head:" + head] += 1
    st["written"] += lg["written"]
    st["posted_para"] += bool(VIS.search(json.dumps([m.get("name") for m in a["gp_extraction"].get("medicines") or []])))
    if lg["written"]:
        v = bool(VIS.search(a["note_text"]))
        st["visible_written"] += v
        st["visible_gx_written"] += bool(VIS.search(json.dumps(a["gp_extraction"])))
        if v and "vis" not in ex:
            ex["vis"] = (seed, nm, head)
    else:
        st["rejected"] += 1
        st["rej:" + "|".join(e[:50] for e in lg["final_errors"])] += 1
print("D3 600:", dict(st), ex)

# ---- D3 misspellings / other molecules (secondary) ----
sec = collections.Counter()
for moved_g, moved_b, mention in [("paracetamol", None, "paracetemol"), ("paracetamol", None, "para-cetamol"), ("paracetamol", None, "P-650"),
                                  ("pantoprazole", None, "Pan 40"), ("pantoprazole", None, "Pantocid"), ("pantoprazole", "Pan 40", "pantoprazole"),
                                  ("cetirizine", None, "Cetzine"), ("cetirizine", None, "Okacet"), ("cetirizine", "Okacet", "cetirizine"),
                                  ("amoxicillin and clavulanic acid", "Augmentin 625 Duo", "amoxiclav"),
                                  ("amoxicillin and clavulanic acid", None, "Augmentin"), ("azithromycin", None, "Azee 500"),
                                  ("azithromycin", "Azee", "azithromycin")]:
    body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days",
            "General Advice": f"Drink warm water and rest; continue {mention} as advised"}
    c, enc, llm = consult(f"rf-d3s-{mention}-{moved_b}", moved_g, moved_b, moved_b or moved_g, body)
    lg = run(c, enc, llm)
    vis = lg["written"] and mention.lower() in lg["artifact"]["note_text"].lower()
    print(f"D3-sec moved={moved_g}/{moved_b} note says {mention!r}: written={lg['written']} visible={bool(vis)}")

# ---- D3 qualifier-only moved names ----
for g in ["calcium", "zinc", "iron", "magnesium", "folic acid", "vitamin D3", "potassium chloride", "calcium carbonate"]:
    body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days",
            "General Advice": f"Drink warm water and rest; take {g} daily"}
    c, enc, llm = consult(f"rf-d3q-{g}", g, None, g, body)
    lg = run(c, enc, llm)
    a = lg["artifact"]
    meds = [m["name"] for m in a["gp_extraction"].get("medicines") or []]
    print(f"D3-qual moved={g}: posted={meds} written={lg['written']} visible_in_note={lg['written'] and g.lower() in a['note_text'].lower()}")

# ---- over-withholding: moved drug with an everyday raw name, legit fields that do not name it ----
for g, b, cc, dx, adv in [("paracetamol", "fever tablet", "Fever", "Viral fever", "Sponge with tap water if fever persists"),
                          ("pantoprazole", "gas tablet", "Abdominal bloating", "Gastritis with gas", "Avoid gas forming food"),
                          (None, "cough syrup", "Cough", "Acute cough", "Steam inhalation for cough"),
                          ("pantoprazole", "Pan 40", "Burning in chest", "Acid peptic disease", "Stop pan masala and tobacco"),
                          (None, "B complex", "Tingling in feet", "Complex regional pain syndrome", "Daily foot care"),
                          ("diclofenac", "pain killer", "Knee pain", "Osteoarthritis knee", "Avoid pain-provoking activity"),
                          (None, "ORS", "Loose stools", "Acute gastroenteritis", "Drink ORS after each loose stool"),
                          ("cetirizine", "allergy tablet", "Sneezing", "Allergic rhinitis", "Avoid dust; allergy test if it recurs"),
                          ("amlodipine", "BP tablet", "Headache", "Hypertension", "Check BP daily at home")]:
    body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days", "General Advice": adv,
            "Diagnoses": dx, "Presenting Complaint": cc}
    c, enc, llm = consult(f"rf-ow-{b}", g, b, b, body, [{"text": adv, "basis": "said", "source_turns": [5]}], cc=cc, dx=dx)
    base = run(c, enc, llm, on=False)
    lg = run(c, enc, llm)
    a = lg["artifact"]
    gx, bx = a["gp_extraction"], base["artifact"]["gp_extraction"]
    lost = [k for k in ("general_advice", "presenting_complaints") if json.dumps(bx.get(k)) != json.dumps(gx.get(k))]
    w = [p["text"] for p in a["provenance"] if "field_withheld" in (p.get("flags") or [])]
    print(f"OW moved={g}/{b!r}: r1={ {k: v for k, v in (lg.get('r1') or {}).items() if v and k.startswith('r1_2')} } withheld={w} "
          f"dx_kept={dx.lower() in a['note_text'].lower()} adv_kept={adv.lower() in a['note_text'].lower()} cc_kept={cc.lower() in a['note_text'].lower()} written={lg['written']}")
