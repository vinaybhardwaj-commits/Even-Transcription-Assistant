# ETA carryover, install and fleet module, 7 September 2026 EOD

Spin up from this file. It adds to `ETA-CARRYOVER-PROMPT-29-AUG-2026-TRANSCRIPTION-EOD-MASTER.md`, which still governs the transcription programme. Where they disagree on the install module, this one is right.

## 1. Read first

The record is `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` (this folder and `docs/handoff/` in the repo). §1 is the decisions log (D1 to D13, all ratified). §12 is the Build R1 addendum with the six rulings and what carries into R2. The build report is `docs/handoff/ETA-INSTALL-BUILD-R1-REPORT-7-SEP-2026.md` in the repo, with a copy-pasteable acceptance runbook in its §3.

Two brains as before. Claude Code now runs on the Mini: `ssh mini`, then `cd ~/dev/Even-Transcription-Assistant`. That folder is shared to V's MacBook as `/Volumes/MiniDev/Even-Transcription-Assistant`. V's own `~/dev/Even-Transcription-Assistant` clone is a separate checkout and was at `d7df4b1` when the session closed. Pull it before use.

## 2. What shipped on 7 September

Build R1 on `feat/room-recorder`, promoted to production at `61b6e13`. Migration `0075_room_install` applied. Vercel Blob store `eta-releases` created and linked. The Install and fleet card is live in `/admin/bench` with its gate closed: no release row, every Copy button disabled, five rooms listed.

What the module is: V picks a room on the Bench page, clicks Copy install command, pastes one line into Terminal on the room Mac, presses Return. The script downloads the signed app from Blob, verifies it, installs it into `~/Applications`, enrols the Mac with a one-time token for a 365-day room session, and starts the LaunchAgent. No Gatekeeper, no admin password, no PIN typed. A five-step checklist fills in from the app's own polls.

## 3. Verify before trusting

- Cache-bust `https://www.evenscribe.app/api/health`, expect `61b6e13`.
- `GET /api/run-migrations` lists through 75.
- `GET /api/admin/bench/fleet` with `Bearer MIGRATION_SECRET` (through Claude Code) expects `room_count 5`, `latest_release null`.
- `vercel promote` rebuilds the commit against production env. The production artifact is not the one acceptance ran on.

## 4. Next: Build R2, the app

R2 cannot start until two prerequisites V owns are closed:

- X1: the in-house code-signing certificate `EvenScribe Room Recorder Code Signing 1`, created and trusted on the build Mac, by Claude Code driving `security` on that Mac. Escrow specifics are builder authority.
- X3: a build Mac with Xcode command line tools. The Mini is the natural choice since Claude Code already runs there.

Then the R2 kickoff (unwritten) covers: bundle assembler in `apps/room-recorder/Packaging/`, Info.plist per PRD §5.2, the `enrol --token --origin` CLI verb (no TTY), keychain storage, the seven poll fields with their derivations, vendored ffmpeg (X2 ruled: ship it with LGPL notices), signing, output `EvenScribe-Room-Recorder-<version>.zip` plus `release.json`, publish through Blob and `POST /api/admin/releases`. Acceptance is PRD §8 Build R2, plus the six carried items in PRD §12.3, plus the two hazards the builder must prove on the first real Mac (PRD §9): launchd-started tapewriter raises the mic prompt for the logged-in user, and `launchctl bootstrap` works from `curl | bash`.

## 5. Carried and owed

- Items 1 and 7 of R1 acceptance need a SQL session into production. Claude Code cannot get one (Vercel marks all DB credentials sensitive). A Neon console session closes both, and deletes the probe install row `install_7fs9pxt8gdcf`.
- `room_bootstrap_token.install_id` foreign key missing. Add in R2's migration.
- The transcription programme's owed list from 29 Aug is unchanged: disarm env state unobserved, nightly coverage report unread, `ROOM_ENERGY_FLOOR` uncalibrated, E1 to E4 pending, tuning-fork clip, gold re-listen, Gemini flips, 11 Cardiology windows, token rotations, production-branch decision.

## 6. Rules that carried this session

- Verify on production reality, never on the report. The migration report was verified from the repo and the preview before V ran it. The Blob "token in the project" claim in my own grounding was wrong and was caught by the builder at run time.
- Acceptance runs through Claude Code with the secret, never V's terminal. Probe data goes to the room named OPD Test only. Never Home Office, never a clinic room.
- The page never asserts completion from its own actions. The builder proved the checklist by running the card's own `deriveSteps` against the live payload.
- Claude Code stops at authorization boundaries. Migration, store creation, and promote each waited for V's word.
