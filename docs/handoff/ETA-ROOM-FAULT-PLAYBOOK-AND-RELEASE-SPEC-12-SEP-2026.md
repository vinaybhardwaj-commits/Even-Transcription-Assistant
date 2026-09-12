# ETA Room Faults — Operator Playbook + Release Spec — 11–12 Sep 2026

Written 12 Sep 2026 10:20 IST by the orchestrator from live evidence (Scribe MCP, Mini state files, room logs, bench fleet cards, source at HEAD `5dff406`→`5a36727`). Every fault below was seen on a real clinic Mac this week, diagnosed remotely, and fixed. Part A is what an operator does today. Part B is what the app and bench must do so Part A stops being necessary. Part C is the fleet reference.

---

## Part A — Operator playbook

### A0. First three calls, before touching anything

For any "room X is not working":

1. `scribe_diff_room <slug>` — listener state, recording flag, `last_piece_at`, `mic_level`, `mic_size.baseline_bytes_per_ms`.
2. `scribe_list_commands room=<slug>` — the last start/stop and its `error` text. This is where the fault names itself.
3. `scribe_list_sessions room=<slug> ist_date=<today>` — chunk counts, `notes` (reaper), gaps.

Match the signature in A1–A5 before acting. A start ACK proves the command path only; it never proves audio.

**Healthy reference:** one piece per 300 s, ~1.15 MB, 3.8–4.0 bytes/ms, first piece within ~4 min of start. Piece size is near-constant-bitrate; a change under ~2× means nothing, a drop of 4× or more means silence.

### A1. Retired identity — room offline, app will not poll

| | |
|---|---|
| Signature | `launchd.log`: `this install has been retired (409 RETIRED). A newer enrolment owns <slug>. Stopping; this copy will not poll again.` Bench: offline / "no poll for N minutes". `status.json` `last_error: retired`. |
| Seen | Home Office 11 Sep 05:33 (×4 re-enrols, all died); OPD 7 11 Sep 10:01. |
| Cause | Every "Copy install command" click on the bench **mints a new enrolment and retires the live one**. Writing a runbook PDF with the id in it killed OPD 7. On ≤0.1.16 a second cause: `room-session.json` (B1.5) outranked `config.json` for install id and the 0.1.8 bootstrap never rewrote it (fixed in 0.1.17, `5a36727`). |
| Cure | Mint once, paste on **that** Mac, in **zsh** (not bash), one line at a time. Bootstrap installs whatever `stable` is at paste time. Never mint "to look at it". |
| Time | 2 min if ssh is on; otherwise a walk. |

### A2. Wedged capture path — "recording", zero pieces

| | |
|---|---|
| Signature | Start acked in <3 s, `recording: true`, `chunk_count: 0` past the 5-min boundary; `mic_level 0.0/0.0`; `end_day` fails `NSPOSIXErrorDomain Code=9 "Bad file descriptor"`; after 30 min the reaper auto-ends with `no chunks >30m`. Bench stays **green** for 10 min (stall window), tape lane shows *yesterday's* piece count. |
| Seen | OPD 3 11 Sep 10:41 (silent 3.5 h); OPD 5 12 Sep 08:50 (silent 35 min); OPD 1/4/6 end_day failures 11 Sep 09:22 same error. Cluster after the overnight 0.1.21 self-update. |
| Cause | The tapewriter's file descriptor died (device re-enumeration or the swap) and the process never reopened it. Remote start/stop cannot clear it; only a process restart does. |
| Cure | Over ssh: `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder`, then `scribe_start_recording` (the failed stop clears the stuck session flag; a resumed session is fine). Confirm first piece at the next 5-min boundary. |
| Time | 90 s + 5 min to confirm. |

### A3. Muted microphone — pieces arrive, nothing in them

| | |
|---|---|
| Signature | Pieces verified on time but **~0.7 bytes/ms** against the room's 3.8–4.0 baseline (6× drop); `mic_level 0.0/0.0` while recording. Everything green. |
| Seen | OPD 3 11 Sep 13:03 onward. |
| Cause | TONOR TM20 touch-mute (LED red). Invisible to software — device present, stream open, samples are digital zero. |
| Cure | Tap the mic. Next piece returns to ~1.2 MB. |

### A4. Dead USB webcam — start fails in 16 s

| | |
|---|---|
| Signature | `start_day` → `tapewriter exited with status 1` after ~16 s, every attempt. `tapewriter.log` (in the session capture dir, `RoomEngine.swift:3261`): `Audio acquisition cycle 1/2/3 produced no durable growth` → `physical_fallback_required`. Capture format opens fine (48 kHz mono Float32). Fleet card: device present, authorized, volume 45%. |
| Seen | Room 4.1 11 Sep 08:59 (×7, recovered 10:06 by hand) and 12 Sep 08:50 (×5, recovered 09:58 by hand). Cardiology once 11 Sep 08:59. |
| Cause | Logitech C270 after overnight idle: enumerates, accepts open, delivers zero frames. `sudo killall coreaudiod` does **not** revive it (tested 09:49 12 Sep). |
| Cure | Hands on the webcam (check/replug, same port — the uid suffix `:3` encodes the port; a different port changes the id). Then start from the desk. Durable fix: replace with a TONOR and retarget with `scribe_set_audio_input` (≥0.1.21). |

### A5. Operator-side traps (cost hours this week)

- **Signing over SSH/tmux**: `build-bundle.sh` refuses in any shell born over SSH (tmux sessions included, even attached at the console). Fix: `security unlock-keychain ~/Library/Keychains/login.keychain-db` then `security set-key-partition-list -S apple-tool:,apple: -s ~/Library/Keychains/login.keychain-db` in that shell, then build. The dump it prints is success.
- **Running a signed build by hand on a `test` room**: the folder it runs from becomes the install path (`install-launch-agent` writes it into the plist) and it will try to swap itself on first poll. Only a folder name **not** ending in `.app` disables self-update. Never run a build out of `.build/` on a live room.
- **Runbook PDFs**: blocks written for zsh break in bash; long lines wrap into separate commands when pasted from a PDF. Ship one-liners; state the shell.
- **Bootstrap + channel**: `update_channel` survives re-enrol by design (0.1.17 resets it to `stable`); check `config.json` after any paste.
- **OPD Macs sleep** without step 2 of the visit runbook (`pmset -a sleep 0 …`); a sleeping Mac looks like "ssh never works" and "Tailscale offline".

---

## Part B — Release spec (next app/bench build)

Ordered by damage prevented. Each item names the fault it retires.

### B1. First-bytes deadline on every start (retires A2 silently, exposes A4)

App: after `start_day` is acked, if no chunk has been **written locally** within 90 s, log `first_bytes_missed`, tear down the capture, reopen the device, retry once; if still nothing, fail the session with `capture_dead` and stop. Server: a session with `status=recording` and `chunk_count=0` 6 min after `started_at` is marked `silent_start`, the bench card goes red, and the watcher posts. Today the first alarm is the reaper at 30 min, and the bench is green until 10 min.

### B2. Bad-fd self-heal (retires A2)

App: any `EBADF`/`Code=9` from the capture handle, or an `end_day` that fails with it, triggers the same reopen-and-retry as B1 instead of leaving a dead handle in a "recording" process. Log the event to the poll payload so the fleet card shows `capture_reopened N`.

### B3. Per-piece density check at ingest (retires A3; the R2.5 first slice)

Server, at chunk ingest: compute `bytes_per_ms` and store it beside the chunk. Compare against the room's own trailing baseline (`mic_size.baseline_bytes_per_ms` already exists). A piece under 0.5× baseline flips `silent_piece`; two consecutive → card amber + watcher line "room X: audio is silence since HH:MM". No global threshold (9 Sep finding stands). This is a server change only; ship it independently of the app.

### B4. Mint does not retire (retires A1)

Bench/server: "Copy install command" mints a token but **does not retire the live install** until the new install's first successful poll. Card copy: "The current install keeps running until the new one polls." Add a second, explicit "Retire now" action for the deliberate case. Also: show the retired id and the retiring id on the card, and log who minted.

### B5. Tapewriter reason on the card and in the MCP (retires the log-hunting in A4)

App: on `captureExited`, include the last 3 lines of `tapewriter.log` in the command result (`error_detail`). Server: store it on the command row; bench card and `scribe_list_commands` show it. Today the reason exists only in a per-session file on the Mac.

### B6. Physical-fallback recovery attempt (softens A4)

App: on `physical_fallback_required`, before giving up: close and reopen the device with a 2 s gap, then try the AVFoundation route as an alternate opener; log each attempt. If still dead, post `needs_hands: <device>` in the poll so the card says exactly that. (Ratified caveat: nothing in software reliably resets a wedged C270; this shortens the failure, it does not remove it. The removal is hardware — see C3.)

### B7. Session-scoped tape lane (retires the "green while empty" card)

Bench: the tape lane counts pieces of the **current session**, not the room-day. `Recording · 7m · 6 pieces` on 11 Sep meant six pieces from a session that ended at 09:22; the live one had none.

### B8. Mute detection while recording (retires A3 at the app)

App: while recording, if the input level meter reads 0.0 for 60 s continuously and the device is a known mute-capable model (TONOR TM20), report `probable_mute` in the poll; card shows "mic may be muted". Level is already sampled (`mic_level`).

### B9. Re-enrol semantics (partly shipped in 0.1.17; finish it)

Done: enrol writes `room-session.json`; mismatch → config wins; one retry on 409; channel reset to `stable`. Add: `device_uid` is validated on enrol against the devices present; if absent, enrol picks the sole USB input and says so, instead of freezing a stale uid.

### B10. Visit runbooks as executable scripts

Ship `Packaging/room-bringup.sh` (sshd, pmset, autologin, Tailscale, identity, mic, kickstart, verdict lines) so a bring-up is one paste in zsh, not nine blocks from a PDF. Include the SSH recipe from A5.

---

## Part C — Fleet reference (verified 12 Sep 10:05 IST)

### C1. Versions and channels
- `stable` = **0.1.21**, published 11 Sep 20:57 IST "by migration_secret". All clinic rooms on 0.1.21 via overnight self-update (0.1.19 → 0.1.20 → 0.1.21, canaries passed). `set_audio_input` available ≥0.1.21.
- Home Office (Mini) on channel `test`, `install_539avu7gqzz5`.

### C2. SSH table (Tailscale, password auth, user = `ehrc-<mac>`)

| Room | Host | User | Tailscale IP |
|---|---|---|---|
| OPD 3 | EHRC-CONSUL4's Mac mini | ehrc-consul4 | 100.102.9.70 |
| OPD 7 | EHRC-CONSUL7's Mac mini | ehrc-consul7 | 100.127.98.43 |
| Room 4.1 | EHRC-DISCUSSION's Mac mini | ehrc-discussion | 100.109.240.30 |
| OPD 5 | EHRC-CONSUL5's Mac mini | ehrc-consul5 | 100.87.161.101 |
| OPD 6 | EHRC-CONSUL6's Mac mini | ehrc-consul6 | 100.122.91.123 |
| Cardiology | EHRC-ECHO's Mac mini | ehrc-echo | 100.74.103.103 |
| OPD 1, OPD 4 | parked by V 11 Sep | — | — |
| Home Office | Vinays-Mac-mini-3 | vinaybhardwaj (`ssh mini`) | 100.75.214.19 |

Command: `ssh -i ~/.ssh/id_ecdsa <user>@<ip>` — key auth installed on all six rooms from V's Air on 12 Sep 10:25 IST (`ssh-copy-id`), so the Cowork `air-shell` MCP reaches every room non-interactively; `sudo` still needs a TTY (V). Room 4.1 and Cardiology were found with `pmset sleep=10` (the others 0) — the likely root of 4.1's morning-dead webcam; fix `sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0`. Also on the tailnet: `opd-bot` 100.94.185.121 (linux), purpose UNVERIFIED. Recorder restart: `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder`. Log: `~/Library/Application Support/EvenScribe/RoomRecorder/launchd.log`; tapewriter reason: `find "$HOME/Library/Application Support/EvenScribe/RoomRecorder" -name tapewriter.log -mmin -120 -exec tail -15 {} \;`.

### C3. Microphones
- 12 Sep every room reports a C270 HD WEBCAM as input, including OPD 3 and OPD 7 which reported TONOR TM20 on 11 Sep. **UNVERIFIED whether this was a deliberate change or 0.1.21's default-device choice.** OPD 7 was the audio reference room on the TONOR (50.6% speech band); check before assuming the reference still holds.
- C270 failures this week: Room 4.1 (dead, twice), OPD 5 (wedge; and judged unusable 9 Sep). Recommendation: TONOR in every room; retarget remotely with `set_audio_input`.

### C4. Open items
1. Who published 0.1.21 to stable via `migration_secret`, and were the partition/keychain steps truly obsolete for every room (0.1.18 note says yes).
2. OPD 7's 11 Sep card showed hostname "EHRC-CONSUL5" against the OPD 7 enrolment — UNVERIFIED, possibly a mis-pasted bootstrap on CONSUL5 that morning.
3. OPD 3 09:22 IST 11 Sep `end_day` from the bench (`source: admin`) ended a working session mid-clinic; identify who.
4. **12 Sep 10:47–10:53 IST experiment:** `set_audio_input` switched OPD 3 and OPD 7 back to their TONORs from the desk — four commands, four sub-second acks, sessions continued in new segments; R4 is proven. Both TONORs delivered pure digital silence (212,378-byte pieces, level 0.0); 0.1.21's own `SILENT_WHILE_RECORDING` flag fired on both, and OPD 7 had logged `mic_primary_lost` at 09:28. Reverted to the C270s after one piece (six minutes of silence per room). So: the 11 Sep desk switch to webcams was a correct emergency move; both TONORs need hands (touch-mute LED or cable) before reuse; and **B3/B8 must be re-baselined against 0.1.21, which already ships part of them** — the Builder brief starts from the live app, not from this document's 11 Sep picture.
5. The 0.1.17 Refuter pass was superseded by direct publishing of 0.1.18–0.1.21; the six-role loop was not run on those. Decide whether B1–B10 go through Builder → Refuter as one release or two.

---

*Files: this document lives at `docs/handoff/ETA-ROOM-FAULT-PLAYBOOK-AND-RELEASE-SPEC-12-SEP-2026.md` in the repo and in `Daily Dash EHRC/ETA/`. Related: `ETA-KICKOFF-0.1.17-STALE-SESSION-ID-11-SEP-2026.md`, `ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-MASTER.md`.*
