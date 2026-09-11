# ETA KICKOFF — B2-A "Room Recorder 0.1.20: the app half of Release B2" — 11 Sep 2026, 18:25 IST

Builder brief for Claude Code on the Mini (tmux `scribe`, **after `/clear`** — this brief is self-contained). Refuter (Opus, tmux
`scribe2`, never the builder) runs after. Orchestrator: Fable (Cowork). Spec = `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-RELEASE-B2-ADDENDUM-11-SEP-2026.md`
decisions **D2, D5 (app side), D7, D8, D9, D10, D11, D12**, ratified by V 18:12 IST. Read it first, then this. Nothing publishes
without V. Passwords never through `!` (rule 24); V unlocks the keychain in a Terminal window before the build.

## Goal
0.1.20 makes a clinic Mac measurable and steerable from the desk: it reports true peak, exact-zero ratio and every input device;
it honours a server move to `stable`; it checks for updates at every session end; and it stops reparsing the tape index every
1.5 s. Server side (B2-S, `e908b84`) is already in production and accepts every new field.

## Known facts (verified 11 Sep)
- Repo `~/dev/Even-Transcription-Assistant`, branch `vinay/release-b1`, HEAD `47733a2` = origin. Production `e908b84`, migrations
  through 0079. `Packaging/VERSION` = `0.1.19`; **next version string 0.1.20** (rule 11). `swift test` (CLT plugin flags) = 544 tests /
  44 suites at `da58a4c`.
- Server intake (B2-S): poll route reads `peak` (0–1), `zero_ratio` (0–1), `input_devices` (JSON array ≤16 of `{name ≤128, uid ≤256,
  is_default}`) — all optional, COALESCE on absence; poll **response** carries `assigned_channel` (`null` or `"stable"`), returned from
  the same UPDATE (`lib/bench-commands.ts:172,286`); the server clears it when the app reports `update_channel=stable`
  (`lib/room-install.ts:1024`). The app already sends `update_channel` on every poll (`RoomEngine.swift:1091`).
- App poll fields: `InstallPollFields.swift` (`tape_advancing :174`, `input_device_name :182`). Device name: `MachineFacts.swift:92`
  `inputDeviceName(forUID:)`; CoreAudio enumeration hook `tapewriter/AudioDevices.swift:46` (`kAudioHardwarePropertyDevices`).
- Poll response decoding: `CommandPollResponse.init(from:)` (`BenchClient.swift:201`) — keyed container, unknown keys ignored; add
  the new key there.
- Update schedule: `RoomUpdateSchedule.isDue` (`RoomSelfUpdate.swift:557-560`):
  `guard let last = lastCheckedAt else { return true }; if deferredWhileRecording && sessionJustEnded { return true }; return now - last >= checkInterval`.
  Wiring: `RoomEngine.swift:491` `sessionEndedSinceUpdateCheck`, `:946` set on `justEnded`, `:949` `isDue(...)`, `:952` cleared.
  Evidence for D2: 11 Sep 11:42Z, five rooms' tapes stopped after `stable` moved — no check fired (nothing deferred); all five
  needed `kickstart -k`.
- Channel: `RoomConfiguration.swift:197` CodingKey `update_channel`; `applyEnrolment` `:520` resets to `"stable"`; comment `:176-182`.
- Levels: `TapeWriter.swift:256-260` is the only per-sample loop (RMS: `squaredSum += normalized*normalized`); `rms` computed `:212`,
  reported `:226`. No peak, no zero count exists anywhere in the file.
- `tape_advancing`: `RoomEngine.swift:474` compares an index file's byte length against a sample count (unit mismatch).
- `currentLevels()`: `RoomEngine.swift:294` and `:2846`, `PrimaryResidentArchiveCaptureOwner.swift:498`, `ResidentAudioCaptureLane.swift:134`,
  `ResidentArchiveLaneWriter.swift:182`; called `RoomEngine.swift:1105`. Today it reparses the whole tape index every 1.5 s.
- Session-read log: `RoomSessionStore.swift:89` logs `room session read from room-session.json` on every read; launch reads twice
  (visible in every `launchd.log` tail today: read → `microphone authorized` → read).
- Swap script: `rescue()` `RoomSelfUpdate.swift:1112`, `trap rescue INT TERM HUP QUIT` `:1126`, `.previous` `:1007`. B1 report §280:
  a script killed in the empty-resident window is rescued but the ~90 MB staged copy is never deleted.
- Build: `Packaging/build-bundle.sh` unchanged since 0.1.19; `ETA_ALLOW_DIRTY_BUILD=1` acceptable if only `docs/handoff/` is dirty.
  Leaf requirement `= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"`; 0.1.19 DR
  `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"`.

## Exact scope (eight changes + version)
1. **D2** `isDue`: `guard let last = lastCheckedAt else { return true }; if sessionJustEnded { return true }; return interval`.
   Keep `deferredWhileRecording` as a field (the log line at `:794` and the fleet reason still use it). Update the doc comment.
   Test: schedule with `lastCheckedAt` 1 min ago, not deferred, `sessionJustEnded: true` → due (fails before, passes after).
2. **D5 app side**: decode `assigned_channel` in `CommandPollResponse`; in `RoomEngine`'s poll handling, if it equals `"stable"` and
   `configuration.updateChannel != "stable"`, set the channel to `stable`, persist config.json, log
   `channel moved to stable by the server`. Any other value (`nil`, `"test"`, junk) is ignored. Tests: stable applied once;
   `"test"` ignored; nil ignored; a Mac already on stable is untouched.
3. **D7**: in the `TapeWriter.swift:256-260` loop track `peakAbs = max(peakAbs, abs(normalized))` and `zeroCount += (sample == 0)`;
   emit `peak` (0–1) and `zero_ratio` (zeroCount / sampleCount) beside `rms` through the same path that reaches
   `InstallPollFields`; poll field names exactly `peak` and `zero_ratio`. Test with a synthetic buffer: known peak, known zero ratio.
4. **D8**: `RoomEngine.swift:474` — compare like with like (both in samples, or both in bytes). Unit test that fails on the old
   comparison with a crafted index/sample pair.
5. **D9**: `currentLevels()` reads only the tail of the tape index since the last read (remember offset/entry count); same output.
   Test: fixture index of N entries parsed once, then the tail only (count parse calls).
6. **D10**: enumerate input devices via `AudioDevices.swift`; poll field `input_devices` = JSON array of `{name, uid, is_default}`,
   ≤16 entries, beside the existing `input_device_name`. Test: encoding of a two-device fixture with one default.
7. **D11**: `RoomSessionStore.swift:89` — log once per launch (cache the first read, or log only on a changed file). Test:
   two reads on launch → one log line.
8. **D12**: `rescue()` removes the staging directory after its restore `mv`; the existing FIFO kill test additionally asserts the
   directory is gone.
9. `Packaging/VERSION` → `0.1.20`; `CHANGELOG.md` line above 0.1.19:
   `- **0.1.20** — peak and exact-zero measurement; input-device list; server may move a Mac to stable; update check at every session end; incremental level reads; one session-read log line; rescue sweeps staging.`

Out of scope: `build-bundle.sh`, the enrol path, the swap script's move order, the release routes, anything under `app/`, `lib/`,
`components/`, `db/`.

## Allowed changes
`apps/room-recorder/Sources/RoomRecorderCore/{RoomSelfUpdate,RoomEngine,RoomConfiguration,RoomSessionStore,BenchClient,MachineFacts,InstallPollFields,PrimaryResidentArchiveCaptureOwner}.swift`
· `apps/room-recorder/Sources/tapewriter/{TapeWriter,AudioDevices,ResidentAudioCaptureLane,ResidentArchiveLaneWriter}.swift` ·
`apps/room-recorder/Tests/**` · `apps/room-recorder/Packaging/VERSION` · `apps/room-recorder/CHANGELOG.md` · `docs/handoff/` (this kickoff, your
report). Nothing else. A file outside this list that must change → STOP and name it.

## What to verify (Builder runs; Refuter reruns)
- `swift test` with the CLT plugin flags: report the count (544 before; every new test named, each shown failing before / passing after).
- Build + sign (`Packaging/build-bundle.sh "$PWD/.build/release-bundle-0.1.20"`, V unlocks the keychain first). On the bundle, with
  exit codes: leaf-only `codesign --verify --strict --deep --verbose=4 -R …` → 0; `codesign -dr -` = 0.1.19 DR; CDHash;
  `CFBundleShortVersionString` 0.1.20; `/usr/bin/grep -c 'anchor trusted'` on all three binaries → 0; zip sha256 = `release.json`.
- **Local end-to-end on Home Office is NOT part of the build** — the app is proven by the rollout (below). Stage the artifact and stop.
- Do not publish, do not push, do not touch any room, config.json or LaunchAgent.

## Output
`docs/handoff/ETA-B2-A-BUILD-REPORT-11-SEP-2026.md`, cap 350 words: commit sha + subject; `--stat`; test count; new tests by name with
fail→pass; the six codesign lines; artifact path, sha256, size_bytes, CDHash; dirty-tree finding; deviations. Commit on
`vinay/release-b1` with this kickoff. Chat reply: sha, count, CDHash, sha256, artifact path — deviations only beyond that.

## Refuter brief (tmux `scribe2`, fresh session or `/clear` first)
Read `git diff 47733a2..HEAD` only. Confirm the file list ⊆ "Allowed changes". Rerun the suite. Unpack the zip with `ditto -x -k`,
rerun the six codesign/plutil/grep/shasum checks yourself. Adversarial, quote lines: (1) can D5 ever move a Mac to `test`, or move a
Mac on `test` to `stable` on a `null`/junk response? (2) does D2 fire a check while a session is still open (it must not — the
deferral must still hold)? (3) can D7's `zero_ratio` divide by zero on an empty buffer? (4) does D9's incremental read miss entries when
the index is truncated or rotated? (5) does D12's sweep ever delete the resident bundle or `.previous`? (6) does D10 ever exceed 16
entries or send a uid longer than 256? Verdict ACCEPT / REJECT + failing line, ≤200 words, to
`docs/handoff/ETA-B2-A-REFUTER-VERDICT-11-SEP-2026.md`.

## Rollout after ACCEPT (V orders each step; Fable reads the evidence)
1. Publish 0.1.20 to `test` (10 Sep runbook §4 recipe, new Blob key `room-recorder/EvenScribe-Room-Recorder-0.1.20.zip`,
   `allowOverwrite:false`).
2. **D14 item 6 — live kill, on the FIRST Home Office attempt** (no version burned): in a Terminal window on the Mini, tail
   `update.log` and, immediately after `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder`, watch for the swap script's
   `sleep` before the moves and `kill <swap.sh pid>` (never `-9`) there. Expect: rescue → `.previous` restored → `bootstrap_agent` →
   0.1.19 polls again; ledger counts one failure; card names the reason (D4). Then `kickstart -k` once more: the one retry allowed swaps
   0.1.20 for real → canary ack. Fleet row `0.1.20 / ok`; `peak`, `zero_ratio`, `input_devices` populated on the card. If the kill lands
   outside the window (swap completes), item 6 is waived — the FIFO test covers it deterministically — and the rollout continues.
3. **D14 item 5 — corrupted zip:** publish a deliberately damaged copy of the same zip as version `0.1.20-bad` to `test` (flip one byte
   inside the bundle, recompute sha256 so the manifest is honest); `kickstart -k` Home Office; expect `update to 0.1.20-bad stopped:
   signature_mismatch …` (or `expand_failed` / `checksum_mismatch` depending on where the byte landed), resident 0.1.20 unchanged, card
   shows the sentence; withdraw `0.1.20-bad`; the next check sees 0.1.20 = running and does nothing.
4. Room 4.1 on `test` (already on `test`): `scribe_stop_recording` → `kickstart -k` over SSH → `update.log` → fleet row. Then
   `scribe_start_recording`.
5. Publish 0.1.20 to `stable` (second key). For each of the other five: stop tape via MCP → `kickstart -k` (11 Sep loop paste) →
   start tape. Exit: seven rows `0.1.20 / ok`, ids unchanged, peak/zero/devices on every row.
6. Withdraw the six stale releases (0.1.17/0.1.13/0.1.10/0.1.8 `test`, 0.1.8/0.1.7 `stable`) — V's ruling of 18:20 IST.
