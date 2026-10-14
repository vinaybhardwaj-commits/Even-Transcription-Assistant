# v5 / v6 freeze plan — DRAFT for the daylight decision (ruling 293). fleet, 25 Sep 2026, ~03:30 IST. No Jev call made; nothing frozen.

## Where things stand (all ids/counts, from the notes and bus)
- v5 frozen: hash 4830ae152bf4 (u9-v5.0). The live page and V's ratings are v4 (ruling 293: they stand). v5 values exist only on the 9-item rater set (pre-rule de-id runs; covered by the ruling-42 records).
- v6 draft 1 (v6_draft.py, UNFROZEN): F1 (CT angiography -> intervention) and F3 (calcium-score CT out), tried on 10 invented cases x 2 runs; F4/F5/F6 not changed (need realistic invented fixtures).
- Accuracy of v5 on truly fresh blind-labelled items: judge-K 32 (or 31 without J37) + judge-L 15: proposed_now predicted 11, 5 agree, label 12, found 5; conditional predicted 3, 2 agree, label 5, found 2; already_done predicted 4, 3 agree, label 8, found 3; gate held 6 of 6 staff items and 3-4 of the ~40 consults (garbled/looped; 0 of 11 on judge-L). These 47 are now DEVELOPMENT data (they drove F1-F6).
- Surgery text for any future Jev call: only the 84 regenerated files (final-v5fresh 56 / final-v5delta 15 / final-v5rater 13), frozen deid.py sha, cap rule on; deid_gate.require refuses everything else. Real tag rate 475 = 18.4 per 1000 turns.

## Decisions for Fable (daylight)
1. Re-score v5 on the regenerated text? What it would measure: how much the cap-rule text changes Jev's outputs on items already scored (47 dev items + the 9-item set), NOT accuracy. Cost: NOT measured (stage a is one call, passing items add stage b, detail questions and evidence probes; the run record of an earlier run would give the real count). Needs an order (ruling 293). Recommendation: yes for the 9-item set only (so the rater page's v5 values come from the gated text), skip the dev items.
2. Freeze v6? Only F1/F3 are supported (fixtures). A freeze needs a NEW fresh set scored once: ≥ 30 blind-labelled items with ≥ 8 proposals, none of them among the 47 + shipped 24 (content check `fresh_overlap.py --shipped-full` against ALL of them), labels locked by eta-refuter-2 before any Jev output is opened, per-class counts with n in every cell, through deid_gate.
3. Candidate sources for that set (none scored): 25 Sep windows with booked-procedure anchors as the transcripts land; Tier A/B stage-1 items after the production-path re-transcription (H01-H05 is the FINAL anchored list after Tier A+B, hist-miner #1631; H04 is the Dietary Room and out); the 63 CT-rescan candidates out of 4,295 real-input windows (49 English-dominant, the known parity miss) after re-transcription. Expect the same low yield of proposals as the content-placed pool (2 of 15 in judge-L).
4. F4/F5/F6 (status wording: done-in-visit; false proposed_now on named-not-described mentions; proposals described without naming): write realistic INVENTED fixtures first (D1a-cleared), then a draft 2. Not before the freeze decision.

## What I do not do without an order
No re-score, no new real-text scoring, no publish. The 9-item rater set page (r254/r282) waits on the human listen at the 10 clips on the Mini.
