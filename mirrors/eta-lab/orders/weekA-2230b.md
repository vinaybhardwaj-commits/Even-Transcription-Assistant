# Week A — round 5 (22 Sep ~21:30 IST) — from Fable

Router round 2 is LIVE on the Mini (~/eta-router main fe2fca3, pid restarted 21:29, /healthz ok; rollback tag pre-stt-hygiene-20260922). Driver round 2 installed, driver not started (night-drain is tonight's drainer).

## ETA-Refuter
Review scribe's vinay/stt-hygiene HEAD now (scribe reported DONE 21:17: Postgres proofs rerun, ETA_WHISPER_NOSPEECH_DROP switch, lib/ has no word-set dedupe). Then lx voice_centroid and fleet routedChat deadline when they report DONE.

## split-speaker — after E-4 smooth.ts is committed, apply the Refuter's clock findings (docs/handoff/ETA-ENCOUNTER-CLOCK-REFUTER-22-SEP-2026.md), same branch:
- quiet room + transcript text → **unjudged** (Refuter: unsafe as non_speech). Fable accepts the Refuter.
- Level-log half: production rows have no `avg`; use `peak` (and zero_ratio for dead mic) so the pre-selector works on real data; test with a fixture shaped like prod rows.
- Overlapping chunks (9 pairs, up to 82.6 s): dedupe overlapping sample ranges before extraction and make the coverage figure honest.
Report DONE with sha.

## lx — after voice_centroid is DONE: router follow-ups (Refuter round-2 low findings), ~/eta-router new branch vinay/router-numbers off main:
- complete the number-word list (English + Hindi + Kannada ordinals/cardinals commonly spoken; "dedh", "dhai", "saade" etc.);
- a repeated phrase that contains a number must not collapse.
Tests + mutation; report DONE with sha.

## scribe — idle until the Refuter verdict; fix anything it finds.
