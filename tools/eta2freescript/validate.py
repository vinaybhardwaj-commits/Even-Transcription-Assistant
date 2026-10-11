"""Validate an eta.freescript artifact.

v0.1 artifacts: the vendored w38 validator as it is (schema + G1-G6).
v0.2 artifacts: (a) the v0.2 JSON Schema, (b) the vendored validator on the artifact's v0.1 projection (to_v01), so every
G-rule still runs unchanged and a v0.1 consumer can read the projection, and (c) the v0.2-only rules:
  C1 every completion_required item_id names a provenance item that is kept out (json_pointer null)
  C2 no provenance item flagged boundary_quarantined is in gp_extraction
  C3 every quarantined turn index is inside the transcript (segment_count)
  C4 an order line of note_text names no kept-out order (held back, quarantined, drug history) that its own
     gp_extraction entry does not also name. G6 checks a line names its entry, not that it names nothing else.
     A drug absent from the whole artifact cannot be caught without a lexicon; the judge's stage_b_additions counts it.

  python -m tools.eta2freescript validate FILE...
"""
from __future__ import annotations

import copy
import importlib.util
import json
from datetime import datetime
from pathlib import Path

import jsonschema

PKG = Path(__file__).resolve().parent
VENDOR = PKG / "vendor" / "freescript-w38"
SCHEMA_V02 = PKG / "schema" / "eta-freescript-artifact.v0.2.schema.json"


def _vendor():
    spec = importlib.util.spec_from_file_location("eta2fs_validate_artifact_w38", VENDOR / "validate_artifact.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


V = _vendor()
V01_FLAGS = set(V.SCHEMA["definitions"]["ProvenanceItem"]["properties"]["flags"]["items"]["enum"])
V01_SPEAKERS = set(V.SCHEMA["definitions"]["ProvenanceItem"]["properties"]["speaker"]["enum"])
_SCHEMA_V02 = None


def schema_v02() -> dict:
    global _SCHEMA_V02
    if _SCHEMA_V02 is None:
        _SCHEMA_V02 = json.loads(SCHEMA_V02.read_text(encoding="utf-8"))
    return _SCHEMA_V02


def to_v01(art: dict) -> dict:
    """The v0.1 view of a v0.2 artifact: v0.2-only keys dropped, staff/other speakers as unknown, role_track as diarisation."""
    a = copy.deepcopy(art)
    a["schema_version"] = "eta.freescript.v0.1"
    a.pop("completion_required", None)
    a.pop("clip_boundary", None)
    tr = a.get("encounter", {}).get("transcript", {})
    tr.pop("speaker_source", None)
    tr.pop("role_track", None)
    a["provenance"] = [p for p in a.get("provenance", []) if p.get("kind") != "clip_boundary"]
    for p in a["provenance"]:
        if p.get("speaker") not in V01_SPEAKERS:
            p["speaker"] = "unknown"
        if p.get("speaker_source") == "role_track":
            p["speaker_source"] = "diarisation"
        p["flags"] = [f for f in p.get("flags", []) if f in V01_FLAGS]
    return a


def _schema_errors(a: dict, schema: dict) -> list[str]:
    fc = jsonschema.FormatChecker()

    @fc.checks("date-time", raises=ValueError)
    def _dt(v):
        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True

    return ["schema-v0.2: %s at /%s" % (e.message[:160], "/".join(map(str, e.path)))
            for e in jsonschema.Draft7Validator(schema, format_checker=fc).iter_errors(a)]


def check(art: dict) -> list[str]:
    if art.get("schema_version") == "eta.freescript.v0.1":
        return V.check(art)
    errs = _schema_errors(art, schema_v02())
    if errs:
        return errs
    errs += V.check(to_v01(art))
    prov = {p["item_id"]: p for p in art["provenance"]}
    for c in art["completion_required"]:
        p = prov.get(c["item_id"])
        if p is None:
            errs.append(f"C1 completion_required {c['kind']} names unknown item {c['item_id']}")
        elif p["json_pointer"] is not None:
            errs.append(f"C1 completion_required {c['kind']} item {c['item_id']} is in gp_extraction")
    for p in art["provenance"]:
        if "boundary_quarantined" in p["flags"] and p["json_pointer"] is not None:
            errs.append(f"C2 {p['item_id']}: boundary_quarantined item is in gp_extraction")
    n = art["encounter"]["transcript"]["segment_count"]
    bad = [t for t in art["clip_boundary"]["quarantined_turns"] if t >= n]
    if bad:
        errs.append(f"C3 quarantined turns {bad} outside the transcript ({n} segments)")
    sec = V.note_sections(art["note_text"])
    for kind, (path, heading) in V.ORDER_LISTS.items():
        entries, lines = V.list_at(art["gp_extraction"], path), sec.get(heading, [])
        out = [p for p in art["provenance"] if p["kind"] == kind and p["json_pointer"] is None and p.get("names")]
        if len(entries) != len(lines):
            continue
        for i, (line, m) in enumerate(zip(lines, entries)):
            for p in out:
                if V.same_drug(p["names"], [line]) and not V.same_drug(p["names"], V.entry_names(m)):
                    errs.append(f"C4 {p['item_id']}: kept-out {kind} named in note {heading} line {i}")
    return errs


def main(paths: list[str]) -> int:
    bad = 0
    for path in paths:
        errs = check(json.loads(Path(path).read_text(encoding="utf-8")))
        print(("OK   " if not errs else "FAIL ") + path)
        for e in errs:
            print("     " + e)
        bad += bool(errs)
    return 1 if bad else 0
