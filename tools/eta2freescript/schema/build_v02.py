"""Derive eta-freescript-artifact.v0.2.schema.json from the vendored v0.1 schema.

  python -m tools.eta2freescript.schema.build_v02          # rewrite the v0.2 file
  python -m tools.eta2freescript.schema.build_v02 --check  # exit 1 if the committed file is stale

Every v0.2 change is made here, on top of the untouched vendor file, so the bump is reviewable as code:
  1. schema_version const eta.freescript.v0.2.
  2. ProvenanceItem.speaker: the REB role track's roles. "attender" is written as "attendant" (the v0.1 word);
     "staff" and "other" are added (v0.1 could only say "unknown" for them).
  3. ProvenanceItem.speaker_source adds "role_track" (speaker taken from REB role.llm-roles).
  4. ProvenanceItem.flags adds "boundary_quarantined" and "doctor_dose_precedence".
  5. encounter.transcript adds speaker_source and role_track (flags only, never text).
  6. Top level adds completion_required[] and clip_boundary{} (both required). ProvenanceItem.kind adds "clip_boundary"
     (a kept-out review item for a suspected boundary that has no quarantined order to point at).
  7. LlmDuration.unit is NOT widened: gp_extraction still mirrors the pulsepb snapshot (DAYS/WEEKS/MONTHS). Years stay
     MONTHS x 12 until Pulse confirms evenpb.DurationUnit has YEARS; see README "Schema notes".
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
V01 = HERE.parent / "vendor" / "freescript-w38" / "eta-freescript-artifact.schema.json"
V02 = HERE / "eta-freescript-artifact.v0.2.schema.json"

SPEAKERS_V02 = ["doctor", "patient", "attendant", "staff", "other", "unknown"]
NEW_FLAGS = ["boundary_quarantined", "doctor_dose_precedence", "field_withheld"]
COMPLETION_KINDS = ["regimen_slot", "drug_history", "exam_missing", "dose_unstated", "follow_up_unstated", "boundary_review"]


def build() -> dict:
    s = copy.deepcopy(json.loads(V01.read_text(encoding="utf-8")))
    s["$id"] = "https://eta.lab/schemas/eta.freescript.v0.2.json"
    s["title"] = "ETA -> FreeScript encounter artifact (v0.2)"
    s["description"] += (" v0.2: speakers from the REB role track (attendant/staff/other), completion_required[] (what the doctor"
                         " must fill before release) and clip_boundary{} (turns quarantined as a previous/next patient).")
    s["properties"]["schema_version"] = {"const": "eta.freescript.v0.2"}
    s["required"] = s["required"] + ["completion_required", "clip_boundary"]

    tr = s["properties"]["encounter"]["properties"]["transcript"]["properties"]
    tr["speaker_source"] = {"enum": ["role_track", "model_inferred"],
                            "description": "role_track: speakers from REB role.llm-roles; model_inferred: Stage A read roles from content."}
    tr["role_track"] = {
        "type": ["object", "null"], "additionalProperties": False,
        "properties": {"config_hash": {"type": ["string", "null"]},
                       "attender_present": {"type": ["boolean", "null"]},
                       "two_consults": {"type": ["boolean", "null"]},
                       "diar_partial": {"type": ["boolean", "null"]}},
    }

    s["properties"]["completion_required"] = {
        "type": "array",
        "description": "What the doctor must complete in Pulse FreeScript before release. One entry per open review item.",
        "items": {
            "type": "object", "additionalProperties": False,
            "required": ["kind", "item_id", "prompt"],
            "properties": {"kind": {"enum": COMPLETION_KINDS},
                           "item_id": {"type": "string", "description": "provenance item_id this entry refers to"},
                           "prompt": {"type": "string"},
                           "detail": {"type": "string"}},
        },
    }
    s["properties"]["clip_boundary"] = {
        "type": "object", "additionalProperties": False,
        "required": ["suspected", "quarantined_turns", "reasons"],
        "properties": {"suspected": {"type": "boolean"},
                       "quarantined_turns": {"type": "array", "items": {"type": "integer", "minimum": 0}},
                       "reasons": {"type": "array", "items": {"type": "string"}}},
    }

    pi = s["definitions"]["ProvenanceItem"]["properties"]
    pi["kind"]["enum"] = pi["kind"]["enum"] + ["clip_boundary"]
    pi["speaker"] = {"enum": SPEAKERS_V02}
    pi["speaker_source"] = {"enum": ["role_track", "diarisation", "model_inferred"]}
    pi["flags"]["items"]["enum"] = pi["flags"]["items"]["enum"] + NEW_FLAGS
    return s


def render() -> str:
    return json.dumps(build(), indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    if "--check" in argv:
        ok = V02.exists() and V02.read_text(encoding="utf-8") == render()
        print("v0.2 schema up to date" if ok else "v0.2 schema is stale: run build_v02")
        return 0 if ok else 1
    V02.write_text(render(), encoding="utf-8")
    print(f"wrote {V02}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
