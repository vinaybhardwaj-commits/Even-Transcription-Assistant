# Refute: vj-data cards.py (rewritten for 186/205), code review BEFORE any render (no cards exist yet)

## PASS
- Leak: the retired 165 profiles are not read. "Usual" comes from desc/profile.json, which the local copy and voice-lab-1 both show without Salanki and with 0 gt2crzyp windows.
- Blinding: reads no truth, key.json or human counts. vpilot_mapping.json is identities only.
- De-id: transcript text goes through surgery-review-v2 deid.py, fail-closed, before it enters a card. Doctors are aliased Dr A/B/C.
- Confident sample = the 10 confident page items + the confident V-pilot turns (rulings 169/188/206).
- Q1-Q3 are taken verbatim from arms/freeze.txt (sha b961291ae64c); THIS TURN carries no speaker label.

## Defects (fix before render)
- C1 ARM 2 RAW VARIANT does not match the frozen text (decides arm 2's result).
  - Frozen: "the turn's raw speaker-embedding vector ... and the same-length centroid vector of EACH candidate".
  - Code: only the verified doctor's print plus the single top other cluster. card_raw = None whenever the room-day has no verified doctor, which is most doubtful turns.
  - Arm 2 then has no input on those turns: a failed/missing call = UNSURE = wrong. It loses by construction, not on merit.
  - Fix: include the turn vector and every window cluster centroid (plus the verified print when one exists), for every card.
- C2 FROZEN WORDING: "Voice match: best candidate <Dr X / speaker cluster> <score>; runner-up <candidate> <score>; margin <m>."
  - The code adds parentheticals ("(verified voice print, this turn vs Dr A)", "(best other speaker cluster or other doctor's print)"), and the runner-up names no candidate.
  - Any wording change is a new run under the order. Fill the placeholders only: runner-up = "speaker cluster k" or "Dr B".
  - Explanatory reasons after "not available" are also extra words. The template says "say 'not available'". Fable may accept these as fills, but it must be ruled.
- C3 Kannada/Hindi: deid.py omits Indic-script fields (fail-closed), so "English alongside Kannada/Hindi where available" is never available. Defensible for PHI, but it is a systematic loss of evidence. Report the count (cards_counts has a field for it) and have Fable accept it explicitly.
- Note: neighbour labels "Doctor (production voiceprint)" expose production's attribution of the PREVIOUS/NEXT turns. The frozen "<speaker label>" permits this and it is evidence arm 3 may use, but it means arm 3 is partly conditioned on arm 1. Report it in the arm 3 write-up.

## Descriptor sanity (Phase 3: spot-check 5 pitch values): PASS
- Method: 5 random test turns >= 2 s (seed 24092026) from desc/test.json. Pitch re-estimated with librosa pYIN (75-500 Hz), a different algorithm from vj-data's Praat autocorrelation. Compared the 10th/50th/90th percentiles. Plot: refute/pitch_spotcheck.png (pYIN contour vs Praat median and 10-90% band).

| turn | dur s | Praat 10/50/90 Hz | pYIN 10/50/90 Hz | median ratio |
|---|---|---|---|---|
| 1 | 3.6 | 98/116/180 | 92/115/178 | 0.99 |
| 2 | 2.4 | 107/128/170 | 75/132/171 | 1.03 |
| 3 | 3.0 | 76/87/111 | 76/80/110 | 0.92 |
| 4 | 2.4 | 119/130/150 | 120/133/156 | 1.02 |
| 5 | 2.0 | 173/181/214 | 174/181/212 | 1.00 |

- Medians agree within 8%, with no octave errors. Turn 2's 10th percentile differs (107 vs 75): pYIN hits its 75 Hz floor on creaky low frames. The card's "range" line uses 10-90%, so low-end jitter of this kind is expected and does not change the reading.
- 20:45 cards.py re-check: C1 (arm 2 raw variant: doctor print + 1 cluster; None without a verified doctor, lines 115-120) and C2 (parenthetical Voice match wording, unnamed runner-up, line 94) are STILL OPEN after the latest edit. Cards must not be rendered for arm runs until fixed.

## Cards RENDERED 20:49 (cards_counts.json) with C1/C2 still open: NOT VALID FOR ARM RUNS
- n_cards 1,612 = doubtful 1,575 (V5 1,006 + SC30 579) + confident 37 (10 page + 27 VP).
- C1 CONFIRMED on the render: doubtful raw_missing 1,397 of 1,575 (89%). Arm 2 would be UNSURE/wrong on 89% of doubtful turns by construction. voice_match_missing = 1,397 on the arm 3 cards too.
- C4 (NEW, coverage): no doubtful cards exist for the VP or E3 sets. The usable DOUBTFUL truth (73 = V-pilot me 40 + voice-verified not-doctor 22 + E-3 11) sits in VP/E3 windows. Every arm would have NO answer on the labelled doubtful turns outside the page's 80 and score them UNSURE = wrong.
  - Blind-safe fix: render cards (and the raw variant) for every production turn that labelled_v2v3.json / labelled_v4v5.json map to (130 turns, answers unseen) and every turn the E-3 identities map to (refute/e3_identities.json, 13 turns). That needs no label knowledge.
- C2 still open (line 94 wording).
- this_turn_transcript_missing_or_omitted 254 (Indic omitted by de-id or no text): report with C3.

## handoff.py (vj-data -> vj-arms/vj-refuter) review
- OK: arm1_in = every pool turn >= 0.8 s over V5/SC30/VP/E3/W58 (consistent with the ruling-215 all_pool weights). turn_id = sha1(window|s|e)[:10], and turn_index.json maps ids to times with no text; I will use it to key the truth at scoring.
- OK (blinding): SC30 cw ids are matched to sc30-NN by the sha256 of the public mp3 vs the staff mp3. key.json is not read, the id mapping is not truth, and human counts stay in /srv/vj-truth.
- NOT OK: the docstring makes C1 a design choice: "raw_text (arm 2; only where a verified voice print exists)". That contradicts the frozen arm 2 prompt ("the same-length centroid vector of EACH candidate"), which does not depend on a verified print. Every card needs a raw variant with the turn vector + all window cluster centroids.
- NOT OK: C4. cards.jsonl (and so the hand-off) has no doubtful cards for VP/E3, where the usable doubtful truth sits.
- The hand-off must not go to arm runs until C1/C2/C4 are fixed and re-rendered.

## Rulings 223 + 224 (21:05) -> what I check on the next render
- 224: C1 + C2 fixed before any render; vj-arms waits. C4 (no doubtful cards for the VP/E3 labelled turns) is NOT named in 224. Asked Fable to add it: without it, every arm scores the 73 labelled doubtful truth turns as wrong.
- 223 check list for the re-render:
  (a) no raw Indic-script characters anywhere in card_text or raw_text (Devanagari U+0900-097F, Kannada U+0C80-0CFF);
  (b) every turn whose de-id text is empty/omitted shows exactly "Hindi/Kannada/other speech: listen to the audio" (254 cards in the 20:49 render);
  (c) once ruling 222's MT exists, those lines show the de-identified English, labelled "machine translation".
- My acceptance test for the re-render: raw variant present on 100% of cards (turn vector + all window cluster centroids); frozen Voice match line matches the template regex; VP/E3 labelled turns carded; (a)/(b) above; the retired profiles not read.

## Re-render 21:22 (1,690 cards): acceptance test (my own checks on cards.jsonl, counts only)
- C1 FIXED: raw variant on 1,690/1,690 cards, each with >= 1 candidate centroid (the verified print where present plus EVERY window cluster centroid).
- C2 FIXED: the "Voice match" line matches the frozen template on 1,690/1,690 (my regex). vj-data's own self-check reports 0 because its regex over-escapes the full stop ("\\." inside an r-string). The cards are right; the check is wrong.
- Template field order: correct on 1,690/1,690. The Q1-Q3 block is present on all.
- 223 PASS: 0 Devanagari/Kannada characters in any card or raw text. The 279 THIS TURN "not available" lines are ALL turns with no production transcript at all (none emptied by de-id), so no "listen to the audio" line was needed.
- C4 MOSTLY FIXED: 93 VP + 12 E3 cards added. Coverage of the USABLE truth (counted inside /srv/vj-truth, refute/cov.py): 86 of 100 carded.
  - Uncarded: 14 (E-3 doctor 1, V-pilot me doctor 6, voice-verified NOT-doctor 7), ALL longer than 30 s. vj-data's unratified 30 s cap drops them, costing 7 of the 25 scarce not-doctor doubtful truth turns.
  - Fix: drop the 30 s cap in cardset (c) for label-mapped turns (the card text is already truncated at 700 chars). Then re-render.
- Verdict: the cards are ACCEPTABLE for arm runs on the 86 carded truth turns and the page items. The 14 > 30 s labelled turns should be carded first (or scored as missing and reported as a coverage loss).
