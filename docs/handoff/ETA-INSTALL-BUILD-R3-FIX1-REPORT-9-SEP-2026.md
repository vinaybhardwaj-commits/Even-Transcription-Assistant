# ETA Install Build R3 — Fix 1 report

**9 September 2026.** Branch `vinay/r3-self-update`, new commit on top of `b11518d`. Not amended, not
pushed, `main` untouched.

Kickoff: `ETA-INSTALL-BUILD-R3-FIX1-KICKOFF-9-SEP-2026.md`. First report:
`ETA-INSTALL-BUILD-R3-REPORT-9-SEP-2026.md`, still accurate except where §0 of the fix kickoff ruled
on its flags and where F1 to F8 below supersede it.

> **One thing you asked for did not happen: `swift test` is still not a console run.** See §5. Every
> other instruction was carried out.

---

## 1. Commit

The single new commit on `vinay/r3-self-update`, parent `b11518d`. `git log --oneline -2` on the
branch gives both — a commit cannot quote its own sha from inside itself, which is why the first
report's Commit line reads the way it does.

---

## 2. F1 to F8

| # | What it was | Where the fix is |
|---|---|---|
| **F1** | The six new poll fields never reached the database. The route built `install` from eleven hard-coded keys and read none of them, so **`session_open` would have stayed NULL for ever and R3-3 would have DELETED the "Tape not advancing" warning rather than fixing it.** | `app/api/bench/commands/route.ts:79-127` — the seven fields (six plus F5's `last_update_version`) are read; `:91-95` `bigint()` never accepts `0`; `:96-102` `instant()` omits rather than guesses. Header comment corrected at `:10-18`. |
| **F2** | A repeatable `swap_failed` was an unbounded download-and-swap loop, roughly every eighty seconds, for ever. | `RoomSelfUpdate.swift:282` `RoomUpdateAttempts` (persisted ledger), `:329` `roomUpdateRecordFailure`, `:345` `roomUpdateIsHeld`, `:589` the guard in `check()`, `:113-125` the constants. `RoomEngine.swift:663` counts a `swap_failed` receipt at startup — the only moment it can be counted, because the process that failed is gone. |
| **F3** | The restarted app deleted the staging directory the swap script was running out of. | `RoomSelfUpdate.swift:102` `handoverMarkerURL`, `:230` `RoomUpdateHandover`, `:270` `roomUpdateMayClearStaging`, marker written at `:614` *before* the spawn. `RoomEngine.swift:652` honours it. The `ThrottleInterval` comment that claimed to protect the swap is corrected at `main.swift:295-302`. |
| **F4** | The acceptance-6 test asserted every outcome except an empty path and signalled after a guessed delay. It passed against a script with no `trap`. | `RoomSelfUpdateTests.swift:480` the rewritten test; `:99` `killInsideTheWindow`; `:121-144` the FIFO rendezvous injected immediately before the second move, with a loud `SwapHarnessError.anchorMissing` if that line ever moves. **Proof it can fail: §3.** |
| **F5** | The version was packed into the head of `last_update_error` and parsed back out, making a free-text column load-bearing. | `0078_install_update_fields.sql:55` the seventh column; `lib/room-install.ts:787,839,921` clean + COALESCE; `lib/room-install-view.ts:57,520` read from the column; `InstallPollFields.swift:46,193` sent as its own item; `RoomSelfUpdate.swift:153` `reportedErrorLine` is now the reason alone. `UPDATE_ERROR_SEPARATOR` and `attemptedVersion` are **deleted**, and a test asserts they no longer exist. |
| **F6** | `update pending` compared every row against the STABLE release, so Home Office on `test` would wear it for ever. | `lib/room-install.ts:1036-1055` reads both channels, guarded separately; `lib/room-install-view.ts:121` `releaseForRow`; `:106-117` `FleetPayload.releases`; `BenchInstallFleet.tsx` picks per row. A channel with nothing published yields **no version word at all**. |
| **F7** | `64` was a bare literal. | `RoomSelfUpdate.swift:70` `handoverExitCode`, cited to R3-4 with the fail-safe reasoning; used at `main.swift:216,220`. |
| **F8** | `record()` interpolated `${VERSION}` into JSON unescaped; a version with a quote or backslash produced a receipt the app could not decode, losing the outcome. | `RoomSelfUpdate.swift:754` `jsonStringBody`, `:825` `VERSION_JSON` in the script. Escaping happens in Swift; the shell only copies bytes. |

**The card header still shows the stable release**, unchanged, per §5.8 of the main kickoff. Only the
per-row comparison became channel-aware.

---

## 3. F4 — proof the test can fail

The kickoff asked for both outputs. The `trap rescue INT TERM HUP QUIT` line was removed from the
generated script, the test was run, then the line was restored and it was run again. Nothing else
changed between the two runs.

### Red, with the `trap` removed

```
✘ Test aScriptKilledBetweenTheTwoMovesRestoresThePreviousBundle() recorded an issue at
  RoomSelfUpdateTests.swift:507:5: Expectation failed: fixture.version(of: fixture.resident) == "0.1.7"
✘ ... :508:5: Expectation failed: FileManager.default.isExecutableFile(atPath:
  fixture.resident.appendingPathComponent("Contents/MacOS/room-recorder").path)
✘ ... :512:5: Expectation failed: !FileManager.default.fileExists(atPath: fixture.previous.path)
✘ ... :514:22: Expectation failed: Self.readResult(fixture)
✘ Test aScriptKilledBetweenTheTwoMovesRestoresThePreviousBundle() failed after 0.375 seconds with 4 issues.
✘ Test run with 1 test in 1 suite failed after 0.376 seconds with 4 issues.
```

All four assertions fail: **the resident path is empty**, there is nothing executable at it,
`.previous` is still sitting there holding the only working bundle, and no receipt was written. That
is precisely the visit-needed state R3-1 exists to prevent, and the old test called it a pass.

### Green, with the `trap` restored

```
✔ Test aScriptKilledBetweenTheTwoMovesRestoresThePreviousBundle() passed after 0.365 seconds.
✔ Test run with 1 test in 1 suite passed after 0.365 seconds.
```

The test now asserts the specific recovery, not the absence of the worst case: resident holds
**0.1.7** and is executable, `.previous` is **gone** (consumed by the restore, not left as a second
copy), `update-result.json` records **`swap_failed`** for version **0.1.8** with a reason containing
"interrupted", and **`launchctl bootstrap`** was called.

The signal lands deterministically because the harness injects a FIFO write immediately before the
second move and the test blocks reading that pipe — opening a FIFO for reading returns only when a
writer opens it, so the test unblocks at the instant the script is inside the window and signals
there. No timing guess remains.

---

## 4. The route test — all seven fields arrive

`tests/unit/bench-commands-install-wire.test.ts`, 8 tests. It drives **the route** and asserts
against the object handed to `pollCommands` — the one place that proves a value crossed from the
query string into the write. The first cut's tests proved the app's end and the database's end and
left exactly this middle untested, which is what let F1 through.

```
carries ALL SEVEN Build R3 fields into pollCommands:
  session_open: false          update_channel: "test"
  last_update_result: "checksum_mismatch"
  last_update_version: "0.1.8"
  last_update_error: "the downloaded file did not match its checksum"
  last_update_at: "2026-09-09T09:14:00.000Z"
  disk_free_bytes: "412300000000"
```

It also pins: `session_open` as a real tri-state where **`false` survives** and `"1"`/`"yes"` are not
reported; `disk_free_bytes` rejecting `0`, `-1`, `1.5`, `9e9`, `abc`; an unparseable `last_update_at`
omitted rather than guessed; a poll with no `install_id` producing no install object at all (the
browser kiosk); a 0.1.7 app's poll still working with all seven absent; and that a poll omitting
`spare_device` is not rejected (§5.7's standing check).

**Verified it catches the original bug.** With the seven fields deleted from the route again, **5 of
the 8 tests fail**; restored, 8 pass.

---

## 5. Gates

| Command | Result |
|---|---|
| `npm run typecheck` | **GREEN** |
| `npm test` | **GREEN — 67 files, 1568 tests, all passed** (was 66 / 1551) |
| `npm run build` | **GREEN** |
| `npm run check:silent` | **RED — the same 9 pre-existing findings, exit 1.** Identical at `1193083`, all in files the contract forbids touching. Accepted per §9 of the fix kickoff; not fixed, and saying so rather than touching them. |
| `cd apps/room-recorder && swift build` | **GREEN** |
| `cd apps/room-recorder && swift test` | **501 tests / 42 suites, 46 issues** — the *identical* pre-existing set (44 tests, all `needsEnrolment`). **Zero issues in any new or changed test.** Was 492 tests; 9 new Swift tests. |

`npm test` was re-run on the Mini as asked; the counts above are its real output.

### `swift test` was NOT run at the console, and I could not make it one

**This is the one instruction I did not carry out, and it is not a thing I can do from here.** The
keychain is still locked in this session:

```
$ security show-keychain-info ~/Library/Keychains/login.keychain-db
security: SecKeychainCopySettings ...: User interaction is not allowed.
```

I run inside the session you started; I cannot move myself to a Terminal.app window on the Mini's own
screen, and unlocking the keychain needs your login password, which I will not ask for or handle. So
this gate remains **unproven, not failed** — exactly as the kickoff characterises it.

**To close it, run this yourself in Terminal.app on the Mini:**

```bash
cd ~/dev/Even-Transcription-Assistant/apps/room-recorder && swift test \
  -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
```

The flags are still needed (no Xcode.app; SwiftPM does not pass the nested swift-testing plugin
directory) — see §3.3 of the first report. Expect **501 passed** if the keychain is unlocked.

**What I can tell you positively:** all 35 `RoomSelfUpdateTests` pass here, including the nine new
ones, and the 46 remaining issues are the identical 44-test `needsEnrolment` set proved in the first
report to exist unchanged at `1193083`. Nothing in Fix 1 added an issue.

One transient appeared in a single run and did not recur:
`archive05HardLinkAliasesRemainFailClosedUnderAtomicLocks` failed once with `errno 35` (EAGAIN) on a
file lock — an unrelated flake in `ArchiveIndexPersistenceP1Tests`, not present before or after.
Worth knowing about; not caused by this work.

---

## 6. Flagged rather than decided

1. **The `.previous` restore now happens in two places.** The trap's `rescue` and step 8.5's explicit
   rollback both restore `.previous`, and step 8.4's failure branch does too. That is deliberate —
   each covers a different failure — but it means three call sites must stay in agreement about what
   "restore" means. If you want one, it needs a shell function and a small rewrite of a script V has
   already reviewed, so I left it.
2. **The hold's 6 hours is chosen, not ratified.** The kickoff said "one retry, then hold" and "do not
   make the backoff configurable" but named no number. I used one check interval
   (`RoomSelfUpdate.retryHold`, 6 h) so a held room tries again the next morning rather than never.
   **Ratify or change it.**
3. **`handoverGrace` is 10 minutes, also chosen.** It bounds how long a dead swap script can keep the
   staging directory alive. Generous for a ~90 MB bundle plus a `codesign --deep`; if a clinic Mac's
   disk is slower than that it would sweep a live handover. Ratify.
4. **The hold's sentence on the card is appended to the receipt's reason.** When the second failure
   lands, `RoomEngine` adds *"This Mac has stopped retrying that version; publish a different one to
   clear it."* to the reason before reporting it (`RoomEngine.swift:672-683`). That satisfies
   "record the hold so the card can show it" without a ninth column, but it does mean the sentence in
   `last_update_error` is not verbatim what the swap script wrote. Flagging because §5.5 is strict
   about who authors a reported value — this clause is authored by the app, from a count it made, not
   by the script.
5. **`update_channel` is still not settable by a verb.** Unchanged from the first report (§8.11,
   accepted). Home Office reaches `test` by hand-editing `config.json`; the procedure is in §9.3 of
   the first report.
6. **Migration 0078 still has not been run anywhere**, and it now carries seven columns. It remains
   additive and idempotent, safe whatever the applied state of 0075–0077 turns out to be. Every SQL
   string in §5 of the first report stands, plus `last_update_version` in the same three statements.
7. **One file outside both contract lists had to change, and I am flagging it rather than
   pretending it was covered.** `app/api/admin/bench/fleet/route.ts` appears on neither the editable
   nor the untouched list of the main kickoff's §6, exactly like `app/api/bench/commands/route.ts`
   did. F6 adds a required `releases` field to `FleetPayload`, and that route builds a `FleetPayload`
   literal in its fail-safe catch block, so it does not compile without the field. **The change is
   one line** — `releases: { stable: null, test: null }` in the degraded fallback. Nothing else in
   that route was touched. If you would rather it had been flagged before it was edited, say so and
   I will treat an uncompilable middle as a stop next time.
8. **The stray `CLAUDE.md` is still untracked and still not committed**, per your ruling. **Two more
   untracked files appeared during this session, also from outside this work:**
   `docs/handoff/ETA-CARRYOVER-PROMPT-9-SEP-2026-EOD-MASTER.md` and
   `docs/handoff/ETA-ORCHESTRATOR-MEMORY.md`. Neither is in any contract; neither was staged or
   committed; both are sitting in your working tree.
9. **The seven acceptance items are still all unrun.** Item 6 is now proved *in test* under SIGTERM;
   that is not the same as proving it on Home Office, and the kickoff's own words apply — it must be
   proven, not argued. Run it with `kill`, never `kill -9`.

---

## 7. One line

Four blockers closed and four smaller items folded in; the wire gap that would have silently deleted
the tape warning in every room is closed and now has a test that fails without the fix — but
`swift test` at the console is still yours to run, and nothing has been proven in a room.
