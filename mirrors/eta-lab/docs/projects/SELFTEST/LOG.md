# LOG — SELFTEST (repeatable system diagnostics)

Build and event log, newest first. Owner panes: diar-lab (lead/spec), lab-mover (plumbing), fleet (device checks), radar-kit (mic self-test).

## 27-28 Sep -- confirm4 built; nightly green; clinical2 deferred on TTS budget
Session: diar-lab, lid-debug, eta-refuter-2.
confirm4 (280 stimuli) built+merged; S3 judge v4 on confirm4: 268/280=95.7% overall but mixed-language cells only 72.5% (below the 90% bar) -- S3 stays indicative. A real scorer bug (fused numerals like '500mg' not recognised as a dose hit) found+fixed. Nightly runs green (13/13, canary 1/1). A bigger clinical2 suite (lid-debug spec, 108 stimuli) hit a TTS character-budget wall (needs ~9,810 chars against 4,530 headroom); 2 real allocation bugs found+fixed; Fable deferred it (zero further TTS spend) -- parked.
Refs: #4380-4463, #4505-4648.

## 27 Sep ~08:0x-10:3x IST — room self-test scorer PASS; clinical S1 + confirm suites for CLARITY
Session: diar-lab, eta-refuter-2.
Room scorer went through 3 FAIL/fix rounds (RT60 reliability, sweep-path gain, a 0.5s manifest-offset bug masking a 46->21 dB SNR drop) to PASS at adc6681df3c1, now reading the app's real 16 kHz raw tape.pcm. W33.1 clinical suite clinical1 (192 stimuli) merged main 5d87140b PASS bbcb0bba. Two S3-judge confirmation suites (confirm2, confirm3+confirm3diag) built for CLARITY's language judge, both PASS after id/spec correction rounds.
Refs: #4192, #4211, #4269, #4275, #4279.

## 26 Sep ~21:2x IST — diag-rig on main; first ElevenLabs voices
Session: diar-lab, eta-refuter-2.
Merged: main 8ae0e169 (byte-identical to PASSed b542d96c, #3918); ElevenLabs change 0b250a83 PASS, main 5ba0ca1e. voices1: 8 stimuli, 1,068 of 60,000 characters, all audio hashes match (#3921). Google credential probe blocked by the pane classifier (#3898).
Refs: #3898, #3918, #3920, #3921.

## 26 Sep ~19:4x-19:5x IST — diag-rig PASS b542d96c
Session: diar-lab, eta-refuter-2.
Build 1 ee394e7e FAIL (4 blocking: outage invisible, silence self-reference, Mini gate, babble) #3861; fixes 416719f9 / e9e0f0bb / b542d96c (Mini IPv4 + IPv6 + mapped spellings refused); PASS #3877, 23 tests. Digital path only; nothing run on the Mini. W27.5: merge to main, Google TTS voice set, first digital report 28 Sep, first nightly 30 Sep.
Refs: #3858, #3861, #3877.

## 26 Sep ~17:2x IST — Home Office pre-check rides Sunday D4 (459.5 addition)
Session: scribe (runbook §4).
Home Office (room_2qe955hy, hostname "Vinay's Mac mini" = the production Mini; TONOR TM20; app 0.1.24) gets a pre-check 07:35 Sunday BEFORE any stimulus: state_flags=[] + last_seen fresh; both switches listed (transcript_enabled/visits_enabled, expected false/false); then SELFTEST 07:35-08:55 speech-only (Sunday, clinic closed, zero patient audio); both switches confirmed OFF by 09:00 (a flip is an admin write, never unruled). Baseline already recorded 26 Sep ~17:22 read-only.
Refs: #3762.

## 26 Sep ~14:10 IST — D6 resolved-as-watched; Home Office = production Mini
Session: minibot (read-only, local).
The Home Office "room" lives on the production Mini (hostname match); TONOR TM20 present and clean now; DISK_AMBER = 79% used. The 25 Sep DEVICE_MISSING there is an intermittent USB fault. Watch protocol: re-check device + flags each wake, post only on regression.
Refs: #3585, #3591; FABLE 439(2).

## 26 Sep 10:17 IST — spec drafted
Session: diar-lab + lab-mover.
Comprehensive diag-rig spec on main (058dcd4; studies/2026-09-26-diag-rig/SPEC-DRAFT.md, draft 7e55ef3). Reuses 10 harnesses; defines generated tones, silence, multi-voice call-and-response, fixed phrases, background noise beds. Home Office Mac = the acoustic rig (sound OK any hour, r428a). Digital path on non-Google machines.
Refs: r428, r428a; #3448.

## 26 Sep 09:57 IST — authorised
Session: Fable + V.
Rig authorised after V reserved the Home Office Mac for testing.
Refs: r428.

## 25 Sep 09:36 IST — mic self-test proven
Session: radar-kit.
Call-and-response feasibility shown in OPD 4: chime over internal speaker → 0.08-0.32 peak on the C270 mic. Tool in kit/mic-selftest/; live runs gated on Fable ruling; canary word "supercalifragilisticexpialidocious"; 1/room/hr; purge rule (r369 item 4).
Refs: r368, r369.

## Open
Fable's spec ruling (phrase-set owner, Indic TTS fallbacks, cron schedule); ElevenLabs key 401 (V re-saves). Stimulus generator + digital injector next.
