# ETA KICKOFF — Debugger "Room faults: wedged capture, bad fd, tapewriter exit 1" — 12 Sep 2026, 10:45 IST

Debugger brief (Opus) for Claude Code on the Mini, **tmux `scribe`, after `/clear`, `/model opus`**. Root-cause work only — **no code
changes, no commits, no room commands, no SSH to any room, no `.env.local`.** Read-only over the repo and the evidence directory
`~/dev/eta-evidence/12-sep/` (V pulls the room logs there before you start). Passwords never through `!`.

## Goal
Name the root cause, with quoted lines, of each of the three faults below, and say for each whether it is a 0.1.21 regression or older.
Then say which of playbook items B1, B2, B4, B5, B6 actually fixes it and what the fix must touch (file:line). That report is the whole
input to the 0.1.22 / server-pair Builder brief; a guess costs a clinic day.

## Known facts (verified 12 Sep 04:47Z from Scribe MCP; do not re-derive, do check the code against them)
- Fleet: seven Macs on 0.1.21 (`stable`), Home Office / Room 4.1 on `test`. Branch `vinay/release-b1` = origin `d4821ec`. Production `5ff2ae0`,
  migrations through 0080. Each of 0.1.18–0.1.21 has a kickoff, build report and Refuter verdict in `docs/handoff/` (the playbook's C4.4 is
  wrong on that). The playbook cites HEAD `5dff406`→`5a36727` and a 0.1.17 kickoff — **first task: `git branch -a --contains 5a36727` and
  `git log --oneline -3 5a36727`; report whether that work is on our branch, another branch, or missing.**
- Playbook = `docs/handoff/ETA-ROOM-FAULT-PLAYBOOK-AND-RELEASE-SPEC-12-SEP-2026.md`. Its C3 "every room now on C270" is deliberate: OPD 3 /
  OPD 7 were switched by `set_audio_input` at 15:33Z / 15:34Z on 11 Sep (dead TM20s). Not a 0.1.21 default-device change.
- **Fault 1 — A4, tapewriter exit 1.** Room 4.1 `start_day` failed `tapewriter exited with status 1` ×6 today 03:20–04:20Z, ~×20 on 11 Sep
  from 03:29Z; Cardiology 11 Sep 03:28–03:30Z. Recovers only by hand on the webcam. `tapewriter.log`: `Audio acquisition cycle 1/2/3
  produced no durable growth` → `physical_fallback_required`. Exit reason is written at `RoomEngine.swift:3261` (playbook claim — verify).
- **Fault 2 — A2, wedged capture.** OPD 5 `bs_mmxqanb7` today: acked start, `recording: true`, 0 chunks, reaper-ended at 30 min. OPD 3
  11 Sep 10:41 IST silent 3.5 h. `end_day` on the wedged session fails `NSPOSIXErrorDomain Code=9 Bad file descriptor`.
- **Fault 3 — EBADF on end_day, older.** OPD 1/3/4/5/6 `end_day` → EBADF at 11 Sep 03:52Z. Those Macs were on **0.1.8** then (0.1.19 was
  the first self-update, 11 Sep ~06:00Z). So EBADF predates 0.1.19; the question is whether 0.1.20/0.1.21 changed its frequency.
- OPD 7 today: cue `mic_primary_lost` 03:58Z, session `bs_b8xav2j3` ended `lost_no_backup`; a new session `bs_b4fvbgze` is recording.
- Rollouts 11 Sep were `launchctl kickstart -k` while tape was stopped by MCP; 0.1.21 self-updated overnight on its own timer on most rooms.
  Self-update = `RoomSelfUpdate.swift` swap script + 180 s canary + `.previous`.
- Capture path: `tapewriter/Recorder.swift:76` `CaptureSession.init` → `AudioDevices.selectDevice(_:on:)` (`AudioDevices.swift:123`);
  segments `captures/<bs_>/seg_<uuid>/tape.idx`; owners `PrimaryResidentArchiveCaptureOwner.swift`, `ResidentAudioCaptureLane.swift`;
  R4-A (0.1.21, `5af9075`) added device reopen-in-new-segment on `set_audio_input` — the one 0.1.21 change that touches the capture handle.
  Dispatch `RoomEngine.swift:1472 handle(_:)`; ack `:1903` → `BenchClient.swift:500`.
- Evidence dir layout: `~/dev/eta-evidence/12-sep/<room>/` with `launchd.log`, `update.log`, `config.json`, `room-session.json`, `status.json`
  and every `tapewriter.log` modified in the last 2 days (path kept). Rooms: `room41`, `opd5`, `opd7`. If a directory is missing, say so
  and work from source + the other rooms; do not wait.

## Exact scope (answer each, quote lines)
1. **Exit 1 path.** From `physical_fallback_required` back to the process exit: what loop produces "no durable growth", what it measures
   (bytes? frames? file size?), how long each cycle is, and what — if anything — it retries. Does it ever reopen the device or try a second
   opener? Is `sudo killall coreaudiod` irrelevant because the device is wedged below CoreAudio (USB), or because the app holds a stale
   `AudioObjectID`? State what evidence in `room41/…/tapewriter.log` decides it.
2. **Wedge path.** How does a session reach `recording: true` with the tapewriter dead or its fd closed, and nothing notices for 30 min?
   Find the fd owner and every place it can be closed or invalidated (device removal callback, swap-script relaunch, `set_audio_input`
   reopen, sleep/wake). Which one happened on OPD 5 today — the `launchd.log` / `update.log` timestamps around 03:20Z decide it.
3. **EBADF.** Where `Code=9` surfaces on `end_day` (file:line), what handle it is (tape file? pipe to tapewriter? socket?), and whether
   0.1.20's session-end update check (`isDue` change) or 0.1.21's reopen can close it while a session is open. Regression or not, with
   the commit that decides it.
4. **`mic_primary_lost` / `lost_no_backup`** on OPD 7: what raises the cue, whether it is the same fd/device event as (2), and why there was
   "no backup".
5. For each fault: B1/B2/B4/B5/B6 — which retires it, which merely shortens it, and the minimal touch list (file:line) for the Builder.
   Flag anything in the playbook's Part B you can show is wrong or insufficient from the code.

## Do not
No edits, no commits, no `git stash`/checkout, no `ssh`, no `swift build` (read-only; `swift test` allowed only if it changes an answer —
say so), no room commands, no Vercel, no writes outside `docs/handoff/ETA-DEBUGGER-REPORT-ROOM-FAULTS-12-SEP-2026.md`.

## Output
`docs/handoff/ETA-DEBUGGER-REPORT-ROOM-FAULTS-12-SEP-2026.md` ≤450 words + one appendix of quoted lines (≤60 lines). Sections:
branch check; Fault 1; Fault 2; Fault 3; OPD 7; fix map (B-item → file:line → regression yes/no); UNVERIFIED list. Do not commit it.
Chat: five lines — one per fault (root cause, regression y/n), plus the branch answer. Nothing else.
