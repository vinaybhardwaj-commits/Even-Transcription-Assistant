# LOG — SELFTEST (repeatable system diagnostics)

Build and event log, newest first. Owner panes: diar-lab (lead/spec), lab-mover (plumbing), fleet (device checks), radar-kit (mic self-test).

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
