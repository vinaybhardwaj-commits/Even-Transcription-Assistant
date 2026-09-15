# RCA — Even Scribe fleet `start_day` morning of 15 Sep 2026

Investigate-only. No behaviour change. Live reads were taken ~05:00 UTC (10:30 IST) against production via Even-Scribe MCP. Native Room Recorder source is **not** on `main`; it lives on `feat/room-recorder` / `vinay/release-b1`. This note maps today’s symptoms onto that code and the 12 Sep troubleshooting spec.

Named faults below are the ones already in `docs/handoff/ETA-ROOM-TROUBLESHOOTING-SPEC-12-SEP-2026.md` on `vinay/release-b1`.

### Field RCA (OPD Bot / clinic Macs) — fold-in

| Room | Verdict | Code vs ops |
|---|---|---|
| **Home Office** | **CONFIRMED FD leak, continues after kickstart.** First pid: ~4885 FDs vs soft `maxfiles=256` → errno 24. New session `bs_tgys4atu`: recording OK, tape growing, **no errno 24 yet**, FDs **947 → 999 → 1101** (mostly PIPE) within minutes. macOS may still `open()` above the soft limit until the hard limit. | Live leak is **`MachineFacts.runTool` ×3 every ~1.5 s poll while recording**, not only failed piece writes. ffmpeg `Pipe()` is a second source after 5 min. Fix: https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant/pull/3 |
| **Room 4.1** | DISCUSSION Mac has **no TONOR — only C270.** `tapewriter.log`: 3× `Audio acquisition cycle N produced no durable growth` then `physical_fallback_required` (~15–16 s). `tape.pcm` **0 bytes.** Session ends. `ack_timeout` is the 8 s MCP wait, not the fault. | **Fault D / USB-CoreAudio.** Path: `CaptureReadinessCoordinator.acquire` → `Recorder` throw. Not a piece-pipeline bug. |
| **OPD 3** | TONOR selected; `tape.pcm` **all zeros** while growing. Pieces upload (~212 KB). | **`SILENT_WHILE_RECORDING` is the correct signal.** Mute/cable. Not a cutter bug. |
| **Cardiology / OPD 5 / OPD 6** | Tailscale **offline 18–20 h** (sleep/power). | **Ops, not code.** |

---

## What is actually listening

`start_day` is **not** an HTTP “press the mic.” MCP inserts a `bench_command` and waits 8 s (`ACK_WAIT_MS` in `lib/bench-bus-constants.ts`). The native app (or a browser kiosk) must poll `GET /api/bench/commands` with `last_poll_at` ≤ 10 s (`LISTENER_FRESH_MS`) or the tool returns `kiosk_not_listening` and **does not create a session**.

The native Room Recorder **is** that kiosk: `tab_id = app_<install_id>`. The now-picture’s `page_open` / `listener_state` is that poll, not a Safari tab. Copy that still says “open the room page on the Mini” is leftover from the browser-kiosk era.

A second heartbeat (`install_id`, `tape_advancing`, `peak`, `zero_ratio`, …) rides the same poll and updates `room_install`. **`tape_advancing` is local durable-sample growth**, not “a row exists in `bench_chunk`.” Home Office: tape can advance while PIPEs climb on that same poll (`machineFacts` → `runTool`).

---

## Class A — PIPE leak on the live recording poll (Home Office, 0.1.22)

**Root cause:** every `RoomEngine.run` iteration (~1.5 s), including while recording is healthy, calls `machineFacts(configuration.deviceUID)` → `MachineFactsReader.runTool` **three times**:

| Helper | Caller |
|---|---|
| `/usr/bin/pmset -g` | `neverSleep()` |
| `/bin/launchctl print gui/<uid>/com.evenscribe.room-recorder` | `launchAgentLoaded()` |
| `/usr/sbin/scutil --get ComputerName` | `hostname()` |

Each `runTool` does `Pipe()` for stdout and **never closes** the handles (0.1.22). That is the leak that **does not wait for a piece failure or a 5-minute cut**. Kickstart only starts a new pid; the same poll still leaks.

**Rate:** 3 pipes × 2 ends ≈ **6 PIPE FDs per poll**. ~4 FD/s at 1.5 s. 947 → 1101 (+154) is ~40 s of polling — matches post-bounce “within minutes.” ~947 already implies a few minutes of leak after launch.

**Soft `maxfiles=256`:** Mini `ulimit -n` / `maxfiles` soft limit is 256. macOS can still grant FDs up to a higher **hard** limit, so lsof can show 947–1101 **without** errno 24 yet. EMFILE (`writeFailed` on `.pcm.tmp`) is when the hard ceiling is actually hit (first pid ~4885).

**Second source (only after 5 min of tape):** `publishAvailable` → `FoundationPieceProcessRunner` — another `Pipe()` on ffmpeg stderr every cutter loop. Not required to explain `bs_tgys4atu` climbing before the first piece.

**Not the leak:** `copyExactRange` `open(.pcm.tmp)` (victim of EMFILE); `PCMTailMeter` (REG `FileHandle`, closed); tapewriter child (own FD table; log handle is one file); resident archive encoder (closes pipes; not this session).

**Live:**

| When | Session | What |
|---|---|---|
| ~05:00Z | `bs_hk2d7acj` | 3-day pid, ~4885 FDs, errno 24, empty spool |
| Post-kickstart | `bs_tgys4atu` | Recording OK, `tape.pcm` growing, **no errno 24 yet**, FDs **947 → 999 → 1101** PIPE |

### 0.1.22 code fix

Closing Foundation `Pipe` handles after `waitUntilExit` is not a reliable Darwin fix (`Process` can retain extra ends). **Do not use `Pipe()` on this path.** PR https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant/pull/3 captures helper/ffmpeg stdio via temp files (`RoomSubprocess`) and closes them.

Until that build is on the Mini, FDs will climb on every recording. Kickstart again only resets the counter.

### Addendum — `bs_tgys4atu`: 10 min, ~26 MB PCM, still no piece, no `last_error`

Tape size is **not** the cut cursor. `RoomPiecePlanner.plan` only sees **`tape.idx` `samples`**, and only emits a piece when `region.end - segment.nextSample >= 4_800_000`. Silence/`silence_ms` is **not** a gate. `spool.pending()` ignores hidden `.piece-*.tmp`, so `pending_piece_count` stays 0 until `spool.publish` after a successful encode.

FDs oscillating ~1k–1.3k means the **poll loop is running**. `publishAvailable` is therefore returning quickly — not blocked in a 9.6 MB copy/ffmpeg (that would stall polls). ffmpeg is **not scheduled** unless `plan` is non-empty.

Gates that match empty spool + empty `last_error`:

1. **`lastError` wiped every successful poll.** After `publishAvailable` throws, `lastError` is saved, then `if retainedArchiveReady { lastError = nil }` (`RoomEngine.run` ~1338). On the plain path `refreshRetainedArchiveRecovery()` is **true** when there is no retained-archive job (`guard let retainedArchiveRecovery else { return true }`). Clinic Macs always clear cutter errors on the next heartbeat. **Absence of `last_error` does not mean the cutter succeeded.**

2. **Planner returns `[]` (no throw).** Last idx `samples` still `< 4_800_000` (or idx unreadable as empty), even if `tape.pcm` is 26 MB. Confirm with `tail -1 …/tape.idx` — the planner never looks at PCM byte size.

3. **Silent no-op (no throw).** `residentCaptureOwner != nil` or `capture == nil` → `publishAvailable` returns. Unlikely here (`captures/<session>/tape.pcm` + `tape_advancing`), but it would look identical in `status.json`.

4. **Throw then (1).** `uncoveredSample`, `indexBeyondPCM`, ffmpeg/`writeFailed` — same empty `last_error` after the poll.

Ops on that Mini: `tail -1 tape.idx` (`samples` vs 4800000), `ls -la spool` (hidden tmps), and whether `last_error` flashes between polls. Do not wait for EMFILE; the first piece is already overdue.

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
| **0.1.22** | Home Office `test` only | **`runTool` ×3 per poll leaks PIPEs while recording.** Kickstart resets the count; `bs_tgys4atu` climbed 947→1101 in minutes. ffmpeg `Pipe()` is a second source after 5 min. PR #3 removes `Pipe()`. |

Healthy today: OPD 7 (0.1.21, TONOR, ~1.2 MB), OPD 1 (0.1.8, C270, ~1.2 MB). Home Office recording can look healthy while PIPEs climb. Room 4.1 is **C270 USB**, not TONOR.

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
| Home Office PIPE leak | `MachineFactsReader.runTool` (`pmset`/`launchctl`/`scutil` every poll); `FoundationPieceProcessRunner` (after 5 min). Fix: `RoomSubprocess` in PR #3 |
| `tape_advancing` vs pieces | `InstallPollFields.swift`; BUILD-HISTORY 0.1.7 fix (durable index, not piece cursor) |
| `SILENT_WHILE_RECORDING` | `evaluateInstallStates` + `SILENT_POLLS` / `SILENT_ZERO_RATIO` |
| `restart_engine` | `RoomEngine.restartEngine` — refuses `session_open` unless `force`; then non-zero exit for launchd |

`main` in this checkout predates fleet/install/state_flags. Production MCP already serves them.

---

## What not to do

- Do not treat Home Office kickstart as a code fix. `bs_tgys4atu` leaked again on the live poll. Ship PR #3 (`RoomSubprocess`, no `Pipe()`).
- Do not treat Room 4.1 as TONOR mute — DISCUSSION Mac has **only C270**. Reseat USB; `physical_fallback_required` is the log line.
- Do not treat OPD 3’s growing zero `tape.pcm` / 212 KB pieces as “encoder broken.”
- Do not treat Cardiology/OPD 5/OPD 6 as software start bugs — Tailscale/sleep, 18–20 h.
