# B4 RUN 2 root cause (lid-debug, 2026-09-28, read-only analysis of eval-out/b4-dev-run{,-2}.jsonl + schema.py @ce91eb1)

## Finding: it is the RESPONSE SCHEMA, not model guessing
- number_digits_value_mismatch: RUN 1 67/67 and RUN 2 90/90 dropped items have NO "w" (w missing). Zero cases of a present-but-wrong digit.
- lexicon_generic_no_two_witness_backing: RUN 2 66/66 have no "w" (RUN 1: 50/54).
- All norm items emitted in RUN 2 (kept + dropped): only 3 have the correct shape {kind, refs, rule, w}. The rest carry CONFLICT fields:
  {conflict_kind, options, reason, refs, rule} 82; {conflict_kind, options, refs, rule} 51; {conflict_kind, refs, rule} 8; ...
- Where the source is readable: kn/te/ta sources are English numbers in Kannada/Telugu/Tamil script (ಫಿಫ್ಟಿ, ఫోర్టీ, டூ), which the parser
  does not read either (declared v1 scope) -- a second, smaller reason those rows can never validate.
So the B4-RUN2-REPORT mechanism ("more confident wrong guesses now that w is mandatory") is not supported by the data: the model keeps
emitting a norm/conflict hybrid with no value, exactly as in RUN 1, and more often.

## Why: schema.py NATIVE_ITEM is one flat object, required = ["kind"] only
w, rule, options, conflict_kind are all optional siblings, so Gemini's constrained decoding happily produces kind="norm" with conflict
fields and no w. Prompt text cannot enforce a field the schema marks optional.

## Fix (schema, per kind, required fields enforced at generation time)
Make each native item an object with exactly one of four sub-objects, each with its own required fields:
  {"copy": {"refs": [...]}} | {"norm": {"refs": [...], "w": "...", "rule": "number_digits|lexicon_generic|split"}}
  | {"gen": {"w": "...", "reason": "..."}} | {"conflict": {"options": [{"refs": [...]}, ...] (minItems 2), "kind": "..."}}
(or anyOf over four typed objects if the route supports anyOf; the wrapper form works with plain object/required support).
check_shape: exactly one sub-object present; per-item failures still go to the validator's per-item drop (not whole-reply rejection),
so router-fix's graceful-degradation concern holds: normalise to today's flat item before validate_items.
Add an uncertainty path so the model isn't pushed into a fake conflict: prompt already says "uncertain single reading -> copy"; keep it.

## Proposal: ONE RUN 3, all pending DEV changes together, then freeze
1 schema per-kind (above) + fixtures (norm without w rejected per item; norm with conflict fields rejected).
2 ADDENDUM-6 (V4 scope, sha f0f68b39a336): whisper-auto segments detected Indic = Indic track; p(en) gate for forced-en/cap2/auto-en.
3 max_tokens 36000 (router-fix's proposal).
4 Shuffled catalog order; persisted running cost.
5 REPORT fused.v1 vs fused.v0 drug+dose item hit per language on clinical1 (S1 scorer) -- still missing from both reports; pass/repair/
  fallback cannot say whether v1 beats v0 (a fallback slice IS v0).
