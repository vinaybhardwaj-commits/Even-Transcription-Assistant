# vj-refuter: usable truth n by source x class (ruling 188 sizing input), counted INSIDE /srv/vj-truth as vjscore (refute/truth_counts.py, counts only)

Mapping rule: a truth clip maps to the production turn with the largest overlap if that is >= 50% of the clip (v5: sum of its segments). Turns hit twice are counted once. Class comes from classification186.json (19:3x, includes VP and E3).
- My independent 186 recompute still agrees: 3,868 of 3,869 (the same single best = 0.5 rounding edge). VP adds 494 confident turns.

| source | doubtful doctor | doubtful not-doctor | confident doctor | confident not-doctor | unmapped |
|---|---|---|---|---|---|
| V-pilot "me" (vp_truth_me) | 40 | 0 | 27 | 0 | 18 |
| E-3 ruling 197(c) | 8 | 3 | 0 | 0 | 40 (4 windows without production rows) |
| total | 48 | 3 | 27 | 0 | |

Against ruling 188 (>= 60 labelled doubtful, >= 30 labelled confident):
- Doubtful: 51, a shortfall of 9. But 48/51 are DOCTOR (see the class-balance flag in refute/17).
- Confident: 27, a shortfall of 3 (all doctor, which is structural under 186). After rater exclusions on the page, plan for more than 3.
- vj-data's vpilot_mapping.json agrees on the confident clips: v2 11 + v3 16 = 27 mapped confident clips (all answers), so every confident-mapped pilot clip was a "me".
- Recommendation for the page size (Fable's call): confident items >= 10 (for a 30+ labelled F4 base after exclusions), and doubtful items sized for >= 30 labelled NOT-doctor turns. Arm 1's empty-role rate says most doubtful items will be patients, companions or staff, so ~60-80 doubtful items should yield it.
- 46 not_me answers remain HELD pending Fable. If ruled usable on single-doctor room-days, they would add not-doctor doubtful truth.

## Selection re-check (selection.json regenerated 19:4x box clock)
- 140 items = 110 doubtful (SC30 82, V5 28) + 30 confident (all SC30). The W58 items were removed, which resolves my N2 for the page.
- Dedupe: 0 selected items are V-labelled turns, 0 are in E-3 windows, 0 are in VP windows. The page pool (SC30 + V5) is disjoint from both label sources, so the "dedupe NOT applied" note is moot for this selection. Blinding OK (no label fields).
- Still a fixed 110 + 30. Ruling 188's sizing is pending Fable (my refute/18 counts are the input).
- 186 recompute still agrees (3,868/3,869).
- OPEN: the Salanki profile LEAK (refute/17) is NOT fixed. rd_np5wt5tw is still a profile room-day and not in test_room_days, and its 7 windows are still in VP. It bites when cards are rendered for VP labelled turns: the arms need cards for the 67 V-pilot truth turns, and some are in those windows.

## UPDATE 21:4x: the VP pyannote counts landed and VP confident fell 494 -> 131 (my upper-bound warning came true)
- Usable truth now (inside /srv/vj-truth): DOUBTFUL 88 = doctor 63 (V-pilot me 55 + E-3 8) + not-doctor 25 (voice-verified 22 + E-3 3). CONFIDENT 12 = V-pilot me 12 (15 of the 27 flipped to doubtful).
- F4 base: 12 + the page's 10 confident items (SC30, still confident) = at most 22 before rater losses, below ruling 169's >= 30. F4 is INSUFFICIENT, so no arm can be adopted, only continued.
- Remedy (Fable's call, before the 23:30 publish): add >= 15 confident items to the page. SC30 has 20 unused confident turns (30 total, 10 on the page), and the VP windows have 131 confident turns (minus the 12 labelled).
- STALE INPUT: ~/vj/arms/inputs/arm1_in.jsonl (16:12 UTC) carries doubtful flags from the previous classification. The combine rule (R1: confident -> arm 1) reads that flag, so the hand-off (arm1_in) must be regenerated from the new classification186 before scoring. The truth turns that flipped are all carded (C4 cards every label-mapped turn regardless of class).
- The page seed is unaffected: the regenerated selection is identical to the seed (90 = 90).

## vj-data alt60 selection (prepared, NOT installed; Fable's call): pre-verified PASS
- 60 unique items = 30 confident (ALL 30 SC30 confident turns: OPD 3 Banerjee 19 + OPD 5 Salanki 11) + 30 doubtful (production role: clinician 10 / empty 20). Classes match classification186; 0 overlap with labelled turns; the identities file carries window_id/s/e only. Blind.
- It gives F4 a base of 12 + 30 = 42 (>= 30 with a buffer), vs <= 22 with the installed 90-set.
- Trade-off: the page's doubtful EMPTY-role items are the main source of NOT-doctor labels (only 25 not-doctor doubtful truth exist now). alt60 has 20 of them vs 50 in the 90-set.
- Suggested middle (Fable): keep 90 items = 30 confident (all SC30) + 60 doubtful (20 clinician / 40 empty). F4 >= 42 AND ~40 not-doctor candidates.
- The default 90-item selection still equals the seed. If either alternative is chosen, surg-page re-seeds and I re-run check_seed + the seed/selection identity check.
- vj-data top-up (selection_topup_confident20_identities.json): PASS. 20 items (window_id/s/e only), 0 overlap with the current seed or labelled turns. Together with the seed's 10 they are exactly the 30 SC30 confident turns. 3 items straddle an excerpt edge (sc30-06, sc30-19): the classification clips them to the excerpt (285.0 vs the true start 283.94), and the top-up correctly uses the full turn. Their class (confident) is from the excerpt context. If Fable installs it (seed 90 + 20 = 110), surg-page re-seeds and I re-check.
- vj-arms (#1130): arms 2/3 current on the 21:49 hand-off (1,723 cards, 12,861 doubtful arm1 rows, confident_labelled 22). Arm 4 is running. The scorer now counts only the last row per turn on CURRENT cards (stale rows excluded from cost, missing and scoring), which resolves my #1114.
