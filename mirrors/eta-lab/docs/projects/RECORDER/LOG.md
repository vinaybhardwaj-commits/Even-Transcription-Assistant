# LOG — RECORDER (next Room Recorder fleet release)

Build and event log, newest first. Owner: scribe (build/deploy) + minibot (Mini monitor). This project was named new on 26 Sep.

## 27 Sep ~09:5x-10:3x IST — 0.1.25 PASS 1da7232; self-test hook + server command built
Session: scribe, eta-refuter, diar-lab.
Swift gate PASS at 1da7232 on the Air (637 tests, 2 pre-existing flakes also on 0.1.24, not a regression, #4276) after 3 FAIL/fix rounds. New self_test bench command (plays a fixed stimulus, records into a separate segment, uploads with a manifest) built into the app; a separate server-side self-test-server (d82ef4c) is NOT yet pushable (eta-refuter FAIL: no self_test variant in the MCP tool group, #4281/#4284). Fable's GO: signed test build to Home Office only, auto-start left on.
Refs: #4252, #4262, #4276, #4280, #4281.

## 26 Sep ~19:3x-20:0x IST — 0.1.25 plan
Session: scribe.
Plan a5009c4 pushed (#3857), corrected d179c38 then d7949f5: DEVICE_MISSING does fire (retraction #3862), 7-day hours, room-schedule code 93a1f17 built and unchecked (#3879).
Refs: #3857, #3862, #3879.

## 26 Sep ~12:15 IST — queue named: 0.1.25 with 5 defects
Session: scribe (OpenCode) + minibot.
Current versions: macOS stable **0.1.24** (build c4a0289, published 17 Sep; branch `vinay/rr-0.1.24`) on all 10 macOS rooms; Linux **0.1.22.2** (build 7b0a67e3) on ORB3. **Recorder releases ride their own branch `vinay/rr-*` + the app_release shelf — never the app branch** (which carries recorder 0.1.22). Next release queue = **0.1.25**, holding scribe's defects #1-#4 (tape_advancing follows tape.pcm not tape.idx; poll reports device_lost; same-uid set_audio_input is a no-op; DEVICE_MISSING flag semantics UNVERIFIED) **plus defect #5 device-loss recovery** (minibot #3581, fleet #3572).
Refs: #3558, #3581, #3572.

## 26 Sep — Mini STT side of the fleet release
Session: minibot.
Mini STT stack (manifest MINI-STT-MANIFEST.v2.json, sha c85d1e6e): whisper-shim 50fcc4e, eta-router 5e841f0, eta-indic e9b71b3 (VAD off), eta-diarize 54248d60. Queued Mini-side: diarize-guard stale in_flight fix (r245, install HOLD r352), migrations 0119/0120/0121 (r357). Deploy-train holds (5907cbc, SCRIBE_MCP_TOKENS_EXTRA, WHISPER_BULK_URLS, ORB3) are SHIP, NOT part of the 0.1.25 queue.
Refs: #3553, #3564.

## 26 Sep ~14:10 IST — Home Office recorder = the production Mini
Session: minibot (read-only, local).
Home Office room (room_2qe955hy) hostname "Vinay's Mac mini" = the production Mini itself (macOS 27.0, Mac16,11); app 0.1.24, TONOR TM20 configured. Read is LOCAL (no ssh/tailnet). DISK_AMBER = data volume 79% used (93 Gi free of 460 Gi). Device present and clean now — the 25 Sep DEVICE_MISSING points to an intermittent USB enumeration fault.
Refs: #3584, #3591.

## 26 Sep — project named
Session: roadmap (this pane).
Programme 15 created. Queued items gathered from records: self-test hooks (r368/369), auto-start at clinic open if V approves (item 151), mute/silence/unplug detection, device-missing handling.
Refs: brief; HANDOVER-scribe.md.

## 25 Sep — recorder backlog facts (from scribe)
Session: scribe.
ORB3 Linux recorder 0.1.22.2 stopped delivering 25 Sep 15:49, recovered 26 Sep 09:52 on its own. Swift app backlog: tape_advancing must follow tape.pcm growth not tape.idx; poll must report device_lost; same-uid set_audio_input is a NO-OP; DEVICE_MISSING may not fire for a lost device.
Refs: HANDOVER-scribe.md §(b)6, §(b)8.

## 23 Sep — ehrc-audiometry room recorder added to the pool
Session: (Mini night-lab ruling).
ehrc-audiometry (M4, 16 GB) runs the EvenScribe Room Recorder app in a live room — never touch its recorder app/tape/audio/login items.
Refs: orders/RULING-MINI-NIGHT-LAB.md.

## Release process (to confirm)
R3 self-update proven 10 Sep (**UNVERIFIED exact date**). Gates + rollout plan still to be written once scope + owner are confirmed.
