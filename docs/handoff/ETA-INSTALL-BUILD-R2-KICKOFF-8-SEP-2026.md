# ETA Install Build R2 — the signed app bundle, the enrol verb, and the first paste

**Kickoff for Claude Code. Paste this whole file.**

Working directory: `~/dev/Even-Transcription-Assistant` on the Mini, branch `feat/room-recorder`, HEAD `ecbd8e4` or later. **Run this session from Terminal.app on the Mini's own screen, not over SSH.** Signing needs the unlocked login keychain, which only a console session has. Verified 8 Sep: signing fails over SSH with `errSecInternalComponent` and succeeds at the console.

Spec: `docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md`. Read §5 (app contract), §8 Build R2 (acceptance), §9 (hazards), §12 (R1 addendum and carried items). R1's report `docs/handoff/ETA-INSTALL-BUILD-R1-REPORT-7-SEP-2026.md` §3 has the working curl runbook. Production serves `61b6e13`. Migrations run through `0075`. Next migration is `0076`.

Two files in `docs/handoff/` may be uncommitted from last night (the PRD with §12, and `ETA-CARRYOVER-PROMPT-7-SEP-2026-INSTALL-EOD-MASTER.md`). Commit them first, unchanged, together with this file.

All design decisions are settled: D1 to D13, the six R1 rulings in §12.1, and the three below. Do not reopen any. Flag gaps in your report.

## Ratified 8 Sep

- **X1 closed.** Identity `EvenScribe Room Recorder Code Signing 1`, SHA-1 `187DD424FB866204111113D60C6F88A21D098EDB`, certificate SHA-256 `903EDCE6F78C2199DFF45939D492041FED0C0A8394DDABB985278349BB281643`, login keychain on `Vinays-Mac-mini-3`, valid to 4 Sep 2036. Record both values in PRD §12 and pin the SHA-1 in the packaging script's verify step. Escrow is V's, not yours: do not export the key.
- **Builds happen at the console.** No scripted `unlock-keychain`, no second keychain. The packaging script assumes an unlocked login keychain and fails loudly if signing fails.
- **Deployment target is macOS 15.0**, set explicitly. The toolchain defaults to `macosx28.0`.

## 0. What kind of build this is

R2 produces the thing the R1 card hands out: a signed `EvenScribe Room Recorder.app` in a zip, and the app-side half of the paste (the `enrol` verb, keychain storage, the seven poll fields). It ends with one real paste on Home Office, which is the only room you may touch, and only when V says. Two rules govern everything here.

- **Labels derived, never typed.** `version`, `build_sha`, `sha256`, `size_bytes` come from the build. Every poll field comes from the machine at the moment of the poll (PRD §5.5 table). No constant stands in for a measurement.
- **The archive always wins.** Home Office's day tape and its uploaded pieces are untouched by anything here. The paste replaces the running process, not the data.

## 1. What to build — six items

### 2.1 Bundle assembler, `apps/room-recorder/Packaging/`

A script that builds release binaries with `swift build -c release` at deployment target 15.0, assembles `EvenScribe Room Recorder.app` per PRD §5.1 (`Contents/MacOS/room-recorder`, `Contents/Helpers/tapewriter`, `Contents/Helpers/ffmpeg`, `Contents/Info.plist`), writes the Info.plist keys of PRD §5.2 (bundle id `com.evenscribe.room-recorder`, URL scheme entry may be omitted since D2's URL scheme was withdrawn, `NSMicrophoneUsageDescription`, `LSUIElement` true, `LSMinimumSystemVersion` 15.0, `CFBundleShortVersionString` from a version file, build sha from `git rev-parse --short HEAD`), signs the helpers then the bundle with the identity above (hardened runtime, no sandbox), verifies with `codesign --verify --strict --verbose=4 -R 'anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"'`, zips with `ditto -c -k --keepParent`, and writes `release.json` (`version`, `build_sha`, `sha256`, `size_bytes`, `min_macos`, `identity_sha1`). Output `EvenScribe-Room-Recorder-<version>.zip` beside `release.json`.

The mic usage string: propose one sentence, patient-facing, in the report. V approves it before publish.

### 2.2 Vendored ffmpeg (X2 ruled: ship it)

Run `Encoder/build-ffmpeg.sh`, place the output at `Contents/Helpers/ffmpeg`, bundle the LGPL notices and the `source-lock.json` under `Contents/Resources/Licenses/`. The app calls ffmpeg by its bundle-relative path only. Remove the Homebrew absolute-path dependency from `configure` for bundle installs. Flip `production_ready` to true in the same commit with a one-line reason pointing at PRD §12 X2.

### 2.3 The `enrol` verb (PRD §5.3)

`room-recorder enrol --token <token> --origin <https origin>`. No TTY, nothing read from stdin. Posts `{ token }` to `POST /api/room-recorder/enrol` at the origin, on 200 stores session, `install_id`, `room_slug`, `room_name` and origin in the login keychain (PRD §5.4 item), writes the non-secret parts of `config.json` (origin, room slug, install id, resident paths), and exits 0. On any non-200 prints the server's error code and exits 1. `config.json` no longer holds a token; migrate an old config that has one by moving the token into the keychain on first `run`.

### 2.4 Poll fields (PRD §5.5)

`run` sends the seven fields on every poll: `install_id`, `app_version`, `build_sha`, `mic_state`, `tape_advancing`, `never_sleep`, `launched_by`. Derivations exactly per the §5.5 table. `tab_id` becomes `app_<install_id>`. On a 409 `RETIRED` the app stops polling, logs why, and exits so launchd does not thrash (use `KeepAlive` with `SuccessfulExit` false, or an exit code launchd respects).

### 2.5 Migration `0076_bootstrap_token_fk`

Add the missing foreign key `room_bootstrap_token.install_id → room_install(install_id)` (PRD §12.3 item 4). Additive, idempotent, self-recording. Not run by you.

### 2.6 Publish and the first paste

1. Build the zip. Report `release.json` and the `codesign -dv` authority line.
2. **Stop.** V ratifies the mic string and the publish.
3. Upload the zip to Blob, `POST /api/admin/releases` on channel `stable`, show the release row. The fleet card's Copy buttons are now live.
4. **Stop.** V ratifies the Home Office paste. PID 948 (the unsigned 27 Aug candidate under launchd) is the running poller; the paste boots it out.
5. V pastes on the Mini's console. You observe from the server side only: the fleet row and checklist for Home Office, the poll fields, the retire of the old install if any.
6. Run the R1 carried items that a real token allows: item 7's expired arm (mint a second token, leave it 30 minutes, then bootstrap and enrol with it, expect 404 and 400).

## 2. What not to do

- Do not paste on any room but Home Office. Do not touch Cardiology, OPD 5, OPD 7 or OPD Test.
- Do not build self-update. That is R3.
- Do not export, copy or print the private key. Do not run `security unlock-keychain`.
- Do not run migration 0076. Report it ready.
- Do not add security work. Out of scope by V's instruction.

## 3. Evidence to report

Against PRD §8 Build R2 items 1 to 8, plus §9's two hazards proven on Home Office: the mic prompt appeared for the launchd-started app and was granted, and `launchctl bootstrap` worked from `curl | bash`. Plus `security find-generic-password -s com.evenscribe.room-recorder.room-token` showing the item exists (never print its value) and `config.json` holding no token. Plus the Home Office row on the fleet card reading the true hostname, model, OS, app version, mic authorized, tape advancing, session expiry about 365 days out. Include commit shas, the release row, the exact paste command minus the token, and the launchd log lines. Add the changelog entry in the same commit as the packaging script.
