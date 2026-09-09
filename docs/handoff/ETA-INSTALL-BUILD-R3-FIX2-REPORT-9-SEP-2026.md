# ETA Install Build R3 — Fix 2 report

**9 September 2026.** Branch `vinay/r3-self-update`, new commit on `4a782a1`. Not amended, not pushed, `main` untouched.
Kickoff: `ETA-INSTALL-BUILD-R3-FIX2-KICKOFF-9-SEP-2026.md`. Verdict read first, then my Fix 1 report.

Commit: the single new commit on this branch (`git log --oneline -1`); a commit cannot quote its own sha.

**Pre-flight.** `pwd` correct; origin `vinaybhardwaj-commits/Even-Transcription-Assistant`; HEAD `4a782a1`; branch
`vinay/r3-self-update`. Untracked: `CLAUDE.md` plus four files under `docs/handoff/`. Nothing else. **Matched, proceeded.**

**Mid-session change, stated because it moved the contract.** The kickoff and `CLAUDE.md` were both rewritten on disk
while I worked. The kickoff first said to ignore `CLAUDE.md`; it now says that file governs and adds **G7 — commit it**.
I followed the updated files, did not edit `CLAUDE.md`, and staged it by exact filename.

---

## G1 — the publish-typo loop, closed upstream

`case versionMismatch` `RoomSelfUpdate.swift:179`; the check (after the staged codesign, before the swap)
`:762-788`; `bundleShortVersion(at:)` `:617`, `PropertyListSerialization` over the staged `Contents/Info.plist`.
Vocabulary: `lib/room-install-view.ts:76` union, `:235` card sentence, `lib/room-install.ts:766` accepted set,
`db/migrations/0078_install_update_fields.sql:67` column comment.

Read from the STAGED path; never `Bundle.main`, never `defaults`. A bundle that will not state a version reads as a
mismatch — "cannot tell" must not pass as "matches". `stop()` writes the receipt and counts it, so one-retry-then-hold
applies with nothing new. **The receipt for this case said `ok`, and a ledger that counts failures cannot bound a loop
made of successes** — which is why F2's ledger never reached it.

**Tests** (`apps/room-recorder/Tests/TapeCoreTests/RoomSelfUpdateTests.swift`):

- `aBundleThatCallsItselfSomethingElseIsStoppedBeforeTheSwap` **:586** — staged plist `0.1.9`, release `0.1.8`. Asserts
  `.versionMismatch`; reason names both versions; `spawned.isEmpty`; resident still `0.1.7`; no `.previous`; staging
  removed; receipt `version == "0.1.8"` (the OFFERED version — what the card's sentence is about and what the ledger is
  keyed by); ledger `failures == 1`, `holdUntil == nil`.
- `theSameMislabelledReleaseIsTriedOnceMoreAndThenHeld` **:628** — four identical offers: `.stopped`, `.stopped`,
  `.heldAfterRepeatedFailure`, `.heldAfterRepeatedFailure`.
- `aStagedBundleThatWillNotSayWhatItIsIsAlsoRefused` **:649**; `aCorrectlyLabelledBundleStillHandsOver` **:667** (the
  negative control — the check is not a wall); `theVersionIsReadFromTheStagedBundleOnDisk` **:677** (missing plist,
  missing key and a non-plist all read nil).

## G2 — one real failure no longer triggers the hold

`roomUpdateCountStartupReceipt` **`RoomSelfUpdate.swift:381`**, called from **`RoomEngine.swift:682`**. The `.swapFailed`
test is stated once inside that function so the rule is testable without standing a whole engine up — which matters here,
because `RoomEngine.load` needs the login keychain and that is what is locked over SSH. `swap_failed` is the only outcome
the swap script writes and the only failure whose author cannot count itself; every other comes from `stop()`.

- `aDownloadFailedReceiptAtStartupDoesNotTouchTheLedger` **:833** — `.downloadFailed`, `.checksumMismatch`,
  `.signatureMismatch`, `.expandFailed`, `.versionMismatch`, `.ok` and a nil receipt each return nil and leave the ledger
  absent.
- `aSwapFailedReceiptAtStartupCountsExactlyOneFailure` **:861** — first `failures == 1`, `holdUntil == nil`; second
  `failures == 2`, `holdUntil == t0 + retryHold`.
- `aDownloadFailureFollowedByARestartStillGetsItsRetry` **:883** — end to end: `stop()` counts once, the process restarts
  with the receipt still on disk, startup counts nothing, `failures == 1`, `roomUpdateIsHeld` false.

## G3 — the two documents corrected

- PRD **`§13.9 item 2`** (`docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md:1150-1156`): the ledger
  bounds loops made of failures; the typo variant loops on successes, was still open after Fix 1, and is closed by G1.
- PRD **`§13.10`** (`:1179`), seven lines, G1–G7.
- **`docs/BUILD-HISTORY.md:317`** corrected in place, plus a Fix 2 paragraph at the end.

## G4 — `handoverGrace` is 30 minutes

`RoomSelfUpdate.swift:119` (`30 * 60`), comment at `:106-118`. No test encoded ten minutes — the existing one used the
symbol — so I added `theHandoverGraceIsThirtyMinutes` **:906** to pin the ratified number itself.

## G5 — `instant()` omits rather than guesses

`app/api/bench/commands/route.ts:109` `ISO_INSTANT`, applied at `:112` before `Date.parse`. Tests in
`tests/unit/bench-commands-install-wire.test.ts`: `rejects what Date.parse would have HAPPILY invented (Fix 2, G5)`
covers `"12"`, `"2026"`, `"2026-09"`, `"2026-09-09"`, `"Sep 9 2026"`, `"1757400000"` and a shape-valid impossible date;
`carries a full ISO-8601 instant, with Z or an explicit offset` covers `"2026-09-09T09:14:00.000Z"` and `+05:30`.

## G6 — the FIFO reader has a deadline

`RoomSelfUpdateTests.swift:178` opens `O_RDONLY | O_NONBLOCK`, polls for a byte to a 10-second deadline, and on timeout
kills the process and throws `SwapHarnessError.windowNeverReached` (**:204**, case at **:221**). The green path is
unchanged: `aScriptKilledBetweenTheTwoMovesRestoresThePreviousBundle` still passes with its four assertions.

**One consequential change, flagged.** Polling costs ~2 ms more than a blocking open — enough to lose the race to bash
forking `sleep`. Bash defers a trap until the current foreground command returns, so the injected `/bin/sleep 30` turned
that test into a 30-second test. Replaced with `for _ in $(seq 1 200); do sleep 0.05; done`: same window, trap fires
within 50 ms, suite back to 2.4 s from 30.5 s. **Test harness only; the shipped script is untouched.**

## G7 — `CLAUDE.md` committed

Staged by exact filename, unedited.

## Gates

| Command | Result |
|---|---|
| `npm run typecheck` | **GREEN**, exit 0, no output |
| `npm test` | **GREEN** — `Test Files 67 passed (67)`, `Tests 1572 passed (1572)` (was 67/1568) |
| `npm run build` | **GREEN** |
| `npm run check:silent` | **RED, exit 1** — `Found 9 silent-failure handler(s)`. The pre-existing 9 at `1193083`, accepted per `CLAUDE.md`; none in files this contract touches. |
| `cd apps/room-recorder && swift build` | **GREEN** — `Build complete!` |
| `cd apps/room-recorder && swift test` | `Test run with 510 tests in 42 suites failed after 10.883 seconds with 46 issues` (was 501/46) |

**`swift test` is UNPROVEN, not failed.** `security show-keychain-info` still answers `User interaction is not allowed`,
so `RoomKeychain.load` fails and 44 tests throw `needsEnrolment`; the only other four issues are
`RoomEngineResidentCaptureTests` expectations downstream of it. **All 44 `RoomSelfUpdateTests` pass**, the nine added here
included — 501 → 510 tests, issue count unchanged at 46. Run it at the console with the flags in §3.3 of the first report.

## Flagged, not decided

1. **The G6 sleep-loop change to the injected harness line** (above). Necessary, but it is a change to how acceptance
   item 6 is exercised, so it is named rather than buried.
2. **`version_mismatch` is in no `CHECK` constraint** — 0078 has none; the column is plain `text` and the vocabulary is
   enforced in `cleanPollFields`. Consistent with the other six; noting it in case you want a constraint later.
3. **A server-side publish guard** (open the zip, compare `Info.plist` to `version`) would stop this at the source rather
   than on each Mac. The verdict deferred it to the publish runbook; G1 does not replace it.
4. **The two orchestrator files** — `ETA-CARRYOVER-PROMPT-9-SEP-2026-EOD-MASTER.md`, `ETA-ORCHESTRATOR-MEMORY.md` — are
   left untracked, per `CLAUDE.md`'s "leave them". The kickoff allowed either.
5. **Nothing has been proven in a room.** Migration 0078 (seven columns) still unrun; the seven §13.5 acceptance items
   still unrun.
