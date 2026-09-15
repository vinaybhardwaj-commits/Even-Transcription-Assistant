# RCA — Even Scribe fleet `start_day` morning of 15 Sep 2026

Investigate-only. No behaviour change. Live reads were taken ~05:00 UTC (10:30 IST) against production via Even-Scribe MCP. Native Room Recorder source is **not** on `main`; it lives on `feat/room-recorder` / `vinay/release-b1`. This note maps today’s symptoms onto that code and the 12 Sep troubleshooting spec.

Named faults below are the ones already in `docs/handoff/ETA-ROOM-TROUBLESHOOTING-SPEC-12-SEP-2026.md` on `vinay/release-b1`.

### Field RCA (OPD Bot / clinic Macs) — fold-in

| Room | Verdict | Code vs ops |
|---|---|---|
| **Home Office** | **CONFIRMED FD leak.** `room-recorder` ~4885 FDs vs **`ulimit -n` 256** → errno 24 on piece tmp. LaunchAgent **kickstarted; now ready.** | **Code fix still required** in 0.1.22 `PiecePipeline.swift` (`FoundationPieceProcessRunner` never closes `Pipe()`). Kickstart only recycled the pid. |
| **Room 4.1** | DISCUSSION Mac has **no TONOR — only C270.** `tapewriter.log`: 3× `Audio acquisition cycle N produced no durable growth` then `physical_fallback_required` (~15–16 s). `tape.pcm` **0 bytes.** Session ends. `ack_timeout` is the 8 s MCP wait, not the fault. | **Fault D / USB-CoreAudio.** Path: `CaptureReadinessCoordinator.acquire` → `Recorder` throw. Not a piece-pipeline bug. |
| **OPD 3** | TONOR selected; `tape.pcm` **all zeros** while growing. Pieces upload (~212 KB). | **`SILENT_WHILE_RECORDING` is the correct signal.** Mute/cable. Not a cutter bug. |
| **Cardiology / OPD 5 / OPD 6** | Tailscale **offline 18–20 h** (sleep/power). | **Ops, not code.** |

---

## What is actually listening

`start_day` is **not** an HTTP “press the mic.” MCP inserts a `bench_command` and waits 8 s (`ACK_WAIT_MS` in `lib/bench-bus-constants.ts`). The native app (or a browser kiosk) must poll `GET /api/bench/commands` with `last_poll_at` ≤ 10 s (`LISTENER_FRESH_MS`) or the tool returns `kiosk_not_listening` and **does not create a session**.

The native Room Recorder **is** that kiosk: `tab_id = app_<install_id>`. The now-picture’s `page_open` / `listener_state` is that poll, not a Safari tab. Copy that still says “open the room page on the Mini” is leftover from the browser-kiosk era.

A second heartbeat (`install_id`, `tape_advancing`, `peak`, `zero_ratio`, …) rides the same poll and updates `room_install`. **`tape_advancing` is local durable-sample growth**, not “a row exists in `bench_chunk`.” Home Office this morning: tape advanced while pieces did not (PIPE leak / EMFILE). Kickstart recycled the pid; **the PiecePipeline leak is unfixed.**

---

## Class A — PIPE FD leak in a long-lived 0.1.22 `room-recorder` (Home Office)

**Root cause:** one `room-recorder` pid ran since Sat 12 Sep and leaked thousands of Foundation `Pipe()` FDs. The piece cutter failed at `RoomPiecePipelineError.writeFailed` (**errno 24 / EMFILE**) when opening `spool/.piece-….pcm.tmp` because **`ulimit -n` is 256**. Tapewriter (child) still wrote PCM. Kickstart recycled that pid (engine **ready**). **The leak in `FoundationPieceProcessRunner` is unfixed.**

**Not:** dead capture, disk full, quiet-room abort, or upload wedge.

**Live (server, ~05:00Z):** `home-office-w8fb`, session `bs_hk2d7acj`, app **0.1.22** (`test`), macOS 27. `start_day` **acked** in ~5.5 s (`cmd_xmx9fwc2`). Native: `session_open=true`, `tape_advancing=true`. Server: **0 chunks**.

**Live (Mini — confirmed, do not discard):**

| Fact | Why it matters |
|---|---|
| pid up since Sat 12 Sep (~3 days) | Leak exposure is **process lifetime**, not this morning’s `start_day`. |
| ~4885 FDs, **~4847 PIPEs**, vs **`ulimit -n` 256** | Soft FD ceiling on the Mini is 256. `open(pcm.tmp)` → EMFILE as soon as the table is full. lsof on the leaked pid counted thousands of PIPE ends. |
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

### 0.1.22 code fix (still required — kickstart is not the fix)

LaunchAgent was **`kickstart -k`’d**; the leaked pid is gone, lock released, engine **ready**. That does **not** close the hole. The next long-lived 0.1.22 process will leak PIPEs again until `ulimit -n` (256 here) is hit.

**Patch `FoundationPieceProcessRunner` in `apps/room-recorder/Sources/RoomRecorderCore/PiecePipeline.swift`:**

Today it allocates `errorPipe = Pipe()`, assigns it to ffmpeg stderr, reads to EOF, `waitUntilExit()`, and **never `closeFile()`**. Parent keeps both ends; FDs survive into the next cutter loop (~1.5 s once a 4.8e6-sample plan exists).

Required behaviour (same hygiene as `FoundationArchiveStreamingProcess`):

1. `defer { try? errorPipe.fileHandleForReading.close(); try? errorPipe.fileHandleForWriting.close() }`
2. After `process.run()`, close the **parent write end** so the read can see EOF.
3. Prefer `process.standardError = FileHandle.nullDevice` if stderr is not needed (`-loglevel error` already). No `Pipe()` at all is the smallest leak surface.

Also close pipes in `MachineFactsReader.runTool` (every poll). Back off when `last_error` is errno 24. Optional: max-uptime recycle so a pid cannot hold `room-recorder.lock` for days.

This docs PR does **not** land that Swift change (`main` has no Room Recorder; native lives on `vinay/release-b1`). Ship the close-always patch on that branch before 0.1.22 stays on any Mini overnight.

### Ops (done)

Kickstart recycled the process. Confirm PIPE count is tens, not thousands, and a WebM within ~5 min of the next `start_day`. Do not treat as TONOR mute.

---

## Class B — `physical_fallback_required` after 3 empty acquisition cycles (Room 4.1)

**Live (server):** `room-4-1-after-cards-before-5-494q`, app **0.1.21** (`stable`). DISCUSSION Mac has **no TONOR hardware — only C270**. Commands today failed `tapewriter exited with status 1` at ~16–17 s (`cmd_wkgt8za2`, `cmd_xcknbvsz`, `cmd_3qxnqan4`, `cmd_kbffdvcu`). Sessions `bs_67v5bd7r` / `bs_e99nxzr7` **ended ~15.7 s**, 0 chunks, `notes` null (native compensation, not the reaper). D30 then shows “Finished for today” — **UI**, not a lock.

**Live (Mini / `tapewriter.log` — confirmed):**

```
Audio acquisition cycle 1 produced no durable growth.
Audio acquisition cycle 2 produced no durable growth.
Audio acquisition cycle 3 produced no durable growth.
```

then **`physical_fallback_required`**. `tape.pcm` is **0 bytes** (writer created the file; no checkpoint ever advanced the durable offset). `ack_timeout` is a **consequence**: MCP waits 8 s (`ACK_WAIT_MS`); the helper takes ~15 s to fail.

### Acquisition / fallback path (tapewriter)

`Recorder` (`apps/room-recorder/Sources/tapewriter/Recorder.swift`):

1. `TapeWriter.startAndWaitUntilReady()` — creates `tape.pcm` / `tape.idx` (can be empty).
2. `CaptureReadinessCoordinator.acquire` with **`CaptureReadinessPolicy.coldBoot`**: `maximumAttempts = 3`, `attemptWindowNS = 5e9`. Deadlines are **from acquisition start**: attempt 1 ≤ **5 s**, attempt 2 ≤ **10 s**, attempt 3 ≤ **15 s** (`attemptWindowNS * attempt`).
3. Each attempt: `AudioDevices.selected(uid:)` → `CaptureSession.start` with `captureGeneration = attempt`. Growth is `TapeWriter.hasDurableGrowth(after: baselineOffset, captureGeneration:)` — durable offset must pass the baseline **for that generation** before the deadline.
4. If the window expires with no growth: `stopAttempt`, then `attemptDidNotGrow` prints **`Audio acquisition cycle N produced no durable growth.`**
5. After 3 failures: outcome **`.physicalFallbackRequired`**. Recorder finalizes and throws:

   `physical_fallback_required: durable audio did not grow after two five-second acquisition retries; unplug the input USB device for at least five seconds, then reconnect it`

   (The throw string says “two retries”; the policy is **three** attempts / ~15 s. The log’s 3× cycle lines are the source of truth.)

6. Helper **exits 1**. No durable samples → `tape.pcm` stays **0 bytes**.

### Engine mapping (`RoomEngine`, 0.1.21)

`startCapture` → `waitForDurableGrowth` (20 s or until the child dies). Child already exited 1 → `RoomEngineError.captureExited` → **`tapewriter exited with status 1`**.

`beginOrResume` compensation (`.noDurableGrowth`): `stopCaptureAndPublishFinal` → `PATCH` session **end** → fail-ack. That is why the session is ~15.7 s long with 0 chunks. MCP’s 8 s wait already returned `ack_timeout` (command was delivered).

There is **no TONOR to switch to** on this Mac. `sudo killall coreaudiod` does not fix Fault D. Same Mini recorded 115 pieces on 12 Sep (`bs_m3kgj3ty`) after identical 16 s failures then a USB reseat.

**Ops:** unplug **C270**, wait ≥ 5 s (the throw’s instruction), **same USB port** (uid suffix is the port), `start_day`. Confirm `tapewriter.log` shows `Recording ready after durable checkpoint growth` and `tape.pcm` growing past 0.

**Optional product (not this RCA):** raise `ACK_WAIT_MS` on `start_day` only (~20 s) so MCP surfaces `tapewriter exited with status 1` / `physical_fallback_required` instead of `ack_timeout`.

---

## Class C — `SILENT_WHILE_RECORDING` (OPD 3) — correct signal, not a piece-pipeline bug

**Live (server + Mini):** `opd-3-kjpf`, app 0.1.21. TONOR **is selected**. `tape.pcm` is **growing and all zeros** (digital silence). Session `bs_ryqjan2t` **is uploading**: 300 s pieces, **each exactly 212 378 bytes**, `zero_ratio=1`, `peak=0`. Flag `SILENT_WHILE_RECORDING`. Fleet `input_devices` may still list C270 as system default; the session `mic_label` is TONOR.

The cutter and encoder are doing their job: 4.8e6 samples of zeros → near-CBR ~212 KB WebM. Same encoder on OPD 7 TONOR with live input is ~1.16–1.26 MB.

**What the flag is:** `evaluateInstallStates` (`lib/bench-bus-constants.ts` on `vinay/release-b1`): recording **and** `tape_advancing`, then `zero_ratio ≥ 0.98` for ≥ 80 polls (~2 min) on 0.1.21 (`silence_ms ≥ 120_000` wins on 0.1.22 if present). `zero_ratio` is **bit-exact zeros**, not a quiet room.

This is **not** undersized-piece health (`lib/mic-health.ts` D36) and **not** the Home Office PIPE leak.

**Root cause:** **Fault S — silent input** on the selected TONOR (mute LED or cable). Same 11–12 Sep finding.

**Ops:** hand in the room, or `set_audio_input` to C270 if present, then confirm the **next** piece is ~1.1 MB and the flag clears.

---

## Class D — Tailscale / sleep offline (ops, not code)

`kiosk_not_listening` = no `bench_listener` poll within 10 s. Offline copy uses `LISTENER_OFFLINE_MS` (10 min).

**Cardiology, OPD 5, OPD 6:** Tailscale **offline 18–20 h** — Mini sleep/power. Not a start_day or piece-pipeline bug. Wake the Mac / keep Tailscale up; then `start_day`.

| Room | Last native poll (pre-outage) | Install | Notes |
|---|---|---|---|
| Cardiology | 14 Sep 08:39Z | 0.1.21, `never_sleep=false` | Sleep/power; Tailscale down |
| OPD 5 | 14 Sep 08:25Z | 0.1.21, `never_sleep=true` | Sleep still won. Stale `session_open` on the install row is last-write. Yesterday `bs_m24h8v5m` reaper-ended (0 chunks). |
| OPD 6 | 14 Sep 10:26Z | 0.1.21 | Same Tailscale/sleep |
| OPD 4 | 14 Sep 08:28Z | **0.1.8**, `signature_mismatch` on 0.1.21 | Offline **and** stuck on old app |
| OT 3 | never | `install: null` | **not_installed** — mint/paste; not a start bug |

OPD 4 / OT 3 remain install problems, not today’s start path.

---

## Versions (0.1.8 / 0.1.21 / 0.1.22)

| Version | Who | Relevant behaviour |
|---|---|---|
| **0.1.8** | OPD 1 (recording today), OPD 4 (offline) | Capture/upload still works (OPD 1: ~1.2 MB pieces on C270). No `peak`/`input_devices` heartbeat. **Cannot self-update to 0.1.21:** `last_update_result=signature_mismatch` (“downloaded app was not signed by Even”) — designated-requirement / Team ID check from R3. Ops: re-enrol or fix signing; do not keep clicking update. |
| **0.1.21** | stable clinic | Fault D (tapewriter exit 1), Fault S (TONOR zeros), `SILENT_WHILE_RECORDING` via `zero_ratio`. No `check_update_now` / `restart_engine`. |
| **0.1.22** | Home Office `test` only | **PIPE leak in `FoundationPieceProcessRunner` still unfixed.** Kickstart cleared today’s EMFILE; next overnight pid can hit `ulimit -n` 256 again. `silence_ms` is heartbeat-only. |

Healthy today: OPD 7 (0.1.21, TONOR, ~1.2 MB), OPD 1 (0.1.8, C270, ~1.2 MB). Home Office is **ready after kickstart** but 0.1.22 still needs the PiecePipeline pipe-close. Room 4.1 is **C270 USB**, not TONOR.

---

## Files / functions (this repo + native branch)

| Symptom | Where |
|---|---|
| `kiosk_not_listening` / 8 s `ack_timeout` | `lib/mcp/tools/bench.ts` `sendAndWait`; `lib/bench-commands.ts` `isListening` / `decideStart`; `lib/bench-bus-constants.ts` `ACK_WAIT_MS`, `LISTENER_FRESH_MS`, `COMMAND_EXPIRY_SECONDS` |
| “Finished for today” | `roomState()` D30 in `lib/bench-bus-constants.ts` |
| Server `stalled` (no uploaded piece 10 min) | `lib/bench-reaper-core.ts` `STALLED_BADGE_MINUTES`; tape lane in `lib/room-facts.ts` |
| Reaper 30 min auto-end | `NOTE_STALL` — **not** Room 4.1 today |
| Chunk verify | `app/api/bench/chunks/route.ts` (HEAD R2 then row) |
| Room 4.1 `physical_fallback_required` | `CaptureReadinessPolicy.coldBoot` + `CaptureReadinessCoordinator.acquire` (`CaptureReadiness.swift`); `Recorder` acquisition loop / throw; `TapeWriter.hasDurableGrowth`; engine `waitForDurableGrowth` / `captureExited` / `beginOrResume` `.noDurableGrowth` |
| Home Office EMFILE | `RoomPiecePipelineError.writeFailed`; `FoundationPieceProcessRunner` (`Pipe` never closed) — **fix still needed on 0.1.22** |
| `tape_advancing` vs pieces | `InstallPollFields.swift`; BUILD-HISTORY 0.1.7 fix (durable index, not piece cursor) |
| `SILENT_WHILE_RECORDING` | `evaluateInstallStates` + `SILENT_POLLS` / `SILENT_ZERO_RATIO` |
| `restart_engine` | `RoomEngine.restartEngine` — refuses `session_open` unless `force`; then non-zero exit for launchd |

`main` in this checkout predates fleet/install/state_flags. Production MCP already serves them.

---

## What not to do

- Home Office is **ready after kickstart**; still **do not** ship 0.1.22 overnight without the `PiecePipeline` pipe-close.
- Do not treat Room 4.1 as TONOR mute — DISCUSSION Mac has **only C270**. Reseat USB; `physical_fallback_required` is the log line.
- Do not treat OPD 3’s growing zero `tape.pcm` / 212 KB pieces as “encoder broken.”
- Do not treat Cardiology/OPD 5/OPD 6 as software start bugs — Tailscale/sleep, 18–20 h.
