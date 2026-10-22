"""Brand-first Medication line for a spoken combination brand (FREESCRIPT-BRAND-FIRST, 15 Oct 2026)."""
import copy
import importlib.util
import json
import random
import re
from pathlib import Path

import pytest
from conftest import CONSULTS, MODEL, build_artifact, empty_encounter, mk_consult, stage_a

from tools.eta2freescript import STAGE_B_VERSION
from tools.eta2freescript.ingest import list_consults, load_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript import note as note_mod
from tools.eta2freescript.note import combination_groups, flags_by_pointer, render_note, repair_note
from tools.eta2freescript.pipeline import run_consult
from tools.eta2freescript.validate import check, printable_errors, to_v01, V

DOC = {"0": "doctor", "1": "patient"}
EXAM = [{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [0]}]


def _oracle():
    spec = importlib.util.spec_from_file_location("oracle_note_main", Path(__file__).parent / "oracle_note_main.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ORACLE = _oracle()


def rx(brand, **kw):
    base = {"action": "start", "decision_turn": 0, "generic": None, "brand_as_said": brand, "strength": None, "frequency": "twice a day",
            "duration": "5 days", "route": "oral", "basis": "said", "confidence": 0.85, "source_quote_turn": 0, "source_turns": [0]}
    base.update(kw)
    return base


def combo_art(say="Take Augmentin 625 twice a day for five days.", brand="Augmentin 625", **kw):
    c = mk_consult([(0, 8, "0", say)], roles=DOC)
    enc = empty_encounter(examination=EXAM, prescription=[rx(brand, **kw)])
    return build_artifact(c, enc)


def test_no_groups_is_byte_identical_to_origin_main():
    # fixtures: every synthetic consult's artifact, plus generated medicine lists
    rng = random.Random(7)
    words = ["paracetamol", "amlodipine", "metformin", "pantoprazole", "cetirizine", "Dolo 650", "Pan D"]
    for n in range(200):
        meds = []
        for _ in range(rng.randint(0, 4)):
            m = {"name": rng.choice(words), "raw_name": rng.choice(words)}
            for k, vals in (("frequency", ["BD", "once a day", ""]), ("duration", ["3 days", "", "1 week"]), ("instructions", ["after food", "", "with water"])):
                v = rng.choice(vals)
                if v:
                    m[k] = v
            meds.append(m)
        gx = {"medicines": meds, "general_advice": "rest"}
        banned = rng.choice([[], ["Dolo 650"], ["metformin"]])
        assert render_note(gx, {}, banned) == ORACLE.render_note(gx, {}, banned)
        assert render_note(gx, {}, banned, []) == ORACLE.render_note(gx, {}, banned)
        assert repair_note("Medication: x", gx, {}, banned) == ORACLE.repair_note("Medication: x", gx, {}, banned)


def test_fixture_artifacts_without_groups_render_as_origin_main(replay_out):
    out, logs = replay_out
    for uid, lg in logs.items():
        art = lg["artifact"]
        assert combination_groups(art) == []
        gx, fl = art["gp_extraction"], flags_by_pointer(art)
        assert render_note(gx, fl, []) == ORACLE.render_note(gx, fl, [])


def test_never_invent_brand_absent_from_cited_turns():
    # catalogue-attested combination, but the doctor never said the brand in a cited turn
    c = mk_consult([(0, 8, "0", "Take the antibiotic twice a day for five days.")], roles=DOC)
    enc = empty_encounter(examination=EXAM, prescription=[rx("Augmentin 625")])
    a = build_artifact(c, enc)
    assert combination_groups(a) == []


def test_every_component_name_is_in_the_grouped_line_generated():
    rng = random.Random(3)
    for _ in range(100):
        k = rng.randint(2, 4)
        names = [f"drug{chr(97 + i)}{rng.randint(10, 99)}" for i in range(k)]
        brand = f"Brand{rng.randint(100, 999)}"
        meds = [{"name": n, "raw_name": brand, "aliases": [brand], "frequency": "BD", "duration": "3 days"} for n in names]
        art = {"gp_extraction": {"medicines": meds},
               "provenance": [{"json_pointer": f"/medicines/{i}", "evidence": [{"segment_ref": "u:0", "speaker": "doctor", "quote_en": f"take {brand.lower()} now"}]} for i in range(k)]}
        g = combination_groups(art)
        assert g == [(brand, list(range(k)))]
        line = render_note(art["gp_extraction"], {}, [], g).split("Medication: ")[1].split("\n")[0]
        assert all(n in line for n in names) and brand in line and printable_errors(f"Medication: {line}", []) == []
        # no catalogue-only brand: remove the spoken mention and nothing groups
        art["provenance"][0]["evidence"][0]["quote_en"] = "take it now"
        for p in art["provenance"][1:]:
            p["evidence"][0]["quote_en"] = "take it now"
        assert combination_groups(art) == []


def test_kept_out_name_equal_to_a_component_is_not_a_false_positive_in_the_group():
    # a drug-history mention of one component must not fail the grouped line (the group counts for each component)
    a = combo_art()
    a["note_text"] = render_note(a["gp_extraction"], flags_by_pointer(a), [], combination_groups(a))
    a["provenance"].append({"item_id": "zz2", "kind": "medicine", "text": "[drug_history] clavulanic acid", "evidence_state": "heard_in_room",
                            "status": "discussed_only", "negated": False, "speaker": "patient", "speaker_source": "role_track", "evidence": a["provenance"][0]["evidence"],
                            "confidence": 0.9, "json_pointer": None, "flags": [], "decision": None, "names": ["clavulanic acid"]})
    assert not any(e.startswith("C4") for e in check(a)), check(a)


def test_ungrouped_lines_still_validate_when_groups_exist():
    a = combo_art()
    a["note_text"] = render_note(a["gp_extraction"], flags_by_pointer(a), [])
    assert check(a) == []


def test_prompt_says_none_when_no_groups(tmp_path):
    uid = "synth-fever-dose"
    fake = FakeClient({"stageA": json.dumps(stage_a(uid)), "stageB": (MODEL / uid / "stageB.txt").read_text()})
    from tools.eta2freescript.pipeline import Options
    run_consult(load_consult(CONSULTS, uid), fake, tmp_path, Options(stage_a="stageA-v2", stage_b="stageB-v9"))
    b = [x for x in fake.calls if x["tag"].startswith("stageB")][0]
    assert b["tag"].startswith("stageB-v9") and b["prompt"].count("\nnone\n") == 1


# --- R2: only the DOCTOR's words count --------------------------------------------------------------------
ROLES = ["doctor", "patient", "attendant", "staff", "other", "unknown", None]


def _set_speaker(a, speaker):
    for p in a["provenance"]:
        for ev in p.get("evidence") or []:
            if speaker is None:
                ev.pop("speaker", None)
            else:
                ev["speaker"] = speaker


def test_patient_turn_from_the_role_track_does_not_group():
    c = mk_consult([(0, 8, "1", "Take Augmentin 625 twice a day for five days.")], roles=DOC)
    enc = empty_encounter(examination=EXAM, prescription=[rx("Augmentin 625")])
    assert combination_groups(build_artifact(c, enc)) == []


def test_group_forms_iff_a_doctor_quote_has_the_brand_generated():
    rng = random.Random(5)
    for _ in range(300):
        k = rng.randint(2, 3)
        brand = f"Brand{rng.randint(100, 999)}"
        meds = [{"name": f"drug{chr(97 + i)}", "raw_name": brand, "aliases": [brand], "frequency": "BD"} for i in range(k)]
        ev = []
        for t in range(rng.randint(1, 4)):
            ev.append({"segment_ref": f"u:{t}", "speaker": rng.choice(ROLES), "quote_en": rng.choice([f"give {brand} now", "give it now", f"{brand}s"])})
        for e in ev:
            if e["speaker"] is None:
                del e["speaker"]
        art = {"gp_extraction": {"medicines": meds},
               "provenance": [{"json_pointer": f"/medicines/{i}", "evidence": copy.deepcopy(ev)} for i in range(k)]}
        expect = any(e.get("speaker") == "doctor" and brand.lower() in e["quote_en"].lower().split() for e in ev)
        assert bool(combination_groups(art)) == expect, ev


@pytest.mark.parametrize("idx", [[0.5, 1], [True, 2], ["0", "1"], [0.0, 1.0], [False, 1], [0, True], [None, 1]])
def test_valid_groups_rejects_non_int_indices(idx):
    gx = {"medicines": [{"name": "a"}, {"name": "b"}, {"name": "c"}]}
    assert render_note(gx, {}, [], [("Brand", idx)]) == ORACLE.render_note(gx, {}, [])
    assert note_mod._valid_groups([("Brand", idx)], 3) == {}
    assert note_mod._valid_groups([("Brand", [0, 1])], 3) == {0: ("Brand", [0, 1])}
