# ETA R4-A BUILD REPORT — Room Recorder 0.1.21 — 11 Sep 2026

**Commit.** `5af9075` room-recorder: 0.1.21 — R4-A set_audio_input, app half. `vinay/release-b1`, above R4-S `8f1f481`; not pushed.

**`--stat`:** 12 files, +1653/−59: six contract sources, three test files (two new), `VERSION`, `CHANGELOG.md`, kickoff. Nothing outside the contract.

**Gate.** `swift test` (CLT flags): `Test run with 582 tests in 47 suites passed`, exit 0 (563 before). `swift build` exit 0. npm not run: R4-S shared the clone; no TS here.

**Tests.** Three unknown-kind tests fail on `07dabbf` at run time (`dataCorrupted … commands[0].kind`) and pass now. Fifteen R4 tests do not compile on `07dabbf` and pass now, including kickoff (a), (b), (c), rollback and both volume branches.

**Artifact.** `apps/room-recorder/.build/release-bundle-0.1.21/EvenScribe-Room-Recorder-0.1.21.zip`, 4002748 bytes. Checked after `ditto -x -k`:
```
codesign --verify --strict --deep -R '= certificate leaf = H"187dd424…8edb"'  exit=0
codesign -dr -  = 0.1.20 DR                                                 exit=0
CDHash=67c228e66bfc74fbfb98863db9913a859dbbff04                             exit=0
CFBundleShortVersionString 0.1.21                                           exit=0
grep -c 'anchor trusted'  0 · 0 · 0                                         exit=1 each
sha256 02658e6a…e158 = release.json                                         exit=0
```
release.json: `0.1.21`, **`build_sha 55be1d1`**. Not published.

**SQL / schema.** None. INFERRED: the three ack keys sit top-level, where R4-D12's `cleanAckApplied(body)` reads them.

**Deviations and flags.**
- **`Recorder.swift` unchanged.** Each `seg_` is its own tapewriter process, so `RoomEngine` stops one and starts the next. No capture-owner file changed.
- **TM20 on the Mini:** `input_volume 0.5439`, `settable true`.
- `build_sha 55be1d1`: the ordered docs commit on top; `apps/` is identical to `5af9075`. Committed before the build: the script stamps `HEAD` and refuses a dirty tree.
- New reasons: `resident_archive_unsupported` (resident path refused whole), `device_switch_failed:…`, `volume_set_failed:…`, `config_write_failed:…`.
- Validation runs before anything is applied, so an unsettable target volume also blocks the switch.
- An undecodable command is dropped without an ack.
- `inputVolume` returns `value: Float?`.
- Absent device: poll fields omitted, not null.
- Failed acks may carry `input_volume_settable:false` or `applied_device_uid`.
- The ≤1.25 s gap is proven against a fake tapewriter only (real startup: D9a).
- Untested: stop-throws, restart-throws, resident refusal.

**Manual steps.** None. **Subagents.** One Opus Reviewer, advisory: no FAIL.
