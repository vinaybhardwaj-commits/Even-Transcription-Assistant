"""FreeScript R2, on R1b (ea2818ee): fable rulings 4-8 on FRX-R1-VERDICT (D3, D5, L2, L1, L6), as R3 redesigned D3 (the
allowlist, FRX-R2-VERDICT F1 / F2 / F7). D1 / D2 / D4 are R1b's (lead rulings B1-B4, F2) and are not redone here. Synthetic
fixtures only; no model calls (FakeClient)."""
from __future__ import annotations

import copy
import json
import random
import re

import pytest
from conftest import mk_consult
from test_r1_floors import hand_art, meds, picks

from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import HEADINGS, MEDICATION_LABEL
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.r1_floors import (
    QUALIFIERS, apply_r1, apply_r1_ex, drug_mentions, name_in_text, name_on_tape, overlap, red_flag_clauses, unposted,
    unposted_in_note,
)


# --- D3: a moved drug is never visible in a written note ------------------------------------------------------
NAMES = ["paracetamol", "Paracetamol 500 mg", "Calpol", "Dolo 650", "PCM", "Crocin", "dolo-650"]
_VISIBLE = re.compile(r"\b(?:paracetamol|calpol|dolo|pcm|crocin)\b", re.I)


def _d3_consult(seed):
    """The verdict's setup, rebuilt: an unknown-speaker paracetamol (R1-2 moves it) said as the generic or a brand, an LLM note
    that names it (any name) under General Advice or Plan of Management, and posted advice that sometimes names it too."""
    from conftest import empty_encounter
    from test_r1_floors import _rx
    rng = random.Random(seed)
    brand = rng.choice([None, "Calpol", "Dolo 650", "Crocin", "PCM"])
    said = brand or "paracetamol"
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and sore throat for two days."), (11, 15, "0", "Throat is red."),
             (16, 22, "2", f"Take {said} 500 mg twice a day for three days."),
             (23, 30, "0", "Start amoxicillin 500 mg three times a day for five days."), (31, 35, "0", "Drink warm water and rest.")]
    rx = _rx("paracetamol", 3, "twice a day", "3 days")
    rx["brand_as_said"] = brand
    named_advice = rng.random() < 0.4
    adv = [{"text": "Drink warm water and rest.", "basis": "said", "source_turns": [5]}]
    if named_advice:
        adv.append({"text": f"Continue {rng.choice(NAMES)} as advised.", "basis": "said", "source_turns": [5]})
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "unknown"})
    c.uid = f"synth-r2-d3-{seed}"
    enc = empty_encounter(examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
                          prescription=[rx, _rx("amoxicillin", 4, "three times a day", "5 days")], advice=adv)
    name = rng.choice(NAMES)
    head = rng.choice(["General Advice", "Plan of Management", "Diagnoses"])
    body = {"Examination": "Throat red", "Medication": "amoxicillin 500 mg three times a day x 5 days",
            "General Advice": "Drink warm water and rest", head: f"continue {name} as advised"}
    if head == "General Advice":
        body[head] = f"Drink warm water and rest; continue {name} as advised"
    llm = "\n".join(f"{h}: {body.get(h, '')}".rstrip() for h in HEADINGS)
    return c, json.dumps(enc), llm, named_advice


def test_d3_moved_drug_never_visible_in_600_runs(tmp_path):
    written = visible = rejected = named_runs = 0
    for seed in range(600):
        c, enc, llm, named = _d3_consult(seed)
        lg = run_consult(c, FakeClient({"stageA": enc, "stageB": llm}), tmp_path, Options(notes_only=True))
        a = lg["artifact"]
        named_runs += named
        assert "paracetamol" not in " ".join(m["name"] for m in a["gp_extraction"].get("medicines") or []).lower(), seed
        if lg["written"]:
            written += 1
            visible += bool(_VISIBLE.search(a["note_text"]))
            assert (f"Medication: {MEDICATION_LABEL}" in a["note_text"].split("\n")) is bool(a["gp_extraction"].get("medicines")), seed
            assert not _VISIBLE.search(json.dumps(a["gp_extraction"])), seed  # nor in a posted field
        else:
            rejected += 1
    print(f"\nD3 600 runs: written {written}, rejected {rejected}, visible {visible}; runs with named posted advice {named_runs}")
    assert visible == 0 and written >= 500


@pytest.mark.parametrize("said,word", [("paracetamol", "paracetamol"), ("Calpol", "calpol"), ("PCM", "pcm"), ("crocin", "crocin"),
                                       ("Dolo-650", "dolo"), ("paracetemol", "paracetamol"), ("para-cetamol", "paracetamol"),
                                       ("P-650", "p650")])
def test_d3_scan_finds_generic_brand_abbreviation_misspelling_and_split(said, word):
    """R3 allowlist: the scan needs no list of the moved drug's names; the lexicon, a fuzzy edit and a split join find it."""
    assert (word,) in drug_mentions(f"continue {said} as advised")
    assert drug_mentions("drink warm water and rest; reduce salt to 5 g a day; review if fever persists") == []


def test_d3_a_mention_of_a_posted_drug_resolves():
    art = hand_art()  # paracetamol (alias Calpol), amoxicillin, pantoprazole posted
    assert unposted(art, "continue Calpol and paracetemol as advised") == []
    assert unposted(art, "continue Azee as advised") == [("azee",)]


def test_d3_posted_field_naming_a_moved_drug_is_withheld_whole():
    art = hand_art(para=("patient", "Take paracetamol 500 mg twice a day."))
    art["gp_extraction"]["general_advice"] = "Drink warm water; continue Calpol as advised"
    art["gp_extraction"]["follow_up"]["follow_up_instructions"] = "review if fever persists on PCM"
    out, c = apply_r1(art)
    gx = out["gp_extraction"]
    assert "general_advice" not in gx and "follow_up_instructions" not in gx.get("follow_up", {})
    assert c["r1_2_moved"] == 1 and c["r1_2b_withheld"] == 2
    w = [p for p in out["provenance"] if "field_withheld" in p["flags"]]
    assert sorted(p["text"] for p in w) == ["follow_up withheld (unconfirmed drug)", "general_advice withheld (unconfirmed drug)"]


def test_d3_a_posted_drug_of_the_same_molecule_as_a_moved_one_stays():
    """R3 allowlist: a doctor-confirmed Dolo 650 stays posted when a patient's paracetamol moves; a mention of either name is
    then a mention of the posted drug (R2 moved both)."""
    art = hand_art(para=("patient", "Take paracetamol 500 mg twice a day."))
    art["gp_extraction"]["medicines"][2].update({"name": "Dolo 650", "raw_name": "Dolo 650"})  # panto slot, doctor quote lacks Dolo
    art["provenance"][9]["evidence"][0]["quote_en"] = art["provenance"][9]["evidence"][0]["quote"] = "Dolo 650 once a day for 5 days."
    out, _ = apply_r1(art)
    assert meds(out) == ["amoxicillin 500 mg", "Dolo 650"] and [p["detail"] for p in picks(out)] == ["paracetamol 500 mg"]


def test_d3_stored_note_that_names_a_moved_drug_is_replaced():
    art = hand_art(para=("patient", "Take paracetamol 500 mg twice a day."))
    art["note_text"] = "\n".join(f"{h}: {'continue PCM as advised' if h == 'General Advice' else ''}".rstrip() for h in HEADINGS)
    out, c, known = apply_r1_ex(art)
    assert c["r1_4_note_rewritten"] == 1 and c["r1_4_pick_drug_in_note"] == 0 and not unposted_in_note(out, out["note_text"], known)


# --- D5: a name on tape needs the base molecule word ---------------------------------------------------------
D5_CASES = [  # the verdict's cases, plus a lone qualifier name (the 7th, rebuilt)
    ("folic acid", "You have some acid reflux, take this daily."),
    ("pantoprazole sodium", "Keep a low sodium diet, take this daily."),
    ("vitamin D3", "Your vitamin levels are fine, take this weekly."),
    ("potassium chloride", "Your potassium is low, take this daily."),
    ("calcium carbonate", "There is calcium in milk, take this daily."),
    ("Augmentin 625 Duo", "Take the Duo pack twice a day."),
    ("Calcium", "There is calcium in milk, take this daily."),
]


@pytest.mark.parametrize("name,quote", D5_CASES)
def test_d5_qualifier_word_alone_goes_to_pick_drug(name, quote):
    art = hand_art(amox=("doctor", quote))
    art["gp_extraction"]["medicines"][1] = {"name": name, "raw_name": name}
    out, c = apply_r1(art)
    assert name not in meds(out) and c["r1_2_moved"] == 1 and [p["detail"] for p in picks(out)][0] == name
    # pantoprazole sodium moved: the posted "pantoprazole 40 mg" is the same drug and follows it (R1-2b, D3)


@pytest.mark.parametrize("name,quote", [("folic acid", "Take folic acid daily."), ("pantoprazole sodium", "Start pantoprazole daily."),
                                        ("vitamin D3", "Take vitamin D3 weekly."), ("Augmentin 625 Duo", "Augmentin twice a day.")])
def test_d5_base_word_on_tape_posts(name, quote):
    art = hand_art(amox=("doctor", quote))
    art["gp_extraction"]["medicines"][1] = {"name": name, "raw_name": name}
    assert name in meds(apply_r1(art)[0])


def test_d5_qualifier_set_covers_the_ruling_words():
    assert {"acid", "sodium", "potassium", "calcium", "chloride", "carbonate", "vitamin", "d3", "duo", "pack", "forte", "sr", "xr",
            "er"} <= QUALIFIERS


# --- L2: exact match; the dangerous look-alike pairs never match each other -----------------------------------
L2_GROUPS = [("prednisolone", "prednisone"), ("hydroxychloroquine", "hydroxyzine", "hydrochlorothiazide"),
             ("chloroquine", "chlorpheniramine", "chlorthalidone"), ("amoxicillin", "amoxiclav")]
L2_PAIRS = [(a, b) for g in L2_GROUPS for a in g for b in g if a != b]


def test_l2_sixteen_pairs():
    assert len(L2_PAIRS) == 16


@pytest.mark.parametrize("name,said", L2_PAIRS)
def test_l2_look_alike_never_matches(name, said):
    """Kills the refuter's M2 (a 4-letter prefix) and any prefix rule: every pair shares a 4- and 5-letter prefix or more."""
    assert not name_in_text(name, f"Start {said} 200 mg twice a day.")
    owner = {"evidence_state": "heard_in_room", "evidence": [{"speaker": "doctor", "quote_en": f"Start {said} 200 mg.", "quote": ""}]}
    assert not name_on_tape({"name": f"{name} 200 mg", "raw_name": name}, owner)
    assert name_on_tape({"name": f"{name} 200 mg", "raw_name": name, "aliases": [said]}, owner)  # a listed alias does match
    art = hand_art(amox=("doctor", f"Start {said} 200 mg three times a day for 5 days."))
    art["gp_extraction"]["medicines"][1].update({"name": f"{name} 200 mg", "raw_name": name})
    assert f"{name} 200 mg" not in meds(apply_r1(art)[0])


# --- L1: the red-flag detector ---------------------------------------------------------------------------------
L1_NEGATED = [  # the verdict's negated / non-clinical class (its quoted examples, the rest rebuilt in kind)
    "No need to go to the emergency.", "You don't need to come back immediately.", "Go to ER? No, not needed.",
    "If you start feeling better, return to work.", "If you start feeling better, return to school.",
    "If you start feeling better, return to the gym.", "If the cough continues to get better, return to your normal diet.",
    "There is no need to rush to hospital.", "You do not need to go to casualty for this.",
    "If you start walking daily, return for a review in a month.",
]
L1_ROUTINE = [  # 16 routine sentences (rebuilt; the verdict does not list its hand set)
    "Come back after one week for review.", "If the reports are normal, come back after three days.", "Come back with the reports.",
    "If you start feeling better, stop the syrup.", "Return for follow-up in two weeks.", "If the cough continues, come back next week.",
    "Come back if needed.", "If you start the tablets today, come back on Monday.", "Drink warm water and rest.",
    "If it is convenient, return to the clinic next month.", "Return the form at the desk.", "If you start exercising, return slowly to running.",
    "Continue the same diet.", "If the rash continues, come back for a review.", "Come back after the blood test.",
    "If you start the new job, return for a fitness certificate.",
]


def test_l1_negated_and_non_clinical_never_fire():
    fired = [s for s in L1_NEGATED if red_flag_clauses(s)]
    print(f"\nL1 negated / non-clinical: {len(fired)}/{len(L1_NEGATED)} fire")
    assert fired == []


def test_l1_routine_hand_set():
    fired = [s for s in L1_ROUTINE if red_flag_clauses(s)]
    print(f"\nL1 routine hand set: {len(fired)}/{len(L1_ROUTINE)} fire")
    assert fired == []


@pytest.mark.parametrize("text", [
    "If the pain becomes severe or you start vomiting, come to emergency immediately.", "Come back immediately if you feel faint.",
    "Go straight to casualty.", "If it gets worse, come back.", "If the fever does not settle, come back immediately.",
    "If there is any bleeding, go to the emergency.", "Rush him to hospital.", "If the breathlessness increases, return to the hospital.",
    "If you see blood in the stool, come back immediately.", "Never ignore chest pain, come to emergency immediately.",
    "Don't worry, but if the pain gets worse come back immediately.",
])
def test_l1_red_flags_still_fire(text):
    assert red_flag_clauses(text) == [text]


def test_l1_blood_test_is_not_a_cue():
    assert red_flag_clauses("If the blood test is normal, come back next week.") == []


# --- L6: the refuter's mutant M5 (coverage threshold 0.5) -----------------------------------------------------
def _rf_with_advice(advice_text):
    from conftest import build_artifact, empty_encounter
    rf = "If the pain becomes severe, come back immediately."
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Pain in the stomach."), (11, 15, "0", "Tummy is soft."), (16, 22, "0", rf)]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient"})
    enc = empty_encounter(examination=[{"performed": "Abdomen", "finding": "soft", "basis": "said", "source_turns": [2]}],
                          advice=[{"text": advice_text, "basis": "said", "source_turns": [2]}])
    return rf, c, build_artifact(c, enc)


def test_l6_m5_overlap_half_is_not_covered():
    rf, c, art = _rf_with_advice("Pain becomes less with rest.")
    assert overlap(rf, art["gp_extraction"]["general_advice"]) == 0.5
    out, cnt = apply_r1(art, c.turns)
    assert cnt["r1_5_added"] == 1 and cnt["r1_5_covered"] == 0  # a 0.5 threshold (M5) calls this covered and adds nothing


def test_l6_overlap_three_quarters_is_covered():
    rf, c, art = _rf_with_advice("Severe pain becomes a reason to see us.")
    assert overlap(rf, art["gp_extraction"]["general_advice"]) == 0.75
    assert apply_r1(art, c.turns)[1]["r1_5_covered"] == 1


# --- the floor still holds over generated artifacts --------------------------------------------------------------
def test_r2_no_posted_string_names_a_moved_drug_over_2000_artifacts():
    names = ["paracetamol", "Calpol", "PCM", "Dolo 650", "crocin", "amoxicillin", "pantoprazole"]
    for seed in range(2000):
        rng = random.Random(seed)
        art = hand_art(para=(rng.choice(["patient", "unknown", "doctor"]), "Take paracetamol 500 mg twice a day for 3 days."),
                       amox=(rng.choice(["patient", "doctor"]), "Start amoxicillin 500 mg three times a day for 5 days."))
        gx = art["gp_extraction"]
        for k in rng.sample(["general_advice", "examination"], rng.randint(0, 2)):
            gx[k] = f"{gx[k]}; {rng.choice(names)} noted"
        out, c, moved = apply_r1_ex(copy.deepcopy(art))
        for i, m in enumerate(out["gp_extraction"].get("medicines") or []):
            assert name_on_tape(m, next(p for p in out["provenance"] if p.get("json_pointer") == f"/medicines/{i}")), seed
        assert not unposted(out, json.dumps(out["gp_extraction"]), moved), seed
