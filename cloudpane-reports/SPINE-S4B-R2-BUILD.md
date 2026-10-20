# SPINE-S4B-R2-BUILD (branch spine/s4b-explorer, on e8fe5418)
Fix round from the Opus refute (.bc/spine-s4b-r1-oref-REPORT.md).
## Changed
- lib/spine/explorer-read.ts
  - FIX-1: `parseExplorerOn` accepts one canonical on form per shape: true, "on", {on:true}, {mode:"on"|"shadow"}, and the JSON text of "on" or of those objects. Contradictions, extra/unknown keys, the string "true", bare "shadow", arrays and everything else are off (404).
  - FIX-2: signal `close_reason` is checked on read against `ENUMS[proxy].close_reason` imported from lib/spine/phi-screen (not copied). A value outside the enum returns null. The encounter response carries `close_reason_withheld` (count).
  - Follow-up: the day-view signal scan uses `t_open >= IST-midnight AND t_open < next IST-midnight` on the bare column (two date params). The refute measured this form with a room filter using (room_id,t_open) in 0.28 ms; with no room filter no index serves it. EXPLAIN was not re-run here (the test helper only runs SELECT-style statements).
- route doc comment (encounter route); tests: spine-explorer-routes.test.ts, spine-explorer-pg.test.ts (flag forms, planted non-enum close_reason, IST-midnight edge signals at 18:29:59Z / 18:30:00Z for 17, 18 and 19 Oct).
## Tests
- Targeted: `Tests  23 passed (23)` (routes + pg, postgres:16).
- Mutants, all killed: contradictory flag read as on (2 failed); close_reason unfiltered (1 failed); range end +2 days (1 failed). The range-off-by-one-day case is the edge-signal counts.
- Full gate (.bc/gate.log): typecheck and typecheck:tests ok; `Test Files  2 failed | 489 passed | 1 skipped (492)`, `Tests  2 failed | 10036 passed | 7 skipped (10045)`. The 2 are the known B29 (e11-silent-room-window sweep) and B30 (no-identity-literals); none are spine files. Same two as R1.
- The && chain stops at vitest, so I ran separately: `npm run build` exit 0; `npm run check:silent` exit 1 (9 findings, all pre-existing in app/[slug]/..., none in spine). swift N/A on Linux.
## Assumptions
- Bare string "shadow" was accepted before; it is now off ("one canonical form per shape": the string shape is "on"). The shadow mode is expressed as {mode:"shadow"}. Anyone who stored "shadow" must change it.
- `{on:true,mode:"on"}` is off (the brief says no mode key beside on).
## Risks
- Response gains one field (`close_reason_withheld`); the eta-lab explorer adapter ignores unknown fields (not re-checked).
