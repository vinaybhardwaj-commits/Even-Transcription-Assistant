"""P-SYN schemas: the JSON Schemas (draft 2020-12) for every file the generator writes.

`python -m eval.pdqi9.psyn schemas` rewrites schemas/*.schema.json from the
dicts below; a test asserts the checked-in files match.
"""

import json
from pathlib import Path

SCHEMA_DIR = Path(__file__).parent / "schemas"
D = "https://json-schema.org/draft/2020-12/schema"

STRATA = ["S-E", "S-N", "S-C", "S-R", "S-D", "S-A", "S-V", "S-M"]
ROLES = ["treating_doctor", "other_clinician", "staff", "translator", "patient", "attender"]
KINDS = ["medicine", "investigation", "referral", "procedure", "other_order", "diagnosis", "advice",
         "counselling", "warning", "lifestyle", "follow_up", "contingency", "patient_concern"]
LABELS = ["supported", "h_unattrib", "unaligned", "precedence_error", "clip_leak", "not_stated"]
SOURCES = ["3of3", "armc", "both", "none"]
VARIANTS = ["v1", "v2", "v3", "v4", "v5"]
FALLBACKS = ["armc_no_centroid", "armc_no_login", "armc_partial_login", "armc_no_match", "armc_margin",
             "armc_rank", "armc_contradiction", "armc_no_output"]

STR = {"type": "string"}
NSTR = {"type": ["string", "null"]}
TID = {"type": "string", "pattern": "^T[0-9]{3}$"}
TIDS = {"type": "array", "items": TID}
SID = {"type": "string", "pattern": "^S[0-9]+$"}
PDID = {"type": "string", "pattern": "^PD[0-9]{2}$"}
NPDID = {"anyOf": [PDID, {"type": "null"}]}
SCRIPT_ID = {"type": "string", "pattern": "^PSYN-(SE|SN|SC|SR|SD|SA|SV|SM)-[0-9]{3}$"}
COVER = {"anyOf": [{"type": "null"}, {"type": "object", "additionalProperties": False,
                                      "required": ["start_frac", "end_frac"],
                                      "properties": {"start_frac": {"type": "number", "minimum": 0, "maximum": 1},
                                                     "end_frac": {"type": "number", "minimum": 0, "maximum": 1}}}]}


def obj(props, required=None, extra=False):
    return {"type": "object", "additionalProperties": extra, "required": required or sorted(props),
            "properties": props}


FORBIDDEN_VALUE = obj({"value": STR, "turn_ids": TIDS, "label": {"enum": LABELS}})
EMPHASIS = obj({"repeat_count": {"type": "integer", "minimum": 1}, "stressed": {"type": "boolean"}})
STANCE = obj({"turn_id": TID, "value": STR, "strength": {"enum": ["firm", "hedged"]}})
RELAY = obj({"relay_turn_id": TID, "of_turn_id": TID, "item_id": STR, "changes_value": {"type": "boolean"},
             "adds_content": {"type": "boolean"}, "changed_attribute": NSTR, "relay_value": NSTR,
             "doctor_value": NSTR, "expected_event": {"enum": ["relay", "relay_conflict", "translator_added"]}})
AFFECT_SCENE = obj({"scene_id": STR, "speaker_id": SID, "turn_ids": TIDS, "intended_state": STR,
                    "agreement_design": STR, "expected_arm4_effect": {"enum": ["none", "reorder_or_emphasis_only"]},
                    "new_items_allowed": {"const": 0}})
PDQI_PLAN = {"anyOf": [{"type": "null"}, obj({
    "rubric": {"enum": ["pdqi9-encounter", "pdqi9-note@2", "all"]}, "defect_in": {"enum": ["consult", "twin", None]},
    "target_item": NSTR, "planted_level": {"enum": [1, 3, 5]},
    "defect_code": {"anyOf": [{"type": "null"}, {"type": "array", "items": STR}]},
    "off_target": {"const": "clean_baseline"}})]}

ENROL_UTT = obj({"utterance_id": {"type": "string", "pattern": "^PD[0-9]{2}-E[0-9]{2}$"}, "text": STR})

SCRIPT = {
    "$schema": D, "$id": "psyn/script.schema.json", "title": "P-SYN scripted consult",
    **obj({
        "script_id": SCRIPT_ID, "stratum": {"enum": STRATA}, "split": {"enum": ["dev", "test"]},
        "seed": {"type": "integer"}, "synthetic": {"const": True},
        "language_mode": {"enum": ["en", "cs"]}, "codeswitch_lang": {"enum": ["hi", "kn", None]},
        "scenario": STR, "trap_tags": {"type": "array", "items": STR},
        "split_cell": STR, "split_group": STR,
        "speakers": {"type": "array", "minItems": 2, "items": obj({
            "speaker_id": SID, "role": {"enum": ROLES}, "display_name": STR, "voice_ref": STR,
            "pseudo_doctor_id": NPDID, "is_treating": {"type": "boolean"},
            "intended_diar_label": {"type": "string", "pattern": "^L[0-9]+$"},
            "language": {"enum": ["en", "hi", "kn"]}, "voice_alike_of": NPDID, "note": NSTR,
            "enrolment": {"anyOf": [{"type": "null"}, {"type": "array", "items": ENROL_UTT}]}})},
        "treating_speaker_id": SID,
        "turns": {"type": "array", "minItems": 5, "items": obj({
            "turn_id": TID, "speaker_id": SID, "text": {"type": "string", "minLength": 1},
            "lang": {"enum": ["en", "hi", "kn"]}, "intended_diar_label": {"type": "string", "pattern": "^L[0-9]+$"},
            "est_seconds": {"type": "number", "exclusiveMinimum": 0}, "short_segment": {"type": "boolean"},
            "clip_region": {"enum": ["in_clip", "pre_bleed", "post_bleed"]},
            "overlap_with": {"anyOf": [TID, {"type": "null"}]}, "affect": NSTR,
            "relay_of": {"anyOf": [TID, {"type": "null"}]}, "section_hint": NSTR})},
        "planted_items": {"type": "array", "minItems": 1, "items": obj({
            "item_id": {"type": "string", "pattern": "^I[0-9]{2}$"}, "kind": {"enum": KINDS},
            "is_order": {"type": "boolean"}, "canonical_key": STR, "category": STR, "trap": NSTR,
            "strength": {"enum": ["firm", "hedged"]}, "emphasis": EMPHASIS,
            "priority_rank": {"type": ["integer", "null"]}, "stances": {"type": "array", "items": STANCE},
            "pdqi_defect": {"type": "boolean"}, "affirmed_patient_raised": {"type": "boolean"},
            "attributes": {"type": "array", "minItems": 1, "items": obj({
                "name": STR, "value": NSTR, "surface": NSTR, "turn_ids": TIDS, "context_turn_ids": TIDS,
                "relay_turn_ids": TIDS, "forbidden_values": {"type": "array", "items": FORBIDDEN_VALUE}})}})},
        "relays": {"type": "array", "items": RELAY},
        "affect_scenes": {"type": "array", "items": AFFECT_SCENE},
        "pdqi9_plan": PDQI_PLAN, "notes": {"type": "object"},
        "metadata_variants": {"type": "array", "minItems": 5, "maxItems": 5, "items": obj({
            "variant_id": {"enum": VARIANTS}, "logged_in_pseudo_doctor_id": NPDID,
            "enrolled_pseudo_doctor_ids": {"type": "array", "items": PDID}, "login_coverage": COVER,
            "description": STR})},
        "claims": {"type": "array", "minItems": 4, "items": obj({
            "claim_id": {"type": "string", "pattern": "^C[0-9]{2}$"}, "text": STR,
            "kind": {"enum": ["present", "decoy"]}, "canonical_key": STR, "item_id": NSTR, "probe": NSTR})},
    }),
}

ATTR_TRUTH = obj({
    "name": STR, "value": NSTR, "surface": NSTR, "turn_ids": TIDS, "context_turn_ids": TIDS, "relay_turn_ids": TIDS,
    "forbidden_values": {"type": "array", "items": FORBIDDEN_VALUE},
    "said_by": {"type": "array", "items": SID}, "said_by_roles": {"type": "array", "items": {"enum": ROLES}},
    "ideal_label": {"enum": LABELS}, "allowed_labels": {"type": "array", "minItems": 1, "items": {"enum": LABELS}},
    "forbidden_labels": {"type": "array", "items": {"enum": LABELS}},
    "label_by_cited_source": {"type": "object", "propertyNames": {"enum": SOURCES},
                              "additionalProperties": {"enum": LABELS}},
    "expected_in_note": {"type": "boolean"}, "segcheck_applies": {"type": "boolean"},
    "t28e_counted": {"type": "boolean"}, "placeholder_forbidden": {"type": "boolean"},
    "segcheck_expected_fail": {"enum": ["duration", "cosine_or_role", None]},
    "invented_value_label": {"enum": LABELS},
}, required=["name", "value", "surface", "turn_ids", "context_turn_ids", "relay_turn_ids", "forbidden_values",
             "said_by", "said_by_roles", "ideal_label", "allowed_labels", "forbidden_labels",
             "label_by_cited_source", "expected_in_note", "segcheck_applies", "t28e_counted",
             "placeholder_forbidden", "segcheck_expected_fail"])

SPANS = obj({"3of3": TIDS, "armc": TIDS, "both": TIDS})

TRUTH = {
    "$schema": D, "$id": "psyn/truth.schema.json", "title": "P-SYN truth sheet (spec A4.4)",
    **obj({
        "script_id": SCRIPT_ID, "stratum": {"enum": STRATA}, "split": {"enum": ["dev", "test"]},
        "synthetic": {"const": True}, "generator_version": STR, "language_mode": {"enum": ["en", "cs"]},
        "treating_speaker_id": SID, "treating_label": STR,
        "roster": {"type": "array", "items": obj({"speaker_id": SID, "true_role": {"enum": ROLES},
                                                  "pseudo_doctor_id": NPDID, "is_treating": {"type": "boolean"},
                                                  "intended_diar_label": STR})},
        "segments": {"type": "array", "items": obj({
            "turn_id": TID, "speaker_id": SID, "true_role": {"enum": ROLES}, "true_identity": STR,
            "intended_diar_label": STR, "on_treating_label": {"type": "boolean"},
            "short_segment": {"type": "boolean"}, "clip_region": STR, "est_seconds": {"type": "number"},
            "section_hint": NSTR})},
        "items": {"type": "array", "items": obj({
            "item_id": STR, "kind": {"enum": KINDS}, "is_order": {"type": "boolean"}, "canonical_key": STR,
            "category": STR, "trap": NSTR, "strength": {"enum": ["firm", "hedged"]}, "emphasis": EMPHASIS,
            "priority_rank": {"type": ["integer", "null"]}, "reversal_chain": {"type": "array", "items": STANCE},
            "affirmed_patient_raised": {"type": "boolean"}, "pdqi_defect": {"type": "boolean"},
            "expected_in_note": {"type": "boolean"}, "said_by_roles": {"type": "array", "items": {"enum": ROLES}},
            "attributes": {"type": "array", "minItems": 1, "items": ATTR_TRUTH}})},
        "instructions": {"type": "array", "items": obj({
            "instruction_id": STR, "category": STR, "canonical_key": STR, "spans": TIDS,
            "strength": {"enum": ["firm", "hedged"]}, "reversal_chain": {"type": "array", "items": STANCE},
            "emphasis": EMPHASIS, "priority_rank": {"type": ["integer", "null"]}})},
        "patient_concerns": {"type": "array", "items": obj({"concern_id": STR, "canonical_key": STR,
                                                            "turn_ids": TIDS})},
        "relays": {"type": "array", "items": RELAY},
        "variants": {"type": "array", "minItems": 5, "maxItems": 5, "items": obj({
            "variant_id": {"enum": VARIANTS}, "logged_in_pseudo_doctor_id": NPDID, "treating_pseudo_doctor_id": PDID,
            "treating_label": STR,
            "expected_armc": obj({"fires": {"type": "boolean"}, "label": NSTR,
                                  "allowed_fallback_reasons": {"type": "array", "items": {"enum": FALLBACKS}},
                                  "must_not_fire_on_label": NSTR}),
            "expected_doctor_spans": SPANS, "armc_label_turn_ids": TIDS, "expected_contradicted_turn_ids": TIDS,
            "fallback_equals_3of3_only": {"type": "boolean"}, "scored_in_primary": {"type": "boolean"},
            "used_for": {"type": "array", "items": STR}, "t28c_eligible": {"type": "boolean"}})},
        "claims": {"type": "array", "items": obj({"claim_id": STR, "kind": {"enum": ["present", "decoy"]},
                                                  "canonical_key": STR, "item_id": NSTR})},
        "decoy_share": {"type": "number"}, "decoy_list": {"type": "array", "items": STR},
        "speaker_gate_ideal": obj({"doctor_conf_seconds": {"type": "number"},
                                   "doctor_conf_segments": {"type": "integer"},
                                   "doctor_conf_share": {"type": "number"}}),
        "affect_scenes": {"type": "array", "items": AFFECT_SCENE}, "pdqi9": PDQI_PLAN,
        "oracle_ablation": {"const": ["script_text", "pipeline_transcript"]},
        "t28e_items": {"type": "array", "items": STR},
    }),
}

ENTRY = obj({"text": STR, "cited_turns": TIDS, "item_id": NSTR,
             "fields": {"type": "object", "additionalProperties": STR}, "defect": {"type": "boolean"}},
            required=["text", "cited_turns", "item_id"])

TWIN = {
    "$schema": D, "$id": "psyn/twin.schema.json", "title": "P-SYN code-built twin note",
    **obj({
        "script_id": SCRIPT_ID, "synthetic": {"const": True}, "artefact": {"enum": ["twin", "twin_defect"]},
        "format": STR,
        "defect": {"anyOf": [{"type": "null"}, obj({"target_item": STR, "planted_level": {"enum": [1, 3, 5]},
                                                    "code": NSTR})]},
        "sections": {"type": "array", "items": obj({"section": STR, "entries": {"type": "array", "items": ENTRY}})},
    }),
}

ENROLMENT = {
    "$schema": D, "$id": "psyn/enrolment.schema.json", "title": "P-SYN pseudo-doctor enrolment sets",
    **obj({
        "synthetic": {"const": True}, "note": STR,
        "pseudo_doctors": {"type": "array", "minItems": 32, "items": obj({
            "pseudo_doctor_id": PDID, "display_name": STR, "voice_ref": STR, "voice_alike_of": NPDID,
            "enrolment": {"type": "array", "minItems": 1, "items": ENROL_UTT}})},
    }),
}

MANIFEST = {
    "$schema": D, "$id": "psyn/manifest.schema.json", "title": "P-SYN build manifest",
    **obj({
        "generator_version": STR, "seed": {"type": "integer"}, "split_seed": {"type": "integer"},
        "synthetic": {"const": True}, "spec": STR, "total_scripts": {"const": 252},
        "counts": {"type": "object"}, "scripts": {"type": "array", "items": obj({
            "script_id": SCRIPT_ID, "stratum": {"enum": STRATA}, "split": {"enum": ["dev", "test"]},
            "dir": STR})},
        "files": {"type": "array", "items": obj({"path": STR, "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                                                 "bytes": {"type": "integer"}})},
    }),
}

ALL = {"script": SCRIPT, "truth": TRUTH, "twin": TWIN, "enrolment": ENROLMENT, "manifest": MANIFEST}


def dumps(obj_):
    return json.dumps(obj_, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write_schemas(directory=SCHEMA_DIR):
    directory.mkdir(parents=True, exist_ok=True)
    for name, sch in ALL.items():
        (directory / f"{name}.schema.json").write_text(dumps(sch), encoding="utf-8")


def validator(name):
    from jsonschema import Draft202012Validator
    Draft202012Validator.check_schema(ALL[name])
    return Draft202012Validator(ALL[name])
