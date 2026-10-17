"""FreeScript R1 (notes-only restart floors): r1_floors.apply_r1, FRX-G1, and pipeline notes_only. Synthetic fixtures only;
no model calls (FakeClient)."""
from __future__ import annotations

import copy
import importlib
import io
import json
import random
import re
import subprocess
import sys
import tarfile

import pytest
from conftest import ROOT, T0, build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.mapper import iso
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import HEADINGS, MEDICATION_LABEL, _split_sections, flags_by_pointer, medication_floor, render_note
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.r1_floors import (
    COUNTERS, FLAG, PICK_PROMPT, RED_FLAG_PATTERNS, apply_r1, name_on_tape, notes_only_note, posted_hits, red_flag_clauses,
)
from tools.eta2freescript.validate import check, frx, printable_errors

UID = "synth-r1"
BASE_SHA = "3cdb7c0b"


# --- a hand-built artifact: every gp_extraction section, one owner per posted pointer -------------------------
def ev(turn, speaker, text, lang="en"):
    return {"segment_ref": f"{UID}:{turn}", "t0": iso(T0 + turn * 10_000), "t1": iso(T0 + turn * 10_000 + 5_000), "quote_en": text,
            "quote": text, "lang": lang, "speaker": speaker, "speaker_source": "role_track"}


def item(iid, kind, ptr, evs, names=None):
    t = int(evs[0]["segment_ref"].rsplit(":", 1)[1])
    it = {"item_id": iid, "kind": kind, "text": f"{kind} {iid}", "evidence_state": "heard_in_room", "status": "prescribed", "negated": False,
          "speaker": evs[0]["speaker"], "speaker_source": "role_track", "evidence": evs, "confidence": 0.9, "json_pointer": ptr,
          "flags": [], "decision": {"turn": t, "speaker": evs[0]["speaker"], "quote": evs[0]["quote"]}}
    if names:
        it["names"] = names
    return it


Q_PARA = "Take paracetamol 500 mg twice a day for 3 days after food, Calpol is fine."
Q_AMOX = "Start amoxicillin 500 mg three times a day for 5 days."
Q_PANTO = "Pantoprazole 40 mg once a day before breakfast for 5 days."


def hand_art(para=None, amox=None, panto=None) -> dict:
    """para / amox / panto: (speaker, quote) overrides for each medicine's one evidence entry."""
    gx = {
        "examination": "Throat red, chest clear",
        "general_advice": "Drink warm water; rest at home",
        "presenting_complaints": {"symptoms": "Fever for two days with sore throat",
                                  "diagnoses": [{"diagnosis_or_impression": "Acute pharyngitis", "raw_name": "pharyngitis"},
                                                {"diagnosis_or_impression": "Seasonal rhinitis", "raw_name": "rhinitis"}]},
        "plan_of_management": {"management_plan": "Symptomatic care.", "requires_surgery_or_procedure": True,
                               "surgery_or_procedure_recommendations": [{"name": "Tonsillectomy", "raw_name": "tonsillectomy", "notes": "elective"}]},
        "medicines": [
            {"name": "paracetamol 500 mg", "raw_name": "paracetamol", "frequency": "twice a day", "duration": "3 days",
             "instructions": "after food", "aliases": ["Calpol"]},
            {"name": "amoxicillin 500 mg", "raw_name": "amoxicillin", "frequency": "three times a day", "duration": "5 days"},
            {"name": "pantoprazole 40 mg", "raw_name": "pantoprazole", "frequency": "once a day", "duration": "5 days",
             "instructions": "before breakfast"},
        ],
        "further_investigations": [{"name": "CBC", "raw_name": "CBC", "instruction": "fasting"}],
        "comorbidities": [{"name": "Hypertension", "raw_name": "hypertension", "notes": "on treatment"}],
        "follow_up": {"followup_type": "IF_REQUIRED", "follow_up_instructions": "review if fever persists"},
        "referrals": [{"speciality": "ENT", "notes": "for throat review"}],
    }
    d = lambda t, q: [ev(t, "doctor", q)]
    prov = [
        item("exa1", "examination", "/examination", d(2, "Throat is red, chest is clear.")),
        item("adv1", "advice", "/general_advice", d(6, "Drink warm water and rest at home.")),
        item("sym1", "symptoms", "/presenting_complaints/symptoms", [ev(1, "patient", "Fever for two days, sore throat.")]),
        item("dia1", "diagnosis", "/presenting_complaints/diagnoses/0", d(2, "This is acute pharyngitis.")),
        item("dia2", "diagnosis", "/presenting_complaints/diagnoses/1", d(2, "Also seasonal rhinitis.")),
        item("man1", "management_plan", "/plan_of_management/management_plan", d(5, "Symptomatic care for now.")),
        item("pro1", "procedure", "/plan_of_management/surgery_or_procedure_recommendations/0", d(7, "Tonsillectomy later, elective."), ["Tonsillectomy"]),
        item("med1", "medicine", "/medicines/0", [ev(3, *(para or ("doctor", Q_PARA)))], ["paracetamol"]),
        item("med2", "medicine", "/medicines/1", [ev(4, *(amox or ("doctor", Q_AMOX)))], ["amoxicillin"]),
        item("med3", "medicine", "/medicines/2", [ev(5, *(panto or ("doctor", Q_PANTO)))], ["pantoprazole"]),
        item("inv1", "investigation", "/further_investigations/0", d(5, "Do a CBC, fasting."), ["CBC"]),
        item("com1", "comorbidity", "/comorbidities/0", d(1, "You have hypertension, on treatment.")),
        item("fol1", "follow_up", "/follow_up", d(8, "Review if the fever persists.")),
        item("ref1", "referral", "/referrals/0", d(7, "See ENT for a throat review."), ["ENT"]),
    ]
    return {"schema_version": "eta.freescript.v0.3", "artifact_id": "r1-test",
            "encounter": {"eta_encounter_id": UID, "transcript": {"segment_count": 10, "speaker_source": "role_track"}},
            "note_text": "", "gp_extraction": gx, "provenance": prov, "completion_required": [],
            "clip_boundary": {"quarantined_turns": []}, "slots": [], "room_facts": {"allergies": [], "vitals": []}}


def _at(gx, path):
    for p in path:
        gx = gx[p]
    return gx


def _put(gx, path, value):
    _at(gx, path[:-1])[path[-1]] = value


def withheld_items(art):
    return [p for p in art["provenance"] if FLAG in (p.get("flags") or [])]


def meds(art):
    return [m["name"] for m in art["gp_extraction"].get("medicines") or []]


def ptrs(art):
    return {p["item_id"]: p["json_pointer"] for p in art["provenance"]}


def picks(art):
    return [c for c in art["completion_required"] if c["kind"] == "pick_drug"]


# --- R1-1 -----------------------------------------------------------------------------------------------------
PATTERNS = {
    "brace": "take {dose}", "bracket": "x [dose] daily", "fullwidth_bracket": "dose 【dose】", "dict_repr": "{'name': 'x'}",
    "key_repr": "'route': 'oral'", "angle": "apply <site> twice", "underscore": "for __ days", "tbd": "TBD", "xx": "XX mg",
    "not_specified": "dose not specified", "unspecified": "unspecified", "to_be_decided": "to be decided",
    "to_be_confirmed": "to be confirmed", "to_be_determined": "to be determined", "d1": "frequency not stated",
    "d4": "no dose given", "d5": "unnamed drug",
}
# path -> (provenance kind, section text, mode): field = the field goes; row = the whole list row goes; scalar = the section goes
FIELDS = {
    ("examination",): ("examination", "examination", "scalar"),
    ("general_advice",): ("advice", "general_advice", "scalar"),
    ("presenting_complaints", "symptoms"): ("symptoms", "symptoms", "scalar"),
    ("plan_of_management", "management_plan"): ("management_plan", "management_plan", "scalar"),
    ("follow_up", "follow_up_instructions"): ("follow_up", "follow_up", "field"),
    ("medicines", 0, "instructions"): ("medicine", "medicines", "field"),
    ("medicines", 0, "aliases", 0): ("medicine", "medicines", "field"),
    ("medicines", 1, "name"): ("medicine", "medicines", "row"),
    ("further_investigations", 0, "instruction"): ("investigation", "further_investigations", "field"),
    ("further_investigations", 0, "name"): ("investigation", "further_investigations", "row"),
    ("comorbidities", 0, "notes"): ("comorbidity", "comorbidities", "field"),
    ("referrals", 0, "notes"): ("referral", "referrals", "field"),
    ("referrals", 0, "speciality"): ("referral", "referrals", "row"),
    ("presenting_complaints", "diagnoses", 1, "diagnosis_or_impression"): ("diagnosis", "diagnoses", "row"),
    ("plan_of_management", "surgery_or_procedure_recommendations", 0, "notes"): ("procedure", "surgery_or_procedure_recommendations", "field"),
}
# Missing-value words withhold only a missing-value statement (F2), so these go in as their own clause; placeholders go anywhere.
MISSING_PATS = {"not_specified", "unspecified", "to_be_decided", "to_be_confirmed", "to_be_determined", "d1", "d4"}
ROW_LEN = {"medicines": 1, "further_investigations": 1, "referrals": 1, "diagnoses": 2, "surgery_or_procedure_recommendations": 1}


def _expected(path, mode) -> dict:
    gx = hand_art()["gp_extraction"]
    if mode == "row":
        n = next(i for i, p in enumerate(path) if isinstance(p, int))
        rows = _at(gx, path[:n])
        rows.pop(path[n])
        if not rows:
            _at(gx, path[:n - 1]).pop(path[n - 1])
    else:
        parent = _at(gx, path[:-1])
        parent.pop(path[-1])
        if isinstance(parent, list) and not parent:
            _at(gx, path[:-2]).pop(path[-2])
    return gx


@pytest.mark.parametrize("pat", sorted(PATTERNS))
@pytest.mark.parametrize("path", list(FIELDS), ids=lambda p: "/".join(map(str, p)))
def test_r1_1_every_pattern_in_every_section_is_withheld(path, pat):
    art = hand_art()
    _put(art["gp_extraction"], path, f"{_at(art['gp_extraction'], path)}{'; ' if pat in MISSING_PATS else ' '}{PATTERNS[pat]}")
    before = copy.deepcopy(art)
    out, c = apply_r1(art)
    assert art == before  # never mutates its input
    kind, section, mode = FIELDS[path]
    assert out["gp_extraction"] == _expected(path, mode)  # withheld whole: no character deleted, nothing else touched
    w = withheld_items(out)
    assert len(w) == 1 and w[0]["flags"] == [FLAG] and w[0]["kind"] == kind
    assert w[0]["text"] == f"{section} withheld (placeholder)" and w[0]["status"] == "discussed_only" and w[0]["json_pointer"] is None
    assert c["r1_1_withheld"] == 1 and posted_hits(out["gp_extraction"]) == []
    assert not [e for e in frx(out) if e.startswith("FRX-G1")]
    if path[0] == "medicines" and mode == "row":
        assert [p["detail"] for p in picks(out)] == ["amoxicillin"] and meds(out) == ["paracetamol 500 mg", "pantoprazole 40 mg"]


def test_r1_1_withheld_row_renumbers_later_rows():
    art = hand_art()
    art["gp_extraction"]["presenting_complaints"]["diagnoses"].append({"diagnosis_or_impression": "Mild dehydration", "raw_name": "dehydration"})
    art["provenance"].append(item("dia3", "diagnosis", "/presenting_complaints/diagnoses/2", [ev(2, "doctor", "Mild dehydration.")]))
    art["gp_extraction"]["presenting_complaints"]["diagnoses"][1]["diagnosis_or_impression"] = "unspecified"
    out, _ = apply_r1(art)
    p = ptrs(out)
    assert p["dia1"] == "/presenting_complaints/diagnoses/0" and p["dia2"] is None and p["dia3"] == "/presenting_complaints/diagnoses/1"


def test_r1_1_clean_artifact_is_byte_identical():
    art = hand_art()
    out, c = apply_r1(art)
    assert json.dumps(out, sort_keys=True) == json.dumps(art, sort_keys=True)
    assert all(v == 0 for k, v in c.items() if k not in ("notes_only", "r1_5_no_turns")) and c["r1_5_no_turns"] == 1 and set(COUNTERS) <= set(c)


def test_frx_g1_fires_when_r1_is_skipped():
    art = hand_art()
    art["gp_extraction"]["examination"] = "Throat red, BP not specified"
    art["gp_extraction"]["medicines"][0]["aliases"] = ["Calpol", "{'brand': 'x'}"]
    g1 = [e for e in frx(art) if e.startswith("FRX-G1")]
    assert g1 == ["FRX-G1 /examination posted string matches the withhold set (missing)",
                  "FRX-G1 /medicines/0/aliases/1 posted string matches the withhold set (bracket)"]
    assert not [e for e in frx(apply_r1(art)[0]) if e.startswith("FRX-G1")]


_INDEPENDENT = re.compile(r"[{}\[\]【】]|__|<site>|\bTBD\b|\bXX\b|unnamed drug|'route'", re.I)


def _missing_clause_posted(s: str) -> bool:
    """Independent of r1_floors: a sentence of `s` (split on ; or .) that is exactly one of the missing-value patterns."""
    want = {PATTERNS[k].lower() for k in MISSING_PATS}
    return any(x.strip().lower() in want for x in re.split(r"[;.]", s))


def _string_paths(node, path=()):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _string_paths(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _string_paths(v, path + (i,))
    elif isinstance(node, str):
        yield path


def test_r1_1_property_no_posted_match_after_apply_r1():
    """2,000 seeded artifacts, 1-4 placeholders each in random strings (nested lists included): none posts after apply_r1."""
    pats = list(PATTERNS.values())
    missing_values = {PATTERNS[k] for k in MISSING_PATS}
    hit = 0
    for seed in range(2000):
        rng = random.Random(seed)
        art = hand_art()
        gx = art["gp_extraction"]
        for path in rng.sample(list(_string_paths(gx)), rng.randint(1, 4)):
            cur, p = _at(gx, path), rng.choice(pats)
            forms = ([f"{cur}; {p}", f"{p}. {cur}", p, f"{cur}; {p}; ok"] if p in missing_values
                     else [f"{cur} {p}", f"{p} {cur}", p, f"{cur}, {p}; ok"])
            _put(gx, path, rng.choice(forms))
        out, c = apply_r1(art)
        hit += c["r1_1_withheld"]
        assert posted_hits(out["gp_extraction"]) == [], seed
        posted = [_at(out["gp_extraction"], q) for q in _string_paths(out["gp_extraction"])]
        assert not [s for s in posted if _INDEPENDENT.search(s) or _missing_clause_posted(s)], seed
        if seed % 50 == 0:
            assert not [e for e in frx(out) if e.startswith("FRX-G1")], seed
    assert hit >= 2000


# --- R1-2 -----------------------------------------------------------------------------------------------------
def test_r1_2_patient_only_evidence_goes_to_pick_drug():
    out, c = apply_r1(hand_art(para=("patient", Q_PARA)))
    assert meds(out) == ["amoxicillin 500 mg", "pantoprazole 40 mg"] and c["r1_2_moved"] == 1
    assert picks(out) == [{"kind": "pick_drug", "item_id": "med1", "prompt": PICK_PROMPT, "detail": "paracetamol 500 mg"}]
    owner = next(p for p in out["provenance"] if p["item_id"] == "med1")
    assert owner["json_pointer"] is None and owner["status"] == "discussed_only"
    assert check_c1(out)


def check_c1(out) -> bool:
    ids = {p["item_id"]: p for p in out["provenance"]}
    return all(ids[c["item_id"]]["json_pointer"] is None for c in picks(out))


def test_r1_2_name_absent_from_quotes_goes_to_pick_drug():
    out, _ = apply_r1(hand_art(para=("doctor", "Take this tablet twice a day for 3 days after food.")))
    assert "paracetamol 500 mg" not in meds(out) and [x["detail"] for x in picks(out)] == ["paracetamol 500 mg"]


def test_r1_2_name_in_doctor_quote_stays():
    out, c = apply_r1(hand_art())
    assert meds(out) == ["paracetamol 500 mg", "amoxicillin 500 mg", "pantoprazole 40 mg"] and c["r1_2_moved"] == 0


@pytest.mark.parametrize("name,quote,stays", [
    # R2 (fable ruling L2): the prefix fallback is gone; exact match on the normalised name or a listed alias only
    ("amoxicillin", "Start amoxil 500 mg three times a day for 5 days.", False),  # was True under the R1 prefix rule
    ("amoxil", "Start amoxicillin 500 mg three times a day for 5 days.", False),  # was True under the R1 prefix rule
    ("cetirizine", "Give CETIRIZINE, 500 mg, for 5 days three times a day.", True),
    ("metformin", "Start metronidazole 500 mg three times a day for 5 days.", False),  # metfo / metro
    ("amoxi", "Start amoxicillin 500 mg three times a day for 5 days.", False),   # 5 letters: no prefix fallback
])
def test_r1_2_prefix_fallback_both_ways(name, quote, stays):
    art = hand_art(amox=("doctor", quote))
    art["gp_extraction"]["medicines"][1].update({"name": f"{name} 500 mg", "raw_name": name})
    out, _ = apply_r1(art)
    assert (f"{name} 500 mg" in meds(out)) is stays


def test_r1_2_three_medicines_middle_removed_renumbers():
    art = hand_art(amox=("patient", Q_AMOX))
    art["provenance"].append({**item("dos1", "medicine", None, [ev(5, "doctor", Q_PANTO)]), "status": "discussed_only"})
    out, _ = apply_r1(art)
    assert meds(out) == ["paracetamol 500 mg", "pantoprazole 40 mg"]
    p = ptrs(out)
    assert p["med1"] == "/medicines/0" and p["med2"] is None and p["med3"] == "/medicines/1" and p["dos1"] is None
    assert [x["item_id"] for x in picks(out)] == ["med2"]


def test_r1_2_not_heard_in_room_does_not_post():
    art = hand_art()
    art["provenance"][7]["evidence_state"] = "inferred"
    assert "paracetamol 500 mg" not in meds(apply_r1(art)[0])


# --- R1-3 -----------------------------------------------------------------------------------------------------
def test_r1_3_digit_not_on_tape_removes_field_and_moves_drug():
    art = hand_art()
    art["gp_extraction"]["medicines"][0]["duration"] = "5 days"  # the paracetamol quote holds 500, 3 and no 5
    out, c = apply_r1(art)
    assert meds(out) == ["amoxicillin 500 mg", "pantoprazole 40 mg"] and c["r1_3_moved"] == 1 and c["r1_3_fields_removed"] == 1
    owner = next(p for p in out["provenance"] if p["item_id"] == "med1")
    assert owner["text"] == "paracetamol 500 mg (dose not on tape)" and owner["json_pointer"] is None
    assert [x["detail"] for x in picks(out)] == ["paracetamol 500 mg"]
    assert not any("5 days" == m.get("duration") and m["raw_name"] == "paracetamol" for m in out["gp_extraction"]["medicines"])


def test_r1_3_digit_on_tape_stays():
    out, c = apply_r1(hand_art())
    assert out["gp_extraction"]["medicines"][0]["duration"] == "3 days" and c["r1_3_moved"] == 0


@pytest.mark.parametrize("field,value,quote,stays", [
    ("duration", "5 days", "Take paracetamol 500 mg twice a day for five days.", True),  # digit in the field, word on tape
    ("frequency", "two times a day", "Take paracetamol 500 mg 2 times a day for 3 days.", True),  # word in the field, digit on tape
    ("frequency", "three times a day", "Take paracetamol 500 mg twice a day for 3 days.", True),  # 3 is on tape
    ("frequency", "four times a day", "Take paracetamol 500 mg twice a day for 3 days.", False),
])
def test_r1_3_number_words(field, value, quote, stays):
    art = hand_art(para=("doctor", quote))
    art["gp_extraction"]["medicines"][0][field] = value
    assert ("paracetamol 500 mg" in meds(apply_r1(art)[0])) is stays


# --- R1-4 -----------------------------------------------------------------------------------------------------
def test_r1_4_medication_floor_replaces_model_lines():
    gx = hand_art()["gp_extraction"]
    llm = "\n".join(f"{h}:" for h in HEADINGS).replace("Medication:", "Medication: cetirizine 10 mg at night\nparacetamol 650 mg")
    got = _split_sections(medication_floor(llm, gx, label=True))["Medication"]
    det = _split_sections(render_note(gx))["Medication"]
    assert got == [MEDICATION_LABEL] + det and not any("cetirizine" in x for x in got)
    assert _split_sections(medication_floor(llm, {}, label=True))["Medication"] == []  # no medicine posted: no section body


def test_r1_4_label_wording_is_the_ruling_and_prints():
    """FRX-R1b B2: the exact wording, and printable_errors returns []."""
    assert MEDICATION_LABEL == "Draft list, not a prescription; the treating doctor checks each drug."
    assert printable_errors(f"Medication: {MEDICATION_LABEL}\nparacetamol 500 mg", []) == []
    assert printable_errors(f"Medication: {MEDICATION_LABEL}", []) == []


def _labelled_art():
    art = hand_art()
    art["note_text"] = render_note(art["gp_extraction"], flags_by_pointer(art))
    return art, notes_only_note(art, art["note_text"])


def test_r1_4_label_is_the_first_medication_line_when_a_drug_posts():
    art, (note, kept) = _labelled_art()
    assert kept is True
    med = _split_sections(note)["Medication"]
    assert med[0] == MEDICATION_LABEL and med[1:] == _split_sections(render_note(art["gp_extraction"], flags_by_pointer(art)))["Medication"]
    assert len(art["gp_extraction"]["medicines"]) == 3  # the label is never a gp_extraction medicine
    assert not any(MEDICATION_LABEL in json.dumps(m) for m in art["gp_extraction"]["medicines"])


def test_r1_4_no_drug_no_label():
    art = hand_art()
    art["gp_extraction"].pop("medicines")
    note, kept = notes_only_note(art, render_note(art["gp_extraction"]))
    assert kept is False and MEDICATION_LABEL not in note


def _llm_note(drugs: list[str], advice: str = "") -> str:
    body = {"Examination": "Throat red", "Medication": "\n".join(drugs), "General Advice": advice}
    return "\n".join(f"{h}: {body.get(h, '')}".rstrip() for h in HEADINGS)


R4_LINES = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and sore throat for two days."), (11, 15, "0", "Throat is red."),
            (16, 22, "2", "Take paracetamol 500 mg twice a day for three days."),
            (23, 30, "0", "Start amoxicillin 500 mg three times a day for five days."), (31, 35, "0", "Drink warm water and rest.")]


def _rx(g, t, freq, dur, strength="500 mg"):
    return {"action": "start", "decision_turn": t, "generic": g, "brand_as_said": None, "strength": strength, "frequency": freq,
            "duration": dur, "route": "oral", "basis": "said", "confidence": 0.85, "source_quote_turn": t, "source_turns": [t]}


def test_b3_label_line_is_skipped_by_g6_c4_frx_c2_and_v01(tmp_path, monkeypatch):
    """FRX-R1b B3: G6 / C4 / FRX-C2 count the Medication lines without the exact label line; the v0.1 note carries none."""
    from tools.eta2freescript import validate
    from tools.eta2freescript.validate import V, _unlabelled, to_v01
    c = mk_consult(R4_LINES, roles={"0": "doctor", "1": "patient", "2": "doctor"})
    enc = empty_encounter(examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
                          prescription=[_rx("paracetamol", 3, "twice a day", "3 days"), _rx("amoxicillin", 4, "three times a day", "5 days")],
                          advice=[{"text": "Drink warm water and rest.", "basis": "said", "source_turns": [5]}])
    lg = run_consult(c, FakeClient({"stageA": json.dumps(enc), "stageB": _llm_note([], "Drink warm water and rest")}), tmp_path)
    art = lg["artifact"]
    assert lg["written"] and lg["final_errors"] == [] and lg["r1"]["r1_4_label_kept"] == 1
    assert _split_sections(art["note_text"])["Medication"][0] == MEDICATION_LABEL and len(art["gp_extraction"]["medicines"]) == 2
    bare = medication_floor(art["note_text"], art["gp_extraction"], flags_by_pointer(art), label=False)
    assert _unlabelled(art["note_text"]) == bare and _unlabelled(bare) == bare
    assert check(dict(art, note_text=bare)) == []
    v01 = to_v01(art)
    assert V.check(v01) == [] and MEDICATION_LABEL not in v01["note_text"] and len(v01["gp_extraction"]["medicines"]) == 2
    assert len(V.note_sections(v01["note_text"])["Medication"]) == 2
    # without the skip the label is one Medication line too many
    monkeypatch.setattr(validate, "_unlabelled", lambda note: note)
    errs = check(art)
    assert any(e.startswith("G6") and "Medication" in e for e in errs)
    monkeypatch.undo()
    # only that exact line: other wording on the heading still counts as a Medication line
    other = art["note_text"].replace(MEDICATION_LABEL, MEDICATION_LABEL.rstrip("."))
    assert _unlabelled(other) == other
    assert any(e.startswith("G6") and "Medication" in e for e in check(dict(art, note_text=other)))
    # the label alone under Medication (no drug line after it) leaves an empty heading
    assert _unlabelled(f"Medication: {MEDICATION_LABEL}\nFurther Investigation: CBC") == "Medication:\nFurther Investigation: CBC"


def test_r1_4_pipeline_drops_model_line_for_a_pick_drug_drug(tmp_path):
    c = mk_consult(R4_LINES, roles={"0": "doctor", "1": "patient", "2": "unknown"})
    enc = empty_encounter(examination=[{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [2]}],
                          prescription=[_rx("paracetamol", 3, "twice a day", "3 days"), _rx("amoxicillin", 4, "three times a day", "5 days")],
                          advice=[{"text": "Drink warm water and rest.", "basis": "said", "source_turns": [5]}])
    llm = _llm_note(["paracetamol 500 mg twice a day x 3 days", "amoxicillin 500 mg three times a day x 5 days"], "Drink warm water and rest")
    fake = FakeClient({"stageA": json.dumps(enc), "stageB": llm})
    lg = run_consult(c, fake, tmp_path)
    note = lg["artifact"]["note_text"]
    assert lg["written"] and lg["final_errors"] == []
    assert "paracetamol" not in note.lower()
    assert _split_sections(note)["Medication"] == [MEDICATION_LABEL, "amoxicillin 500 mg three times a day x for five days"]
    assert lg["r1"]["r1_2_moved"] == 1 and lg["r1"]["r1_4_label_kept"] == 1
    v01 = json.loads((tmp_path / c.uid / "artifact.v0.1.json").read_text())
    assert MEDICATION_LABEL not in v01["note_text"] and len(v01["gp_extraction"]["medicines"]) == 1
    stage_b = [x for x in fake.calls if x["tag"].startswith("stageB")][0]["prompt"]
    assert "paracetamol" not in stage_b  # Stage B never sees the drug R1 moved
    # B3: with the label skipped, C4 / FRX-C2 still line the Medication lines up with the entries and catch a kept-out name
    art = copy.deepcopy(lg["artifact"])
    art["provenance"].append(dict(item("ko1", "medicine", None, [ev(3, "doctor", "Not cetirizine.")], ["cetirizine"]), status="discussed_only"))
    art["note_text"] = art["note_text"].replace("amoxicillin 500 mg three times a day x for five days",
                                                "amoxicillin 500 mg three times a day x for five days, cetirizine 10 mg")
    errs = check(art)
    assert any(e.startswith("C4 ko1") for e in errs) and any(e.startswith("FRX-C2 ko1") for e in errs)


# --- generated consults: OFF is the base, byte for byte; ON changes only Stage B's input -------------------------
DRUGS = [("paracetamol", "500 mg"), ("amoxicillin", "500 mg"), ("cetirizine", "10 mg"), ("pantoprazole", "40 mg")]
FREQ = ["twice a day", "three times a day", "once a day"]
DUR = [("3 days", "three days"), ("5 days", "five days"), ("7 days", "seven days")]


def gen_consult(seed: int):
    """(consult, Stage A json, Stage B note): 0-3 drugs, each said by the doctor (most), an unknown speaker or the patient,
    sometimes unnamed or with a duration off tape; advice; sometimes a red flag (doctor or patient) or a placeholder."""
    rng = random.Random(seed)
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and sore throat for two days."), (11, 15, "0", "Throat is red.")]
    rxs, said = [], []
    for g, st in rng.sample(DRUGS, rng.randint(0, 3)):
        spk = rng.choices(["0", "2", "1"], [7, 2, 1])[0]
        freq, (dur, dur_said) = rng.choice(FREQ), rng.choice(DUR)
        named = rng.random() > 0.2
        if rng.random() < 0.15:
            dur = "10 days"
        t = len(lines)
        lines.append((t * 10, t * 10 + 6, spk, f"Take {g if named else 'this tablet'} {st} {freq} for {dur_said}."))
        rxs.append(_rx(g, t, freq, dur, st))
        said.append(f"{g} {st} {freq} x {dur}")
    t = len(lines)
    lines.append((t * 10, t * 10 + 5, "0", "Drink warm water and rest."))
    advice = [{"text": "Drink warm water and rest." + (" Dose not specified." if rng.random() < 0.1 else ""), "basis": "said",
               "source_turns": [t]}]
    if rng.random() < 0.4:
        t = len(lines)
        lines.append((t * 10, t * 10 + 6, rng.choice(["0", "0", "1"]), "If the fever does not settle, come back immediately."))
    finding = "red" + (" [to be confirmed]" if rng.random() < 0.1 else "")
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "unknown"})
    c.uid = f"synth-r1-{seed}"
    enc = empty_encounter(examination=[{"performed": "Throat", "finding": finding, "basis": "said", "source_turns": [2]}],
                          prescription=rxs, advice=advice)
    llm = _llm_note(said, "Drink warm water and rest" + (" [S1]" if rng.random() < 0.1 else ""))
    return c, json.dumps(enc), llm


@pytest.fixture(scope="module")
def base_pipeline(tmp_path_factory):
    """run_consult as it is at 3cdb7c0b, imported from `git archive` under another package name."""
    d = tmp_path_factory.mktemp("r1base")
    try:
        tar = subprocess.run(["git", "-C", str(ROOT), "archive", BASE_SHA, "tools/eta2freescript"], capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip(f"no git history for {BASE_SHA}")
    with tarfile.open(fileobj=io.BytesIO(tar)) as tf:
        tf.extractall(d)
    (d / "tools" / "eta2freescript").rename(d / "eta2fs_r1base")
    sys.path.insert(0, str(d))
    try:
        yield importlib.import_module("eta2fs_r1base.pipeline")
    finally:
        sys.path.remove(str(d))


VOLATILE = ("artifact_id", "created_at")


def _art_key(art):
    a = copy.deepcopy(art)
    for k in VOLATILE:
        a.pop(k, None)
    for k in ("run_id", "code_sha256"):
        a["generator"].pop(k, None)
    return json.dumps(a, sort_keys=True)


def _run(rc, opts_cls, seed, out, **kw):
    c, enc, llm = gen_consult(seed)
    fake = FakeClient({"stageA": enc, "stageB": llm})
    lg = rc(c, fake, out, opts_cls(**kw))
    return lg, fake.calls


N_GEN = 200


LOG_VOLATILE = ("secs_stageA", "secs_stageB", "secs_total", "artifact")


def test_r1_4_off_is_byte_identical_to_base(base_pipeline, tmp_path):
    """FRX-R1b B4: OFF is the base: note, artifact, model calls, validation log and the write / reject decision."""
    flips = written = g1_seen = 0
    for seed in range(N_GEN):
        base, base_calls = _run(base_pipeline.run_consult, base_pipeline.Options, seed, tmp_path / "base")
        off, off_calls = _run(run_consult, Options, seed, tmp_path / "off", notes_only=False)
        assert off["artifact"]["note_text"] == base["artifact"]["note_text"], seed
        assert _art_key(off["artifact"]) == _art_key(base["artifact"]), seed
        assert off_calls == base_calls, seed
        assert "r1" not in off
        assert off["final_errors"] == base["final_errors"] and off["written"] == base["written"], seed
        assert {k: v for k, v in off.items() if k not in LOG_VOLATILE} == {k: v for k, v in base.items() if k not in LOG_VOLATILE}, seed
        for name in ("artifact.json", "artifact.v0.1.json", "artifact.rejected.json"):
            b, o = tmp_path / "base" / f"synth-r1-{seed}" / name, tmp_path / "off" / f"synth-r1-{seed}" / name
            assert b.exists() == o.exists(), (seed, name)
            if b.exists():
                assert _art_key(json.loads(o.read_text())) == _art_key(json.loads(b.read_text())), (seed, name)
        flips += off["written"] != base["written"]
        written += off["written"]
        g1_seen += any(e.startswith("FRX-G1") for e in check(off["artifact"]))
    print(f"\nR1-4 OFF oracle: {N_GEN} consults, note, artifact, log and write decision identical; written {written}; "
          f"flips {flips}; FRX-G1 would fire on {g1_seen} (excluded OFF)")
    assert flips == 0 and g1_seen  # the generated set does exercise FRX-G1


def test_r1_4_on_changes_only_stage_b_input(base_pipeline, tmp_path):
    same = differ = moved = labels = written = 0
    for seed in range(N_GEN):
        _, base_calls = _run(base_pipeline.run_consult, base_pipeline.Options, seed, tmp_path / "base")
        on, on_calls = _run(run_consult, Options, seed, tmp_path / "on")
        assert [x["tag"] for x in on_calls] == [x["tag"] for x in base_calls], seed
        assert on_calls[0] == base_calls[0], seed  # Stage A: identical
        r1 = on.get("r1") or {k: 0 for k in COUNTERS}  # logged only when R1 acted
        changed = any(r1[k] for k in ("r1_1_withheld", "r1_2_moved", "r1_3_moved", "r1_5_added"))
        assert (on_calls[1] == base_calls[1]) is (not changed), seed  # Stage B differs exactly where R1 changed gp_extraction
        same += not changed
        differ += changed
        moved += r1["r1_2_moved"] + r1["r1_3_moved"]
        a = on["artifact"]
        posted = bool(a["gp_extraction"].get("medicines"))
        assert (f"Medication: {MEDICATION_LABEL}" in a["note_text"].split("\n")) is posted, seed  # B3: every posted drug, the label
        assert r1["r1_4_label_kept"] == int(posted), seed
        labels += r1["r1_4_label_kept"]
        if on["written"]:
            v01 = json.loads((tmp_path / "on" / f"synth-r1-{seed}" / "artifact.v0.1.json").read_text())
            assert MEDICATION_LABEL not in v01["note_text"], seed
        written += on["written"]
        for i, m in enumerate(a["gp_extraction"].get("medicines") or []):  # zero posted medicines without a doctor name span
            assert name_on_tape(m, next(p for p in a["provenance"] if p.get("json_pointer") == f"/medicines/{i}")), seed
    print(f"\nR1-4 recorder: {N_GEN} consults; Stage A identical in all; Stage B input identical {same}, changed by R1 {differ}; drugs moved {moved}; "
          f"r1_4_label_kept {labels}; written {written}")
    assert same and differ and labels > 0


# --- R1-5 -----------------------------------------------------------------------------------------------------
RF = "If the pain becomes severe or you start vomiting, come to emergency immediately."


def _rf_art(speaker="0", advice=None, lang="en"):
    lines = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Pain in the stomach since morning."), (11, 15, "0", "Tummy is soft."),
             (16, 22, speaker, RF)]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient"}, lang=lang)
    enc = empty_encounter(examination=[{"performed": "Abdomen", "finding": "soft", "basis": "said", "source_turns": [2]}],
                          advice=advice or [])
    return c, build_artifact(c, enc)


def test_r1_5_doctor_red_flag_is_carried():
    c, art = _rf_art()
    assert "general_advice" not in art["gp_extraction"]
    out, cnt = apply_r1(art, c.turns)
    assert out["gp_extraction"]["general_advice"] == RF and cnt["r1_5_added"] == 1
    p = [x for x in out["provenance"] if x["json_pointer"] == "/general_advice"]
    assert len(p) == 1 and p[0]["kind"] == "advice" and p[0]["status"] == "prescribed" and p[0]["flags"] == []
    assert [(e["segment_ref"], e["speaker"]) for e in p[0]["evidence"]] == [("synth-unit:3", "doctor")]
    out["note_text"] = render_note(out["gp_extraction"], flags_by_pointer(out))
    assert check(out) == []


def test_r1_5_already_in_advice_adds_nothing():
    c, art = _rf_art(advice=[{"text": "Come to emergency immediately if the pain becomes severe or you start vomiting.", "basis": "said",
                              "source_turns": [2]}])
    before = art["gp_extraction"]["general_advice"]
    out, cnt = apply_r1(art, c.turns)
    assert out["gp_extraction"]["general_advice"] == before and cnt["r1_5_added"] == 0 and cnt["r1_5_covered"] == 1


def test_r1_5_patient_sentence_adds_nothing():
    c, art = _rf_art(speaker="1")
    out, cnt = apply_r1(art, c.turns)
    assert "general_advice" not in out["gp_extraction"] and cnt["r1_5_added"] == 0 and cnt["r1_5_detected"] == 0


def test_r1_5_non_english_turn_is_skipped_and_counted():
    c, art = _rf_art(lang="hi")
    out, cnt = apply_r1(art, c.turns)
    assert "general_advice" not in out["gp_extraction"] and cnt["r1_5_non_english_skipped"] == 3


def test_r1_5_quarantined_turn_is_not_carried():
    c, art = _rf_art()
    art["clip_boundary"]["quarantined_turns"] = [3]
    assert apply_r1(art, c.turns)[1]["r1_5_added"] == 0


def test_r1_5_line_that_fails_printable_errors_is_counted_not_added():
    c, art = _rf_art()
    c.turns[3].text = "If the pain is severe, come back immediately [S1]."
    out, cnt = apply_r1(art, c.turns)
    assert cnt["r1_5_blocked"] == 1 and "general_advice" not in out["gp_extraction"]


@pytest.mark.parametrize("text", [
    "Come back immediately if you feel faint.", "Come at once.", "Go to the emergency if you bleed.", "Go straight to casualty.",
    "If it gets worse, come back.", "If the fever increases, come back to the hospital.", "If vomiting does not settle come back.",
    "Rush him to hospital.", "Report to the ER straight away.",
])
def test_r1_5_detector_covers_the_class(text):
    assert red_flag_clauses(text) == [text] and len(RED_FLAG_PATTERNS) >= 4


@pytest.mark.parametrize("text", ["Come back after one week.", "Drink warm water and rest.", "The emergency was last year."])
def test_r1_5_detector_ignores_routine_advice(text):
    assert red_flag_clauses(text) == []


def test_apply_r1_notes_only_false_is_a_copy():
    art = hand_art(para=("patient", Q_PARA))
    out, c = apply_r1(art, None, notes_only=False)
    assert out == art and out is not art and c["notes_only"] is False


# --- F2 (FRX-R1b clinical ruling): missing-value words withhold only a missing-value statement --------------------
QUALIFIED = ["fever of unknown origin", "hypertension, unspecified", "pain of unclear aetiology"]
F2_PATHS = [("presenting_complaints", "diagnoses", 0, "diagnosis_or_impression"), ("comorbidities", 0, "name"), ("examination",),
            ("presenting_complaints", "symptoms"), ("medicines", 0, "instructions")]


@pytest.mark.parametrize("text", QUALIFIED)
@pytest.mark.parametrize("path", F2_PATHS, ids=lambda p: "/".join(map(str, p)))
def test_f2_clinical_qualifier_posts_unchanged(path, text):
    art = hand_art()
    _put(art["gp_extraction"], path, text)
    out, c = apply_r1(art)
    assert _at(out["gp_extraction"], path) == text and c["r1_1_withheld"] == 0 and not withheld_items(out)
    assert not [e for e in frx(out) if e.startswith("FRX-G1")]


@pytest.mark.parametrize("text", ["not specified", "unknown", "Not specified.", "Unknown", "dose: not specified", "duration: unknown",
                                  "after food; not specified", "after food, dose not specified"])
@pytest.mark.parametrize("path", F2_PATHS, ids=lambda p: "/".join(map(str, p)))
def test_f2_missing_value_statement_is_withheld(path, text):
    art = hand_art()
    _put(art["gp_extraction"], path, text)
    out, c = apply_r1(art)
    assert c["r1_1_withheld"] == 1 and len(withheld_items(out)) == 1
    assert text not in json.dumps(out["gp_extraction"])  # the field, or its row, is gone whole
    assert posted_hits(out["gp_extraction"]) == []
