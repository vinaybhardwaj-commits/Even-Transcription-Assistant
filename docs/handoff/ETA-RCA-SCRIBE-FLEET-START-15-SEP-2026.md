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

**Live (Mini, later):** LaunchAgent up; tapewriter writing `captures/bs_hk2d7acj/{tape.pcm,tape.idx}`; ~24 MB PCM; idx rms≈0.009 peak≈0.05; `status.json` `state=recording`, **`pending_piece_count=0`, spool empty**. Capture is alive. The break is **after** durable PCM, **before** a WebM lands in `spool/`.

**Duration note:** tape is **16 kHz s16le mono** after `PCMResampler` (`TapeConstants.sampleRate = 16_000`, 32 000 bytes/s). 24 MB ≈ **12.5 minutes**, not 4.6 min (that 4.6 min figure assumes 44.1 kHz). A full piece is **4 800 000 samples = 300 s @ 16 kHz = 9.6 MB of PCM** (`RoomPiecePlanner.fullPieceSamples`). 24 MB is **past two cut boundaries**. Waiting for “the first 5 minutes” no longer explains empty spool.

### Piece pipeline (plain capture path — this session)

```
tapewriter  --record-->  tape.pcm + tape.idx (checkpoint every 1.25s)
                              |
RoomEngine.run() loop (~1.5s)
  1. publishAvailable(finalFlush: false)     // CUT
  2. drainPending()                          // UPLOAD
```

| Step | Function | What “success” looks like |
|---|---|---|
| Capture | `TapeWriter.checkpoint` | idx `samples` = `byte_offset / 2`, tracks PCM |
| Plan | `RoomPiecePlanner.plan` | one plan per **exactly** 4.8e6 samples; remainder waits until `finalFlush` or a discontinuity |
| Encode | `FFmpegPieceEncoder.encode` | writes `spool/<session>_chunk_NNNNN.webm` via bundled ffmpeg (`libopus` 32k voip) |
| Spool | `RoomPieceSpool.publish` | sibling `.json` manifest; **this** is what `pending_piece_count` counts |
| Upload | `RoomEngine.drainPending` → `uploadImmutablePiece` | R2 + `POST /api/bench/chunks`; then `removeVerified` (spool empties **after** success) |

`pending_piece_count` is `spool.pending().count` (`saveStatus`). **Empty spool + growing PCM means cut never published a piece**, not “upload is slow.” A wedged **upload** would show `pending_piece_count ≥ 1` and files in `spool/`.

`tape_advancing` is **not** the cutter. It compares consecutive durable idx sample counts (`currentDurableSampleIndex` / `tapeIsAdvancing`). `segment.nextSample` is the **cut cursor**, advanced only after a successful encode+publish.

### What leaves spool empty while recording continues

`publishAvailable(finalFlush: false)` is the only periodic cutter. It no-ops or fails without touching spool in these cases:

1. **`residentCaptureOwner != nil` → immediate return** (first line of `publishAvailable`). Resident archive uses a different delivery pipeline. This session’s `captures/bs_hk2d7acj/tape.pcm` layout is the **plain** path, so this should be off. Confirm `resident_archive_capture_enabled` in a fresh `report_diag`.

2. **`capture == nil`** — engine lost the `Segment` while tapewriter still runs (should not happen with the instance lock; would still look like this).

3. **Planner returns `[]`** — last idx `samples` still `< 4_800_000`, or idx unreadable as empty. **Ruled out** if last idx line has `samples` ≥ 4.8e6 (24 MB PCM implies ~1.2e7 if idx is in lockstep).

4. **Planner / IndexLog throws** — caught in `run()`, `lastError` set, **cursor not advanced**, retry next loop. Typical: `indexBeyondPCM`, `byte_offset must equal samples * 2`, `sample 0 is not covered by the index` (`uncoveredSample` if the first idx record’s `samples` > `nextSample`).

5. **`FFmpegPieceEncoder.encode` throws** — **most likely once (3) is ruled out.** Plans exist; `spool.publish` never runs. Failures: `ffmpeg exited N: …` (spawn/hardened-runtime/libopus on macOS 27), `emptyOutput`, `destinationExists` (leftover webm — would mean spool **not** empty unless cleaned). Encode uses unique `.tmp` names then `installWithoutReplacement`; temps are deleted on `defer`.

`drainPending` is **not** in the empty-spool picture: it only walks already-published spool entries. Its 5→60 s backoff only matters after a piece is sitting in `spool/`.

### Next (ops — one read, then Fault W cure)

On the Mini, **one** of:

```
plutil -p "$HOME/Library/Application Support/EvenScribe/RoomRecorder/status.json"
# last_error is the cutter/ffmpeg/index exception if (4) or (5)
tail -1 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/captures/bs_hk2d7acj/tape.idx"
# "samples" >= 4800000 ⇒ planner should have emitted a piece; empty spool ⇒ ffmpeg/index throw
ls -la "$HOME/Library/Application Support/EvenScribe/RoomRecorder/spool"
```

Then playbook §2.2: `end_day` first (never `restart_engine` while `session_open`). Then `restart_engine`, `start_day`. If `end_day` returns `NSPOSIXErrorDomain Code=9`, that is the documented W fingerprint.

**Builder:** if `last_error` is `ffmpeg exited …`, the 0.1.22 bundled encoder vs macOS 27 is the defect (cut never starts). If `samples` on the last idx line is still `< 4800000` with 24 MB PCM, idx and PCM have diverged (cut never starts). Do not treat as TONOR mute.

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
| **0.1.22** | Home Office `test` only (Room 4.1 stayed `stable`) | Adds `silence_ms`, `clip_count`, `restart_engine`, `report_diag`. **Does not prevent Fault W.** `tapewriter --version` is not a real command (`unknown command: --version`) — ignore that diag line. |

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
| `tape_advancing` vs pieces | `InstallPollFields.swift`; BUILD-HISTORY 0.1.7 fix (durable index, not piece cursor) |
| `SILENT_WHILE_RECORDING` | `evaluateInstallStates` + `SILENT_POLLS` / `SILENT_ZERO_RATIO` |

`main` in this checkout predates fleet/install/state_flags. Production MCP already serves them.

---

## What not to do

- Do not `close_orphaned_session` on Home Office while the native listener is **fresh and claims** `bs_hk2d7acj` — that door refuses `kiosk_attached` by design (`lib/bench-orphan.ts`).
- Do not `restart_engine` on 0.1.22 while `session_open`.
- Do not treat OPD 3’s 212 KB pieces as “encoder broken.”
- Do not treat Cardiology/OPD 4/5/6 as software start bugs until the Mac polls again.
