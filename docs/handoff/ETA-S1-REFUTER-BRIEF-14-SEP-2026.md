# ETA — S1 REFUTER BRIEF
**14 September 2026 · Session: `ETA-Refuter` · Opus. You did not build this. Read-only on the repo.**

## The ask

Refute the S1 build: commit **`d852127`** on `vinay/s1-auto-drain`, base `vinay/release-b1` at
`14a4f38`, in `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`.
Contract: `docs/handoff/ETA-S1-AUTO-DRAIN-CC-KICKOFF-14-SEP-2026.md`.
Builder's report: `docs/handoff/ETA-S1-AUTO-DRAIN-REPORT-14-SEP-2026.md`.

## Rules

- **Do not trust the report's gate lines.** Clone the branch at depth into your own scratch
  directory and rerun `npx tsc --noEmit` and the full suite yourself. Quote the output you saw.
- Check the kickoff's file contract **item by item**: the six named files, the untouched list, and
  that there is no migration in `d852127`.
- PASS/FAIL per contract item, each with a `file:line` proof line.
- Another session is committing a FIX1 on this same branch right now. **Pin your review to
  `d852127`** and ignore anything after it.
- Read-only: no edits, no pushes, no env changes.

## Already ruled — do not re-litigate these

The Builder's flags F1, F2, F3, F4, F6 and F8 are ruled in
`docs/handoff/ETA-S1-D1-VERDICT-AND-RULINGS-14-SEP-2026.md`. F1, F3, F4 and F8 are being fixed in
FIX1. Do not spend effort re-proposing them. **Tell me what those flags missed.**

## Where I most want you looking

1. **The selector SQL.** It is inferred against a schema the Builder could not query. Does it do what
   the kickoff specified — `closed`, grid-aligned, non-null `room_day_id`, inside
   `AUTO_DRAIN_MAX_AGE_HOURS`, newest-first, capped — and does the live-job check actually exclude a
   window that already has a `room_window` job in a live state? Name the failure mode if a column or
   a status value is wrong.
2. **The cap.** Prove the batch limit cannot be exceeded, including when the env override is garbage,
   absent, zero, negative or enormous. The clamp is 1..10.
3. **Rule 7 and rule 10 on the new tests.** Every refusal test must have a paired control that proves
   the refusal is not universal, and every boundary fixture must be expressed in terms of
   `AUTO_DRAIN_MAX_AGE_HOURS`, not the numbers it happens to produce today. Name any test that would
   still pass against broken code.
4. **The emotion change.** `planned > 0, scored = 0` ⇒ failed; `scored > 0` with failures ⇒ ok;
   `planned = 0` ⇒ `no_segments`. Confirm the third case is genuinely untouched.
5. **Anything that ships inert.** Four core paths shipped inert last cycle with every gate green. Is
   there a path here that cannot execute — a flag read that throws, a route that returns before it
   enqueues, a test that exercises a fake rather than the real function?

## Report

`docs/handoff/ETA-S1-REFUTER-VERDICT-14-SEP-2026.md`, at most 500 words: overall PASS/FAIL · per
contract item · your quoted `tsc` and test output · every new finding with a `file:line` proof ·
what you did not check.
