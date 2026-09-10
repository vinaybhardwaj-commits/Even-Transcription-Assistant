# ETA Install Build B1 — the launch canary

**Kickoff for Claude Code. Paste this whole file.** Same session, same machine.

Working directory: `~/dev/Even-Transcription-Assistant` on the Mini. Base: branch `vinay/r3-self-update` at **`2e4cf37`**.
**Create branch `vinay/release-b1` from it. Commit on the branch, do not push, do not touch `main` or `feat/room-recorder`.**

Read first, in this order: the repo's `CLAUDE.md`; `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-RELEASE-B1-ADDENDUM-10-SEP-2026.md`
(§14, governing; every decision is settled — do not reopen, flag instead); `docs/handoff/ETA-INSTALL-BUILD-R3-FIX2-VERDICT-9-SEP-2026.md`
(G2 residual); `docs/handoff/ETA-INSTALL-BUILD-R3-ACCEPTANCE-VERDICT-10-SEP-2026.md` (finding 3, the needsEnrolment diagnosis).

## Pre-flight
`pwd`, `git remote -v`, `git status --porcelain`, `git rev-parse HEAD` (must be `2e4cf37`). Untracked `docs/handoff/*` files are
expected; anything else STOP and report. Then `git checkout -b vinay/release-b1`.

## Grounding (read before writing code)
- `apps/room-recorder/Sources/RoomRecorderCore/RoomSelfUpdate.swift` — `RoomSwapScript.render` (`:875-1007`): `PREVIOUS` at
  `:875`, `rescue` trap `:955-964`, `bootstrap_agent` `:942-945`, `record` `:927-938`, step 8.6 `:1006`. `RoomUpdateHandover`,
  `RoomUpdateAttempts` (`:294-309`), `roomUpdateCountStartupReceipt` (`:380-389`), `spawnDetached` (`:506-543`).
- `apps/room-recorder/Sources/RoomRecorderCore/RoomEngine.swift` — `init` `:610-713` (marker clear at `:273` in the diff
  numbering, ~`:661` in file), poll loop `:917-973`, receipt delete `:967-973`.
- `apps/room-recorder/Sources/RoomRecorderCLI/main.swift` — plist `:281-306`, exit paths `:180-230`, `:317-328`.
- `apps/room-recorder/Tests/TapeCoreTests/RoomSelfUpdateTests.swift` — `Fixture`, `stubTools`, `runSwapScript`
  (`killInsideTheWindow` FIFO pattern), `RecordingRunner`.
- `apps/room-recorder/Tests/TapeCoreTests/RoomSessionFromKeychainTests.swift` — the `enrolmentReader:` injection to copy.

## B1-1 Watchdog in the swap script (§14.2 steps 1–4)
After `record ok null`: write `update-canary.json` atomically with keys `version`, `previous`, `armed_at` (§14.2.1; `previous`
read with `/usr/bin/plutil -extract CFBundleShortVersionString raw "$PREVIOUS/Contents/Info.plist"`, `null` on failure). Keep the
handover marker. After `bootstrap_agent`: loop `CANARY_SECONDS=180` in `CANARY_SLICE=2` slices; exit 0 when the file is gone;
on timeout do exactly §14.2.3 in that order and log each step to `update.log`. The receipt reason is the literal
`the new version did not poll within 180 s; restored <old>` with `<old>` from the canary file's `previous` (or `unknown`).
JSON-escape via the existing `jsonStringBody` path. Never touch `.previous` on the success path except in the rollback.

## B1-2 App acknowledgement (§14.2 steps 5–6)
`RoomEngine`: a pure helper `roomCanaryAcknowledge(root:) -> String?` that deletes `update-canary.json` if present and returns
its `version`; call it after every successful `pollCommands` return, before the receipt delete; on a returned version log
`canary passed for <version>` and clear `RoomUpdateHandover`. Remove the marker-clear-on-receipt in `init`. `RoomUpdateHandover`
and staging sweep otherwise unchanged.

## B1-3 Break-on-launch hook (§14.2 step 7, D7)
`main.swift`: before `RoomEngine.load`, if `<root>/break-on-launch` exists, write `room-recorder: break-on-launch present; exiting 1`
to stderr and `exit(1)`. Nothing else in `main.swift` changes.

## B1-4 Ledger stamp (D8)
`RoomUpdateAttempts` gains `countedReceiptAt: Date?` (`CodingKeys` `counted_receipt_at`). `roomUpdateCountStartupReceipt`
returns nil without writing when `receipt.at == previous?.countedReceiptAt`; otherwise records and stamps. Flip the existing test
that asserts the double count.

## B1-5 needsEnrolment fixture (D9)
Inject a stub `enrolmentReader:` returning a fixed `RoomKeychainRecord` in every `RoomEngine.load(` call in
`RoomEngineResidentCaptureTests.swift`, `RoomEngineRecoveryBarrierTests.swift`, and the `key03FreshProvision…` test in
`ArchiveKeyLifecycleP1Tests.swift`. No production code change. Target: 0 issues over SSH.

## B1-6 Packaging
`Packaging/VERSION` → `0.1.11`. `Packaging/build-bundle.sh:101-107`: replace the "Run this script from Terminal.app…" message
with: `the signing key is present but unusable in this session. Over SSH run: security unlock-keychain ~/Library/Keychains/login.keychain-db
then security set-key-partition-list -S apple-tool:,apple: -s ~/Library/Keychains/login.keychain-db (password at the prompt), and retry.`
Keep the check itself.

## Tests (all new, in `RoomSelfUpdateTests.swift` unless stated)
1. `theWatchdogExitsWhenTheCanaryIsAcknowledged` — harness rewrites `CANARY_SECONDS=180`→`4`, `CANARY_SLICE=2`→`1`; delete the
   canary file 1 s after bootstrap; script exits 0 within 3 s; resident still new; `.previous` still present.
2. `theWatchdogRollsBackWhenNobodyPolls` — same rewrite; nobody deletes the file; after timeout resident == old version, `.previous`
   absent, receipt `swap_failed` with the literal reason naming the old version, `launchctl bootout` then `bootstrap` in the log.
3. `aScriptKilledInsideTheRollbackRestoresThePreviousBundle` — FIFO rendezvous injected before the rollback's `mv "$PREVIOUS"`; SIGTERM;
   assert the rescue outcome. Prove it can fail as F4 did (remove the trap, red; restore, green) — both outputs in the report.
4. `theAppAcknowledgesTheCanaryOnItsFirstSuccessfulPoll` — engine test with a stub remote: marker + canary present at init; after one
   poll both gone; log line present. And `aReceiptAloneDoesNotClearTheHandoverMarker`.
5. `breakOnLaunchExitsOne` — can be a `Process` test of the built binary or a unit of the guard function; state which.
6. `aSwapFailedReceiptIsCountedOnceAcrossRestarts` — two inits, one receipt, one failure.
7. `swift test` over SSH: **510 + new, 0 issues.**

## File contract
**Editable:** `RoomSelfUpdate.swift`, `RoomEngine.swift`, `RoomRecorderCLI/main.swift` (B1-3 only), `RoomSelfUpdateTests.swift`,
`RoomEngineResidentCaptureTests.swift`, `RoomEngineRecoveryBarrierTests.swift`, `ArchiveKeyLifecycleP1Tests.swift` (B1-5 only),
`Packaging/VERSION`, `Packaging/build-bundle.sh` (message only), `docs/BUILD-HISTORY.md`, `docs/handoff/` (this kickoff, your report).
**Untouched:** everything under `lib/`, `app/`, `db/`, `components/`; `InstallPollFields.swift`; `BenchClient.swift`; `TapeWriter.swift`;
`PrimaryResident*`; the PRD and its addenda. A file you need that is on neither list is a spec gap: **flag it and stop that item**, do not
widen the contract.

## Gates
`npm run typecheck`, `npm test`, `npm run build` (server untouched — say so, still run them), `npm run check:silent` (9 pre-existing
accepted), `swift build`, `swift test` over SSH with 0 issues. Do not build or sign a bundle; the orchestrator does that after review.

## Report
`docs/handoff/ETA-INSTALL-BUILD-B1-REPORT-10-SEP-2026.md`: sha; B1-1…B1-6 with file:line; the rendered watchdog block quoted verbatim;
test 3's red and green outputs; all gates with real numbers; anything flagged rather than decided. Cap 150 lines.
