# ETA B2-A BUILD REPORT — Room Recorder 0.1.20 — 11 Sep 2026

**Commit.** `74a79ea` room-recorder: 0.1.20 — Release B2 app half. Local on `vinay/release-b1`; not pushed.

**`--stat`:** 18 files, +1328/−54. Sources: `BenchClient`, `InstallPollFields`, `MachineFacts`, `RoomConfiguration`, `RoomEngine`, `RoomSelfUpdate`, `RoomSessionStore`, `TapeCore/TapeFormat`, `tapewriter/{AudioDevices,TapeWriter}`. Tests: `IndexLogTests`, `RoomInstallDeviceTests`, `RoomSelfUpdateTests`, `RoomSessionStoreTests`, new `ReleaseB2TapeMeasurementTests`. Plus `VERSION`, `CHANGELOG.md`, kickoff.

**Gate.** `swift test` (CLT flags): `Test run with 563 tests in 45 suites passed` (544/44 before). `swift build`, typecheck, `npm run build`: exit 0. `npm test`: `Tests 1621 passed`. `check:silent`: the accepted nine, all under `app/`.

**Tests, red on phase-1 stubs (0.1.19 behaviour) → green:** aSessionEndMakesTheCheckDueEvenWhenNothingWasDeferred, aDeferredCheckReRunsWhenTheSessionEnds (rewritten, ruling c), aScriptKilledBetweenTheTwoMoves… and aScriptKilledInsideTheRollback… (staging asserts), aPollResponseCarriesTheServerAssignedChannel, onlyAServerMoveToStable…, aServerMoveToStableReachesTheNextReleaseFetchWithoutARestart, twoReadsOfOneUnchangedFileLogTheReadOnce, aCheckpointWithPeakAndZeroRatioRoundTrips, peakOrZeroRatioOutsideZeroToOne…, checkpointLevelsMeasureTruePeak…, aSilentCaptureWritesAnExactZeroRatioOfOne…, theDurableSampleIndexIsCountedInSamples…, theTapeIndexIsParsedOnceAndThenOnlyItsTail, aHalfWrittenLineWaits…, peakAndZeroRatioRideThePoll…, theInputDeviceListIsSentWithTheDefaultMarked, theInputDeviceListDrops…AndCapsAtSixteen. **Green both sides (guards):** aCheckpointWrittenBefore020…StillDecodes, aTruncatedReplacedOrRewrittenIndex…, aServerAnswerThatIsNotAMoveToStableChangesNothing, factsCarryTheDeviceListIntoThePoll.

**Artifact** `apps/room-recorder/.build/release-bundle-0.1.20/EvenScribe-Room-Recorder-0.1.20.zip`, checked after `ditto -x -k`:
```
codesign --verify … -R '= certificate leaf = H"187dd424…8edb"'  explicit requirement satisfied   exit=0
codesign -dr -   identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"   exit=0  (= 0.1.19)
CDHash=d652d47ddee251fd8d91e77ea6f7d749a604ef6d   exit=0
CFBundleShortVersionString 0.1.20   exit=0
grep -c 'anchor trusted'  room-recorder 0 · tapewriter 0 · ffmpeg 0   exit=1 each (no match)
shasum 83278526712f516f84e16e38e555b2888c854c16d195a61283fdf439b4c0ab9c = release.json   exit=0
```
`size_bytes` 3984181; `build_sha` 74a79ea. Not published.

**Dirty tree.** Clean at build; `ETA_ALLOW_DIRTY_BUILD` not set.

**Deviations and flags.**
- Contract widened by the orchestrator (ruling a, 18:30): `Sources/TapeCore/TapeFormat.swift`.
- Flake: one full run failed `archive05HardLinkAliasesRemainFailClosedUnderAtomicLocks` (`lockFailed … errno 35`), an untouched suite; it passed alone and in the two full runs after.
- The resident-archive lane (off on every Mac) sends no `peak`/`zero_ratio`.
- `+` in a device name reaches the server as a space: `BenchClient` query encoding, unchanged.
- D12 sweeps only after a successful restore.
- Rollout item 6: a `kill` during `sleep 3` fires `rescue()` with the resident intact — no restore, no receipt.

**SQL / manual steps.** None. **Subagents.** One Opus Reviewer, advisory self-check of the diff; its result was still pending when this report was committed and is relayed in chat.

## Rollout

Published `test` `rel_neygnnarrp2q`, `stable` `rel_fpscgwpuqqys`, sha256 `83278526…ab9c`. Home Office swapped 13:37:38Z, ack 2 s. Item 5 PASS: `0.1.20-bad` stopped `signature_mismatch: the downloaded app was not signed by Even`, resident unchanged, `rel_cdgjnjpjhqb6` withdrawn; the row keeps that result after withdraw (COALESCE). Item 6 waived: a `kill` in `sleep 3` finds the resident intact. Room 4.1 13:51:47Z; Cardiology 13:59:04Z, OPD 3 13:59:31Z, OPD 5 13:59:49Z, OPD 6 14:00:09Z, OPD 7 14:00:27Z. Fleet 14:02:17Z: seven `0.1.20` rows, ids unchanged; OPD 1/OPD 4 `0.1.8`. Withdrawn (HTTP 200 ×6): test 0.1.17/0.1.13/0.1.10/0.1.8, stable 0.1.8/0.1.7. **OPD 3 and OPD 7: `peak 0`, `zero_ratio 1`, tape advancing, 14:02Z and 14:03Z — TONOR recording silence.**
