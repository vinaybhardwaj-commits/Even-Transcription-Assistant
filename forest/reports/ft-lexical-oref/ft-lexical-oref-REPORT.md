# ft-lexical-oref: adversarial refute of lane ft-lexical (cb-ft-lexical)
Opus 5.5, 20 Oct 2026, written 12:03 IST (the lab box clock). D split only; nothing under ft8/H or ft-h1shot/sealed read. Lane files not edited.
Target: ~/oc/forest-lead/ft/out/ft-lexical/ (PLAN.md sha12 c2aec8cd35b7 confirmed, mtime 11:20). Recheck scripts: ~/wt/ft-lexical-oref/.bc/recheck_*.py.

## VERDICT: PASS-WITH-FIXES
The arithmetic is right. Every Fisher p, BH q, test count, Wilson CI and kappa I recomputed matches. The leakage screen for the "booked/done" direction is implemented correctly.
Two interpretation problems weaken summary item 3 ("non-converters say where else they might go"), which is the lane's headline patient-side finding:
- window-length bias (F1);
- a one-sided outcome screen (F2).
There is also one PHI fix (F3). None of these overturns the paperwork, consult-recovery or counsellor-call results.

## Findings
**F1 (MAJOR): window-length / exposure bias in analyses 1 and 2 is not handled.**
- The problem. Converters' call windows stop at surgery: last eligible call is median day 1.5 (R) and 1.0 (S), against 4.0 and 5.0 for non-converters. Non-converters keep receiving late "chase" calls that converters never get.
- Why it matters. Episode-level presence ("theme or term in >= 1 item") therefore favours whatever is said late in a window. ft-calltext handled this with a matched design. ft-lexical used an at-risk rule only in analysis 4.
- Recompute (Ale; matched = each non-converter cut at a pseudo surgery day drawn from converters' days_to_surgery, seed 20; lane value -> matched):
  - S timing_later: 19% vs 35%, p 0.003 -> 19% vs 28%, p 0.089.
  - S second_opinion: 2% vs 11%, p 0.013 -> 2% vs 8%, p 0.087.
  - S doctor_named: 58% vs 78%, p 0.0004 -> 58% vs 72%, p 0.021.
  - S going_elsewhere: 2% vs 16%, p 0.0006 -> 2% vs 12%, p 0.011.
  - R second_opinion: 0% vs 13% -> 0% vs 11%, p 0.017.
  - R going_elsewhere: 4% vs 18% -> 4% vs 16%, p 0.034.
- What holds. Directions hold, but the gaps shrink by roughly a third to a half. At the day-3 landmark (at-risk at day 3, calls before day 3) only S going_elsewhere stays below 0.05 (0/35 vs 11%, p 0.035).
- What strengthens. Insurance and reassurance (R) hold or strengthen: reassurance matched p 0.022; landmark-3 52% vs 25%, p 0.012.
- The admin-removed survivor "up" (summaries) is mostly "follow up" chase-call wording, which is the same artefact.
- FIX:
  - Add a matched-window (or T=3 / T=7 landmark) sensitivity table for analyses 1 and 2, with themes plus the flagged terms, and BH it as its own family.
  - Rewrite summary item 3 to give the matched rates and say the gap is partly late-window chase calls that converters cannot have.
  - Note the same artefact for item 2 ("up") and for doctor_named.
  - Add a caveat line: "Converters' windows are shorter (they stop at surgery)."

**F2 (MAJOR): the leak screen is one-sided, and going_elsewhere / second_opinion partly ARE the negative outcome.**
- The problem. ft-calltext's outcome_revealed definition (ftc_tag.py:26) catches only booked, scheduled, admitted or done at Even. It never catches "patient has gone, or decided to go, elsewhere". For Ale = 0, that statement reveals the label.
- Evidence. Of 74 verified going_elsewhere quotes in summaries, 16 match already / done / decided wording. Reading them (not reproduced), several are explicit statements that the patient was already admitted elsewhere, had decided on another hospital, or planned to proceed there. Those are statements of the non-conversion itself, not predictors of it.
- The current caveats cover only the positive direction (pre-auth talk).
- FIX:
  - Add a caveat: "going_elsewhere / second_opinion include statements that the patient already chose or went to another provider; these are the negative outcome, not a lever."
  - Add a sensitivity that drops themes whose verified quote states a completed or decided alternative. A regex or manual pass over the about 250 R+S going_elsewhere + second_opinion quotes is enough; no new Haiku tagging is needed. Report the rates with and without them.
  - Soften item 10 ("mostly the patient NOT mentioning alternatives") accordingly.

**F3 (MAJOR, PHI): person first names appear as terms in LEXICAL-TERMS.md.**
- Line 81 (calls, counsellor side; glossed "coordinator name", 3 vs 2 units) and line 147 (summaries; glossed "person's name", 2 vs 3 units) show a bare first name in the term column. The snippet masks the name, but the term column does not.
- With 5 units, the line-147 name may be a patient or relative.
- FIX: replace both terms with [name] (or drop the rows), add a name filter in quotes.py/report.py (drop any term Haiku glosses as a name, plus a staff/doctor first-name stoplist), regenerate, and update the sha12 in DONE.md.
- I found nothing else: no digit runs, phone numbers or Dr/Mr+name in either file, and the place names in the theme quotes do not appear in the reports.

**F4 (MEDIUM): the theme BH family is not the pre-registered one, and this is not disclosed.**
- PLAN.md line 54 says "BH over all theme x corpus x label tests". themes.py runs BH per label x mode. LEXICAL.md describes the per-label family but does not call it a deviation.
- Under the PLAN family (per mode, all labels pooled), Ale changes:
  - calls going_elsewhere: q 0.072 -> 0.096 (all text) and 0.096 -> 0.129 (admin removed; loses the flag);
  - summaries second_opinion, admin removed: 0.087 -> 0.117 (loses the flag);
  - reassurance, calls: 0.046 -> 0.061 (still flagged).
- Summary item 3 cites calls going_elsewhere 18% vs 4% and says "this holds with admin talk removed". Under the pre-registered family it does not.
- FIX: report q under the PLAN family (primary) or list this as a deviation and add the PLAN-family q column, then correct item 3.

**F5 (MEDIUM): the Jev kappa is pooled over corpora and hides weak agreement on headline cells.**
Per corpus, recomputed on the same 399-item sample (sample reproduced exactly: seed 20, 15%):
| theme | corpus | n | Haiku yes | Jev yes | kappa |
|---|---|---|---|---|---|
| second_opinion | R | 112 | 4 | 14 | 0.41 |
| reassurance | R | 112 | 18 | 7 | 0.43 |
| going_elsewhere | S | 255 | 11 | 12 | 0.59 |
| timing_later | S | 255 | 32 | 49 | 0.58 |
| recovery_stay_explained | K | 32 | 12 | 8 | 0.71 |
| insurance_cashless | all three corpora | | | | 0.90 or higher |
- FIX: add per-corpus kappa for every flagged theme cell. Say that the calls "0% vs 13% second opinion" rests on a theme where the two coders agree only moderately and Haiku under-calls relative to Jev.

**F6 (MINOR): consult roles do not follow the ft-audio rule.**
- prep.py uses caa-labels whenever roles_map returns none, with no 0.5 labelled-share threshold. Of 191 consults, 21 are ones ft-audio marked caa-weak (did NOT use); all 21 are Ale-labelled and 1 is a converter. They feed the doctor and patient-side cells.
- Recheck without them: the 4 flagged doctor terms keep the same direction, with p rising (day 4.3e-4 -> 9.4e-4; "and if you" 1.6e-5 -> 3.6e-5). The "day" flag (q 0.098) would probably go.
- FIX: drop caa-weak from the doctor and patient-side cells (treat those consults as unclear), rerun lex.py for K, and update item 6.

**F7 (MINOR): other undisclosed deviations from PLAN.** Add a "Deviations from PLAN" section listing:
- (a) Code-mix is a script-based minority-word share, not "share of segments whose language differs from main language".
- (b) Call main language comes from the STT json language_code, not rlf_prep lang_main.
- (c) Question rate counts '?' characters, not segments ending in '?'.
- (d) The Monroe prior uses the >= 5-unit filtered vocabulary, not whole-corpus counts. z differs by at most about 0.2 on the cells I recomputed; immaterial.
- (e) Theme "admin removed" drops a theme only if its single verified quote has an admin word. That is not the segment deletion PLAN describes. LEXICAL.md line 95 describes segment deletion for all admin-removed rows.
- (f) PLAN says 12 Jev drop-ins. The code drops leak_union, 10 R + 6 S = 16. This is more conservative, which is fine, but say so.
- (g) R window is day < 14, S is day <= 14.

**F8 (MINOR): wording in the 10-line summary.**
- Item 1: "it is not a reason anyone said yes" asserts a causal direction. Change to "most likely follows a yes".
- Item 2: the surviving term is "up". "follow up" itself is not flagged after admin removal (q 0.46). Change to "'up' (mostly 'follow up')", and see F1.
- Item 3: "confirms ft-calltext's tag result". These are the same summaries coded by the same model family, so change to "is consistent with (not independent of)".
- Item 6 and caveats: "Hindi consults converted less" (1/24 vs 17/110) is not significant (q 0.41). Change to "had fewer converters (not significant)".
- Item 9 / counsellor note: "100 of 2467 calls" counts R+S items, which can be the same call twice. Change to "items".
- Item 1 lists "room" among counsellor words; it is a patient-side term.

## Checked and correct
- **Leakage (calls R).**
  - elig_t14 (ft-engines assemble.py:106): pre-event is strict (call_day >= event_date is dropped), tagged, not outcome_revealed.
  - None of the 4 rl tags with outcome_revealed_unverified reach the items.
  - 0 R or S items are in Jev leak_union.
  - R and S: 0 items with day_from_rx >= days_to_surgery.
  - No untagged R item.
- **Leakage (summaries S, cohort P).**
  - S follows the ft-calltext tags_D rule (verified or unverified dropped).
  - Cohort P: the lane's amb_hash (episodes_D) is identical to ft-calltext v2final's F1 hash-only flag (9/9 episodes).
- **Consults K.**
  - ft-audio features_ale has 198 consults, all through split_guard = D.
  - Text is native stt.sarvam-saaras-v3 (saaras:v3, 196 files; no translate.* used). Native-script terms confirm it.
  - Ale labels: 139 of 198 (24 converters).
- **split_guard.** Pinned list; all 1,233 episodes are D. No code path touches ft8/H or the sealed set.
- **Monroe et al. 2008.**
  - delta = log-odds difference with prior a; var = 1/(y1+a) + 1/(y0+a). The formula is correct.
  - Independent recompute of 9 cells: unit counts and Fisher p match exactly; z within 0.2.
  - Episode-level Fisher is what goes into BH.
- **BH.**
  - Lexical, theme and other BH q recomputed with statsmodels: max difference 2e-16.
  - Ledger: 143,529 tests (lexical 143,248 + themes 236 + language 27 + counsellor 18). Every family's test and flag counts match.
- **Themes and kappa.**
  - Theme Fisher p and Wilson CIs match (e.g. 20/24 gives 64-93; 37/110 gives 25-43).
  - Kappa table reproduced.
- **Counsellor behaviour.**
  - The day-3 at-risk rule is implemented: days_to_surgery <= 3 excluded, calls on days 0-2.
  - Counsellor-id coverage is stated honestly: no agent id; names in about 4%.
- **Roles.** Call roles reuse roles_A.one unchanged. Speaker cells are restricted to lexicon and lexicon_weak calls (389 of 772 eligible), and the role-cue artefact is disclosed.
- **Summary numbers.** Every number in summary items 1-10 matches the tables, e.g. reassurance h14 admin-removed q = 0.0995, which really is below 0.10.
- **Caveats.** recovery_stay as post-decision talk (item 5), "monday" as scheduling the mask missed, and insurance/pre-auth as reverse direction are all present and adequate. What is missing is F1 and F2.
