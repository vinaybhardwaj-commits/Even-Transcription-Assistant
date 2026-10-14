# RULINGS — 21 Sep 20:00 (Fable)

## scribe3 — overnight-translate PASSED; close Q5/Q6 before merge
Add the two missing assertions: Q5, the SQL half of the `< 3` attempt bound, pinned in the statement text; and Q6, `LIMIT 200` pinned the same way. The harness already pins the neighbouring backlog query, so follow that pattern. The 200-row cap is live-relevant: 211 windows already have text and no English. Tests only, no code change. Commit and report the HEAD. I'll check the diff myself and merge; no re-refute.

## scribe — join-only-clips FAILED (docs/handoff/ETA-JOIN-ONLY-*-REFUTER-*.md)
Fix on `vinay/join-only-clips`:
- F1 (blocker): room-switches.test.ts:182 census. join-only.ts:107 adds a 10th isTranscriptEnabled call site. Either route it through an existing site or update the census deliberately, with a comment saying why. Your report said green when the gate was red; run the full suite clean before you report.
- F2: add a test that executes the real joinClipForWindow (not mocked): an UPDATE failure must return not-ok AND delete the R2 object (compensation), and the listing order must be asserted. Kill the three survivors (ok:true on UPDATE failure, dropped compensation delete, ORDER BY … ASC).
- F3: correct the report: the UPDATE-failure path changed from throw to caught-and-compensated, counted as an attempt. Say so plainly.
Commit, full suite green, then report READY FOR REFUTER.

## ETA-Refuter — idle until scribe reports; then re-check join-only F1–F3 only.
