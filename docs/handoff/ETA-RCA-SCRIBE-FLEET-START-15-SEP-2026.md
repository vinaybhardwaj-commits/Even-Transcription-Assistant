# RCA — Even Scribe fleet `start_day` morning of 15 Sep 2026

Investigate-only. No behaviour change. Live reads were taken ~05:00 UTC (10:30 IST) against production via Even-Scribe MCP. Native Room Recorder source is **not** on `main`; it lives on `feat/room-recorder` / `vinay/release-b1`. This note maps today’s symptoms onto that code and the 12 Sep troubleshooting spec.

Named faults below are the ones already in `docs/handoff/ETA-ROOM-TROUBLESHOOTING-SPEC-12-SEP-2026.md` on `vinay/release-b1`.

---

## What is actually listening

`start_day` is **not** an HTTP “press the mic.” MCP inserts a `bench_command` and waits 8 s (`ACK_WAIT_MS` in `lib/bench-bus-constants.ts`). The native app (or a browser kiosk) must poll `GET /api/bench/commands` with `last_poll_at` ≤ 10 s (`LISTENER_FRESH_MS`) or the tool returns `kiosk_not_listening` and **does not create a session**.

The native Room Recorder **is** that kiosk: `tab_id = app_<install_id>`. The now-picture’s `page_open` / `listener_state` is that poll, not a Safari tab. Copy that still says “open the room page on the Mini” is leftover from the browser-kiosk era.

A second heartbeat (`install_id`, `tape_advancing`, `peak`, `zero_ratio`, …) rides the same poll and updates `room_install`. **`tape_advancing` is local durable-sample growth**, not “a row exists in `bench_chunk`.” Home Office today: tape advances; pieces do not, because the **0.1.22 engine pid leaked PIPEs**.

---

## Class A — PIPE FD leak in a long-lived 0.1.22 `room-recorder` (Home Office)

**Root cause:** one `room-recorder` pid has been running since Sat 12 Sep and leaked thousands of Foundation `Pipe()` FDs. The piece cutter then fails at `RoomPiecePipelineError.writeFailed` (**errno 24 / EMFILE**) when opening `spool/.piece-….pcm.tmp`. Tapewriter (child) still writes PCM. Spool stays empty because the write never becomes a durable WebM. `room-recorder.lock` is still held by **that same pid**, so a second engine cannot take over.

**Not:** dead capture, disk full, quiet-room abort, or upload wedge.

**Live (server, ~05:00Z):** `home-office-w8fb`, session `bs_hk2d7acj`, app **0.1.22** (`test`), macOS 27. `start_day` **acked** in ~5.5 s (`cmd_xmx9fwc2`). Native: `session_open=true`, `tape_advancing=true`. Server: **0 chunks**.

**Live (Mini — confirmed, do not discard):**

| Fact | Why it matters |
|---|---|
| pid up since Sat 12 Sep (~3 days) | Leak exposure is **process lifetime**, not this morning’s `start_day`. |
| ~4885 FDs, **~4847 PIPEs** | Foundation `Pipe()`, not leftover `.pcm.tmp` REG files. |
| `last_error` = `cannot write …/spool/.piece-….pcm.tmp: errno 24` | Exact `RoomPiecePipelineError.writeFailed(path, errno)` in `PiecePipeline.swift`. |
| Disk **~113 GB free** | Not `ENOSPC`. Spool empty because `open()` fails **before** a durable piece exists. |
| `room-recorder.lock` held by this pid | `RoomEngineInstanceLock`: `flock(LOCK_EX\|LOCK_NB)` for the life of the process (`deinit` unlocks). Second start → `alreadyRunning`. |
| idx rms≈0.009, not flat zero | Quiet room, not digital silence. |
| `pending_piece_count=0`, spool empty | Cut never reached `RoomPieceSpool.publish`. |

### Ruled out by Mini (do not re-open)

- **Silence does not abort a cut.** `RoomPiecePlanner.fullPieceSamples = 4_800_000` (300 s @ 16 kHz). The planner only looks at idx sample ranges and discontinuities. `silence_ms` is **heartbeat only** (`PCMTailMeter`, −55 dBFS / `|sample| ≥ 59`) and is sent as `silence_ms` on the poll. It is not an input to `plan()` / `encode()`.
- **Disk is not full.** 113 GB free; errno 24 is EMFILE, not ENOSPC.
- **Capture is not dead.** Tapewriter keeps `tape.pcm` / `tape.idx` growing under the session dir.
- **Upload is not wedged.** A wedged upload would leave `pending ≥ 1` and files in `spool/`.

### Piece pipeline (plain capture, 0.1.22)

```
tapewriter  --record-->  tape.pcm + tape.idx
                              |
RoomEngine.run() loop (~1.5s)
  1. publishAvailable(finalFlush: false)     // CUT — fails here
  2. drainPending()                          // never sees a piece
```

`FFmpegPieceEncoder.encode`: unique `.piece-<uuid>.pcm.tmp` + `.webm.tmp`; `copyExactRange` then `FoundationPieceProcessRunner` (ffmpeg); `defer` unlinks temps. **`writeFailed` is thrown in `copyExactRange` when `open(pcm.tmp)` returns −1.** ffmpeg is not started on the current attempt. Throws are caught in `run()`, `lastError` is saved, `segment.nextSample` is **not** advanced → tight retry every ~1.5 s.

### Where PIPEs leak (piece pipeline + long-lived process)

`copyExactRange` itself **does not leak**: source and dest FDs are `defer { close }`. If `open(pcm.tmp)` fails, no dest FD is taken. That open is the EMFILE **victim**.

The table is PIPEs. In the **piece pipeline** the only `Pipe()` is:

```
FoundationPieceProcessRunner.run
  errorPipe = Pipe()
  process.standardError = errorPipe
  process.run()
  errorPipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  // never closeFile() on read or write end
```

Once a 4.8e6-sample plan exists, this runs every cutter loop. Parent keeps both pipe ends; Foundation `Process` may retain the `Pipe` after exit. Without an explicit close, FDs survive into the next attempt.

Same missing-close pattern exists on the **poll path** (`MachineFactsReader.runTool`: `pmset` / `launchctl` / `scutil` every ~1.5 s for the whole 3-day pid). `report_diag` helpers are rare. The resident-archive encoder **does** close pipe ends — this session is the **plain** cutter (`captures/bs_hk2d7acj/tape.pcm`).

After EMFILE, `encode` throws before `runner.run`, so **that** loop adds no new ffmpeg pipe. The ~4847 PIPEs are from **earlier** `Pipe()` constructions on this pid. Tapewriter is a child with its own FD table → PCM continues.

`NSPOSIXErrorDomain Code=9` on stop (playbook Fault W) is **EBADF** — same FD-table family.

### 0.1.22

Home Office is the only Mini on **0.1.22** and the only one with a **3-day pid** holding the lock. `FoundationPieceProcessRunner` text is the same as 0.1.21 (`PiecePipeline.swift` diff empty vs `5af9075`). 0.1.22 did **not** add a pipe-close fix. It did add `silence_ms` / `clip_count` (`PCMTailMeter` closes its `FileHandle` — REG, not PIPE). The defect that bit today is **this long-lived 0.1.22 process** leaking PIPEs until the cutter cannot `open`.

### Recommended fix (product — not in this docs-only PR)

1. **Close-always** in `FoundationPieceProcessRunner` (and `runTool`): after `run()`, close the parent write end; `defer { closeFile() }` both ends after `waitUntilExit`. Prefer `FileHandle.nullDevice` for ffmpeg stderr (`-loglevel error`).
2. Back off when `last_error` is errno 24 — do not tight-loop `Pipe()` / `open(pcm.tmp)`.
3. **Max uptime:** recycle the engine so a leak cannot hold `room-recorder.lock` for days. Immediate ops **is** kill that pid (lock releases on `deinit` / process death).

### Next (ops)

The lock is held by the leaked pid. A second `room-recorder` will not start (`alreadyRunning`). Recycle **that** process:

1. `end_day` first. `restart_engine` refuses `session_open` unless `force`. Code=9 on stop is still W.
2. `restart_engine` (0.1.22) **or** `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder` — new pid, new FD table, lock reacquired.
3. `start_day`. Confirm PIPE count is tens, not thousands, and a WebM within ~5 min.

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
| **0.1.22** | Home Office `test` only | Same piece `Pipe()` as 0.1.21; **this pid** leaked until EMFILE and still holds `room-recorder.lock`. `silence_ms` is heartbeat-only, not a cut abort. |

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
| Home Office EMFILE / empty spool | `RoomPiecePipelineError.writeFailed`; `copyExactRange` + `FoundationPieceProcessRunner` (`Pipe` never closed); `RoomEngineInstanceLock` (`room-recorder.lock`, `flock` for process life) |
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
