#!/usr/bin/env python3
"""FUSER v1 B2: JSON schema for the model's REFERENCE-FIRST output (design section 3). The model never
writes free-text native transcript: it writes items (copy/norm/gen/conflict) that CODE materialises from
the cited refs (V2 re-checks every materialisation).

ADDENDUM-7 (RUN 3): the wire format is SIX HOMOGENEOUS ARRAYS, every field required, closed objects,
no oneOf/anyOf, because the earlier flat item (required=["kind"] only) let the model mix conflict fields
into norm items and omit "w" (RUN 2: 3 clean norm items). "pos" orders the native sequence.
normalise_items() maps a reply back to the flat item list the V1-V6 validator has always consumed, so
the validator is unchanged; it drops per ITEM, never rejects a whole reply for one bad item.
"""

NATIVE_KINDS = ("copies", "norms", "gens", "conflicts")
ARRAYS = ("copies", "norms", "gens", "conflicts", "en_clauses", "entities")
RULES = ("number_digits", "lexicon_generic", "split")
ENTITY_KINDS = ("drug", "dose", "freq", "duration", "dx", "test")

_REFS = {"type": "array", "minItems": 1, "items": {"type": "string"}}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


SLICE_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "copies": {"type": "array", "items": _obj({"pos": {"type": "integer"}, "refs": _REFS})},
        "norms": {"type": "array", "items": _obj({
            "pos": {"type": "integer"}, "refs": _REFS,
            "w": {"type": "string", "minLength": 1},
            "rule": {"type": "string", "enum": list(RULES)}})},
        "gens": {"type": "array", "items": _obj({
            "pos": {"type": "integer"}, "w": {"type": "string", "minLength": 1}, "reason": {"type": "string"}})},
        "conflicts": {"type": "array", "items": _obj({
            "pos": {"type": "integer"}, "kind": {"type": "string"},
            "options": {"type": "array", "minItems": 2, "items": _obj({"refs": _REFS})}})},
        "en_clauses": {"type": "array", "items": _obj({
            "text": {"type": "string"}, "native_pos": {"type": "array", "items": {"type": "integer"}}})},
        "entities": {"type": "array", "items": _obj({
            "kind": {"type": "string", "enum": list(ENTITY_KINDS)}, "value": {"type": "string"},
            "unit": {"type": "string"}, "native_pos": {"type": "array", "items": {"type": "integer"}}})},
    },
    "required": list(ARRAYS),
    "additionalProperties": False,
}

RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {"name": "fuser_v1_slice", "strict": True, "schema": SLICE_RESPONSE_SCHEMA},
}


def check_shape(data) -> tuple[bool, str]:
    """Whole-reply structural check ONLY: a JSON object with all six arrays as lists. Everything finer
    (per-item fields) is per-item in normalise_items, never a whole-reply rejection."""
    if not isinstance(data, dict):
        return False, "not a JSON object"
    for key in ARRAYS:
        if not isinstance(data.get(key), list):
            return False, f"missing or non-list {key!r}"
    return True, ""


def _is_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _refs_ok(refs) -> bool:
    return isinstance(refs, list) and len(refs) >= 1 and all(isinstance(r, str) and r for r in refs)


_KEYS = {
    "copies": {"pos", "refs"},
    "norms": {"pos", "refs", "w", "rule"},
    "gens": {"pos", "w", "reason"},
    "conflicts": {"pos", "kind", "options"},
}
_FLAT_KIND = {"copies": "copy", "norms": "norm", "gens": "gen", "conflicts": "conflict"}


def _flat_item(arr: str, it: dict) -> dict:
    kind = _FLAT_KIND[arr]
    if kind == "copy":
        return {"kind": "copy", "refs": it["refs"]}
    if kind == "norm":
        return {"kind": "norm", "refs": it["refs"], "w": it.get("w"), "rule": it["rule"]}
    if kind == "gen":
        return {"kind": "gen", "w": it["w"], "reason": it["reason"]}
    return {"kind": "conflict", "options": it["options"], "conflict_kind": it["kind"]}


def _item_problem(arr: str, it) -> str | None:
    """Reason this item breaks its kind's required shape, else None."""
    if not isinstance(it, dict):
        return "bad_item_shape"
    keys = set(it)
    if not keys <= _KEYS[arr]:
        return "bad_item_shape"  # extra fields, e.g. a norm carrying conflict fields
    required = _KEYS[arr] - ({"w"} if arr == "norms" else set())
    if not required <= keys:
        return "bad_item_shape"
    if not _is_int(it["pos"]) or it["pos"] < 0:
        return "bad_item_shape"
    if arr in ("copies", "norms") and not _refs_ok(it["refs"]):
        return "bad_item_shape"
    if arr == "norms":
        if it["rule"] not in RULES:
            return "bad_item_shape"
        if not isinstance(it.get("w"), str) or not it["w"].strip():
            return "norm_missing_w"
    if arr == "gens":
        if not isinstance(it["w"], str) or not it["w"].strip() or not isinstance(it["reason"], str):
            return "bad_item_shape"
    if arr == "conflicts":
        opts = it["options"]
        if not isinstance(it["kind"], str) or not isinstance(opts, list):
            return "bad_item_shape"
        if not all(isinstance(o, dict) and set(o) == {"refs"} and _refs_ok(o["refs"]) for o in opts):
            return "bad_item_shape"
        if len(opts) < 2:
            return "conflict_lt2"
    return None


def normalise_items(reply: dict) -> tuple[dict, list[dict], dict]:
    """(flat_response, pre_dropped, stats). flat_response = {native_items, en_clauses, entities} in the
    shape validator.validate_slice always consumed (native_items sorted by pos; clauses/entities carry
    indices into THAT list). pre_dropped = items dropped here, each {index: None, item, reason, clinical},
    to be counted by validate_slice exactly like validator drops (a dropped norm number_digits/
    lexicon_generic item is clinical). An entity/clause citing any pos that did not survive gets an empty
    index list, which V5/V6 drop as unlinked. stats = pos diagnostics for the RUN 3 report."""
    entries = []  # (pos, arr, item, position-in-array)
    pre_dropped = []
    stats = {"n_raw_items": 0, "dup_pos": 0, "pos_gaps": 0, "out_of_order": 0,
             "raw_by_kind": {}, "kept_by_kind": {}}

    def _drop(arr, it, reason):
        flat = _flat_item(arr, it) if isinstance(it, dict) and _safe_flat(arr, it) \
            else {"kind": _FLAT_KIND[arr], "raw": it}
        pre_dropped.append({"index": None, "item": flat, "reason": reason,
                            "clinical": _is_clinical_flat(flat)})

    pos_counts: dict[int, int] = {}
    for arr in NATIVE_KINDS:
        stats["raw_by_kind"][arr] = len(reply[arr])
        stats["n_raw_items"] += len(reply[arr])
        last = -1
        for pos_in_arr, it in enumerate(reply[arr]):
            if isinstance(it, dict) and _is_int(it.get("pos")) and it["pos"] >= 0:
                pos_counts[it["pos"]] = pos_counts.get(it["pos"], 0) + 1
                if it["pos"] < last:
                    stats["out_of_order"] += 1
                last = it["pos"]
    dup = {p for p, c in pos_counts.items() if c > 1}
    stats["dup_pos"] = len(dup)
    if pos_counts:
        stats["pos_gaps"] = len(set(range(max(pos_counts) + 1)) - set(pos_counts))

    for arr in NATIVE_KINDS:
        for pos_in_arr, it in enumerate(reply[arr]):
            if isinstance(it, dict) and _is_int(it.get("pos")) and it["pos"] in dup:
                _drop(arr, it, "dup_pos")
                continue
            problem = _item_problem(arr, it)
            if problem:
                _drop(arr, it, problem)
                continue
            entries.append((it["pos"], arr, it))
            stats["kept_by_kind"][arr] = stats["kept_by_kind"].get(arr, 0) + 1
    entries.sort(key=lambda e: e[0])
    pos_to_idx = {pos: i for i, (pos, _, _) in enumerate(entries)}
    native_items = [_flat_item(arr, it) for _, arr, it in entries]

    def _map(poss):
        if not isinstance(poss, list) or not poss or not all(_is_int(p) for p in poss):
            return []
        if any(p not in pos_to_idx for p in poss):
            return []
        return [pos_to_idx[p] for p in poss]

    stats["bad_clause_shape"] = 0
    stats["bad_entity_shape"] = 0
    en_clauses = []
    for cl in reply["en_clauses"]:
        if isinstance(cl, dict) and isinstance(cl.get("text"), str):
            en_clauses.append({"text": cl["text"], "native_idx": _map(cl.get("native_pos"))})
        else:
            stats["bad_clause_shape"] += 1
    entities = []
    for ent in reply["entities"]:
        if isinstance(ent, dict) and ent.get("kind") in ENTITY_KINDS and isinstance(ent.get("value"), str):
            entities.append({"kind": ent["kind"], "value": ent["value"], "unit": ent.get("unit"),
                             "native_items": _map(ent.get("native_pos"))})
        else:
            stats["bad_entity_shape"] += 1
    return {"native_items": native_items, "en_clauses": en_clauses, "entities": entities}, pre_dropped, stats


def _safe_flat(arr, it) -> bool:
    try:
        _flat_item(arr, it)
        return True
    except (KeyError, TypeError):
        return False


def _is_clinical_flat(flat: dict) -> bool:
    return flat.get("kind") == "norm" and flat.get("rule") in ("number_digits", "lexicon_generic")
