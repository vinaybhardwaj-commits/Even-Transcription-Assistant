# Ruling 337d: is real speech being discarded? PRE-REGISTRATION (split-speaker, 25 Sep 2026, ~08:20 IST; before ANY service is called on these windows)
Design by eta-refuter #1897, accepted. Frozen: `discarded_logic.py` (design, thresholds and decision rule in its docstring; sha256 in `plan_frozen.json`), `discarded_run.py`, `plan_frozen.json` (windows, spans, chunks, forced languages; ids and times only).
Tests on invented numbers: `test_discarded_logic.py` (16 OK, incl. the Clopper-Pearson 17.2 % / 11.6 % bounds refuter-2 quoted).

## Why this test
All 213 refused segments of the 30 drawn windows are the router's fixed-window fallback (Silero heard nothing) and were labelled `en`; these rooms speak Kannada/Hindi. If whisper-English over faint Indic speech is what the guard drops, the TEXT was garbage but the SPEECH was real. webrtcvad/energy cannot tell that from noise; a forced-language ASR plus a diarizer can.

## Windows and audio (from `plan_frozen.json`)
| group | windows | chunks (<= 60 s) | measured audio |
|---|---:|---:|---:|
| the 30 refused windows (frozen draw 9894479), span = union of refused segments | 30 | 127 | 5,907.9 s |
| 10 guard-ACCEPTED controls (frozen), span = union of accepted segments | 10 | 177 | 5,081.8 s |
| 14 noisy no-text controls (N1 8 + N2 6, frozen 87ed79b), first 300 s of each | 14 | 70 | 4,200.0 s |
Forced languages per window: the room's most frequent Indic label in its OTHER segments (readability `features.jsonl`); the second most frequent too when the first holds < 60 % (30 windows); the corpus pair kn+hi when the room has < 50 Indic segments (10 windows). Language sources: room-top2 30, room-top1 14, corpus-top2 10 windows.

## Arms and measures (frozen in the docstring)
A1 IndicConformer (box twin :8082, ctc), A2 whisper large-v3-turbo forced language (box twin :8080, temperature 0, max_context 0), both scored with the 337c readability score as an Indic engine; D the diarizer (box twin :8001): diarized speech seconds = union of transcript_segments.
Best output per chunk = highest readability score (ties: more words). SUBSTANTIVE chunk: >= 5 words AND score >= 0.60 AND diarized speech >= 5.0 s. Window REAL iff substantive seconds >= 20 % of measured seconds.

## Decision (frozen)
Controls separate iff accepted windows are REAL in >= 7 of 10 AND noisy no-text windows REAL in <= 1 of 14; if not, the 30-window counts are not to be read. If they separate, K = REAL windows of 30: K >= 6 -> real speech is being discarded materially: propose a guard-side change (retry a fixed-window English refusal with the room's Indic language before discarding) with these numbers; 2..5 -> some, bounded with Clopper-Pearson, no proposal beyond a larger draw; <= 1 -> no material discarding detected. Any guard change is Fable's.
Also reported: each arm alone (A1, A2), text-only (no diarizer), diarizer-only.

## Limits stated in advance
The diarizer and the forced ASR are themselves fallible on faint audio (the controls test that); IndicConformer can emit text on non-speech (hence the diarizer requirement and the noisy controls); the readability score sees structure, not meaning; 30 windows bound a rate, they do not measure it; recovered text stays on the box for V/Sandhya (never in git or on the bus); box twins only, the Mini and the ssh-tunnel ports 18001/18086 are never used; one request at a time at nice 15.
