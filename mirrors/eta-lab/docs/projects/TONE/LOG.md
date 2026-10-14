# LOG — TONE (emotion / tonality)

Build and event log, newest first. Owner panes: indic-mt (study), lab-mover (replica infra).

28 Sep ~13:5x-14:0x -- T-REB emotion layer built + PASSed; 0 real REB windows to run on
Session: tone, eta-refuter.
wavlm crosslingual, per-turn with a whole-window fallback (min 1.5s speech). eta-refuter FAILed the first review on a real bug: the no-diarization fallback used an absolute tape-clock timestamp where the schema wants a window-relative one -- fixed, re-reviewed clean (30e43ede). Full pipeline (11 new + suite tests) green. Ran against the live REB root: 0 real windows for 26/27 Sep -- only synthetic DEV data present. No real HF run attempted. Same secret-rotation flag (r2_audio_read) raised in tone's housekeeping note, routed to V correctly by every agent that saw it.
Refs: #5352, #5355, #5410, #5417.

## 27-28 Sep -- W45 weak first results; role-field design gap found
Session: tone, eta-refuter-2.
Coverage queued on box GPU. Synthetic validation (ElevenLabs, 6 emotions x languages, SELFTEST-rig room-acoustic versions) scored wavlm: 0/12 on anxious/angry/sad in every language/condition; a Gemini arm improves angry (0->6/12) but breaks neutral (->0/12) -- rankings flip between engines, an engine artifact not a language fact. Text-sentiment pilot moved to 24 Sep (26 Sep had zero transcribed/diarized windows) and found room_turn_speaker.role is never 'patient', only 'clinician' or null -- design gap being corrected.
Refs: #4506, #4511, #4524, #4581.

## 25 Sep 07:50 IST — dedupe deployed
Session: indic-mt + scribe.
Emotion dedupe fix 87a7215 shipped in train a92ebae.
Refs: r347, r216.

## 24 Sep 16:50 IST — backlog requeued
Session: indic-mt.
8 failed historical emotion windows requeued; 7 scored, 1 duplicate-key.
Refs: #521, r140.

## 23 Sep 18:45 IST — service live
Session: indic-mt.
Aniemore wavlm / emotion2vec service live on Mini port 8086.
Refs: orders/EMOTION-WS-I.md.

## Status
Study CLOSED, steady state. PAUSED as a programme; service runs in background when enabled.

- 29 Sep 2026 (rev 25): PARKED. Control run: noise 5/5 and speech 3/4 read as sadness; EMOTION-PARKED.md 3a05849a.
- 29 Sep ~19:27 IST (rev 26): disclosure #6926 recorded; #7071 says control pool had no OPD4 windows.
