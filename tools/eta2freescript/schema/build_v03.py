"""Derive eta-freescript-artifact.v0.3.schema.json from the v0.2 schema.

  python -m tools.eta2freescript.schema.build_v03
  python -m tools.eta2freescript.schema.build_v03 --check

v0.3 is the finished-prescription contract (docs/eta2freescript/FINISHED-RX-SPEC.md). gp_extraction still
mirrors the vendored pulsepb snapshot. New keys sit beside it: visit_date_ist, run_id, slots, room_facts,
evidence_state, and procedure provenance. LlmDuration may say YEARS; the mapper emits MONTHS x 12 unless
ETA_FREESCRIPT_EMIT_YEARS=1, and to_v01 rewrites YEARS so the w38 validator still passes.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

from tools.eta2freescript.schema.build_v02 import SPEAKERS_V02, build as build_v02

HERE = Path(__file__).resolve().parent
V03 = HERE / "eta-freescript-artifact.v0.3.schema.json"

COMPLETION_KINDS = [
    "pick_drug", "dose_unstated", "drug_history", "exam_missing", "follow_up_unstated", "follow_up_missing",
    "surgery_confirm", "inferred_confirm", "allergy_check", "boundary_review", "lab_dx_conflict",
]
KEPT_OUT = ["stopped", "not_given", "discussed_only", "conditional", "already_done", "asked_only", "drug_history"]
EVIDENCE_STATE = ["heard_in_room", "inferred", "not_said_in_room"]
ORDER_STATUS = ["ordered", "conditional", "already_done", "asked_only"]
ADVISED = ["advised", "offered_elective", "ordered", "conditional"]


def _part() -> dict:
    return {
        "type": "object", "additionalProperties": False, "required": ["evidence_state"],
        "properties": {
            "text": {"type": "string"},
            "value": {"type": ["string", "number", "null"]},
            "unit": {"type": ["string", "null"]},
            "evidence_state": {"enum": EVIDENCE_STATE},
            "source": {"enum": ["doctor", "patient", "attendant", "label"]},
            "as_heard": {"type": "string"},
        },
    }


def build() -> dict:
    s = copy.deepcopy(build_v02())
    s["$id"] = "https://eta.lab/schemas/eta.freescript.v0.3.json"
    s["title"] = "ETA -> FreeScript encounter artifact (v0.3)"
    s["description"] += " v0.3: finished prescription. visit_date_ist, run_id, slots, room_facts, evidence_state."
    s["properties"]["schema_version"] = {"const": "eta.freescript.v0.3"}
    for key in ("slots", "room_facts"):
        if key not in s["required"]:
            s["required"].append(key)

    gen = s["properties"]["generator"]
    gen["required"] = gen["required"] + ["run_id"]
    gen["properties"]["run_id"] = {"type": "string", "minLength": 4, "maxLength": 80}

    enc = s["properties"]["encounter"]
    enc["required"] = enc["required"] + ["visit_date_ist"]
    enc["properties"]["visit_date_ist"] = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}

    s["properties"]["completion_required"]["items"]["properties"]["kind"] = {"enum": COMPLETION_KINDS}
    s["properties"]["slots"] = {
        "type": "array",
        "items": {
            "type": "object", "additionalProperties": False,
            "required": ["slot_id", "form", "frequency", "duration", "timing", "class", "indication", "strength",
                         "decision", "evidence", "confidence", "json_pointer"],
            "properties": {
                "slot_id": {"type": "string"},
                "form": _part(), "frequency": _part(), "duration": _part(), "timing": _part(),
                "class": _part(), "indication": _part(), "strength": _part(),
                "decision": {"type": ["object", "null"]},
                "evidence": {"type": "array"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 0.6},
                "json_pointer": {"type": "null"},
                "flags": {"type": "array", "items": {"type": "string"}},
            },
        },
    }
    s["properties"]["room_facts"] = {
        "type": "object", "additionalProperties": False, "required": ["allergies", "vitals"],
        "properties": {
            "allergies": {"type": "array", "items": {"type": "object"}},
            "vitals": {"type": "array", "items": {"type": "object"}},
        },
    }

    dur = s["definitions"]["LlmDuration"]["properties"]["unit"]
    dur["enum"] = ["DAYS", "WEEKS", "MONTHS", "YEARS"]
    dur["description"] = ("evenpb.DurationUnit. Default emit is MONTHS x 12 (ETA_FREESCRIPT_EMIT_YEARS unset or 0). "
                          "YEARS is emitted only when ETA_FREESCRIPT_EMIT_YEARS=1.")

    ev = s["definitions"]["Evidence"]["properties"]
    ev["quote"] = {"type": "string"}
    ev["quote_native"] = {"type": "string"}
    ev["speaker"] = {"enum": SPEAKERS_V02}
    ev["speaker_source"] = {"enum": ["role_track", "diarisation", "model_inferred"]}

    pi = s["definitions"]["ProvenanceItem"]
    pi["required"] = pi["required"] + ["evidence_state"]
    props = pi["properties"]
    props["kind"]["enum"] = props["kind"]["enum"] + ["allergy", "vital"]
    props["status"]["enum"] = props["status"]["enum"] + ["conditional", "already_done", "asked_only", "drug_history"]
    props["evidence_state"] = {"enum": EVIDENCE_STATE}
    props["decision"] = {"type": ["object", "null"]}
    props["for_this_patient"] = {"type": "boolean"}
    props["medicine"] = {"type": "object"}
    props["diagnosis"] = {"type": "object"}
    props["investigation"] = {"type": "object"}
    props["procedure"] = {"type": "object"}
    props["follow_up"] = {"type": "object"}
    props["flags"]["items"]["enum"] += [
        "translation_conflict", "unresolved_name", "molecule_conflict",
        "dose_binding_conflict", "implausible_strength", "lab_dx_conflict",
    ]
    for clause in pi.get("allOf", []):
        enum = clause.get("if", {}).get("properties", {}).get("status", {}).get("enum")
        if enum and "discussed_only" in enum and "prescribed" not in enum:
            clause["if"]["properties"]["status"]["enum"] = KEPT_OUT
    return s


def render() -> str:
    return json.dumps(build(), indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    if "--check" in argv:
        ok = V03.exists() and V03.read_text(encoding="utf-8") == render()
        print("v0.3 schema up to date" if ok else "v0.3 schema is stale: run build_v03")
        return 0 if ok else 1
    V03.write_text(render(), encoding="utf-8")
    print(f"wrote {V03}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
