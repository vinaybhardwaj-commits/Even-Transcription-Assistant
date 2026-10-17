"""FreeScript R3: fable's R3 order on FRX-R2-VERDICT (F1-F7, L1, L3). The moved-drug blocklist is replaced by an ALLOWLIST: a
drug mention in a posted string or the note must resolve to a posted, tape-supported medicine. Synthetic fixtures only; no
model calls (FakeClient)."""
from __future__ import annotations

import json
import random
import re

import pytest
from conftest import empty_encounter, mk_consult
from test_r1_floors import _rx, gen_consult, hand_art, meds, picks

from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import HEADINGS
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.r1_floors import (
    apply_r1, drug_mentions, name_on_tape, red_flag_clauses, unposted, vocab,
)


def owner(q, spk="doctor"):
    return {"evidence_state": "heard_in_room", "evidence": [{"speaker": spk, "quote_en": q, "quote": q}]}


def posts(name, q, aliases=()):
    return name_on_tape({"name": name, "raw_name": name, "aliases": list(aliases)}, owner(q))


def _note(body):
    return "\n".join(f"{h}: {body.get(h, '')}".rstrip() for h in HEADINGS)


# --- F1 / F2: the allowlist over the pipeline; any name of the drug, the mapper's own pick_drugs too -------------
PAIRS = [("azithromycin", "Azee"), ("pantoprazole", "Pan 40"), ("pantoprazole", "Pantocid"), ("cetirizine", "Cetzine"),
         ("amoxicillin", "Mox"), ("paracetamol", "Dolo 650"), ("paracetamol", "Calpol"), ("ibuprofen", "Brufen"),
         ("montelukast", "Montair"), ("metformin", "Glycomet"), ("amlodipine", "Amlong"), ("domperidone", "Domstal"),
         ("ondansetron", "Emeset"), ("levocetirizine", "Levocet"), ("cefixime", "Taxim-O")]


def _f1_consult(seed):
    r = random.Random(seed)
    g, b = r.choice(PAIRS)
    said, mention = r.choice([g, b]), r.choice([g, b, g.upper(), (b or g) + " 500"])
    if r.random() < 0.2:
        g = None  # Stage A generic null: the mapper's own pick_drug (F2)
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and body ache for two days."), (11, 15, "0", "Throat is red."),
             (16, 22, "2", f"Take {said} 500 mg twice a day for three days."),
             (23, 30, "0", "Start cefuroxime 500 mg twice a day for five days."), (31, 35, "0", "Drink warm water and rest.")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "unknown"})
    c.uid = f"synth-r3-f1-{seed}"
    rx = _rx(g, 3, "twice a day", "3 days")
    rx["brand_as_said"] = b if said == b else None
    enc = empty_encounter(examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
                          prescription=[rx, _rx("cefuroxime", 4, "twice a day", "5 days")],
                          advice=[{"text": "Drink warm water and rest.", "basis": "said", "source_turns": [5]}])
    head = r.choice(["General Advice", "Plan of Management", "Diagnoses", "Follow up"])
    body = {"Examination": "Throat red", "General Advice": "Drink warm water and rest", head: f"continue {mention} as advised"}
    return c, json.dumps(enc), _note(body), mention


def test_f1_f2_no_unposted_drug_is_visible_in_200_runs(tmp_path):
    written = visible = 0
    for seed in range(200):
        c, enc, llm, mention = _f1_consult(seed)
        lg = run_consult(c, FakeClient({"stageA": enc, "stageB": llm}), tmp_path, Options(notes_only=True))
        a = lg["artifact"]
        posted = " ".join(m["name"] for m in a["gp_extraction"].get("medicines") or []).lower()
        word = mention.split()[0].lower()
        if lg["written"]:
            written += 1
            if word not in posted:
                visible += bool(re.search(r"\b" + re.escape(word) + r"\b", a["note_text"], re.I))
    print(f"\nR3 F1/F2 200 runs: written {written}, unposted drug visible {visible}")
    assert visible == 0 and written >= 180


# --- F3: a split prefix or a combination partner refuses the name --------------------------------------------------
@pytest.mark.parametrize("name,quote", [("chloroquine", "Start hydroxy chloroquine 200 mg."), ("cetirizine", "Start levo cetirizine 5 mg."),
                                        ("prednisolone", "Start methyl prednisolone 4 mg."), ("omeprazole", "Start es omeprazole 40 mg."),
                                        ("ofloxacin", "Start levo ofloxacin 500."), ("amoxicillin", "Start amoxicillin clavulanate 625.")])
def test_f3_split_spelling_does_not_post(name, quote):
    assert not posts(name, quote)
    assert posts(name, f"Start {name} 200 mg.")


# --- F4: R1-2b before R1-5; a stop / avoid mention never posts a drug but still withholds ------------------------------
def test_f4_withheld_advice_does_not_hide_the_red_flag(tmp_path):
    rf = "If you vomit blood, go to the emergency immediately."
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "2", "Take ibuprofen twice a day for three days."), (11, 15, "0", "Throat is red."),
             (16, 22, "0", f"Avoid ibuprofen because of the ulcer. Drink warm water. {rf}")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "unknown"})
    enc = empty_encounter(examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
                          prescription=[_rx("ibuprofen", 1, "twice a day", "3 days")],
                          advice=[{"text": "Avoid ibuprofen because of the ulcer.", "basis": "said", "source_turns": [3]},
                                  {"text": "Drink warm water.", "basis": "said", "source_turns": [3]},
                                  {"text": rf, "basis": "said", "source_turns": [3]}])
    lg = run_consult(c, FakeClient({"stageA": json.dumps(enc), "stageB": _note({"Examination": "Throat red"})}), tmp_path,
                     Options(notes_only=True))
    ga = lg["artifact"]["gp_extraction"].get("general_advice") or ""
    assert lg["written"] and rf.rstrip(".") in ga and "Avoid ibuprofen because of the ulcer" in ga  # R4 G3: the warning stays
    assert "ibuprofen" not in json.dumps(lg["artifact"]["gp_extraction"].get("medicines") or [])


@pytest.mark.parametrize("name,quote", [("Pan 40", "Stop pan masala and tobacco, Pan 40 is not needed."),
                                        ("ibuprofen", "Avoid ibuprofen because of the ulcer."),
                                        ("aspirin", "Do not take aspirin before the procedure.")])
def test_f4_stop_or_avoid_mention_does_not_post(name, quote):
    assert not posts(name, quote)


def test_f4_stop_or_avoid_mention_stays_in_the_note():
    """R3 withheld it ("still counts for withholding"); fable's R4 ruling G3 reverses that: a warning passes the scan."""
    art = hand_art(para=("patient", "Take paracetamol 500 mg twice a day."))
    art["gp_extraction"]["general_advice"] = "Avoid ibuprofen because of the ulcer"
    out, c = apply_r1(art)
    assert out["gp_extraction"]["general_advice"] == "Avoid ibuprofen because of the ulcer" and c["r1_2b_withheld"] == 0


# --- F5: the R1-5 item never claims /general_advice when an owner has it -------------------------------------------
def test_f5_no_g1_pointer_clash_on_200_generated_consults(tmp_path):
    clash = added = 0
    for seed in range(200):
        c, enc, llm = gen_consult(seed)
        lg = run_consult(c, FakeClient({"stageA": enc, "stageB": llm}), tmp_path, Options(notes_only=True))
        clash += any(re.match(r"G1 advr1_\d+: json_pointer", e) for e in lg["final_errors"])
        added += (lg.get("r1") or {}).get("r1_5_added", 0)
        ptrs = [p.get("json_pointer") for p in lg["artifact"]["provenance"] if p.get("json_pointer") == "/general_advice"]
        assert len(ptrs) <= 1, seed
    print(f"\nR3 F5: 200 consults ON, R1-5 lines added {added}, G1 pointer clash {clash}")
    assert clash == 0 and added > 0


# --- F6: a short brand that is an everyday word posts only with its strength or a form word ----------------------------
@pytest.mark.parametrize("name,quote,ok", [("Pan 40", "Pan masala stop.", False), ("Pan 40", "Take Pan 40 before food.", True),
                                           ("Pan 40", "Tab pan before food.", True), ("Pan-D", "Pan D before food.", True),
                                           ("Mox", "Mox is fine.", False), ("Mox", "Mox 500 three times a day.", True),
                                           ("Zinc", "Zinc levels are fine.", False)])
def test_f6_everyday_brand_needs_strength_or_form(name, quote, ok):
    assert posts(name, quote) is ok


def test_f6_everyday_list_is_built_from_the_lexicon():
    ev = vocab().everyday
    assert {"pan", "mox", "dolo", "azee", "zinc"} <= ev and "paracetamol" not in ev


# --- F7: a moved qualifier-only drug ---------------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["Calcium", "Zinc", "Iron"])
def test_f7_moved_qualifier_drug_withholds_the_advice(name):
    art = hand_art()
    art["gp_extraction"]["medicines"][0].update({"name": name, "raw_name": name, "aliases": []})
    art["provenance"][7]["evidence"][0]["speaker"] = "patient"
    art["gp_extraction"]["general_advice"] = f"take {name.lower()} daily"
    out, c = apply_r1(art)
    assert name not in meds(out) and "general_advice" not in out["gp_extraction"] and c["r1_2b_withheld"] >= 1


# --- the scan stays off plain clinical text --------------------------------------------------------------------------
@pytest.mark.parametrize("text", ["Fever (2 days).", "Knee pain (2 days).", "Reduce salt to 5 g a day", "Drink warm water and rest",
                                  "Viral fever", "Acute pharyngitis", "Hypertension on treatment", "review if fever persists",
                                  "Low sodium diet", "Iron deficiency anaemia", "Vitamin D deficiency"])
def test_scan_ignores_plain_clinical_text(text):
    assert drug_mentions(text, ["paracetamol", "fever tablet", "pain killer"]) == []


# --- L1: a combination posts when every component is on tape --------------------------------------------------------
def test_l1_combination_with_a_qualifier_component_posts():
    assert posts("Calcium + Vitamin D3", "Calcium with vitamin D3 daily.")
    assert not posts("Calcium + Vitamin D3", "Calcium and vitamin are important.")
    assert not posts("Calcium", "There is calcium in milk.")


# --- L3: the red-flag cues back, negation-guarded --------------------------------------------------------------------
@pytest.mark.parametrize("text", ["If he becomes drowsy, bring him to casualty immediately.", "If the pain is not better in two days, come back.",
                                  "If the fever continues, come back.", "If it continues, come back to the hospital."])
def test_l3_misses_now_fire(text):
    assert red_flag_clauses(text) == [text]


@pytest.mark.parametrize("text", ["You need not come back immediately, it is mild.", "It is not an emergency, so don't go to casualty.",
                                  "If the cough continues, keep using steam.", "No need to bring him to casualty."])
def test_l3_negated_still_does_not_fire(text):
    assert red_flag_clauses(text) == []


def test_unposted_resolves_a_posted_drug_written_as_another_name():
    art = hand_art()  # paracetamol posted
    assert unposted(art, "Dolo SOS for fever; crocin if needed") == []
    assert picks(apply_r1(art)[0]) == []


# --- R4 (fable's R4 order on FRX-R3-VERDICT) ---------------------------------------------------------------------------
@pytest.mark.parametrize("name,quote", [("amlodipine", "Start s amlodipine 2.5 mg."), ("cetirizine", "Start r cetirizine 5 mg."),
                                        ("amoxicillin", "Start amoxicillin plus clavulanic acid 625."),
                                        ("amoxicillin", "Start amoxicillin + clavulanic acid 625."),
                                        ("amoxicillin", "Start amoxicillin and clavulanic acid 625.")])
def test_r4_g1_isomer_prefix_and_joined_partner_refuse(name, quote):
    assert not posts(name, quote)


def test_r4_g1_two_medicines_in_one_clause_both_post():
    art = hand_art(para=("doctor", "Take paracetamol and amoxicillin, paracetamol 500 mg twice a day for 3 days."),
                   amox=("doctor", "Start amoxicillin and paracetamol, amoxicillin 500 mg three times a day for 5 days."))
    assert meds(apply_r1(art)[0])[:2] == ["paracetamol 500 mg", "amoxicillin 500 mg"]


@pytest.mark.parametrize("brand", ["Met", "Pause"])
def test_r4_g2_a_moved_plain_word_brand_counts_bare_in_the_scan(brand):
    assert drug_mentions(f"continue {brand} as advised", [brand]) == [(brand.lower(),)]
    assert not posts(brand, f"Continue {brand} as advised.")  # posting still needs its strength or form word next to it


G3_WARNINGS = ["Do not take amoxicillin again; you had a rash with it.", "Avoid ibuprofen because of the stomach ulcer.",
               "Stop metformin two days before the CT scan.", "Do not stop aspirin before the procedure."]


@pytest.mark.parametrize("adv", G3_WARNINGS)
def test_r4_g3_a_drug_warning_stays_and_never_posts(adv):
    art = hand_art()
    art["gp_extraction"]["general_advice"] = adv
    out, _ = apply_r1(art)
    assert out["gp_extraction"]["general_advice"] == adv
    drug = re.search(r"amoxicillin|ibuprofen|metformin|aspirin", adv).group(0)
    assert not posts(drug, adv)


def test_r4_g3_only_the_item_naming_an_unposted_drug_is_withheld():
    art = hand_art()
    art["gp_extraction"]["general_advice"] = "Hypertensive on telmisartan, continue own medicines; Drink warm water. Rest at home"
    out, c = apply_r1(art)
    assert out["gp_extraction"]["general_advice"] == "Drink warm water. Rest at home" and c["r1_2b_withheld"] == 1
    assert [p["text"] for p in out["provenance"] if "field_withheld" in p["flags"]] == ["general_advice withheld (unconfirmed drug)"]


@pytest.mark.parametrize("text", ["Warm saline gargles", "Sitz bath twice a day", "Saline nasal drops", "Sunscreen when outdoors",
                                  "ORS solution after each loose stool", "Electral powder in water", "Calamine lotion for itching"])
def test_r4_g4_non_drug_and_non_prescription_words_pass_the_scan(text):
    assert drug_mentions(text, ["ORS", "Electral", "calamine"]) == []


def test_r4_g4_non_prescription_products_never_post():
    assert not posts("ORS", "Take ORS 200 ml after each loose stool.") and not posts("Calamine lotion", "Apply calamine lotion twice.")


def test_r4_g5_y6_a_split_misspelt_name_is_joined():
    """Kills Y6 (two-word join off): neither half is a drug word; only the join, one edit from paracetamol, finds it."""
    assert ("paracetamol",) in drug_mentions("continue parace temol as advised")
    assert ("paracetamol",) in drug_mentions("continue para cetemol as advised")  # "para" is a lexicon word itself


def test_r4_g5_y10_pipeline_rejects_a_note_that_still_names_an_unposted_drug(tmp_path, monkeypatch):
    """Kills Y10 (the pipeline keeps the note): when the deterministic note also names an unposted drug, the write rejects."""
    from tools.eta2freescript import pipeline
    real = pipeline._fallback_note_ex

    def names_azee(*a, **k):
        text, rem = real(*a, **k)
        return text.replace("General Advice:", "General Advice: continue Azee as advised;", 1), rem
    monkeypatch.setattr(pipeline, "_fallback_note_ex", names_azee)
    c, enc, llm = gen_consult(3)
    llm = llm.replace("General Advice:", "General Advice: continue Azee as advised;", 1)
    lg = run_consult(c, FakeClient({"stageA": enc, "stageB": llm}), tmp_path, Options(notes_only=True))
    assert not lg["written"] and "FRX-R1 note_text names a drug that is not posted" in lg["final_errors"]
