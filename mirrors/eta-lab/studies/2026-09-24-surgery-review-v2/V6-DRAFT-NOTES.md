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

## Findings from the two fresh sets (added 24 Sep, late) — v6 candidates, NOT applied
Fresh sets used: judge-K 32 (the 40 minus 8 already rated by V, see V5-FRESH-ACCURACY.md CORRECTION) and judge-L 15 (24 Sep delta pass, labels sha256 f3c58748...). Together 47 blind-labelled items. **These 47 are now DEVELOPMENT data for v6**: a v6 freeze must be scored on a NEW fresh set (leakage rule), checked by content with `fresh_overlap.py` against shipped consults and every earlier set.
- F5 false proposed_now on consults with no in-scope procedure: judge-K 2 of 11 none items, judge-L 2 of 11 (L05, L07: named in passing at named 0.50-0.52, described 0.04-0.07, status read proposed_now). Candidate change: `status` should require that the procedure is advised for THIS patient; named-not-described mentions are `mentioned_only`. UNTESTED.
- F6 proposals described without naming score low on `named` (L08 named 0.19 / described 0.95; J12-like): the page shows the placeholder name; not a status error.
- F2 gate: 4 of 30 consults held on judge-K (garbled/looped), 0 of 11 on judge-L; staff talk held 6/6. Report the loop/garble flag beside a hold.
Combined status view (47 = judge-K 32 + judge-L 15, from the two scripts): proposed_now predicted 11, 5 agree; label 12, found 5. conditional predicted 3, 2 agree (K 1 of 2, L 1 of 1); label 5, found 2. already_done predicted 4, 3 agree; label 8, found 3. mentioned_only predicted 3, 0 agree; label 0. n is small in every cell.
