# ETA R4-A REFUTER VERDICT — 0.1.21 — 11 Sep 2026

**ACCEPT.** `5af9075`. `git diff 07dabbf..HEAD -- apps/`: 11 files, all on the R4-A list.

**Rerun.** `swift test` (CLT flags): `Test run with 582 tests in 47 suites passed`, exit 0. Zip via `ditto -x -k`: leaf verify exit 0; DR = 0.1.20 zip's (app, tapewriter, ffmpeg); `CDHash=67c228e66bfc74fbfb98863db9913a859dbbff04`; plist `0.1.21`; `anchor trusted` 0/0/0; sha256 `02658e6a…e158` = release.json, `version 0.1.21`.

1. No. `segment.process.interrupt()` / `waitUntilExit()` precede `startCapture`, which guards `!hasActiveCapture`; `sessionID` is never assigned.
2. No partial file: `data.write(to: destination, options: [.atomic])`, 0600. Keys `RoomConfiguration` does not model are dropped: the existing writer's behaviour.
3. No. `command = try? BenchCommand(from: decoder)`; `args` is any `JSONValue`. Only a non-array `commands` still fails the poll.
4. No. `min(max(value, 0), 1)`; `mScope: kAudioDevicePropertyScopeInput`; the only `AudioObjectSetPropertyData`.
5. The old device: `restoreDeviceUID(previousUID)`, reopen; else `phase = .failed`, reconciliation.
6. Cut and spooled (`publishAvailable(segment: &segment, finalFlush: true)`) before the new segment opens; uploaded afterwards by `drainPending`. No audio lost; the gap is recorded in `initialGapBeforeMS`.
7. Yes. `guard let running = capture, running.process.isRunning else { return nil }`; the test asserts `launcher.launchedDevices.isEmpty`.

**Note.** If the device is lost after a successful switch, config still names it.
