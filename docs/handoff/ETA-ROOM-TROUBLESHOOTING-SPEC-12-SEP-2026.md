# ETA Room Recorder — Troubleshooting Spec Sheet

Version 1.1 · 12 Sep 2026 · Fleet at app 0.1.21 (`stable`) · Applies to every clinic Mac running the EvenScribe Room Recorder and to Home Office (Mini).
Companion documents: `ETA-ROOM-FAULT-PLAYBOOK-AND-RELEASE-SPEC-12-SEP-2026.md` (the four faults in depth + the release spec B1–B10) and `ETA-OPD-VISIT-RUNBOOK-11-SEP-2026.md` / `ETAROOMOPD7BRINGUP11SEP2026.pdf` (bring-up of a new Mac).

This sheet is the procedure. Follow it top to bottom; do not skip §1.

---

## 0. Tools and reach — what to use for what

| Need | Tool | Notes |
|---|---|---|
| Room state, sessions, commands, pieces | Scribe MCP: `scribe_diff_room`, `scribe_list_sessions`, `scribe_list_commands`, `scribe_get_session` | Read-only. Always first. Cached per argument set — change an argument if a result looks stale. |
| Start / stop tape | Scribe MCP: `scribe_start_recording`, `scribe_stop_recording` | Needs a listening kiosk (polled ≤10 s). Start is idempotent. |
| Switch mic / set volume | Scribe MCP: `scribe_set_audio_input` (app ≥0.1.21) | Sub-second ack; recording continues in a new segment. |
| Run a command on a room Mac | `tailscale-shell` MCP → `run_on host=<alias>` | Aliases: `mini`, `consul4` (OPD 3), `consul5` (OPD 5), `consul6` (OPD 6), `consul7` (OPD 7), `discussion` (Room 4.1), `echo` (Cardiology). Key auth, `zsh -lc`, **no sudo**. |
| Same, from V's Air | `air-shell` MCP → `run_command` (`ssh -o BatchMode=yes -i ~/.ssh/id_ecdsa user@ip '…'`) | Fallback for the above. |
| Read/write files on the Mini | `ReadMini` MCP (`read_file`, `write_file`, `search`) | Repo at `~/dev/Even-Transcription-Assistant`. |
| Bench pages (fleet card, mint install command) | Sonnet browser driver on `/admin/bench` | The fleet API route is proxy-blocked from Cowork shells. **"Copy install command" mints and retires — click once, only when you will paste.** |
| Anything needing `sudo` (pmset, sshd, autologin) | V, in a Terminal tab on that host | No TTY from any MCP. |
| Physical: mute button, USB reseat, power | A person in the room | The sheet says exactly when. |

Healthy numbers to hold in your head: one piece per 300 s; **~1.15 MB / 3.8–4.0 bytes per ms**; first piece within ~4 min of start; `mic_level` peak > 0.005 while recording. A piece at **~212 KB / 0.7 bytes/ms is digital silence**; the encoder is near-constant-bitrate, so only a ≥4× drop means anything.

---

## 1. Triage — three reads before any action

Run all three for the room, in this order, and write down the answers:

```
scribe_diff_room       room_slug=<slug>
scribe_list_commands   room_slug=<slug>  limit=10
scribe_list_sessions   room_slug=<slug>  ist_date=<today>
```

From `diff_room` note: `listener_state`, `listener_age_ms`, `recording`, `last_piece_at`, `mic_level`, `mic_size.baseline_bytes_per_ms`, `room_state.flags`.
From `list_commands` note: the newest `start_day`/`end_day`/`set_audio_input` and its `error` text.
From `list_sessions` note: today's sessions, `chunk_count`, `notes` (reaper), `gap_ms`.

Then go to the one branch in §2 that matches. If two match, the earlier-numbered one wins.

---

## 2. Decision tree

### 2.1 Listener `stale`/`never`, room offline or "dropped"

**Ask:** how long since the last poll (`listener_age_ms`)?

- **< 10 min** → wait; kiosks drop for a minute after a self-update swap (canary) and come back.
- **≥ 10 min** → run on the host:
  ```
  tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; cat "$HOME/Library/Application Support/EvenScribe/RoomRecorder/status.json"
  ```
  - Log says **`409 RETIRED … will not poll again`** → **Fault R (retired identity)**. Cure: mint **one** fresh install command from the bench (Sonnet driver), paste it on **that** Mac in **zsh**, one line. Confirm with `diff_room` → `listening` within 10 s. Cause is almost always a "Copy install command" click somewhere; find out who and why.
  - Log ends with **`handing over to the swap script`** and nothing after → the swap is mid-flight or failed; check `update.log` tail and `update-result.json`. A rollback is normal; a `swap_failed` twice puts the version on hold — publish a different one or withdraw.
  - `ssh` itself fails with **timed out / no route** → the Mac is asleep or at the login window. Check `pmset -g | grep -w sleep` (want 0) and `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser` (want the room user) once you can reach it; both need V's Terminal to fix.
  - `ssh` fails **Permission denied** → key not installed on that host; `ssh-copy-id -i ~/.ssh/id_ecdsa.pub user@ip` from V's Terminal (password once).

### 2.2 Listener `listening`, `recording: true`, but no pieces

**Ask:** how long since `started_at`, and is `last_piece_at` advancing?

- **< 5 min since start** → wait for the first 5-minute boundary. Do nothing.
- **≥ 6 min, `chunk_count 0`** (or `last_piece_at` frozen for > 6 min during a session) → **Fault W (wedged capture)**. Confirm cheaply: `scribe_stop_recording` — if it answers `NSPOSIXErrorDomain Code=9 "Bad file descriptor"`, it is W. Cure, in this order:
  1. End the session first — the failed stop above has already cleared the app's session flag. **Never kickstart a room that is healthily recording** (rule from the Tier 1 work, 12 Sep): end the session, then restart.
  2. On app ≥ 0.1.22 use the operator verb `restart_engine` (refuses with `session_open` if a session is live — that refusal is the guard working). On ≤ 0.1.21:
     ```
     run_on <alias>: launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder
     ```
  3. Wait 15 s, `scribe_start_recording` (if the app resumed the old session that is fine), confirm the first piece at the next boundary.
  **The bench stays green for 10 minutes during W** — do not trust the card.

### 2.3 Pieces arrive on time but tiny, or `mic_level 0.0` while recording, or flag `SILENT_WHILE_RECORDING`

→ **Fault S (silent input)**. Nothing in software is broken; the device delivers zeros.

1. Identify the device: `diff_room` → the session's `mic_label`, or `plutil -extract device_uid raw -o - "$HOME/Library/Application Support/EvenScribe/RoomRecorder/config.json"`.
2. If it is a **TONOR TM20** → touch-mute (LED red) or cable. Needs a hand in the room. Meanwhile, if a second input exists (`system_profiler SPAudioDataType | grep -iE "tonor|c270"` on the host), switch to it:
   `scribe_set_audio_input room_slug=<slug> device_uid=<other uid>` — and switch back after the hand, reading the next piece both times.
3. If it is a **C270** → same as 2.4's physical step (reseat), or switch to the TONOR if one is present and alive.
4. Never leave a room on a silent device because "the session is running". Six minutes of silence per switch is the cost; a morning of silence is the alternative.

### 2.4 `start_day` fails: `tapewriter exited with status 1`

→ **Fault D (device opens but delivers nothing)**. The failure takes ~16 s (three acquisition cycles). Read the reason:

```
run_on <alias>: find "$HOME/Library/Application Support/EvenScribe/RoomRecorder" -name tapewriter.log -mmin -120 -exec sh -c 'echo "== $1"; tail -6 "$1"' _ {} \;
```

- **`produced no durable growth` → `physical_fallback_required`** → the USB device is wedged. `sudo killall coreaudiod` does **not** fix it (tested 12 Sep). A kickstart does not fix it. Someone unplugs the device, waits 5 s, plugs it into the **same** port (the uid's `:N` suffix is the port; another port = another uid = the app won't find it). Then `scribe_start_recording`. If this room does it two mornings running, check `pmset -g | grep -w sleep` — a Mac that sleeps overnight power-cycles the webcam.
- **`Input device lost`** → device unplugged or re-enumerated; same physical step, then check `config.json` `device_uid` still matches what `system_profiler` shows.
- **CoreAudio error opening the device** → mic permission. `tail -3 launchd.log` should say `microphone authorized`; if not, the app's TCC grant is gone (a re-signed bundle with a different designated requirement) — that is a release problem, not a room problem.

### 2.5 `start_day` fails: `kiosk_not_listening`

→ §2.1. Start needs a kiosk that polled within 10 s.

### 2.6 `end_day` fails: `no_active_session`

→ Double-click on the bench, or the reaper already ended it. Nothing to do; `list_sessions` shows the truth.

### 2.7 Bench shows "Recording · Nm · K pieces" but `list_sessions` says the current session has fewer

→ Known display defect (tape lane counts the room-day, not the session). Use `scribe_get_session` for the real count. Fix is release-spec item B7.

### 2.8 Two sessions today, one ended by `admin` mid-clinic

→ Someone pressed stop on the bench. Not a fault; a governance question. Note the time and ask.

### 2.9 Room recording fine but audio quality is wrong (clipping, hum, distant)

→ Not this sheet. That is the audio-measurement track (R2.5, 9 Sep findings): OPD 3 clipped at +4.7 dBTP on the TONOR, OPD 5's C270 is 88% below 300 Hz. Piece size will look healthy. Fix is gain at capture and the right microphone, per room.

---

## 3. After every fix — the verification standard

A fix is not done until **all three** are true, in the log you keep for the day:

1. `diff_room`: `listener_state listening`, `recording true`, `flags []`.
2. `get_session` on the live session: a **new** piece since the fix, 300 000 ms, `verified`, size ≥ 0.5 × the room's `baseline_bytes_per_ms` × 300 000 (≈ 0.6 MB or more; healthy ≈ 1.15 MB).
3. `mic_level.peak > 0.005` on the `diff_room` after the piece.

If 2 fails while 1 passes, you are in §2.3, not done.

---

## 4. Escalation ladder

| Level | Who | Can do | Cannot do |
|---|---|---|---|
| L0 desk (MCP only) | orchestrator | read everything; start/stop; switch mic; mint an install command (once, to paste) | restart the app; read logs on the Mac |
| L1 desk (ssh) | orchestrator via `tailscale-shell` | everything L0 + kickstart the app, read `launchd.log`/`tapewriter.log`/`config.json`, `system_profiler`, paste a bootstrap | `sudo`: pmset, sshd, autologin, `killall coreaudiod` |
| L2 V's Terminal | V | everything L1 + `sudo` | physical |
| L3 hands | anyone in the building | mute button, USB reseat, power, login window | — |

Go up one level only when the sheet says the current level cannot fix it. Every walk (L3) that turns out to have been a `sleep=10` or a mute button should end with the L2 fix applied so it does not recur.

---

## 5. Daily pre-clinic check (08:40 IST, before the 08:50 fleet start)

1. `scribe_diff_room` (all rooms). Any `stale`/`offline` → §2.1 now, not at 09:00.
2. For each room with a `sleep=10` history, `run_on <alias>: pmset -g | grep -w sleep` — if 10, the L2 fix is still owed.
3. At 08:56 (first piece boundary after the 08:50 start): `scribe_list_sessions ist_date=today` — any `chunk_count 0` → §2.2 immediately; any piece < 0.6 MB → §2.3.
4. Post one line per room to the day log. Rooms are not "up" because they are green; they are up because a piece of the right size arrived.

---

## 6. Things that are true and easy to get wrong

- A start **ack** proves the command bus, not audio. Only a piece proves audio.
- The bench is **green for 10 minutes** on a wedged room and shows **yesterday's pieces** on the tape lane.
- **"Copy install command" retires the live install.** Reading it kills the room. Mint only to paste.
- **Runbook blocks are zsh.** In bash `read -s "PW?…"` is a syntax error. PDFs wrap long lines into separate commands. One-liners, state the shell.
- `update_channel` survives a re-enrol (by design, reset to `stable` from 0.1.17). Check `config.json` after any paste.
- Running a signed build **from any folder ending in `.app`** installs it there and it self-updates on first poll. Test builds run from a folder not ending in `.app`.
- Signing in **any shell born over SSH (tmux included)** needs `security unlock-keychain` + `set-key-partition-list` first.
- `sudo killall coreaudiod` does not revive a wedged C270. Hands do.
- A `test`-channel assignment on the bench is **inert on apps < 0.1.22**; a canary on an older app needs a `config.json` edit over ssh.
- MCP clients (Claude.ai connector, Claude Code) cache the tool list; a new verb does not appear until the client reconnects — drive the door with curl to prove it.
- A Mac with `sleep=10` looks like "ssh never works", "Tailscale offline" and "webcam dead every morning" — three tickets, one cause.
- Piece size is near-constant-bitrate: a 10 % change is noise, a 4× drop is silence, identical byte counts across rooms (212,378) is pure zeros.

---

## 7. Fleet reference (12 Sep 2026)

| Room | alias | user@ip | install_id | input today |
|---|---|---|---|---|
| OPD 3 | consul4 | ehrc-consul4@100.102.9.70 | install_fc2jt2zs4x8v | C270 (TONOR present, silent) |
| OPD 5 | consul5 | ehrc-consul5@100.87.161.101 | install_e3yjw3ut698x | C270 |
| OPD 6 | consul6 | ehrc-consul6@100.122.91.123 | install_d2nkvqcnqb7k | C270 |
| OPD 7 | consul7 | ehrc-consul7@100.127.98.43 | install_ukpd4tsvxg6z | C270 (TONOR present, silent) |
| Room 4.1 | discussion | ehrc-discussion@100.109.240.30 | install_ys5fz8s4una5 | C270 · `sleep=10` owed |
| Cardiology | echo | ehrc-echo@100.74.103.103 | install_tvhrqz2sq5ky | C270 · `sleep=10` owed |
| Home Office | mini | vinaybhardwaj@100.75.214.19 | install_539avu7gqzz5 (`test`) | TONOR |
| OPD 1, OPD 4 | — | parked by V 11 Sep | — | — |

`opd-bot` 100.94.185.121 (linux) is on the tailnet; purpose UNVERIFIED.

Paths on every room Mac: root `~/Library/Application Support/EvenScribe/RoomRecorder/` → `config.json`, `status.json`, `room-session.json`, `launchd.log`, `update.log`, `update-result.json`, `captures/<session>/tapewriter.log`. App: `~/Applications/EvenScribe Room Recorder.app`. LaunchAgent: `com.evenscribe.room-recorder` (gui domain; `KeepAlive.SuccessfulExit=false`).

---

*Maintained in the repo at `docs/handoff/ETA-ROOM-TROUBLESHOOTING-SPEC-12-SEP-2026.md` and mirrored in `Daily Dash EHRC/ETA/`. Bump the version line when a branch changes. Every new fault gets a branch here and a row in the playbook; every fix that becomes app behaviour gets its branch marked "retired in 0.1.x".*
