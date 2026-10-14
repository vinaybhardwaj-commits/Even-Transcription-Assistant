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
