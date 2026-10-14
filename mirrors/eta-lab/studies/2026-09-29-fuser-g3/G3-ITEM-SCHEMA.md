# G3 blinded dose-audit: item schema and builder contract (lid-debug, 2026-09-29; Fable T-FUSER-4 #6948)
Governing records: ADDENDUM-5 b572a95c1cca (rater V, item rules), ADDENDUM-9 r3 7415bf80626b (pair = v1 vs production P if Fable rules
so, else v1 vs v0; strings from each system's NATIVE text via ONE shared extractor; TEST n = 23), refuter-2 #5655 (a)-(d), #5826,
lab-viewer loader g3_seed.py @ f787c273 (field whitelist). Items are built ONLY from frozen TEST output (T-FUSER-4); never from DEV.

## items.json (what the page and loader see) — a JSON list, shuffled order
  {"item_id": "g3i_<8 hex>", "consult_id": "<cap consult id>", "span": {"t0_ms": int, "t1_ms": int}, "audio_key": "audio/<item_id>.m4a",
   "A": "<drug> <dose> <unit>" | "<drug>" | "(nothing)", "B": same}
  No other fields (the loader aborts on extras). item_id carries no system or consult information (random).

## key.json (box-only, 0600, never uploaded; opened only after the run is closed)
  {"run_id", "items_sha256", "seed_note": "os.urandom, not stored", "created", "systems": {"v1": {...source sha...}, "cmp": {...}},
   "items": {item_id: {"A": "v1"|"cmp", "B": "v1"|"cmp", "rx_item_id": str|null, "kind": "rx"|"unlinked",
             "v1": {"generic", "dose_value", "unit", "t0_ms", "t1_ms"}|null, "cmp": {...}|null}}}

## Canonical rendering (identical code path for both sides; refuter-2 (a))
  generic: lexicon canonical name, lowercase, single spaces.  dose: integer if whole, else minimal decimal ("0.5"); no thousands separator.
  unit: one of mg, mcg, g, ml, iu, units, "" (mapped from spoken/written forms).  "<generic> <dose> <unit>" trimmed; drug with no dose ->
  "<generic>"; nothing rendered -> "(nothing)". ASCII only.

## Item set
  (i) every Rx drug item of the consult (cap items.jsonl cls=drug) rendered by >= 1 system (matched by generic);
  (ii) every drug rendered by either system with no Rx link (the fabrication surface), one item per (consult, generic).
  Rx drugs rendered by neither system: not shown; counted (missing for both) in the build report.

## Span / clip
  union of both systems' cited times for that drug in that consult, +- 10 s, clipped to [0, consult duration]; cut from the consult audio,
  loudness-normalised (ffmpeg loudnorm), metadata stripped (-map_metadata -1), AAC m4a. Consult-relative times; no absolute times.

## Randomisation
  A/B side per item from secrets (not seeded, not reproducible by anyone who sees items.json); order shuffled with secrets. The mapping lives
  only in key.json. Build report prints the A=v1 share (expect ~0.5) and a per-consult side check (no consult all-A).

## Extractor (OPEN: to be frozen before TEST, refuter-2 witness)
  One extractor applied to both systems' native text. The builder takes it as a plugin. Candidates: (1) cap's S2 matcher (the captured_pct
  scorer), extended to return spans; (2) the reference extractor in g3_build.py (exact lexicon match on Latin words + optional native-script
  drug matcher; digits and English-by-ear numbers with a unit cue). Recommendation: (1), so G3 and S2 agree on what counts as a rendered
  drug; (2) is the fallback and is what the tests exercise.
