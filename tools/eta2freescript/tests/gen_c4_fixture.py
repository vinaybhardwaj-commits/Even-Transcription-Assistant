"""Builds tests/c4_fixtures/pipeline_artifact.json THROUGH THE REAL PIPELINE (run_consult, FakeClient) from a synthetic transcript with sentinels planted in the
turns that hold heard strength / frequency / duration / timing, an unnamed regimen slot, an off-catalogue brand, a quarantined previous-patient turn and a vital.
Run: python tools/eta2freescript/tests/gen_c4_fixture.py   (tests/test_c4_fixture.py regenerates it and compares). Synthetic only."""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[2])]
from conftest import empty_encounter, mk_consult  # noqa: E402

OUT = HERE / "c4_fixtures" / "pipeline_artifact.json"
SENTINELS = {"prev": "ZQSENTQ0", "strength": "ZQSENTS1", "freq": "ZQSENTF2", "dur": "ZQSENTD3", "timing": "ZQSENTT4", "slot": "ZQSENTL5", "brand": "ZQSENTB6", "vital": "ZQSENTV7"}
LINES = [
    (0, 4, "0", f"Previous patient Venkatesh {SENTINELS['prev']} MRN 998877 had fever."),
    (5, 9, "0", "Good morning, tell me what happened."),
    (10, 14, "1", "I have giddiness and a cough."),
    (15, 24, "0", f"Start Glycomet 500 twice daily {SENTINELS['freq']} for 5 days {SENTINELS['dur']} after food {SENTINELS['timing']}, strength {SENTINELS['strength']}."),
    (25, 34, "0", f"Also start Zorbexin Plus Forte {SENTINELS['brand']} tablet twice a day for three days."),
    (35, 44, "0", f"Give a sugar tablet at night for a month {SENTINELS['slot']}."),
    (45, 52, "0", f"Your pulse is 84 {SENTINELS['vital']}."),
    (53, 60, "0", "Come back after one week."),
]


def stage_a() -> dict:
    s = {"basis": "said"}
    rx = lambda g, b, t, **k: {"action": "start", "decision_turn": t, "generic": g, "brand_as_said": b, "strength": k.get("strength"), "frequency": k.get("frequency"),
                              "duration": k.get("duration"), "timing": k.get("timing"), "route": "oral", "basis": "said", "confidence": 0.9, "source_quote_turn": t, "source_turns": [t]}
    return empty_encounter(
        chief_complaint={"text": "Giddiness and cough", **s, "source_turns": [2]},
        prescription=[rx(None, "Glycomet 500", 3, strength="500 mg", frequency="twice daily", duration="5 days", timing="after food"),
                      rx(None, "Zorbexin Plus Forte", 4, frequency="twice a day", duration="three days")],
        regimen_slots=[{"form": "tablet", "class": "sugar tablet", "frequency": None, "duration": "a month", "timing": "at night", "quote_turn": 5, "decision_turn": 5,
                        "basis": "said", "confidence": 0.8, "source_turns": [5]}],
        vitals=[{"name": "pulse", "value": "84", **s, "source_turns": [6]}],
        follow_up={"type": "MANDATORY_FOLLOW_UP", "interval": {"value": 1, "unit": "WEEKS"}, **s, "source_turns": [7]},
        consult_boundary={"suspected": True, "foreign_turns": [0], "reason": "previous patient"},
    )


def build() -> dict:
    from tools.eta2freescript.models import FakeClient
    from tools.eta2freescript.pipeline import Options, run_consult
    c = mk_consult(LINES, roles={"0": "doctor", "1": "patient"})
    c.uid = "synth-c4"
    note = "\n".join(f"{h}:" for h in ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management", "Surgery or Procedure", "Medication",
                                      "Further Investigation", "Follow up", "Refer to", "General Advice"])
    with tempfile.TemporaryDirectory() as d:
        lg = run_consult(c, FakeClient({"stageA": json.dumps(stage_a()), "stageB": note}), Path(d), Options())
        art = lg["artifact"]
    for k in ("artifact_id", "created_at"):
        art[k] = "fixed"
    art["generator"]["run_id"] = "fixed"
    art["generator"]["code_sha256"] = "0" * 64
    art["generator"]["data_files"] = {k: "0" * 64 for k in art["generator"].get("data_files", {})}  # a sha is a digit run the identity-shape scan would read as a phone number
    art["generator"]["prompt_sha256"] = "0" * 64
    return {"artifact": art, "completion_required": art["completion_required"], "sentinels": SENTINELS,
            "heard": ["twice daily", "5 days", "after food", "500", "three days", "a month", "at night", "Zorbexin Plus Forte"]}


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", OUT)
