"""Residuals carried into P2 (spec "Settled decisions and carried residuals")."""
import json
import os
import subprocess
import sys
from pathlib import Path

from conftest import empty_encounter, mk_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import run_consult
from tools.eta2freescript.v10 import data, meds
from tools.eta2freescript.validate import printable_errors
from test_v10_pipeline import DOC, rx

ROOT = Path(__file__).resolve().parents[1]


def run(tmp_path, lines, enc, roles=DOC):
    c = mk_consult(lines, roles=roles)
    return run_consult(c, FakeClient({"stageA": json.dumps(enc), "stageB": "x"}), tmp_path)["artifact"]


def test_v5f4_next_segment_reversal_overrides_the_earlier_strength(tmp_path):
    lines = [(0, 3, "0", "Start Dolo 650 twice a day."), (4.5, 7, "0", "No wait, keep it at 500.")]
    a = run(tmp_path, lines, empty_encounter(prescription=[rx("paracetamol", "Dolo 650", 0, "650 mg")]))
    internal = a["confirm_internal"][a["confirm_prompts"][0]["prompt_id"]]
    assert internal["strength"]["value"] == "500" and internal["reversal"] is True and set(internal["strength"]["cited_spans"]) <= {"s0", "s1"}
    far = [(0, 3, "0", "Start Dolo 650 twice a day."), (9, 12, "0", "No wait, keep it at 500.")]  # more than 2.0 s later: no override
    b = run(tmp_path / "far", far, empty_encounter(prescription=[rx("paracetamol", "Dolo 650", 0, "650 mg")]))
    assert b["confirm_internal"][b["confirm_prompts"][0]["prompt_id"]]["strength"]["value"] == "650 mg"


def test_a51_brands_that_are_ordinary_words_are_caught_by_the_dictionary_veto(tmp_path):
    for adv in ("Took Gastroma for 5 days", "Dart at night for 3 days", "Pan after food for 5 days"):
        lines = [(0, 5, "0", adv + ".")]
        a = run(tmp_path / adv[:4], lines, empty_encounter(advice=[{"text": adv, "basis": "said", "source_turns": [0]}]))
        assert "general_advice" not in a["gp_extraction"], adv
        assert a["withheld"] and a["withheld"][0]["reason_code"] in ("veto_ood", "veto_detector", "veto_dosing_word", "unslotted", "frame")


def test_r16_a_hit_in_general_advice_drops_only_that_item(tmp_path):
    lines = [(0, 6, "0", "Drink plenty of water. Take Warf 5 daily. Avoid oily food.")]
    items = [{"text": t, "basis": "said", "source_turns": [0]} for t in ("Drink plenty of water", "Take Warf 5 daily", "Avoid oily food")]
    a = run(tmp_path, lines, empty_encounter(advice=items))
    assert a["gp_extraction"]["general_advice"] == "Drink plenty of water; Avoid oily food" and len(a["withheld"]) == 1


def test_a55_acid_reflux_does_not_fail_the_artifact_while_folic_acid_is_held(tmp_path):
    lines = [(0, 4, "0", "You have acid reflux."), (5, 8, "0", "Stop folic acid.")]
    enc = empty_encounter(diagnoses=[{"label": "Acid reflux", "rank": "primary", "doctor_named": True, "status": "confirmed", "basis": "said", "source_turns": [0]}],
                          prescription=[rx("folic acid", None, 1, None, None, None, action="stop")])
    c = mk_consult(lines, roles=DOC)
    lg = run_consult(c, FakeClient({"stageA": json.dumps(enc), "stageB": "x"}), tmp_path)
    assert lg["final_valid"], lg["final_errors"]
    assert "Acid reflux" in lg["artifact"]["note_text"] and "olic" not in lg["artifact"]["note_text"]


def test_s3_low_sat_is_a_number_word_again():
    from tools.eta2freescript.v10.numbers import find_numbers
    assert find_numbers("sat")


def test_s3_low_negation_split_by_a_pause_is_flagged(tmp_path):
    lines = [(0, 2, "0", "Don't"), (6, 9, "0", "take rest at home")]
    a = run(tmp_path, lines, empty_encounter(advice=[{"text": "Take rest at home", "basis": "said", "source_turns": [1]}]))
    assert any("negation_cue_nearby" in p["flags"] for p in a["provenance"] if p["kind"] == "advice")


def test_frxn1_meta_statement_withholds_only_when_the_whole_value_is_one():
    whole = "Medication: strength not stated"
    inside = "Further Investigation: Repeat the chest film because the earlier report was not mentioned by the patient at all today"
    assert any("d1" in e for e in printable_errors("Further Investigation: dose not stated", []))
    assert not any("d1" in e for e in printable_errors(inside, []))
    assert not any("d1" in e for e in printable_errors("Further Investigation: CBC", []))


def test_contract_bundle_checks_pass_and_do_not_rewrite_the_dictionary():
    before = (ROOT / "contract_v1" / "data" / "scowl_words.json").read_bytes()
    env = dict(os.environ, PATH=str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"], PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run(["bash", "run_checks.sh"], cwd=ROOT / "contract_v1", env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout[-400:] + r.stderr[-400:]
    assert (ROOT / "contract_v1" / "data" / "scowl_words.json").read_bytes() == before
    script = (ROOT / "contract_v1" / "run_checks.sh").read_text()
    assert "build_vocab.py \"$TMP/scowl_rebuilt.json\"" in script and "exit 1" in script


def test_c7_provenance_names_every_data_file():
    p = data.provenance()
    assert set(p) == {"dictionary_sha256", "clinical_whitelist_sha256", "catalogue_snapshot_sha256", "catalogue_snapshot_date", "dosing_words_sha256", "analytes_sha256",
                      "number_lexicon_sha256", "detector_thresholds_sha256", "slot_bounds_sha256", "whitelist_extra_sha256", "whitelist_abbrev_sha256", "support_hedges_sha256", "number_homographs_sha256", "given_names_sha256", "surnames_sha256", "med_master_sha256", "class_forms_sha256"}
    assert all(len(v) == 64 for k, v in p.items() if k.endswith("sha256")) and p["catalogue_snapshot_date"]


def test_number_lexicon_covers_the_repo_lexicon():
    lib = json.loads((ROOT.parents[1] / "lib" / "stt" / "number-words.json").read_text(encoding="utf-8"))["words"]
    mine = set(data.load(data.NUMBER_LEXICON)["words"])
    assert {w.lower() for w in lib if w.strip()} - {"do"} <= mine
