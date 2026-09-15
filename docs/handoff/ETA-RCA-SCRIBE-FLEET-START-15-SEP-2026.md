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

**Live:** `home-office-w8fb`, session `bs_hk2d7acj`, app **0.1.22** (`test`), macOS 27. `start_day` **acked** in ~5.5 s (`cmd_xmx9fwc2`). Native: `session_open=true`, `tape_advancing=true`, streak hundreds, TONOR selected, peak ~0.01–0.035 (above digital zero). Server: **0 chunks, 0 events**, `audio_recorded_ms=0`, tape lane “Says recording, silent 14m”, `stalled=true` (10-minute **chunk** stall, `STALLED_BADGE_MINUTES`).

**Not:** the 30-minute reaper (`lib/bench-reaper-core.ts`). That would `PATCH` ended with note `auto-ended: no chunks >30m`. The row is still `recording`.

**Not:** silent mic. Levels are non-zero. `SILENT_WHILE_RECORDING` is **not** set. Contrast OPD 3 (Class C).

**Root cause (verified against code + playbook):** **Fault W — wedged capture.** `startCapture` waited until tapewriter’s index showed durable growth (`waitForDurableGrowth`, 20 s cap) and then acked. After that, **5-minute piece cut + R2 verify + `POST /api/bench/chunks` never completed**. Native still reports tape advancing because the PCM/index frontier moves; the operator now-picture stalls because it clocks **uploaded** pieces (`isBenchStalled` / `last_any_chunk_at`).

Healthy rooms (OPD 7 / OPD 1) had piece 0 at T+5 min (~1.1–1.3 MB). Home Office at T+15 min still had none.

**Next (ops, 0.1.22):** playbook §2.2 — `end_day` first (never `restart_engine` while `session_open`; that verb **refuses** `session_open`). Then `restart_engine`, then `start_day`. Confirm first piece at the next 5-minute boundary. If `end_day` returns `NSPOSIXErrorDomain Code=9`, that is the documented W fingerprint.

**Next (builder):** inspect this Mini’s spool / tapewriter.log / upload backoff. macOS 27 + 0.1.22 is the unique pair in the fleet. Do **not** treat this as “TONOR mute” unless levels collapse to ~0 and `zero_ratio` ≥ 0.98.

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
