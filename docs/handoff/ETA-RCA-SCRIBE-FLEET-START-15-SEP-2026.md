# RCA — Even Scribe fleet `start_day` morning of 15 Sep 2026

Investigate-only. No behaviour change. Live reads were taken ~05:00 UTC (10:30 IST) against production via Even-Scribe MCP. Native Room Recorder source is **not** on `main`; it lives on `feat/room-recorder` / `vinay/release-b1`. This note maps today’s symptoms onto that code and the 12 Sep troubleshooting spec.

Named faults below are the ones already in `docs/handoff/ETA-ROOM-TROUBLESHOOTING-SPEC-12-SEP-2026.md` on `vinay/release-b1`.

---

## What is actually listening

`start_day` is **not** an HTTP “press the mic.” MCP inserts a `bench_command` and waits 8 s (`ACK_WAIT_MS` in `lib/bench-bus-constants.ts`). The native app (or a browser kiosk) must poll `GET /api/bench/commands` with `last_poll_at` ≤ 10 s (`LISTENER_FRESH_MS`) or the tool returns `kiosk_not_listening` and **does not create a session**.

The native Room Recorder **is** that kiosk: `tab_id = app_<install_id>`. The now-picture’s `page_open` / `listener_state` is that poll, not a Safari tab. Copy that still says “open the room page on the Mini” is leftover from the browser-kiosk era.

A second heartbeat (`install_id`, `tape_advancing`, `peak`, `zero_ratio`, …) rides the same poll and updates `room_install`. **`tape_advancing` is local durable-sample growth**, not “a row exists in `bench_chunk`.” That split is load-bearing for Home Office today.

---

## Class A — recording with zero durable tape (Home Office)

**Live (server, ~05:00Z):** `home-office-w8fb`, session `bs_hk2d7acj`, app **0.1.22** (`test`), macOS 27. `start_day` **acked** in ~5.5 s (`cmd_xmx9fwc2`). Native: `session_open=true`, `tape_advancing=true`. Server: **0 chunks**.

**Live (Mini, later — confirmed, do not discard):**

- `room-recorder` pid **up since Sat 12 Sep (~3 days)**.
- **~4885 open FDs, ~4847 of them PIPEs.**
- `status.json` `last_error`: `cannot write …/spool/.piece-….pcm.tmp: errno 24` (**EMFILE / Too many open files**).
- `pending_piece_count=0`, spool empty; tapewriter still writing `tape.pcm` (idx rms≈0.009, not flat zero).

Capture is alive. The cutter cannot open a new temp file because the **engine process has exhausted the FD table**. The `.pcm.tmp` open is the **victim**, not the leak. ~4847 PIPEs means Foundation `Pipe()` objects, not leftover `.pcm.tmp` REG files.

Tape is **16 kHz s16le** (32 000 B/s). A piece is **4 800 000 samples / 300 s**. Growing PCM past that boundary is expected; pieces never publish because `copyExactRange` fails at `open(…pcm.tmp)` before ffmpeg runs.

### Piece pipeline (plain capture)

```
tapewriter  --record-->  tape.pcm + tape.idx
                              |
RoomEngine.run() loop (~1.5s)
  1. publishAvailable(finalFlush: false)     // CUT
  2. drainPending()                          // UPLOAD
```

`FFmpegPieceEncoder.encode` (`PiecePipeline.swift`): unique `.piece-<uuid>.pcm.tmp` + `.webm.tmp` under `spool/`; `copyExactRange` then `FoundationPieceProcessRunner.run` (ffmpeg); `defer` unlinks both temps. `RoomPieceSpool.publish` is what increments `pending_piece_count`. Throws in `run()` set `lastError` and **do not** advance `segment.nextSample`.

### 1. Where `.pcm.tmp` is opened — and whether that path leaks

`copyExactRange` (`PiecePipeline.swift`):

- `open(tape.pcm, O_RDONLY|O_CLOEXEC)` → `defer { close(sourceFD) }`
- `open(.piece-….pcm.tmp, O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC)` → **this is errno 24**
- destination also `defer { close(destinationFD) }`

If `open` fails, no destination FD is taken. On any later throw, `defer` still closes. **The piece-copy FDs do not leak across attempts.** Failed writes also hit `defer { removeItem(inputTemporary) }` in `encode`, so spool should stay empty of `.pcm.tmp` (hidden files; `ls` without `-a` would miss them anyway).

`writeFailed(path, errno)` is exactly the Mini string: `cannot write \(path): errno \(code)`.

### 2. Long-lived PIPEs that are not closed on a failed piece

The FD table is pipes. Sites that call `Pipe()` in the resident app:

| Site | When | Close hygiene |
|---|---|---|
| **`FoundationPieceProcessRunner.run`** | **Every cutter attempt** (once `plan` is non-empty, every ~1.5 s) | `errorPipe = Pipe()` assigned to `process.standardError`. Reads `fileHandleForReading.readDataToEndOfFile()`, `waitUntilExit()`. **Never `closeFile()` on read or write end.** Stdin/stdout are `FileHandle.nullDevice` (shared, OK). |
| **`MachineFactsReader.runTool`** | **Every poll** (~1.5 s): `pmset -g`, `launchctl print …`, `scutil --get ComputerName` | Same: `Pipe()` on stdout, no `closeFile()`. |
| `RoomEngine.runHelperVersion` | `report_diag` only (`tapewriter --version`, `ffmpeg -version`) | Same pattern; not the 3-day background leak. |
| `ArchiveFFmpegStreamingEncoder` / `FoundationArchiveStreamingProcess` | Resident-archive encode | **Does** close: parent closes unused ends after `run()`, workers `close()` in `defer`. Not this session’s `captures/…/tape.pcm` path. |

Failed piece after EMFILE: `encode` throws in `copyExactRange` **before** `runner.run`, so **that** attempt adds no new ffmpeg pipe. The ~4847 PIPEs are from **earlier** `Pipe()` constructions that were never closed. Classic Foundation behaviour: parent keeps both pipe ends; `Process` may retain the `Pipe` after exit; without an explicit close the FDs survive the next loop.

`publishAvailable` catches the throw, saves `last_error`, retries next loop → immediate another `open(pcm.tmp)` → same EMFILE. `pending` stays 0. Tapewriter is a **child** with its own FD table, so PCM keeps growing.

Playbook Fault W `NSPOSIXErrorDomain Code=9` is **EBADF** (bad FD). Same family as a wrecked FD table; EMFILE is the cutter’s symptom, EBADF is often the stop’s.

### 3. 0.1.22 vs 0.1.21

`git diff 5af9075 origin/vinay/release-b1 -- …/PiecePipeline.swift` is **empty**. `FoundationPieceProcessRunner` and `copyExactRange` are the same in 0.1.21. Changelog 0.1.22 adds operator verbs + `clip_count`/`silence_ms` (`PCMTailMeter` opens `tape.pcm` with `FileHandle` and **does** `defer { close() }` — REG files, not PIPEs).

**There is no 0.1.22-only FD-leak patch, and no 0.1.22-only pipe in the piece encoder.** Home Office is the Mini that (a) kept **one pid for ~3 days**, (b) is on **macOS 27**, (c) actually ran the cutter this morning. Clinic 0.1.21 boxes that `kickstart` or sleep more often would not accumulate thousands of PIPEs. Room 4.1 never reaches the cutter (session dies at ~16 s).

If `runTool` leaked 2 FDs per helper × 3 helpers × every 1.5 s for 3 days, the table would be orders of magnitude larger than 4885. So either completed `runTool` processes **do** drop pipes on deinit, or the burst is **cutter retries** once a 5-minute plan exists (plus whatever macOS 27 does not reclaim). The Mini count is still the defect: the process cannot open a piece file.

### 4. Recommended fix (product — not in this docs-only PR)

1. **Close-on-error / close-always** in `FoundationPieceProcessRunner` and `MachineFactsReader.runTool`: after `process.run()`, close the parent write end; after `waitUntilExit()`, `closeFile()` both ends in `defer`. Prefer `process.standardError = FileHandle.nullDevice` for ffmpeg (`-loglevel error` already); no pipe required.
2. **Do not retry-encode in a tight loop while `last_error` is errno 24** — backoff, surface `EMFILE` as a fleet flag, stop calling `Pipe()`.
3. **Process recycle:** `restart_engine` already exits non-zero so launchd relaunches (refuses with `session_open` unless `force`). Add a max-uptime restart (e.g. daily, idle-only) so a leak cannot run for 3 days. Immediate ops **is** recycle after `end_day`.

### Next (ops) — this is Fault W with a named errno

Playbook §2.2, in order:

1. `end_day` (never `restart_engine` while `session_open` — it returns `session_open` unless `force`). Code=9 on stop is still W.
2. `restart_engine` (0.1.22) — **this is the FD-table cure**; launchd starts a new pid.
3. `start_day`. Confirm `lsof -p <pid> | rg -c PIPE` is tens, not thousands, and the first WebM within ~5 min.

Do not treat as TONOR mute. Do not `close_orphaned_session` while the listener is fresh and claims `bs_hk2d7acj`.

---

## Class B — `ack_timeout` then ~16 s session with 0 chunks (Room 4.1)

**Live:** `room-4-1-after-cards-before-5-494q`, app **0.1.21** (`stable`), C270. Commands today:

| command | created | acked | error |
|---|---|---|---|
| `cmd_wkgt8za2` | 04:44:20Z | 04:44:37Z | `tapewriter exited with status 1` |
| `cmd_xcknbvsz` | 04:44:58Z | 04:45:15Z | same |
| `cmd_3qxnqan4` | 04:51:08Z | 04:51:26Z | same |
| `cmd_kbffdvcu` | 04:56:01Z | 04:56:18Z | same |

Sessions `bs_67v5bd7r` / `bs_e99nxzr7`: started, **ended ~15.7 s later**, 0 chunks, `notes` null (not the reaper). Room then `finished` (“Finished for today”) because D30 (`roomState` in `lib/bench-bus-constants.ts`) fires when the latest session today is `ended` and nothing is recording. That is **UI**, not a lock: `start_available` stays true while the listener is fresh.

**Why MCP says `ack_timeout`:** tools wait **8 s**. Tapewriter cold-boot readiness is **three windows of 5 / 10 / 15 s** (`CaptureReadinessPolicy.coldBoot` in `apps/room-recorder/Sources/tapewriter/CaptureReadiness.swift`). On failure the helper exits 1; `RoomEngine` maps that to `"tapewriter exited with status 1"`, **ends the session it just created** (`beginOrResume` compensation: stop capture → `PATCH` end → fail-ack). The fail-ack lands at ~16–17 s, after the MCP wait. If a poll happened after insert, `sendAndWait` classifies this as `ack_timeout` (delivered) rather than `kiosk_not_listening`.

**Why the listener sometimes drops:** the engine’s poll loop backs off or the process restarts; `last_poll_at` older than 10 s → `kiosk_not_listening` on the next start. Not a separate defect.

**Not:** auto-end “finished for today”, 15 s command expiry of an **already delivered** command, or the 30-minute reaper.

**Root cause:** **Fault D — device opens but delivers no durable growth.** Same Mini recorded 115 verified pieces (~139 MB) on 12 Sep (`bs_m3kgj3ty`) after a string of identical 16 s failures. USB/CoreAudio wedged overnight is the documented cause (`physical_fallback_required`); `sudo killall coreaudiod` does **not** fix it.

**Next (ops):** unplug C270, wait 5 s, **same USB port** (uid suffix is the port), then `start_day`. Check `pmset` sleep. Read newest `tapewriter.log` for `produced no durable growth` vs `Input device lost` vs CoreAudio open error.

**Optional product mismatch (not a one-line guard):** raising `ACK_WAIT_MS` on `start_day` only (e.g. 20 s) would surface `tapewriter exited with status 1` instead of `ack_timeout`. Do not change it in this RCA.

---

## Class C — `SILENT_WHILE_RECORDING` and ~212 KB pieces (OPD 3)

**Live:** `opd-3-kjpf`, app 0.1.21, session `bs_ryqjan2t` **is** uploading: three 300 s pieces, **each exactly 212 378 bytes**, `zero_ratio=1`, `peak=0`. Flag `SILENT_WHILE_RECORDING`. Session `mic_label` is **TONOR**; fleet `input_devices` has C270 as **default**. Expected device is TONOR.

**What the flag is:** server-side, `evaluateInstallStates` (`lib/bench-bus-constants.ts` on `vinay/release-b1`):

- recording **and** `tape_advancing`
- 0.1.21: `zero_ratio ≥ 0.98` for ≥ 80 consecutive polls (~2 min)
- 0.1.22: `silence_ms ≥ 120_000` (−55 dBFS) wins if present

`zero_ratio` is **bit-exact zeros**, not “a quiet room.” A working room still has a noise floor.

**212 KB / 5 min is expected for digital silence.** The 12 Sep playbook: “~1.15 MB / 3.8–4.0 bytes per ms” healthy; “**~212 KB / 0.7 bytes/ms is digital silence**”; encoder is near-CBR. OPD 7 on TONOR today is ~1.16–1.26 MB — same encoder, live input.

This is **not** undersized-piece health (`lib/mic-health.ts` D36): that rule needs the meter to have **heard sound**. OPD 3’s `mic_size.newest` is `ok` because the room is consistently tiny **and** silent — the size rule refuses to call a quiet room dead.

**Root cause:** **Fault S — silent input** on the selected TONOR (mute LED or cable). Same finding 11–12 Sep: desk-switch to TONOR on OPD 3/7 produced identical 212 378-byte pieces; they reverted to C270.

**Next (ops):** hand in the room (TONOR mute/cable), or `set_audio_input` to the C270 uid, then confirm the **next** piece is ~1.1 MB and the flag clears.

---

## Class D — `kiosk_not_listening` / offline / never installed

`kiosk_not_listening` = no `bench_listener` poll within 10 s (`isListening`). Offline copy uses `LISTENER_OFFLINE_MS` (10 min) after that.

| Room | Last native poll | Install | Notes |
|---|---|---|---|
| Cardiology | 14 Sep 08:39Z | 0.1.21, `never_sleep=false` | Mini asleep / app not polling |
| OPD 4 | 14 Sep 08:28Z | **0.1.8**, `signature_mismatch` on 0.1.21 | Same offline; also stuck on old app |
| OPD 5 | 14 Sep 08:25Z | 0.1.21, `never_sleep=true` | Sleep/power still won. Stale `session_open`/`tape_advancing` on the **install row** is last-write; now-picture correctly shows not recording. Yesterday’s session `bs_m24h8v5m` was **reaper-ended** (0 chunks). |
| OPD 6 | 14 Sep 10:26Z | 0.1.21 | Same |
| OT 3 | never | `install: null` | **not_installed** — mint/paste install; not a start bug |

**Next (ops):** wake Mac, confirm launchd + `launchd.log` (409 RETIRED vs swap stuck vs sleep). Cardiology/OPD 5/6: `pmset` / autologin (needs a human Terminal; MCP cannot sudo). OT 3: first install.

---

## Versions (0.1.8 / 0.1.21 / 0.1.22)

| Version | Who | Relevant behaviour |
|---|---|---|
| **0.1.8** | OPD 1 (recording today), OPD 4 (offline) | Capture/upload still works (OPD 1: ~1.2 MB pieces on C270). No `peak`/`input_devices` heartbeat. **Cannot self-update to 0.1.21:** `last_update_result=signature_mismatch` (“downloaded app was not signed by Even”) — designated-requirement / Team ID check from R3. Ops: re-enrol or fix signing; do not keep clicking update. |
| **0.1.21** | stable clinic | Fault D (tapewriter exit 1), Fault S (TONOR zeros), `SILENT_WHILE_RECORDING` via `zero_ratio`. No `check_update_now` / `restart_engine`. |
| **0.1.22** | Home Office `test` only (Room 4.1 stayed `stable`) | Adds `silence_ms`, `clip_count`, `restart_engine`, `report_diag`. **Piece encoder Pipe/FD handling is identical to 0.1.21.** Home Office W today is **EMFILE** after ~3-day pid. `tapewriter --version` is not a real command — ignore that diag line. |

Healthy today: OPD 7 (0.1.21, TONOR, ~1.2 MB), OPD 1 (0.1.8, C270, ~1.2 MB). Version is not the common factor. **Device + USB + mute + whether pieces actually upload** are.

---

## Files / functions (this repo + native branch)

| Symptom | Where |
|---|---|
| `kiosk_not_listening` / 8 s `ack_timeout` | `lib/mcp/tools/bench.ts` `sendAndWait`; `lib/bench-commands.ts` `isListening` / `decideStart`; `lib/bench-bus-constants.ts` `ACK_WAIT_MS`, `LISTENER_FRESH_MS`, `COMMAND_EXPIRY_SECONDS` |
| “Finished for today” | `roomState()` D30 in `lib/bench-bus-constants.ts` |
| Server `stalled` (no uploaded piece 10 min) | `lib/bench-reaper-core.ts` `STALLED_BADGE_MINUTES`; tape lane in `lib/room-facts.ts` |
| Reaper 30 min auto-end | `NOTE_STALL` — **not** Room 4.1 today |
| Chunk verify | `app/api/bench/chunks/route.ts` (HEAD R2 then row) |
| Native start / tapewriter exit 1 / 15 s | `RoomEngine.beginOrResume` / `waitForDurableGrowth`; `CaptureReadinessPolicy.coldBoot`; error string `tapewriter exited with status \(status)` |
| Home Office EMFILE / empty spool | `FFmpegPieceEncoder.encode` + `copyExactRange`; `FoundationPieceProcessRunner` (`Pipe` never closed); `MachineFactsReader.runTool`; `writeFailed` → `cannot write … errno 24` |
| `tape_advancing` vs pieces | `InstallPollFields.swift`; BUILD-HISTORY 0.1.7 fix (durable index, not piece cursor) |
| `SILENT_WHILE_RECORDING` | `evaluateInstallStates` + `SILENT_POLLS` / `SILENT_ZERO_RATIO` |
| `restart_engine` | `RoomEngine.restartEngine` — refuses `session_open` unless `force`; then non-zero exit for launchd |

`main` in this checkout predates fleet/install/state_flags. Production MCP already serves them.

---

## What not to do

- Do not `close_orphaned_session` on Home Office while the native listener is **fresh and claims** `bs_hk2d7acj` — that door refuses `kiosk_attached` by design (`lib/bench-orphan.ts`).
- Do not `restart_engine` on 0.1.22 while `session_open` (returns `session_open` unless `force`). **End the session first**, then restart — that recycle is the EMFILE cure.
- Do not treat OPD 3’s 212 KB pieces as “encoder broken.”
- Do not treat Cardiology/OPD 4/5/6 as software start bugs until the Mac polls again.
