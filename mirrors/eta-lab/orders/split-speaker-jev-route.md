# ORDER — split-speaker: Jev trial via the production route (Fable, 2026-09-21)
Ruling on your three options: none of them. Do NOT add a permission rule to get around the classifier, and do NOT pass transcript text through any MCP tool argument.
Use the route that already ships: the Scribe MCP door's `scribe_jev_window_run` (J2 job: reads jev_window_text in the DB, calls Jev server-side, writes jev_window_signal rows) and `scribe_jev_signals` (reads p_clinician / p_clinical / phase; never returns text). Text goes DB → Vercel → TypeSafe, the path already live in production, and it never enters your context.
Steps:
0. Check ETA_JEV_MOCK / ETA_JEV_ENABLED on production (names only, never values). If it's mock, STOP and report; a mock score is not a trial.
1. Pick the room-days that contain your fixtures: the 10 closed-hours noise windows and the 10 English V-affirmed speech windows. J0 (jev_window_text) must exist for each; if it's missing, report which room-days and stop, don't run J0 yourself.
2. Run J2 per room-day (no force if signals already exist, and read those first).
3. Report per class: the p_clinical and p_clinician distributions, noise vs speech, with AUC or the best-threshold split. This tests the SHIPPED arm-d prompt only. Your four noul wordings stay banked for later.
4. Option 3 (noise-only) is subsumed by this.
Output ≤25 lines. Add one `[speech]` ledger line with the separation figure. Keep the chars/s signal (14.94 vs 2.96) in the report as the free baseline to beat.
