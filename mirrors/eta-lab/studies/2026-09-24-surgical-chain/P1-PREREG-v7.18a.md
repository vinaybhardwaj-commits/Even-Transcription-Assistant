# P1-PREREG-v7.18a — dated addendum to P1-PREREG-v7.18 (linker-oc, 25 Sep 2026)

**Authority:** refuter-2's r406 review of the T9 assemble code (bus #2572, item F2). One rule is added; everything else in v7.18 (7c8566b) stands unchanged. This addendum is committed BEFORE the code change that implements it. No judge, prompt, floor, margin, tie rule, verdict set or de-identification rule changes.

## A1. New drop reason `out_of_scope_lang` (extends R3)
A turn whose `lang` is **neither English by the pinned rule** (`lang in ("en", "english")` — exactly the test the pinned `link3_run.hist_turns` uses for its `en` field) **nor one of the eight Indic tags** (`kn`, `hi`, `ta`, `ml`, `bn`, `gu`, `te`, `mr`) **is dropped and counted by the reason `out_of_scope_lang`**. It is never kept as English, never translated, never guessed. R3's list of drop reasons is extended by this one; the line appears in no text sent anywhere, like every other dropped line.

Counts at the time of this addendum (all 27 selected rooms of the final main run, via the pinned `link3_run.hist_turns`, counts only): `en` 158, `kn` 83, `hi` 65, `ta` 29, `ml` 24, `bn` 10, `gu` 8, `mr` 4, `te` 4, `und` 78 (463 turns total, 0 rooms unresolved). The new reason therefore applies today to the 78 `und` turns; any other value outside the two accepted sets would be dropped by the same rule.

## A2. Restatement (no change, for the record)
R3's UNCOVERED rule counts **kept Indic (337b) turns only**: kept English turns alone never make a window or an item covered for T9 (review item F1). This was always the meaning of R3 ("kept English turns alone are the native stratum's business, not T9's"); the T9 code is being corrected to match it.

A further change to any rule here is a new dated version with its reason.
