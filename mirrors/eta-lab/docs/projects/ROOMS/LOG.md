# LOG — ROOMS (every clinic hour recorded)

Build and event log, newest first. Owner panes: fleet (fleet-watch), scribe, radar-kit.

## 26 Sep ~16:2x IST — FABLE 453.0 rules OPD 4 RESTART; executor silent
Session: Fable (ruling), scribe (relay + read-only verify), conductor (relay), fleet (fleet-watch).
OPD 4 (room_ux92qpws, app 0.1.24) down since 10:59 IST: DEVICE_MISSING + ENCODER_STALLED, input_devices empty (C270 not enumerated), tape_advancing FALSE; V pressed start_day 6x → all already_recording. FABLE 453.0 ruled RESTART (~15:45): restart_engine NOW, then start_day only if the device re-enumerates. But no executor acted ~20 min — the box scribe_mcp_token is refused scribe_room_command (scope S3); the Mini write scope is minibot's alone, and minibot stayed silent. Escalated URGENT to Fable.
Refs: #3721, #3722, #3723, #3726, #3727.

## 26 Sep ~17:00 IST — OPD 4 down ~5.5 h; 8 rooms recording
Session: fleet (fleet-watch, 5-min polling).
OPD 4 DEVICE_MISSING (11:01) + NOT_RECORDING (11:31) still open; looks physical. 8 rooms recording. Restart = Fable's ruling. Dietary Mac silent since 24 Sep (hostname unknown).
Refs: #3676.

## 26 Sep ~14:10 IST — Home Office resolved: it is the production Mini
Session: minibot (read-only, local) + scribe (DB read).
Home Office room = "Vinay's Mac mini" = the production Mini itself (TONOR TM20, app 0.1.24). DISK_AMBER = 79% disk used. The 25 Sep DEVICE_MISSING there is an intermittent USB fault, not a room issue; D6 closed-as-watched (minibot re-checks on wake).
Refs: #3584, #3591.

## 26 Sep 09:19 IST — no auto-start exists
Session: fleet/scribe (investigation).
Saturday recording delayed; V started rooms manually. Found: there has never been an auto-start mechanism — staff press Start each morning. Auto-start design = item 151 (V's decision).
Refs: #3366, #3373.

## 25 Sep — exact-zero root cause + C270 correction
Session: scribe + fleet + eta-refuter.
Bit-exact zero tape (137 h) root-caused to TONOR TM20 hardware mute (r255/280). V corrected OPD 4 uses a C270 webcam (no mute) — r336; acoustic test proved the C270 works in an empty room (r355/368).
Refs: r255, r267, r280, r336, r355, r368.

## 25 Sep 13:47 IST — fleet-watch live
Session: fleet.
24x7 room monitor deployed (r399), 5-min polling, $2/day cap; NOT_RECORDING/NOT_DELIVERING/DEVICE_MISSING alerts. Hardened local proxy (a47da00) keeps audio links off the LLM.
Refs: #2483, r399, r401, r404.
