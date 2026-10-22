"""FRX-V10 end to end: slot tokens, withholding records, confirm prompts, Medication by code, C4/C7, served model id, D7, no strength path."""
import copy
import json
import os
import re
from pathlib import Path

import pytest

from conftest import empty_encounter, mk_consult
from tools.eta2freescript import PIPELINE_VERSION, STAGE_A_VERSION, STAGE_B_VERSION
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.v10 import data, meds, names

DOC = {"0": "doctor", "1": "patient"}
HEADINGS = ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management", "Surgery or Procedure", "Medication",
            "Further Investigation", "Follow up", "Refer to", "General Advice"]


def note(**kw):
    return "\n".join(f"{h}: {kw.get(h.replace(' ', '_').replace('-', '_'), '')}".rstrip() for h in HEADINGS)


def rx(generic, brand, t, st=None, freq="twice a day", dur="3 days", action="start"):
    return {"action": action, "decision_turn": t, "generic": generic, "brand_as_said": brand, "strength": st, "frequency": freq, "duration": dur,
            "route": None, "basis": "said", "confidence": 0.85, "source_quote_turn": t, "source_turns": [t]}


def run(tmp_path, lines, enc, roles=DOC, role_track=True, stage_b=None, served=None, **kw):
    c = mk_consult(lines, roles=roles, role_track=role_track, **kw)
    # the default Stage B note has no headings, so the validator rejects it and the deterministic render is used
    fake = FakeClient({"stageA": json.dumps(enc), "stageB": stage_b if stage_b is not None else "no headings here"}, served_id=served)
    lg = run_consult(c, fake, tmp_path)
    return lg, lg["artifact"], fake


LINES = [(0, 4, "0", "Tell me what happened."), (5, 9, "1", "I have fever since three days."), (10, 14, "0", "Start Dolo 650 twice a day for three days."),
         (30, 34, "0", "Review after two weeks. Come back at once if the fever goes above 103."), (50, 54, "0", "BP is 130 by 80, pulse 84.")]


def base_enc(**kw):
    e = dict(chief_complaint={"text": "Fever", "duration": {"value": 3, "unit": "DAYS"}, "basis": "said", "source_turns": [1]},
             prescription=[rx("paracetamol", "Dolo 650", 2, "650 mg")],
             follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 2, "unit": "WEEKS"}, "basis": "said", "source_turns": [3]},
             examination=[{"performed": "General", "finding": "BP 130/80, pulse 84", "basis": "said", "source_turns": [4]}])
    e.update(kw)
    return empty_encounter(**e)


def test_versions():
    assert (PIPELINE_VERSION, STAGE_A_VERSION, STAGE_B_VERSION) == ("3.0.0", "v3", "v10")


def test_medicine_becomes_a_prompt_with_no_strength_in_any_posted_field(tmp_path):
    lg, a, _ = run(tmp_path, LINES, base_enc())
    assert lg["final_valid"], lg["final_errors"]
    assert "medicines" not in a["gp_extraction"]
    assert re.search(r"(?m)^Medication: Draft list, not a prescription; the treating doctor checks each drug\.$", a["note_text"])
    assert "PARACETAMOL (Dolo) — confirm" in a["note_text"]
    med = a["note_text"].split("Further Investigation:")[0].split("Medication:")[1]
    assert not re.search(r"\d", med)
    pr = a["confirm_prompts"][0]
    assert pr["kind"] == "medicine" and pr["action"] == "start" and pr["drug"]["generic"] == "PARACETAMOL" and pr["drug"]["brand_recognised"] == "Dolo"
    assert "notes_only" in pr["doctor_confirm_reason"]
    pub = json.dumps({k: v for k, v in a.items() if k != "confirm_internal"})
    assert "650" not in re.sub(r'"quote[^"]*": "[^"]*"', "", pub)  # no strength outside the verbatim quotes and confirm_internal
    internal = a["confirm_internal"][pr["prompt_id"]]
    assert internal["strength"]["value"] == "650 mg" and internal["frequency"]["value"] == "twice a day"
    assert re.fullmatch(r"\d\d:\d\d", internal["strength_heard_at"]["clip_mmss"])


def test_numbers_post_only_as_slots_and_write_back_canonically(tmp_path):
    enc = base_enc(chief_complaint={"text": "Fever since 3 days", "basis": "said", "source_turns": [1]})
    lg, a, fake = run(tmp_path, LINES, enc)
    gx = a["gp_extraction"]
    assert gx["presenting_complaints"]["symptoms"] == "Fever since 3 days."
    assert gx["examination"] == "General - BP 130/80 mmHg, pulse 84/min" or "130/80" in gx["examination"]
    b = [x for x in fake.calls if x["tag"].startswith("stageB")][0]["prompt"]
    assert "⟦S" in b and "130/80" not in b and "3 days" not in b          # Stage B sees tokens, never a number
    assert a["generator"]["data_files"]["dictionary_sha256"] and a["generator"]["data_files"]["catalogue_snapshot_date"]
    assert a["generator"]["profile_version"] is None


def test_unslotted_number_is_withheld_with_record_and_prompt(tmp_path):
    enc = base_enc(advice=[{"text": "Take Warf 5 daily. Drink plenty of water", "basis": "said", "source_turns": [3]}])
    lg, a, _ = run(tmp_path, LINES, enc)
    assert lg["final_valid"], lg["final_errors"]
    assert "Warf" not in a["gp_extraction"].get("general_advice", "") and "5" not in a["gp_extraction"].get("general_advice", "")
    w = [x for x in a["withheld"] if x["field_pointer"] == "/general_advice"]
    assert w and w[0]["reason_code"] in ("unslotted", "veto_ood", "veto_dosing_word", "veto_detector") and w[0]["stage"] == "floor" and w[0]["span_ids"]
    ids = {c["item_id"] for c in a["completion_required"] if c["kind"] == "field_withheld"}
    assert w[0]["prompt_id"] in ids and any("General Advice withheld" in c["prompt"] for c in a["completion_required"])


def test_red_flag_with_a_vetoed_number_is_withheld_whole_and_its_prompt_is_first(tmp_path):
    enc = base_enc(red_flags_safety_net=[{"text": "Come back at once if the fever goes above 103 and take Calpol 650", "must_carry": True, "basis": "said", "source_turns": [3]},
                                         {"text": "Go to the emergency room if you faint", "must_carry": True, "basis": "said", "source_turns": [3]}])
    lg, a, _ = run(tmp_path, LINES, enc)
    assert lg["final_valid"], lg["final_errors"]
    assert a["gp_extraction"]["general_advice"].startswith("Go to the emergency room if you faint")
    assert a["completion_required"][0]["kind"] == "field_withheld" and a["completion_required"][0]["prompt"].startswith("Red flag said at")
    assert [r["text_en"] for r in a["red_flags"]] == ["Go to the emergency room if you faint"] and a["red_flags"][0]["must_carry"] is True
    assert any(w["red_flag"] for w in a["withheld"])


def test_red_flags_are_not_trimmed_by_the_advice_budget(tmp_path):
    advice = [{"text": f"Avoid {w} food", "basis": "said", "source_turns": [3]} for w in ("oily", "spicy", "sweet", "fried", "salty", "cold", "heavy", "raw")]
    reds = [{"text": "Return immediately if there is chest pain", "must_carry": True, "basis": "said", "source_turns": [3]}]
    lg, a, _ = run(tmp_path, LINES, base_enc(advice=advice, red_flags_safety_net=reds))
    ga = a["gp_extraction"]["general_advice"]
    assert ga.startswith("Return immediately if there is chest pain") and len(ga.split("; ")) <= 6
    assert lg["final_valid"], lg["final_errors"]


def test_stage_b_cannot_add_a_number_or_a_token(tmp_path):
    enc = base_enc(chief_complaint={"text": "Fever since 3 days", "basis": "said", "source_turns": [1]})
    bad = note(Presenting_Complaint="Fever for 9 days", Examination="BP 120/80")
    lg, a, _ = run(tmp_path, LINES, enc, stage_b=bad)
    assert lg["note_source"] == "deterministic_fallback"
    assert "9 days" not in a["note_text"] and "120/80" not in a["note_text"]
    inv = note(Presenting_Complaint="Fever since ⟦S77⟧")
    lg, a, _ = run(tmp_path, LINES, enc, stage_b=inv)
    assert lg["note_source"] == "deterministic_fallback" and "⟦" not in a["note_text"]


def test_stage_b_cannot_write_the_medication_section(tmp_path):
    lg, a, _ = run(tmp_path, LINES, base_enc(), stage_b=note(Medication="Dolo 650 twice a day"))
    assert "Dolo 650" not in a["note_text"] and "PARACETAMOL (Dolo) — confirm" in a["note_text"]


def test_stop_is_a_prompt_and_never_named_in_note_or_gp(tmp_path):
    lines = LINES + [(60, 64, "0", "Stop Zoryl now.")]
    enc = base_enc(prescription=[rx("paracetamol", "Dolo 650", 2, "650 mg"), rx("glimepiride", "Zoryl", 5, None, None, None, action="stop")])
    lg, a, _ = run(tmp_path, lines, enc)
    assert lg["final_valid"], lg["final_errors"]
    stops = [p for p in a["confirm_prompts"] if p["action"] == "stop"]
    assert stops and "stop_order" in stops[0]["doctor_confirm_reason"]
    assert "Zoryl" not in a["note_text"] and "glimepiride" not in a["note_text"].lower() and "Zoryl" not in json.dumps(a["gp_extraction"])
    assert "Medication changes discussed: see the confirm list." in a["note_text"]


def test_unmapped_brand_reads_confirm_generic(tmp_path):
    lines = LINES + [(60, 64, "0", "Start Warf at night.")]
    enc = base_enc(prescription=[rx(None, "Warf", 5, None, None, None)])
    lg, a, _ = run(tmp_path, lines, enc)
    assert "Warf — confirm generic" in a["note_text"] and a["confirm_prompts"][0]["drug"]["generic"] is None
    assert "brand_unmapped" in a["confirm_prompts"][0]["doctor_confirm_reason"]


def test_brand_carries_no_digits():
    assert names.spoken_brand("Dolo 650") == "Dolo" and names.spoken_brand("Mixtard 30/70") == "Mixtard" and names.spoken_brand("Augmentin 625 Duo") == "Augmentin Duo"
    assert names.spoken_brand("Telma-AM 40/5") == "Telma-AM" and names.spoken_brand("650") is None


def test_brand_names_are_never_erased_by_the_medication_renderer():
    # Brand redactor regression (FRX-V1 fix round): brand-name erasures were 526 of 600 runs; they must be 0
    brands = ["Dolo 650", "Crocin Advance", "Calpol 500", "Glycomet-GP 1", "Telma-H 40", "Augmentin 625 Duo", "Pan D", "Zerodol P", "Mixtard 30/70", "Ecosprin AV 75/10"]
    erased = 0
    for i in range(600):
        b = brands[i % len(brands)] + ("" if i % 3 else " tab")
        line = names.med_line(names.drug_block({"brand_as_said": b, "generic": None}))
        head = re.sub(r"[\d\-\s]", "", b.replace(" tab", "").split()[0]).lower()  # the catalogue spells Glycomet-GP "Glycomet GP"
        erased += head not in re.sub(r"[\-\s]", "", line.lower())
    assert erased == 0


def test_no_order_capable_span_posts_no_order(tmp_path):
    enc = base_enc(investigations=[{"name": "Chest X-ray", "order_status": "ordered", "decision_turn": 2, "basis": "said", "source_turns": [2]}])
    lines = LINES[:2] + [(10, 14, "0", "Start Dolo 650 twice a day for three days and get a chest X-ray.")] + LINES[3:]
    lg, a, _ = run(tmp_path, lines, enc, role_track=False)  # D7: roles inferred by Stage A never order
    assert "further_investigations" not in a["gp_extraction"] and not any(s["order_capable"] for s in a["spans"])
    lg2, a2, _ = run(tmp_path, lines, enc)
    assert a2["gp_extraction"]["further_investigations"][0]["name"] == "Chest X-ray"


def test_follow_up_date_needs_an_interval_slot(tmp_path):
    lg, a, _ = run(tmp_path, LINES, base_enc())
    fu = a["gp_extraction"]["follow_up"]
    assert fu.get("followup_date") and "2 weeks" in fu["follow_up_instructions"]
    enc = base_enc(follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 3, "unit": "WEEKS"}, "basis": "said", "source_turns": [3]})
    lg, a, _ = run(tmp_path, LINES, enc)
    fu = a["gp_extraction"]["follow_up"]
    assert "followup_date" not in fu and any(w["field_pointer"] == "/follow_up" for w in a["withheld"])


def test_served_model_id_is_read_back_not_typed(tmp_path):
    lg, a, _ = run(tmp_path, LINES, base_enc(), served="global.anthropic.claude-sonnet-4-6")
    assert a["generator"]["served_model_id"] == "global.anthropic.claude-sonnet-4-6" and a["generator"]["model_id_source"] == "provider_response"
    lg, a, _ = run(tmp_path, LINES, base_enc())
    assert a["generator"]["served_model_id"] is None and a["generator"]["model_id_source"] == "request_alias_unverified"
    from tools.eta2freescript.models import served_model_id
    assert served_model_id({"modelId": "m1"}) == "m1" and served_model_id({"ResponseMetadata": {"HTTPHeaders": {"X-Amzn-Bedrock-Model-Id": "m2"}}}) == "m2"
    assert served_model_id({"output": {}}) is None


def test_encounter_and_stage_a_raw_are_persisted(tmp_path):
    lg, a, _ = run(tmp_path, LINES, base_enc())
    od = tmp_path / "synth-unit"
    assert (od / "encounter.json").exists() and (od / "stageA.raw.txt").exists()


def test_kept_out_records_carry_stage_and_spans(tmp_path):
    enc = base_enc(investigations=[{"name": "CBC", "order_status": "ordered", "decision_turn": 1, "basis": "said", "source_turns": [1]}])
    lg, a, _ = run(tmp_path, LINES, enc)
    assert a["kept_out"] and all(k["stage"] in ("stage_a", "mapper", "floor", "catalogue", "boundary") and "span_ids" in k for k in a["kept_out"])


# --- no config or environment can make v10 post a strength or a medicine (ruling 22 Oct 12:12) ------------------------------------------------
def test_no_env_or_config_makes_v10_post_a_strength_or_a_medicine(tmp_path, monkeypatch):
    for k, v in {"ETA_FREESCRIPT_NOTES_ONLY": "0", "ETA_FREESCRIPT_POST_STRENGTH": "1", "ETA_FREESCRIPT_EMIT_YEARS": "1", "ETA_FREESCRIPT": "1",
                 "ETA_FREESCRIPT_V10": "0", "ETA_FREESCRIPT_MEDICINES": "1"}.items():
        monkeypatch.setenv(k, v)
    lg, a, _ = run(tmp_path, LINES, base_enc())
    assert "medicines" not in a["gp_extraction"] and not re.search(r"650", a["note_text"] + json.dumps(a["gp_extraction"]))
    src = "\n".join(p.read_text(encoding="utf-8") for p in Path(__file__).resolve().parents[1].glob("*.py"))
    assert "POST_STRENGTH" not in src and "NOTES_ONLY" not in src
    assert {f for f in Options.__dataclass_fields__} == {"model", "stage_a", "stage_b", "stage_b_enabled", "write_v01"}
    prod = [p for p in Path(__file__).resolve().parents[1].rglob("*.py") if "tests" not in p.parts and "contract_v1" not in p.parts]
    assert not (Path(__file__).resolve().parents[1] / "v10" / "config.py").exists()  # ruling 4: no switch that could re-enable a medicine path
    assert not [p.name for p in prod if re.search(r"\bACTIVE\b|v10\.config|v10 import config", p.read_text(encoding="utf-8"))]
