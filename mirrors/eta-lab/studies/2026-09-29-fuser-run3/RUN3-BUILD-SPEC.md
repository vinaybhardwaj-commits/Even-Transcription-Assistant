# FUSER v1 RUN 3 — build spec (designer: lid-debug; builder: router-fix; reviewer: eta-refuter-2)
Fable GO 2026-09-29: RUN 3, option (c) of router-fix #5642. DEV phase; TEST unseen (no cw-* windows in REB, no TEST output anywhere).
This folder is the committed spec. The two design changes are the WITNESSED addenda, copied byte-for-byte:
- FUSER-V1-ADDENDUM-7-schema.md   sha256 prefix cb3faebbaf3e (witnessed #5663): per-kind response schema.
- FUSER-V1-ADDENDUM-6-V4-scope.md sha256 prefix f0f68b39a336 (witnessed #5647): V4 applies the p(en) gate only to English-decoded Whisper.
- B4-RUN2-FINDING.md              sha256 prefix 248ecf881e37 (confirmed #5647): the evidence for ADDENDUM-7.
If this file and an addendum ever disagree, the addendum wins; this file only orders the work and collects the review conditions.

## 1. Schema (ADDENDUM-7)
schema.py: replace ITEM_SCHEMA / SLICE_RESPONSE_SCHEMA with six arrays, every object closed (additionalProperties false) and every
property required:
  copies[{pos:int, refs:[str] minItems 1}]
  norms[{pos:int, refs:[str] minItems 1, w:str minLength 1, rule: number_digits|lexicon_generic|split}]
  gens[{pos:int, w:str minLength 1, reason:str}]
  conflicts[{pos:int, kind:str, options:[{refs:[str] minItems 1}] minItems 2}]
  en_clauses[{text:str, native_pos:[int]}]
  entities[{kind: drug|dose|freq|duration|dx|test, value:str, unit:str ("" if none), native_pos:[int]}]
check_shape(): whole-reply bad_shape ONLY if one of the six arrays is missing or not a list.
normalise_items(reply) -> today's flat native_items sorted by pos, so validator V1-V6 run unchanged. Per-ITEM drops, never whole-reply:
  norm_missing_w, bad_item_shape (missing required field / wrong type / extra field / wrong enum), dup_pos (drop EVERY item sharing a
  pos), conflict_lt2. Gaps in pos allowed. Entities/clauses resolve native_pos through the normalised list; unknown pos -> dropped (V5/V6).
Dropped-by-normalise items count in dropped_items like any validator drop (clinical ones count toward REPAIR/FALLBACK).

## 2. V4 scope (ADDENDUM-6)
Per cited Whisper token, by its own track and segment:
  whisper-forced-en, whisper-cap2           -> p(en) < 0.9 gate as today (numbers/units/lexicon drugs with an Indic anchor only).
  whisper-auto, segment extras.lid.detected == "en"  -> same gate.
  whisper-auto, segment extras.lid.detected != "en"  -> an Indic track: normal V1/V2/V3/V5, no p(en) gate.
  whisper-auto segment with no extras.lid   -> treat as "en" (gated): unknown is not evidence of Indic.
Latin tokens inside an Indic-detected whisper-auto segment (code-mixed English words) may be copied; clinical-class ones still need
V2/V5 backing like any track.

## 3. Prompt (wording only)
Describe the six arrays and that pos orders the native transcript; norm always carries w; an uncertain single reading -> copies
(verbatim) or omitted; conflicts need >= 2 options from different tokens/tracks. whisper-auto is multilingual: its per-segment
detected language is given; the "invents fluent English" warning applies to forced-en and cap2, and to whisper-auto only where it
detected English.

## 4. Call config
max_tokens 36000. Keep RESPONSE_FORMAT strict:true (now meaningful). Record route-reported strict/enforcement in each reply record.

## 5. Tests (must pass before review)
Schema/normaliser fixtures F1-F7 (ADDENDUM-7): F1 norm w/o w -> per-item drop; F2 norm with conflict fields -> bad_item_shape;
F3 duplicate pos -> all dropped; F4 conflict with 1 option -> conflict_lt2; F5 entity at unknown pos -> dropped; F6 round trip: a valid
reply normalises to exactly the hand-built flat items and V1-V6 outcomes are identical; F7 missing array -> bad_shape.
V4 fixtures (ADDENDUM-6): Indic-detected whisper-auto Devanagari copy passes; its digit goes through V2; forced-en token at low p(en)
without anchor rejected; en-detected whisper-auto token without anchor rejected; whisper-auto segment without extras.lid is gated.
All existing fuserv1 tests stay green.

## 6. Before the paid run (refuter-2 #5663)
ONE smoke call on a clinical1 window through the real OpenRouter -> Gemini route with the new RESPONSE_FORMAT. Record:
  (a) does the route ACCEPT the schema (additionalProperties/minLength/minItems are not uniformly supported); a rejected schema would
      make every slice a bad_reply, so if rejected: drop only the unsupported keywords, keep the six closed arrays, and say so;
  (b) does it ENFORCE (does a missing w or an extra field still come back?); if not, normalise_items is the real guard: say so;
  (c) finish_reason; (d) pos stats: duplicates, gaps, out-of-order across arrays.
Post the smoke result; RUN 3 starts only after refuter-2 has seen it.

## 7. The run
Same 222 DEV windows; shuffled catalog order (fixed seed, recorded); cost cap $14 with stop-and-post; running cost persisted across
resumes; own eval-out file b4-dev-run-3.jsonl; RUN 1/2 files and reports untouched; same reb pin a447dc36 and v0 c403e9b.

## 8. Report (B4-RUN3-REPORT.md)
(i) fused.v1 vs fused.v0 drug+dose item hit per language on clinical1 (S1 scorer at its current main sha; text_en and text_native),
    with paired-bootstrap CIs: the number that says whether v1 beats v0; pass/repair/fallback alone cannot (a fallback slice IS v0).
(ii) norm items emitted vs kept; drop reasons incl. the new per-item ones; pos stats.
(iii) whisper_low_pen_unanchored before/after, split by track and by detected language.
(iv) pass/repair/fallback per language/condition vs RUN 1/2; latency; finish_reason; cost with/without length-hits.
(v) Declared: 5 changes bundled (schema, V4, prompt wording, max_tokens, shuffle) -> no per-change attribution.
Then: re-freeze (dated addendum naming the code sha), and only then the 24-consult TEST ingest + run.
