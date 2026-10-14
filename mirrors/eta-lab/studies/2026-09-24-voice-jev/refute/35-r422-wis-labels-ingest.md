# 35. Ruling 422: "Who is speaking" labels (rater V) ingested into the VJ seal. vj-refuter, 26 Sep ~05:10 box clock
No label counts or content here, by design.

## Received and verified
- Received: ~/eta-data/vj-truth-sealed/incoming/wis-labels-V-20260926.json, placed by Fable (artifact labels doc, schema 1, doc version 261).
- File: 12,365 B, mode 600 in 700 dirs, sha256 45c08626bb5b2ff6... It equals the value Fable gave for source, transit and box.
- Structure: {rater, schema, t, updated}. 110 turn entries keyed by 8-char page ids.

## Reconciliation (ids only)
- 90 ids = the main page key ~/eta-data/who-is-speaking/key.json (the #930 90-identity seed), all answered.
- 20 ids = the top-up key ~/eta-data/who-is-speaking-topup/key.json (ruling 241 top-up, built 24 Sep 22:04, checked by me then), all answered.
- 0 ids in neither, and the two keys do not overlap. So 110 = 90 + 20.

## Sealed
- Written: ~/eta-data/vj-truth-sealed/wis-labels-V-20260926.json.gpg (AES256, the same seal key, 2,513 B, sha256 a48c00b2a0d09ba4...).
- A decrypt round-trip gives plaintext sha 45c08626..., so it is OK.
- Recorded in ~/eta-data/vj-truth-sealed/INGEST-MANIFEST.txt (hashes, source, time; no content).
- The plaintext in incoming/ was removed after a second round-trip check, so no plaintext is at rest. incoming/ is empty.
- Mirror: the new .gpg + INGEST-MANIFEST.txt go to /Volumes/Air Drive/gcp-archive/_vj-truth-sealed/, as r413.4(a) (lab-mover asked).

## Deny check for vj-arms / vj-link (live configs f70a04548251 / 2663b1d45c4c, reloaded under item 77)
- read and external_directory deny "/home/eta/eta-data/vj-truth-sealed/*"; bash denies "*vj-truth-sealed*", "*.claude*" and "*secrets-archive*"; the key under ~/.claude is denied.
- I could NOT confirm from the compiled binary whether the read glob "/*" also matches NESTED paths (incoming/<file>).
- There is no exposure today: incoming/ is empty and every other file is ciphertext.
- For future plaintext deliveries into incoming/, I recommend that the config owner (herdr-kit, item 77) add "/home/eta/eta-data/vj-truth-sealed/**" and "*vj-truth-sealed*" to read and external_directory.
- Until then, I ingest each delivery at once, so plaintext does not sit in incoming/.
- Mirror CONFIRMED (lab-mover #3273): Mini-side sha of wis-labels-V-20260926.json.gpg (a48c00b2...) and INGEST-MANIFEST.txt (28b749f6..., 264 B) equal the box files. incoming/ was not mirrored.

## Page-item to turn_id mapping rule, fixed BEFORE any label value is read (26 Sep ~06:20)
Found using the keys and turn_index.json only (label-free): 97 of 110 items match exactly one turn; 9 match two turn_ids for the same span; 4 match none.
1. Exact match (window_id equal; |s-s'| and |e-e'| < 0.25 s): use that turn_id.
2. Several exact matches (the same span exists as W58 + SC30, or twice in SC30): per the refute/22 addendum, use the SC30-context turn_id that the arm run used, i.e. the one present in the arm 2/3/4 outputs. If more than one is present, take the SC30 id with the lowest lexical turn_id and report it.
3. No exact match (SC30 turns clipped at the excerpt start or split by diarization): map to the turn in the same window with MUTUAL overlap >= 50%, i.e. the overlap is >= 50% of the arm turn AND >= 50% of the page span. If no single turn meets that, the item is EXCLUDED and reported (count only). No splitting of one label across sub-turns.
4. Each page label gives at most one truth row. A turn labelled by several sources keeps its highest-priority source (COMBINE_RULE D5: who_is_speaking is lowest).

## Mapping applied (ids only) and arm coverage
- Result: 97 exact, 9 multi resolved to the SC30 id the arms used, 3 by mutual overlap >= 50%, and 1 EXCLUDED (a top-up item whose span covers two SC30 sub-turns, neither >= 50% of the span). That gives 109 page items mapped to 109 distinct turn_ids.
- Coverage: arm 1 covers 109/109. Arms 2/3/4 cover the 90 main-page turns and 0 of the 19 mapped top-up turns (ruling 241, all CONFIDENT under arm 1). They were never carded, clipped or listed in a confident-ids file.
- Consequence: before the final scoring, vj-data must card and clip the 19 (J-card A), and vj-arms must then run arms 2/3 on them as the R6 confident sample (J-card B). Arm 4 on them needs Fable's Vertex decision. Posted as #3287 (ids only).

## Fable 425.5: arm 4 on the 19 top-up turns with V's Vertex creds, conditions (#3339)
- The original arm-4 rows (1,767 l1 + 71 l2) all record model "gemini-3.8-flash" with no resolved version stored, and prompt_sha 9d155a2ffe3c3106....
- The new run must:
  - pin a NAMED version and store the response modelVersion per row (the original-vs-new version difference is reported as a caveat);
  - use the same prompt_sha, temperature 0, l1 only and the same clip cutting;
  - run the 19 ids via --turn-ids + the confident-ids file;
  - resume append-only, with the first 1,838 rows hash-identical;
  - keep the creds out of logs and argv.
- Condition 1 AMENDED (after vj-arms #3340-reply):
  - A pinned, versioned --model recorded per row by the frozen runner suffices. The response modelVersion is not stored, since that would need a code edit.
  - If Vertex refuses the versioned id, the run stops, with no alias fallback.
  - Auth is via a token-only gcloud shim (#3340), with zero arm-code change.
  - Reported caveat: the original = alias, the new = pinned version.

## J-005 (vj-data) check: PASS (handoff at 05:46 box)
- arm1_in 7f0af18f28b0 is unchanged.
- cards 467560040b5a and clips d95dc0b751ec: +20 rows, 0 old rows changed.
- topup_confident_ids 4403f96adc28 (20); confident_labelled_ids 0b04566706f3 (42).
- The cards use the frozen line structure, with raw_text and no tier or truth words. Clips: 4 of 4 re-cut byte-identical.
- The 20th id, t12cca6639e, is the sub-turn of my EXCLUDED page item. It is carded but gets no truth row and is not scored.
- J-006: arms 2/3 on the 20 via --turn-ids topup_confident_ids.txt.

## J-006 (vj-arms, arms 2/3 on the 20 top-up turns): PASS
- arm2 and arm3 are now 1,787 rows each. The 1,767-row prefix hashes 554d07a0045f / eef524e54664 equal the original witnesses.
- Full sha: arm2 bb7da6c4c3fc..., arm3 a2ace59ad657....
- The 20 new rows per arm are exactly the top-up ids: no errors, freeze stamp present, q1 present, model jev-1.13.0.
- Arm 4 waits (shim + version).
- vj-arms MANIFEST.sha256 appended: the first 2,436 lines are byte-identical to MANIFEST.sha256.preJ006 (165eaea8913a); +6 lines; new d90692a6cd17. Its header cites "#3362" (my mistaken hsend id); the actual J-006 PASS is bus #3364.
