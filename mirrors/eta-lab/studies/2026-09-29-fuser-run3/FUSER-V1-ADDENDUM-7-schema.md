# FUSER v1 — ADDENDUM 7: per-kind response schema for RUN 3 (dated 2026-09-29, lid-debug, designer). DRAFT until eta-refuter-2 witnesses.
Changes design §3 output format (DEV phase; TEST unseen). Evidence: B4-RUN2-FINDING.md 248ecf881e37, confirmed by refuter-2 #5647.
Applies only if Fable gives the named RUN 3 GO (router-fix #5642 option (c)).

## Problem (schema.py @ce91eb1)
ITEM_SCHEMA is one flat object, required=["kind"]; w/rule/reason/options/conflict_kind are optional siblings. The model mixes kinds
(norm items with conflict_kind/options and no w: RUN 2 only 3 clean norm items). RESPONSE_FORMAT also sets "strict": true, which
cannot constrain anything useful while every field but kind is optional and additionalProperties is unset.

## New response shape (no oneOf/anyOf: homogeneous arrays, every field required, closed objects)
SLICE_RESPONSE = {
  "copies":    [ {"pos": int, "refs": [str, >=1]} ],
  "norms":     [ {"pos": int, "refs": [str, >=1], "w": str (minLength 1), "rule": "number_digits"|"lexicon_generic"|"split"} ],
  "gens":      [ {"pos": int, "w": str (minLength 1), "reason": str} ],
  "conflicts": [ {"pos": int, "kind": str, "options": [ {"refs": [str, >=1]} ] (minItems 2)} ],
  "en_clauses":[ {"text": str, "native_pos": [int]} ],
  "entities":  [ {"kind": "drug"|"dose"|"freq"|"duration"|"dx"|"test", "value": str, "unit": str ("" if none), "native_pos": [int]} ]
}
Every object: all listed properties in "required", "additionalProperties": false. Top level: all six arrays required (may be empty).
"pos" = the item's position in the native sequence (0-based). Entities and clauses cite pos, not array indices.

## Code (schema.py + one normaliser; validator V1-V6 unchanged)
1 check_shape: the six arrays exist and are lists -> else whole-reply bad_shape (as today). Nothing per-item here.
2 normalise_items(reply) -> today's flat list sorted by pos: {kind:"copy",refs} / {kind:"norm",refs,w,rule} / {kind:"gen",w,reason} /
  {kind:"conflict",options,conflict_kind:<kind>}. Per-item, NOT whole-reply: an item that breaks its kind's required fields (API didn't
  enforce), a duplicate pos (drop ALL items sharing it), a conflict with < 2 options, or extra fields -> dropped with its own reason
  (norm_missing_w, dup_pos, conflict_lt2, bad_item_shape) and counted in dropped_items; clinical ones still count toward REPAIR/FALLBACK.
  Gaps in pos are allowed (materialise in pos order).
3 Entities/clauses: native_pos resolved through the normalised list; an unknown pos -> that entity/clause dropped (V5/V6 as today).
4 RESPONSE_FORMAT strict:true is now meaningful; keep it. gemini_call records whether the route reported strict enforcement.

## Prompt (to match; wording change only)
Describe the six arrays and that pos orders the native transcript. Keep the rules: uncertain single reading -> copies (verbatim) or omit;
conflicts need two options from different tokens/tracks; norm always carries w. Plus ADDENDUM-6's whisper-auto wording.

## Fixtures (builder adds; refuter-2 reviews before RUN 3, per #5647)
F1 norm without w -> per-item drop norm_missing_w; rest of the reply kept.  F2 norm carrying conflict fields -> bad_item_shape.
F3 two items with the same pos -> both dropped dup_pos.  F4 conflict with 1 option -> conflict_lt2.  F5 entity citing unknown pos ->
entity dropped.  F6 round trip: a valid reply normalises to exactly today's flat items (V1-V6 outcomes unchanged vs a hand-built flat
equivalent).  F7 check_shape rejects a reply missing any of the six arrays.

## RUN 3 = this + ADDENDUM-6 + max_tokens 36000 + shuffled catalog + persisted running cost
Report adds: (i) v1 vs v0 drug+dose item hit per language on clinical1 (S1 scorer, text_en and text_native); (ii) norm items emitted vs
kept, and drop reasons incl. the new per-item ones; (iii) note that 5 changes are bundled, so no per-change attribution (refuter-2 #5647).
