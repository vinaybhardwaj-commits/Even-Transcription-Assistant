# Ruling 333 measurement: pre-registration (split-speaker, 25 Sep 2026, ~07:15 IST, BEFORE any window is measured)

Question (Fable ruling 333): of the windows whose every segment the router's `english_hallucination_guard` refused (text not stored), how many hold speech? It bounds how much
refusal hit real speech. It does NOT say the refused text was correct, and it changes no guard. The full frozen spec is the docstring of `refused_logic.py`
(logic sha256 `466f56b380236f746c66e49813605d039f3c6e194a69d5604f868e973efdb770`); this file records the numbers.

## Population (frozen)
- Raw run records on this box (`hist/runs`, `hist/out`, `lab-vault/staged/runs`) with >= 1 segment and EVERY segment `refused == true`: **603 distinct windows**
  (14 windows have more than one such file; the lexicographically last is used). Windows in the exact-zero NO_SIGNAL lists or with vault-index status `no_signal`:
  **0** of them were all-refused (none), so nothing was excluded on that ground; in population: **603**.
- Relation to the figures already quoted: ruling 333 says 618 of 4,668 records; a count of raw records gives 617 all-refused records (603 windows) of 4,711 with segments; the vault view index
  (`view-202609250657`) has 620 records with status `refused` of 4,927 (17 are not raw all-refused records on this box, so they cannot be measured here). The population is the raw-record one.
- Language stratum: every segment of every all-refused record carries `en` (the refused text is not stored, so no other label exists). So "room x language" is room only; reported, not hidden.

## Draw (frozen; written once, never redrawn): `draw_frozen.json`, seed 20260925
| room | all-refused windows | drawn |
|---|---:|---:|
| room_2qe955hy | 41 | 2 |
| room_4ggnkg5x | 47 | 2 |
| room_7egw2my6 | 35 | 2 |
| room_87frpus9 | 119 | 6 |
| room_bh6jtq4t | 27 | 1 |
| room_d74hhmc4 | 1 | 0 |
| room_jwyrr4dc | 16 | 1 |
| room_pnyc9u49 | 38 | 2 |
| room_qyzghzaf | 108 | 5 |
| room_ux92qpws | 54 | 3 |
| room_xf5vcjpt | 2 | 0 |
| room_yh3etjpf | 76 | 4 |
| room_ymch4bxu | 39 | 2 |
Total drawn: 30. Proportional (largest remainder), every room with >= 15 windows at least 1, rooms under 15 (room_d74hhmc4, room_xf5vcjpt) 0.

## Controls (same measurement)
- 10 guard-ACCEPTED windows (vault status `text`, n_words >= 100; pool 2052), measured over their accepted segments' spans.
- 5 exact-zero NO_SIGNAL windows (pool 530), measured over the whole 900 s.
- They must separate on the primary detector: accepted median speech fraction >= 0.50 AND silent maximum <= 0.02. If not, the 30-window counts are NOT to be read.

## Measurement (frozen)
- Measured span per window = union of its refused segments (overlap counted once), clipped to 0..900 s from the window start and to covered audio. The controls also test that time mapping.
- Detectors (16 kHz mono): **D1b webrtcvad mode 3, 30 ms = PRIMARY**; D1a webrtcvad mode 2; D2 silero-vad 6.2.3 (threshold 0.5; the router's OWN detector, so near-circular: comparison only);
  D3 energy (30 ms RMS dBFS >= window p20 floor + 12 dB; a plain level test, hum reads as speech: baseline only).
- Decision per window (primary): SPEECH PRESENT if D1b speech seconds in the span >= 5.0 AND fraction >= 0.10. Continuous numbers are reported for all detectors so other thresholds can be read.
- Audio: the chunk files already cached on the box by hist-bulk (`~/eta-data/hist-mining/audio`, name = R2 key with `/` -> `__`), all 603 windows verified present; no service, no Mini, no vendor call, no presigned read
  (refuter #1812 asked for presigned single-chunk reads; the same chunks are local, so none is needed; I did not re-fetch them to compare bytes, so cache integrity is assumed from hist-bulk's fetch). CPU only, nice 15.
- Output: window id, room id, language code, seconds, fractions, flags. Never text, never labels.

## What it cannot show
Speech presence is not correctness of the refused text; the primary detector can misfire on noise; the D2 arm is near-circular; the language stratum is degenerate; the population is what this box holds.
