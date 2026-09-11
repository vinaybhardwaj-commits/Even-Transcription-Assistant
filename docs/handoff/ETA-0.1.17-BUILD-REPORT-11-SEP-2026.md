# ETA 0.1.17 BUILD REPORT — stale session id — 11 Sep 2026

**Commit.** `5a36727` room-recorder: 0.1.17 — a re-enrolled Mac never polls as a retired install id. Local on `vinay/release-b1`, not pushed.

**Gate.** `swift test` (with the repo's documented CLT plugin flags): `Test run with 543 tests in 44 suites passed` (535 on a clean `5dff406` copy). `npm test`: `Tests 1572 passed`. `npm run typecheck`: exit 0. `npm run build`: exit 0.

**Files.** Eight, all under `apps/room-recorder/`: `VERSION`, `main.swift`, `RoomConfiguration.swift`, `RoomEngine.swift`, `RoomEnrolment.swift`, `RoomSessionStore.swift`, `RoomSelfUpdateTests.swift`, new `RoomStaleIdentityTests.swift`. Nothing outside the contract moved.

**Four tests, fail at `5dff406` → pass.** (a) `enrolOverAStaleSessionFileLeavesItNamingTheNewInstall`: before, `file.installID == Self.enrolledID` fails. (b) `aSessionFileThatDisagreesWithConfigLosesAndIsRewritten`: 5 issues, polled as the file's id. (c) `retiredFromTheSessionFileRetriesOnceAsConfigThenStops`: 6 issues, no retry. (d) `aReEnrolmentPutsTheChannelBackOnStable`: `updateChannel == "stable"` fails. Four more tests guard the unchanged paths.

**End-to-end, Home Office** (planted `install_k54jsz5r4cyz`, config `install_539avu7gqzz5`, launch 03:00:21Z):
```
room-recorder: room session read from room-session.json
room-recorder: microphone authorized
room-recorder: room session read from room-session.json
room-recorder: room session install id install_k54jsz5r4cyz disagrees with config install_539avu7gqzz5; config wins, session file rewritten
```
The app logs nothing per poll. Proof of the successful poll: no RETIRED line, `status.json` `ready` with `last_error` null at 03:00:37Z, and `scribe_diff_room` `listening`. The file was rewritten to `539avu7gqzz5`, mode 0600. The one permitted re-bootstrap put 0.1.13 back from `~/Applications`, listening; plist checksum unchanged.

**DR.** 0.1.17 and 0.1.13 are identical: `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"`. `codesign --verify --deep --strict`: valid. `spctl` rejects both alike (in-house certificate).

**Artifact.** `apps/room-recorder/.build/release-bundle-0.1.17/EvenScribe-Room-Recorder-0.1.17.zip`, sha256 `26156d0e…b176`. Not published.

**Schema assumptions.** No SQL. A retired poll is 409 with `RETIRED` in the body (existing). The room JWT carries no install id (settled).

**Flags.**
- Deviations 1–3 accepted.
- The e2e ran from a copy whose folder name doesn't end in `.app`, so it had no updater (option A).
- 0.1.17's startup swept the stale 00:40Z handover marker and `update-staging`.
- Fleet card showed 0.1.17 ~30 s.
- `.app.previous` is 0.1.8, not 0.1.13.
- Built with `ETA_ALLOW_DIRTY_BUILD=1` (V's unbundled docs).
- A config-less Mac keeps the file's id.

**Manual steps, subagents.** None.

**Follow-on: server-assigned channel.** Change 4 makes `test` a hand edit after every paste. Instead, the bench card could store each install's channel and the poll response carry it. The app would trust it one way only: the server can move a Mac to `stable`, never to `test`. That keeps the R3-8 valve per Mac. Not built.
