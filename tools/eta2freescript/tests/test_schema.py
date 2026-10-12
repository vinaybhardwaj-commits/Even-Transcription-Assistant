"""v0.2 schema: derived from the vendored v0.1, committed file not stale; vendored validator self-test still holds."""
import copy
import json
from pathlib import Path

from tools.eta2freescript.schema import build_v02
from tools.eta2freescript.validate import V, check, schema_v02, to_v01

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "freescript-w38"


def test_committed_v02_schema_is_up_to_date():
    assert build_v02.main(["--check"]) == 0


def test_committed_v03_schema_is_up_to_date():
    from tools.eta2freescript.schema import build_v03
    assert build_v03.main(["--check"]) == 0
    assert build_v03.build()["properties"]["schema_version"]["const"] == "eta.freescript.v0.3"


def test_v02_speakers_flags_and_kinds():
    s = schema_v02()
    d = s["$defs"] if "$defs" in s else s["definitions"]
    blob = json.dumps(d)
    for v in ("attendant", "staff", "other", "role_track", "boundary_quarantined", "doctor_dose_precedence", "clip_boundary"):
        assert f'"{v}"' in blob
    assert '"attender"' not in blob
    assert {"completion_required", "clip_boundary"} <= set(s["required"])
    assert s["properties"]["schema_version"]["const"] == "eta.freescript.v0.2"


def test_duration_unit_is_not_widened():
    blob = json.dumps(schema_v02())
    assert '"YEARS"' not in blob and '"DAYS", "WEEKS", "MONTHS"' in blob


def test_to_v01_projection(replay_out):
    _, logs = replay_out
    art = logs["synth-boundary-knee"]["artifact"]
    v1 = to_v01(art)
    assert v1["schema_version"] == "eta.freescript.v0.1"
    assert "completion_required" not in v1 and "clip_boundary" not in v1
    assert {p["speaker"] for p in v1["provenance"]} <= {"doctor", "patient", "attendant", "unknown"}
    assert {p["speaker_source"] for p in v1["provenance"]} <= {"diarisation", "model_inferred"}
    assert V.check(v1) == []


def test_c_rules(replay_out):
    _, logs = replay_out
    art = logs["synth-boundary-knee"]["artifact"]
    a = copy.deepcopy(art)
    a["completion_required"][0]["item_id"] = "nope"
    assert any(e.startswith("C1") for e in check(a))
    a = copy.deepcopy(art)
    q = next(p for p in a["provenance"] if "boundary_quarantined" in p["flags"])
    q["json_pointer"] = "/general_advice"
    assert check(a)  # the schema already forbids it; C2 is the same rule for a schema-valid edit
    q["status"] = "prescribed"
    a["gp_extraction"]["general_advice"] = "x"
    assert any(e.startswith("C2") or e.startswith("schema") for e in check(a))
    a = copy.deepcopy(art)
    a["clip_boundary"]["quarantined_turns"].append(999)
    assert any(e.startswith("C3") for e in check(a))


def test_vendored_examples_and_mutants_match_expected():
    for p in sorted((VENDOR / "examples").glob("*.json")):
        assert V.check(json.loads(p.read_text())) == [], p.name
    rows = [l.split("\t") for l in (VENDOR / "tests" / "expected.tsv").read_text().splitlines() if l.strip()]
    assert rows
    for name, *_, expected in rows:
        errs = V.check(json.loads((VENDOR / "tests" / "mutants" / f"{name}.json").read_text()))
        assert ("pass" if not errs else "fail") == expected.strip(), name
