# ETA Install Build R3 — FIX 1

**Kickoff for Claude Code. Paste this whole file.** Same session, same machine, **same branch**.

Working directory: `~/dev/Even-Transcription-Assistant` on the Mini, branch **`vinay/r3-self-update`**,
currently at `b11518d`. **New commit on the same branch. Do not amend. Do not push. Do not touch `main`.**

Read first: `docs/handoff/ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md` (the main kickoff, still governing)
and your own `ETA-INSTALL-BUILD-R3-REPORT-9-SEP-2026.md`.

**The build was reviewed. R3-1 to R3-12 are all correctly implemented, the file contract held, the swap
script is right including its quoting, and the codesign catch was correct.** Eight items need work. Four
block the trip. The rest are rulings folded in.

---

## 0. Rulings on your flags. Do not reopen these.

| Your flag | Ruling |
|---|---|
| §8.1 leading `= ` on `codesign -R` | **You were right and the kickoff was wrong.** Keep the packaging script's form. I am correcting the kickoff and PRD §13.3 step 6. |
| §8.2 `--deep` on both checks | **Accepted.** Precedent from `build-bundle.sh` on the same unpacked-zip shape. |
| §8.5 check at the end of a successful poll | **Accepted**, including that "on launch" means "on the first successful poll". |
| §8.6 the three reason sentences you wrote | **Ratified as written.** |
| §8.7 channel tag in the Room cell | **Accepted. The mockup wins over the kickoff's prose.** |
| §8.9 state C marks the row `needs_attention` without a second line | **Accepted.** |
| §8.11 channel by hand edit, no verb | **Accepted.** |
| §8.12 `disk_free_bytes` read in `InstallPollFields.swift` | **Accepted**, including `volumeAvailableCapacityForImportantUsageKey`. |
| §8.13 the one edited test file | **Accepted.** Asserting `nil` is the stronger guard. |
| size mismatch reported as `download_failed` | **Accepted.** More accurate than `checksum_mismatch` for a truncated download. |
| §13.4's "twelve poll fields" | **Your count wins.** 14 poll fields, 17 wire items. §13.4's prose was arithmetic, not contract. |
| §8.3 the SIGKILL window | **Accepted as a documented limit. Do NOT add `renamex_np`.** F2 and F3 below are what actually shrink that window, by orders of magnitude more than an atomic swap would. Acceptance item 6 is run with `kill`, not `kill -9`. |
| §8.10 the tape warning quiet on pre-0.1.8 rooms | **Accepted** given R3-2, **once F1 is fixed.** Until F1 is fixed it is not "quiet on 0.1.7 rooms", it is dead everywhere. |
| §8.15 one PRD copy | **Accepted.** My premise was wrong. |
| §8.16 the stray `CLAUDE.md` | **Correct to leave it.** V is investigating separately. Do not commit it. |

---

## 1. F1 — BLOCKER. The six new poll fields never reach the database.

**This is a spec gap in my kickoff, not your error.** `app/api/bench/commands/route.ts` appeared on neither
the editable list nor the untouched list of §6, so you correctly honoured "edit ONLY these" and left it.

**What is wrong.** The app sends the six new query items. `applyInstallPoll` writes them. The route in the
middle builds `install` from eleven hard-coded keys (`route.ts:77-91`) and reads **none** of
`session_open`, `update_channel`, `last_update_result`, `last_update_error`, `last_update_at`,
`disk_free_bytes`. `lib/bench-commands.ts:162` passes `input.install` straight through, so nothing
downstream can recover them.

**What would happen in the rooms.** `session_open` stays NULL for ever, so `sessionOpen === true` is never
true, so **"Tape not advancing" never fires again in any room.** R3-3 would not fix that warning, it would
delete it. A room with a patient in it and a dead microphone cable would read healthy. State B would be
unreachable, state C would never render, Home Office would display `channel stable` while on `test`, and
the disk line would never appear. Acceptance items 5 and 7 could not pass.

**File contract amendment, [V-9SEP]:** `app/api/bench/commands/route.ts` moves to the **editable** list.
`lib/bench-commands.ts` stays untouched.

**Fix.** Read the six items in the route's `install` block, using the existing discipline: `tri()` for
`session_open`, plain string for `update_channel`, `last_update_result` and `last_update_error`, and
integer parsing for `disk_free_bytes` and a timestamp parse for `last_update_at` that **omits rather than
guesses** on anything unparseable. Never substitute 0 or a default.

**Test.** A test that drives **the route**, not `applyInstallPoll`, with a full query string, and asserts
all six values arrive in the object handed to `pollCommands`. Your existing
`tests/unit/room-install-update.test.ts` proves the database layer and leaves the wire unproven — that gap
is what let this through.

---

## 2. F2 — BLOCKER. A repeatable `swap_failed` is an unbounded download-and-swap loop.

`updateSchedule` lives in memory (`RoomEngine.swift:459`) and is rebuilt on every process start.
`isDue` returns true unconditionally when `lastCheckedAt` is nil (`RoomSelfUpdate.swift:211`). `check()`
consults nothing about the previous attempt.

So a resident-verify failure restores `.previous`, bootstraps the old app, and about 1.5 seconds later that
app asks again, gets the same version, downloads it again, stages it again — the staged check passed last
time, it was the resident check that failed — spawns again, exits 64 again. Roughly every 80 seconds,
for ever, until someone withdraws the release. Every cycle boots the agent out and passes through the
window where the resident bundle does not exist.

The same loop fires with no failure at all if a published release's `version` disagrees with the
`CFBundleShortVersionString` inside its zip. A publish typo would do it.

**Fix.** Make the attempt survive a process restart and refuse to repeat itself. `update-result.json`
already persists the outcome and, after F5, the version. On startup, if the last result is a failure for
version V, do not attempt version V again until either a different version is offered or a backoff has
expired. **One retry, then hold**, and record the hold so the card can show it. Do not make the backoff
configurable.

**Test.** Two consecutive failed swaps of the same version result in exactly one retry and then no further
download.

---

## 3. F3 — BLOCKER. The restarted app deletes the staging directory the swap script is running from.

`RoomEngine.init` unconditionally removes `RoomSelfUpdate.stagingURL(root:)` (`RoomEngine.swift:642`),
which holds `swap.sh` and the expanded staged bundle the script is about to move.

`ThrottleInterval` does not protect this. It is a minimum interval between **starts**, and the app has been
running for hours, so launchd respawns on exit 64 immediately. The script has to win a race against the new
process reaching `RoomEngine.load`. The comment at `main.swift:298-300` that thirty seconds "buys the swap
its quiet" is a misreading of launchd and should be corrected in the same commit.

**Fix.** Do not delete staging while a handover is in flight. Write a handover marker before spawning the
script and skip the staging cleanup while it is present and fresh; clear it when the outcome is read. A
time-based rule (delete only staging older than N minutes) is acceptable if simpler, but the marker is
preferred because it states the intent.

**Test.** With a handover marker present, `RoomEngine.init` leaves the staging directory alone.

---

## 4. F4 — BLOCKER. Acceptance test 6 proves nothing.

`aScriptKilledDuringTheSwapLeavesAWorkingBundleAtTheResidentPath` asserts
`resident == "0.1.7" || resident == "0.1.8"` — every outcome except an empty path. The harness replaces
`/bin/sleep 3` with `/bin/sleep 0` and then waits 0.35 s before signalling, so the script has almost always
already exited. **This test passes identically against a script with no `trap` line.**

§13.5 item 6 is the one item the addendum singles out as needing proof rather than argument.

**Fix.** Make the signal land inside the window deterministically: keep a real pause between the two moves
in the test build of the script, or have the script signal a fifo when it reaches the window and have the
test send SIGTERM on that signal. Then assert the specific recovery: the resident path holds **0.1.7**,
`.previous` is gone, `update-result.json` records `swap_failed`, and the agent was bootstrapped.

**Prove the test can fail.** Remove the `trap` line, show the test goes red, restore it. Put both outputs
in the report.

---

## 5. F5 — `last_update_version`, a seventh column in 0078. [V-9SEP, ratified]

Your §8.4 flagged it and V has ratified it. Add `last_update_version text` (nullable) to migration 0078.
It is not yet applied anywhere, so amend 0078 in place rather than writing 0079. COALESCE it with the other
update columns. Stop packing the version into `last_update_error`; remove `UPDATE_ERROR_SEPARATOR` and its
reader, and have `lib/room-install-view.ts` build the mockup's sentence from the two columns.

---

## 6. F6 — Suppress `update pending` for a Mac whose channel is not the header's.

Your §8.8 flagged the contradiction and was right to leave it rather than decide it. **The approved mockup
state E draws Home Office on `test` with no such pill**, so the mockup governs over §13.4's prose.

**Fix.** `deriveRow` compares a row against the newest non-withdrawn release **for that row's channel**.
`latestRelease` already takes a channel; `readFleet` hard-codes `"stable"`. Fetch both channels and pick
per row. If a row's channel has no release, the row shows no version word at all — never "update pending".

---

## 7. F7 and F8 — two small ones

**F7.** `64` is a bare literal at `main.swift:225`. Make it a named constant with a comment citing R3-4.

**F8.** The `record()` heredoc interpolates `${VERSION}` into a JSON string without escaping
(`RoomSelfUpdate.swift:597`). A version containing a quote or a backslash produces a receipt
`RoomUpdateResult.read` cannot decode, losing the outcome. Escape it, or write the JSON with a tool that
does.

---

## 8. File contract for this fix

**Editable, in addition to the main kickoff's §6 list:**

```
app/api/bench/commands/route.ts        [V-9SEP amendment, F1]
```

**Everything else in the main kickoff's §6 UNTOUCHED list still applies**, `lib/bench-commands.ts`
included. Do not widen the contract further; flag instead.

---

## 9. Gates

The same five. **`swift test` must be run from Terminal.app on the Mini's own screen**, not over SSH — the
46 `needsEnrolment` issues you saw are the locked-login-keychain condition, and that gate is currently
unproven rather than failed. `npm run check:silent`'s 9 findings are pre-existing at `1193083` and are
accepted; say so rather than fixing files the contract forbids.

**`npm test` could not be re-run independently** (the tree's `node_modules` is a macOS install and the
review shell is Linux). Re-run it on the Mini and quote the real output.

---

## 10. Report

Append to `docs/handoff/ETA-INSTALL-BUILD-R3-REPORT-9-SEP-2026.md` as **§13, Fix 1**, or write
`ETA-INSTALL-BUILD-R3-FIX1-REPORT-9-SEP-2026.md`. Either way include:

1. The new commit sha.
2. F1 to F8 each with the file:line of the fix.
3. **F4's proof that the test can fail**: the red output with the `trap` removed, and the green output with
   it restored.
4. The route test's assertion that all six fields arrive.
5. All five gates, with `swift test` run at the console and its real result.
6. Anything you had to flag rather than decide.
