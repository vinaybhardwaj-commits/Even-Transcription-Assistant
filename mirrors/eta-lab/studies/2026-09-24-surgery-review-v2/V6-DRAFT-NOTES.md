# v6 wording DRAFT 1 — UNFROZEN (fleet, 24 Sep 2026)

Nothing frozen, nothing scored on a real set. Source: eta-refuter-2 #1075 findings F1-F4 on frozen v5 (4830ae152bf4) vs judge-K. The 40 judge-K items are NOT used to tune this (leakage); the draft is tried only on INVENTED fixtures (v6_trial.py, D1a-cleared, no patient text) and a later freeze is scored on a NEW fresh set.

| finding | change in draft 1 | fixture result (2 runs each) |
|---|---|---|
| F1 v5 answers imaging_ct on CT angiography while its own text says intervention | `intervention` now names CT angiography; `imaging_ct` excludes it | 2 of 2 angiogram fixtures: v5 imaging_ct, v6 intervention; 2 plain/contrast CT controls unchanged (imaging_ct) |
| F3 calcium-score CT read as a CT | one sentence added to named and described: a CT used only to count calcium is not a CT here | invented calcium-score consult: v5 named 0.41-0.42, v6 0.08 (described 0.06-0.11 both). The real J09 (v5 named 0.56) is NOT re-run |
| F4 mentioned_only 0/3; J12-type "done in this visit" reads already_done | NOT changed | invented fixtures do not reproduce either (v5 already gives proposed_now for a manoeuvre now, history for past operations, mentioned_only for a general explanation); an edit would be untested wording |
| F2 gate false holds | none | garbled / looped transcripts: a transcript-quality loss; the fix is a flag beside the hold (loop / garble), not a wording change |

Controls unchanged v5 to v6: conditional CT, general explanation, two history cases, plain and contrast CT.
Limits: 10 invented cases, 2 runs each; Jev is non-deterministic; only F1 and F3 are shown to move. Not shown: any effect on real consults, and no F4 evidence either way. Before a freeze: realistic fixtures for F4 (not the judge-K items), mutation-checked selftest, freeze record, eta-refuter-2 verifies the hash.
