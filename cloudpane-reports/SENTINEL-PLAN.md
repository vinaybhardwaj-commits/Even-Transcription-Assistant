# SENTINEL-PLAN: Room Sentinel inventory, map, gaps, slices, risks
cloud-sentinel-plan, 17 Oct 2026. Serving model is named in the session report (repo rule: no model ids in pushed files). Research by three Sonnet readers. Read-only: no product code changed.
Refs read: `origin/guardian/fr1-c1-r16` 41b88298 (kiosk c1-0.4.7-r16d3), `origin/cloudpane/cloud-guardian-r16e{,-w}/r16e` (c1-0.4.8, descends r16), `origin/main` bffc52f7.
`guardian/fr1-c1-control`, `guardian/consult-alert`, `guardian/fr1-consult-open-publish-2`, `consult/micguard-state` are all merged into main. `fr1-consult-open-publish` (no -2) does not exist.
Paths: K = `tools/room-guardian/kiosk` at r16, M = `tools/room-guardian/mini` at main. All SQL INFERRED (no DB here). zero-watch v2 and tailnet-heal are NOT in the repo (Mini-only); described from the brief.

## Five facts that change the design
1. **coreaudiod heal already exists but refuses during a consult.** `heal_coreaudiod` (K/lib/heal.sh:164) escalates when capture is open (:166). It fires only on `coreaudio_no_device` (heal.sh:483). `coreaudio_rms_dead` needs RMS <= -100 dBFS, i.e. exact zero (K/lib/faulttree.sh:43), and is escalate-only (heal.sh:488). Fable's near-zero webcam signature (zero_ratio 0.6-0.97, peak <= 0.001, about -60 dBFS) is not detected by anything on the kiosk.
2. **consult_open is a HOLD, not a consult signal.** The Mini publishes `consult_open` inside `guardian/control`, not as its own topic (M/subscriber/consult_hold.py; subscriber.py:169-170). It is fail-closed TRUE on any stale or unknown source, and its 90 s snapshot rule makes every room true (consult_hold.py:32). It is right for "do not disrupt" and wrong as the MIC_DEAD_WEBCAM trigger, because a stale DB would read as "in consult" and fire coreaudiod. Rooms come from config `consult_room_map`, not hard-coded OPD 6. The publisher is off unless `consult_open_publish` is true (UNVERIFIED in prod).
3. **The health topic does have a monitor.** The subscriber raises `guardian_quiet` after 120 s with no health line (M/subscriber). The pipe "no monitor found" log only means nobody calls `pipe monitor`. But the subscriber writes JSONL plus local SQLite only (subscriber.py:319), so nothing reaches Neon or Rooms Live.
4. **Steward cannot restart or message today.** `LIVE_IMPLEMENTED_ACTIONS = [scribe_start, scribe_stop]` (lib/steward/config.ts:223). The executor throws for restart, ticket and message (lib/steward/executor.ts:246-254), and `issueTicket()` has no caller (lib/steward/tickets.ts:161). "Steward as alert sink" therefore has nothing to plug into. The working sink is `room_alert_outbox` via `queueOpsAlert` (lib/alerts/ops-alert.ts:67).
5. **The kiosk agent is bash, not POSIX sh** (`#!/bin/bash`, `bash -p`, `[[ =~ ]]`). Keep bash: a rewrite would discard 16 rounds of hardening. Its static test forbids perl, python, osascript and jq in kiosk code. RMS uses `od|awk` (K/lib/collect.sh:12-27).

## 1. Inventory
| # | Item (ref) | Senses | Decides | Acts on | Mode | Rooms |
|---|---|---|---|---|---|---|
| I1 | Guardian kiosk loop K/bin/guardian.sh:120 `tick` | all of K/lib/collect.sh | faulttree.sh, 25+ codes | heal.sh ladder | shadow default. Heal only if control `modes[room]=heal` (killswitch.sh:116) | one `GUARDIAN_ROOM` per conf. Installed OPD 6 only |
| I2 | collect.sh:12 `rms_dbfs_2s` | last 2 s of newest tape.pcm, under 5 s old | - | - | live | - |
| I3 | collect.sh:52,170 USB/engine | ioreg IOUSBHostDevice/IOAudioEngine vs `USB_MIC_PATTERN` default `C270` (common.sh:68) | usb_device_missing, usb_power_off, coreaudio_no_device | - | live | C270 only by default |
| I4 | collect.sh:112 HID idle, :116 TCC row (root helper), :153 status.json, presence heartbeat file | | mic_denied/restricted/row_missing, recorder_* (faulttree.sh:65-75), presence_stale :95 | | | |
| I5 | heal.sh:164 `heal_coreaudiod` | coreaudiod pid | coreaudio_no_device | `killall coreaudiod` via guardian-root.sh:80 | heal mode, capture idle only | - |
| I6 | heal.sh:183 `heal_recorder`, :102 `recorder_restart` | | recorder_not_running/hung/needs_enrol | launchctl bootout+bootstrap (not kickstart -k) | capture idle only | - |
| I7 | heal.sh:207 `heal_chrome` | HID idle, speech, consult hold | presence_stale | pkill + open Chrome | night, or day with hold clear + idle 600 s | - |
| I8 | heal.sh:358 `heal_usb_power_off` | CC cable-detect log | usb_power_off | reboot | locked shadow `USB_DPRIME_HEAL=0` (common.sh:86) | - |
| I9 | heal.sh:116 `heal_tcc`, :228 `heal_drift` | | mic_denied numeric row, pmset/launchagent drift | sqlite TCC update, reinstall agent | heal mode | - |
| I10 | killswitch.sh | `guardian/control` (common.sh:73), file `flags/heal-off`, conf/tree checks | kill if any bad or stale > 90 s | - | fail-closed | fleet + per room |
| I11 | killswitch.sh:131 `consult_hold_clear` | consult_open field | clear only on fresh false | gates Chrome, canary, reboot | - | - |
| I12 | canary.sh (r16d3/r16e) | tape RMS rise | pass/aborted:<why> | afplay tone | heal mode, IST 21:40/07:20 slots | - |
| I13 | common.sh:252 `publish` | - | - | pico `kiosk/<room>/{health,heal,canary,probe-reply}` | live | - |
| I14 | M/pipe run-pipe.sh, build-pipe.sh, authorize-key.sh | - | - | pico pipe-ssh on the Mini | live | - |
| I15 | M/subscriber subscriber.py, run_subscriber.py:48,131 | kiosk streams | guardian_quiet 120 s, heal_escalated | JSONL, local cases, INBOX md, publishes `guardian/control` every 30 s | live | rooms in config |
| I16 | M/subscriber/consult_hold.py | pulse_presence_events (hb, encounter_open/close, POST), bench_session, bench_level_sample, opt. eta_encounter_windows | consult_open per room, fail-true | control field | flag `consult_open_publish` | `consult_room_map` |
| I17 | M/router (alert_router, ubus_bus.py:9,40) | cases | page, re-page 600 s/1800 s | ETA bus as `room-guardian` | live | - |
| I18 | lib/steward/* + app/api/cron/steward (1 min) | bench, presence, windows, kiosk_health, room_install | 20+ rules (rules.ts:5-28) | scribe_start/stop only | kill_switch ON seed (0128:34), shadow.global, `start_day_live` | all roster |
| I19 | lib/steward/input-failover.ts:36-50 | zero_ratio >= 0.98 for 90 s | webcam to TONOR | `set_audio_input` bench_command | `input_failover_live` default false (config.ts:172) | rooms with both devices |
| I20 | StewardTickets.swift:329-352 + tickets API | signed tickets | - | wake, open_pulse, relaunch_chrome, kickstart -k recorder | dead: no issuer | - |
| I21 | KioskHealthCore (Swift, in recorder) | power, audio devices, HID, chrome, drift, display | assertions | none ("NO ACTIONS", KioskHealthEngine.swift:7-9) | live observe | all |
| I22 | lib/alerts ops-sweep.ts (2 min), commit 07c0cb25 | open eta_encounter_windows + no chunk 5 min | `recorder_off IN CONSULT` | room_alert_outbox | live alert | all |
| I23 | tools/eta-micguard-poller poll.py:41-46 + lib/micguard-read.ts | kiosk mic-guard `.last` over ssh | stale > 300 s | POST mic_guard to /api/kiosk-health; display | loaded, not running | per kiosks.json |
| I24 | tools/eta-consult-room-audio-state ras/zeros.py:42, classify.py:36 | tape chunks offline | mute, gated (zr >= 0.95) | writes room_audio_state | shadow report | all |
| I25 | Rooms Live lib/rooms-live/present.ts:64,66 | room_install, levels, kiosk_health, steward_decisions, room_audio_state (snapshot.ts:154-184) | copy by state | display | live | 8 rooms (rooms.ts:7-16) |
| I26 | eta-presence-guard.sh (branch sweep/import-eta-presence-guard only, not main) | extension forcelist | missing ext | rewrite plist, killall cfprefsd, Chrome restart (sh:343-407) | live root, 60 s, any hour | deployed set UNVERIFIED |
| I27 | eta-steward.sh (same branch) | tickets | - | bash ticket executor | 60 s | UNVERIFIED |
| I28 | fable zero-watch v2, tailnet-heal (Mini, not in repo) | consult (scribe_now), level | silent 3 min in consult | killall coreaudiod / LAN-jump Tailscale up | LIVE | fleet |
| I29 | lib/fleet/verbs.ts `coreaudiod_reset`, HelperCommandRunner.swift:138 | operator verb | 1 per 30 min, refused over open session | launchctl kickstart -k coreaudiod | manual | any |

## 2. Map to Sentinel
| Item | Verdict | Change |
|---|---|---|
| I1 loop, I10 kill switch, I13 publish, I14 pipe, I15 subscriber, I17 router | REUSE | Base is r16e kiosk (c1-0.4.8) plus main mini. Tick 15 s is configurable. |
| I2 RMS | ADAPT | The same awk pass also emits `zero_ratio_2s` and `peak_2s` (abs max / 32768). |
| I3 USB pattern | ADAPT | Add conf `GUARDIAN_MIC_CLASS=webcam\|tonor` and per-class pattern. Mismatch is reported in the health line. |
| I4 status/HID/TCC/presence | REUSE | Maps to RECORDER_DOWN, MIC_PERM, PRESENCE_DEAD. |
| I5 heal_coreaudiod | ADAPT | New consult path (S4). The idle path stays for coreaudio_no_device. |
| I6 heal_recorder | REUSE for RECORDER_DOWN | Already refuses with capture open. Ladder step "restart capture in consult" stays escalate-only until V GO. |
| I7 heal_chrome | REUSE for PRESENCE_DEAD | Retire I26's Chrome rung first (R3). |
| I8 USB reboot | REUSE, stays shadow | DEVICE_MISSING has no re-enumerate today (G6). |
| I9, I12 canary | REUSE | Unchanged. |
| I11 consult hold | REUSE as the "do not disrupt" gate | Not the trigger (fact 2). |
| I16 consult publisher | ADAPT | Add an affirmative `consult_live` map (G1). |
| I18 Steward | KEEP cloud | 07:30 start and backstop only. Its kiosk-facing restart/message rules stay shadow. Not the alert sink. |
| I19 input failover | KEEP OFF | Set `input_failover_live=false` while Sentinel heals MIC_DEAD_WEBCAM (R3). |
| I20 tickets / StewardTickets.swift | DROP from this loop | No issuer. Its kickstart -k recorder conflicts with "never kickstart -k". |
| I21 KioskHealthCore | REUSE as observer | No actions to fight. |
| I22 recorder_off IN CONSULT | REUSE | Independent server-side backstop. |
| I23 micguard poller/read | DROP after Sentinel 48 h clean | micguard-read.ts is the template for the Rooms Live read (G4). |
| I24 room-audio-state | REUSE as the labelled bench for G2 thresholds | No runtime role. |
| I25 Rooms Live copy | ADAPT | Device-aware text (G3). |
| I26 presence-guard | ADAPT then DROP its Chrome rung | Keep the forcelist rewrite until Sentinel PRESENCE_DEAD is in heal. |
| I27 eta-steward.sh | DROP | Dead pipeline (I20). |
| I28 zero-watch | DROP after 48 h clean. tailnet-heal: KEEP on Mini (TAILNET_DOWN) | - |
| I29 fleet verb | KEEP manual | Operator tool. |

## 3. Gaps (new code)
- G1 **consult_live for every room.** Mini consult_hold.py adds `consult_live: {room: true|false}`. True only when the room's Pulse machine has a fresh Presence heartbeat AND its newest POST-driven event is `encounter_open` within OPEN_UNCLOSED_MAX_S. False on a fresh close. A stale or unknown room is ABSENT (never true). Kiosk parser: form 3 is `{"consult_live": {...}, "consult_open": {...}, "kill"...}` (sort_keys order); consult_live is parsed like CONTROL_CONSULT_RE, and malformed means unknown, never kill-change. `consult_room_map` must name every OPD room. Which rooms are mapped in prod is UNVERIFIED, and newcat-orch owns the machine map. Zero-watch uses `doctor.activity=="In consultation"` (scribe_now). Bench both sources against each other before choosing (S2).
- G2 **Near-zero webcam detector.** `mic_dead_webcam` in faulttree: class webcam, consult_live true, capture_open, zr_2s >= 0.6 AND peak_2s <= 0.001 for N consecutive ticks spanning >= 180 s (state file, reset on any good tick). Thresholds are from one OPD 7 event: bench on room_audio_state history before heal ON.
- G3 **Device-aware repair copy.** present.ts:64/66 picks text by device class from `room_install.expected_device_name` (already read, read.ts:45-50), using the input-failover.ts:38-39 regexes. TONOR: "Ask the doctor to unmute the TONOR mic (button on the mic)". Webcam: current copy. Unknown: neutral "check the microphone's USB cable". No new table.
- G4 **Health to Neon to Rooms Live.** The subscriber forwards the latest health line per room, at most once per 60 s or on code change, as event kind `sentinel` to `/api/kiosk-health` (same auth path as micguard poll.py). `lib/sentinel-read.ts` is cloned from micguard-read.ts and feeds a RoomRow `sentinel` field. Tile text comes from code + device (G3).
- G5 **Alert sink.** The router's ubus page stays. Codes MIC_MUTED_TONOR, MIC_DEAD_WEBCAM step 3, DEVICE_MISSING, MIC_PERM and RECORDER_DOWN step 2 also go to `queueOpsAlert` (room_alert_outbox), deduped per room+code 30 min.
- G6 **USB re-enumerate** for DEVICE_MISSING. No safe kiosk primitive exists. Ship alert-only, and research a primitive separately (out of Monday scope).
- G7 **Per-code heal allowlist.** Control modes stay `shadow|heal` (do not widen CONTROL_RE). The build carries constant `SENTINEL_HEAL_CODES="mic_dead_webcam recorder_down"`. Every other code is would_do even in heal mode.
- G8 **Delivery over pico.** Today install is ssh + install.sh. "Updates over pico" means kiosks run code received on a topic, a new trust boundary. Proposal: the topic carries only a version + sha256, and the kiosk pulls the tarball over the existing ssh path and verifies the hash before install.sh. Fable to rule.

## 4. Slices (smallest first; each is its own branch, build, refute; Builder = Sonnet)
Gate for every slice: the repo gate in CLAUDE.md (typecheck, vitest, build, check:silent with 9 accepted, swift build/test). Kiosk: `bash tools/room-guardian/kiosk/tests/run.sh` ON THE MINI (macOS). On Linux the suite has about 500-900 platform failures, so Linux runs are UNPROVEN, not green. Also `shellcheck -x` on the touched .sh, the no-perl/python/jq static test, and `scripts/steward/scrub.sh`. Mini: `tools/room-guardian/mini/tests/run.sh` (40 tests, 7 skipped at base).
- **S0 Base** (no behaviour change). Bring the r16e kiosk (pick `-w`, shellcheck clean, c1-0.4.8) onto main. The kiosk on main is c1-0.3.0-r14, the mini on main is newer than r16's, so keep main's mini. Pass: the kiosk suite on the Mini has 0 new failures vs r16e; mini 40 tests pass. Kill: n/a.
- **S1 Copy fix G3** (TS only). Tests: vitest `present.test.ts` covering TONOR, C270 and unknown for each of the unplugged/silent states. Kill: none needed (display).
- **S2 Sense.** zero_ratio_2s/peak_2s in collect.sh; `GUARDIAN_MIC_CLASS` in conf.sh and install.sh `--mic-class`; health line gains `zr`, `peak`, `mic_class`. New `tests/t_sentinel_sense.sh` with PCM fixtures: all-zero, near-zero (zr 0.8, peak 30/32768), speech. Assert the exact health JSON. Mini subscriber test: unknown health keys pass through. Kill: none (read-only).
- **S3 consult_live G1.** Kiosk parser first (form 3 accepted, consult_live parsed, kill/modes byte-identical). Then Mini publish behind `consult_live_publish` (default false). Tests: K `t_control.sh` new cases (form 3 valid, malformed consult_live leaves kill unchanged, room absent means unknown, old forms unchanged) plus a mutant. Mini: `tests/test_consult_probe.py` cases (stale hb absent, fresh open true, fresh close false, DB error means the whole map absent). Bench: 1 clinic day of consult_live vs zero-watch's scribe_now signal per room, agreement reported. Kill: the Mini flag.
- **S4 Fault codes, shadow.** faulttree maps to MIC_DEAD_WEBCAM, MIC_MUTED_TONOR (class tonor, consult_live, exact zero 180 s), DEVICE_MISSING, RECORDER_DOWN, PRESENCE_DEAD, MIC_PERM. Health line carries `code`. Every code yields would_do only. Tests: `t_sentinel_codes.sh`, a table-driven fixture per code, plus negatives: consult_live absent, false or stale gives no MIC_* code; TONOR exact zero never yields MIC_DEAD_WEBCAM; webcam silent 170 s gives no code. Kill: shadow by construction.
- **S5 Heal MIC_DEAD_WEBCAM.** New `heal_coreaudiod_consult`. Allowed with capture open ONLY if class webcam, code MIC_DEAD_WEBCAM, consult_live true this tick, kill clear, mode heal, the code in SENTINEL_HEAL_CODES, and no MIC_DEAD_WEBCAM heal in the last 1800 s (own stamp, outside the 3/h cap). Verify: pid changes and zr_2s < 0.6 within 60 s, then ok; otherwise one alert (step 3) and no retry inside cooldown. Ladder step 2 (capture restart) is escalate-only until V GO. Tests: `t_sentinel_heal.sh` with root helper fake: fires once, cooldown blocks a second, kill/shadow/consult-absent/tonor each block, a failed verify alerts. Mutants: drop the class check; drop the cooldown. Kill: fleet kill, per-room mode, flag file.
- **S6 Publish G4 + G5.** Subscriber forwards to /api/kiosk-health, plus `lib/sentinel-read.ts` and the RoomTile render. Route vitest for the event kind; Mini test for the forward rate limit; sentinel-read unit tests (stale 600 s). Kill: subscriber flag `sentinel_forward`.
- **S7 Fleet install.** Run install.sh per room with `--mic-class`: OPD 3 and Cardiology are tonor; OPD 1, 4, 5, 6, 7 and Dietary are webcam. Fleet room list is UNVERIFIED against rooms.ts. Start all rooms in shadow 24 h, then heal for MIC_DEAD_WEBCAM + RECORDER_DOWN on V's room list. G8 delivery as ruled. Retire zero-watch, the micguard poller and the presence-guard Chrome rung after 48 h clean.

## 5. Risks
- R1 **Recording in a consult.** coreaudiod kill drops audio for a few seconds. It is proven once (OPD 7, 11:16) to recover without a recorder restart, and that is the only evidence. S5 verify must catch a recorder that does not resume: escalate, never restart capture. RECORDER_DOWN heal must never run with capture open (heal.sh:104 already refuses). Guardian's bootout/bootstrap is used, never kickstart -k. Ticket relaunch (I20) stays dead.
- R2 **False consult trigger.** If MIC_DEAD_WEBCAM keyed on consult_open, any DB outage would fire coreaudiod fleet-wide every 30 min. G1's absent-means-unknown rule prevents it, and the S4 negatives pin it.
- R3 **Two healers.** zero-watch, Sentinel S5, Steward input failover (I19) and the fleet verb (I29) all touch the same mic. Rule: at most one live per room. On the room's S5 heal ON day, zero-watch is disabled for that room; `input_failover_live` stays false. Chrome: presence-guard (I26) and heal_chrome (I7) must not both restart, so drop I26's rung before PRESENCE_DEAD heal. Sentinel and zero-watch should also share a cooldown file name if they ever overlap (UNVERIFIED that zero-watch has one).
- R4 **Restart loop.** A dead webcam firmware state would loop coreaudiod. A 30 min per-code cooldown plus no retry inside it plus the fleet 3/h cap bound it to 2 kills per hour max. Alert after the first failed verify.
- R5 **Control contract break.** The kiosk kills itself on any unparsed control line (subscriber.py:166-170). The Mini must not publish form 3 before every kiosk accepts it, so release order is kiosk first (as the 2.4 d' release did). A kill is safe (shadow) but stops all heal.
- R6 **TONOR misclass.** A wrong `--mic-class` turns a muted TONOR into coreaudiod kills. Install asserts that the class matches the ioreg device name, and a mismatch disables heal for that room.
- R7 **Thresholds from n=1.** zr 0.6 / peak 0.001 / 3 min come from one OPD 7 event. Bench on labelled room_audio_state days (I24) before heal ON.
- R8 **Pico delivery.** Running code from a topic is a remote-exec path into clinical kiosks (G8). Hash-pinned pull only.
- R9 **Linux cannot prove the kiosk suite.** Every kiosk slice's green must come from the Mini run.
