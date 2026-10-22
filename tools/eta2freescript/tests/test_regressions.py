"""Regressions from the 35-consult eval of c848ba90. Synthetic inputs only."""
import json

import pytest
from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript.eval.aggregate import COMPLETION_KINDS, head
from tools.eta2freescript.eval.judge import metrics
from tools.eta2freescript.models import FakeClient, GatewayClient, UsageLedger
from tools.eta2freescript.note import sanitize_note
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.validate import check

DOC = {"0": "doctor", "1": "patient"}


def test_class_word_and_no_name_note_become_a_slot_with_strength():
    c = mk_consult([(0, 6, "0", "Take a cholesterol medicine, 10 mg, at night for one month.")], roles=DOC)
    rx = {"action": "start", "decision_turn": 0, "generic": "statin", "brand_as_said": None, "name_interpretation": "no name was spoken",
          "strength": "10 mg", "frequency": "at night", "duration": "1 month", "basis": "said", "confidence": 0.7,
          "source_quote_turn": 0, "source_turns": [0]}
    art = build_artifact(c, empty_encounter(
        examination=[{"performed": "General", "finding": "well", "basis": "said", "source_turns": [0]}], prescription=[rx]))
    assert "medicines" not in art["gp_extraction"]
    assert art["completion_required"][0]["kind"] == "pick_drug"
    assert "statin" in json.dumps(art["slots"][0]) and "10 mg" in json.dumps(art["slots"][0])
    # A no-name note blocks a guessed generic too.
    rx["generic"] = "atorvastatin"
    rx["name_interpretation"] = "name not spoken, class only"
    art = build_artifact(c, empty_encounter(
        examination=[{"performed": "General", "finding": "well", "basis": "said", "source_turns": [0]}], prescription=[rx]))
    assert "medicines" not in art["gp_extraction"]
    assert "atorvastatin" not in json.dumps(art["gp_extraction"]).lower()


def test_near_miss_brand_is_not_a_second_continue_prompt():
    lines = [(0, 4, "1", "I take Concord 2.5."), (5, 10, "0", "Continue Concor 2.5, that is bisoprolol, every day.")]
    c = mk_consult(lines, roles=DOC)
    art = build_artifact(c, empty_encounter(
        examination=[{"performed": "Pulse", "finding": "regular", "basis": "said", "source_turns": [1]}],
        prescription=[{"action": "continue", "decision_turn": 1, "generic": "bisoprolol", "brand_as_said": "Concor 2.5",
                       "strength": "2.5 mg", "frequency": "once a day", "duration": None, "basis": "said", "confidence": 0.9,
                       "source_quote_turn": 1, "source_turns": [0, 1]}],
        drug_history=[{"name_as_said": "Concord 2.5", "text": "Takes Concord 2.5", "current": True, "reported_by": "patient", "source_turns": [0]}]))
    prompts = [x["prompt"] for x in art["completion_required"]]
    assert not any(p.startswith("Continue") for p in prompts)
    assert not art["gp_extraction"].get("medicines") and len(art["confirm_prompts"]) == 1 and "bisoprolol" in (art["confirm_prompts"][0]["drug"].get("generic") or "").lower()


def test_continue_prompt_only_when_plausible_and_garbled_names_collapse():
    lines = [(0, 4, "1", "I have diabetes and I take metformin."), (5, 9, "0", "Your diabetes needs the metformin continued."),
             (10, 14, "1", "Also some xzqpl and the one from last time.")]
    c = mk_consult(lines, roles=DOC)
    art = build_artifact(c, empty_encounter(
        examination=[{"performed": "General", "finding": "well", "basis": "said", "source_turns": [1]}],
        diagnoses=[{"label": "Diabetes mellitus", "rank": "primary", "doctor_named": True, "status": "confirmed", "basis": "said", "source_turns": [1]}],
        drug_history=[
            {"name_as_said": "metformin", "text": "takes metformin for diabetes", "current": True, "reported_by": "patient", "source_turns": [0, 1]},
            {"name_as_said": "xzqpl", "text": "some xzqpl tablet", "current": True, "reported_by": "patient", "source_turns": [2]},
            {"name_as_said": "the one from last time", "text": "the one from last time", "current": True, "reported_by": "patient", "source_turns": [2]},
        ]))
    prompts = [x["prompt"] for x in art["completion_required"]]
    assert prompts.count("Continue metformin?") == 1
    assert prompts.count("Patient mentioned other medicines") == 1
    assert sum(p.startswith("Continue") for p in prompts) == 1


def test_dose_marker_only_line_is_stripped():
    note = "Co-morbidities:\nPresenting Complaint:\nExamination:\nDiagnoses:\nPlan of Management:\nSurgery or Procedure:\nMedication: [dose not stated — doctor to verify]\nFurther Investigation:\nFollow up:\nRefer to:\nGeneral Advice:\n"
    assert "dose not stated" not in sanitize_note(note)
    assert "Medication:" in sanitize_note(note)


def test_held_back_metrics_ignore_slots_and_aggregate_splits_completion(replay_out):
    _, logs = replay_out
    art = logs["synth-fever-dose"]["artifact"]
    rec = {"uid": "synth-fever-dose", "kept_out": [
        {"text": "[regimen_slot] Name this drug"}, {"text": "[held_back_inferred_order] pantoprazole"},
        {"text": "[drug_history] metformin"}, {"text": "[boundary_quarantine] referral"}],
           "audit": {"kept_out_review": [
               {"k": 0, "verdict": "true_order_held_back"}, {"k": 1, "verdict": "true_order_held_back"},
               {"k": 2, "verdict": "hallucination_prevented"}, {"k": 3, "verdict": "unclear"}],
                     "drugs_ref": [], "drugs_pred": [], "comorbidities_pred": [], "completion_review": [],
                     "diagnosis": {}, "investigations_ref": [], "investigations_pred": [], "referrals_pred": [],
                     "advice_ref": [], "advice_pred": [], "follow_up": {}, "hallucinations": [],
                     "omissions_said_aloud": [], "omissions_not_said_aloud": [], "stage_b_additions": []}}
    row = metrics(rec, art, {})
    assert row["held_true_order"] == 1 and row["held_halluc_prevented"] == 1 and row["held_unclear"] == 0
    h = head([row])
    assert set(h["completion_required_by_type"]) == set(COMPLETION_KINDS)
    assert sum(h["completion_required_by_type"].values()) == h["completion_required_items"]


def test_gateway_chat_retries(monkeypatch):
    monkeypatch.setattr("tools.eta2freescript.models.time.sleep", lambda _s: None)
    calls = {"n": 0}

    class Gw:
        def chat(self, *_a, **_k):
            calls["n"] += 1
            if calls["n"] < 3:
                raise RuntimeError("throttle")
            return "ok", {"usage": {"inputTokens": 1, "outputTokens": 1}, "stopReason": "end"}

    client = GatewayClient.__new__(GatewayClient)
    client.ledger = UsageLedger(None)
    client.gw = Gw()
    assert client._chat("sonnet", "p", "s", 8, 0.0, "t") == "ok"
    assert calls["n"] == 3
    calls["n"] = 0

    class Always:
        def chat(self, *_a, **_k):
            calls["n"] += 1
            raise RuntimeError("down")

    client.gw = Always()
    with pytest.raises(RuntimeError):
        client._chat("sonnet", "p", "s", 8, 0.0, "t")
    assert calls["n"] == 3


