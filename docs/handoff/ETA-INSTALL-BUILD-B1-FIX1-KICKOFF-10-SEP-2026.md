# ETA Install Build B1 — FIX 1

**Kickoff for Claude Code. Paste this whole file.** Same session, same machine, branch **`vinay/release-b1`** at `6e8ed69`.
**New commit on the same branch. Do not amend. Do not push. Do not touch `main`.**

Review of `6e8ed69`: B1-1 to B1-6 all correctly implemented; the rendered script passes `bash -n`; the final-slice look, the
FIFO placement between `rm -rf .failed` and `mv "$PREVIOUS"`, and the empty-resident negative control are all right. Your
flags 1, 3, 4, 5, 9, 10 are accepted as written. Three small items remain.

## Rulings on your flags [V-10SEP]
| Flag | Ruling |
|---|---|
| 2 — a 3-minute outage rolls back a healthy build | Accepted residual. Add it to §14.3 (see H3). It costs one ledger failure and a re-offer; it cannot strand a room. |
| 6 — rescue inside the rollback leaves the canary file | Accepted. H2 clears the marker; the canary is removed by the restored app's first poll, as you say. |
| 7 — script death inside 180 s | Unchanged, already in §14.3. |
| 8 — B1-6 message vs `CLAUDE.md` | **`CLAUDE.md` was wrong and is now corrected by the orchestrator in the working tree.** Stage `CLAUDE.md` by exact filename and include it in this commit. Do not edit it. |

## H1 — BLOCKER. The rollback destroys the new bundle before it knows the old one exists.
`RoomSelfUpdate.swift` rendered rollback: `mv "$RESIDENT" "${RESIDENT}.failed"` → `rm -rf "${RESIDENT}.failed"` → `mv "$PREVIOUS" "$RESIDENT"`
(unchecked). If `.previous` is absent or the rename fails, the resident path is empty and `bootstrap_agent` points at nothing — a
bricked room, from the code that exists to prevent one.

**Fix.** Before `bootout`: `if [ ! -d "$PREVIOUS" ]; then say "no previous bundle to restore; leaving ${VERSION} in place"; record swap_failed
"\"the new version did not poll within ${CANARY_SECONDS} s and no previous bundle was present to restore\""; /bin/rm -f "$CANARY"; exit 1; fi`.
Then in the rollback, check the restore: `if ! /bin/mv -f "$PREVIOUS" "$RESIDENT"; then say "restore failed"; /bin/mv -f "${RESIDENT}.failed" "$RESIDENT" 2>/dev/null; …record swap_failed with reason "…restore of <old> failed; kept <new>"; bootstrap_agent; exit 1; fi` —
and move the `rm -rf "${RESIDENT}.failed"` to **after** a successful restore. Order becomes: guard → bootout → mv resident→.failed →
mv previous→resident (checked) → rm -rf .failed → record → rm canary → bootstrap.
**Test.** `theRollbackRefusesWhenThereIsNoPreviousBundle`: delete `.previous` after arming; timeout; resident still the NEW version and
executable; receipt `swap_failed` with the no-previous sentence; agent bootstrapped or left running (state which and why); `.failed` absent.

## H2 — Clear the handover marker in the rollback path.
After a successful restore, `rm -f` the marker at the path `RoomUpdateHandover` uses (`RoomSelfUpdate.handoverMarkerURL`); pass it into the
script as `HANDOVER_MARKER=<quoted path>` like the other paths. Extend the rollback test to assert the marker is gone.

## H3 — Docs.
Append to `ETA-INSTALL-AND-FLEET-PRD-RELEASE-B1-ADDENDUM-10-SEP-2026.md` §14.3 one bullet for the outage case (flag 2) and one for the
no-previous case (H1). Fix the report's `restored 0.1.11` → the old version. `docs/BUILD-HISTORY.md` one paragraph.

## File contract
Editable: `RoomSelfUpdate.swift`, `RoomSelfUpdateTests.swift`, the B1 addendum (§14.3 only), `docs/BUILD-HISTORY.md`, your report, and
`CLAUDE.md` (stage only). Everything else untouched.

## Gates
The six, `swift test` over SSH with 0 issues. No bundle, nothing signed.

## Report
Append `## Fix 1` to `ETA-INSTALL-BUILD-B1-REPORT-10-SEP-2026.md`: sha, H1–H3 with file:line, the new rollback block verbatim, the new test's
output, gates. Cap 60 lines.
