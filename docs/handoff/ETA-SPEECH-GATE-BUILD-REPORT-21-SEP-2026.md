# ETA — speech gate. Builder report. 21 Sep 2026

`a34320d` on `vinay/speech-gate`, base `45eedda`. Not pushed.

**Where.** `lib/stt/diarize-window.ts:165-178`, between `parseDiarizeSegments` and the segments
returned for storage. Logic in `lib/stt/speech-gate.ts`. Flag **`DIARIZE_SPEECH_GATE`**, default
OFF; off means *unjudged*, not passed. It flags — `speech_ms`, `speech_ratio`, verdict — and never
drops. `roomEnergyFloor` now uses its room via `ROOM_ENERGY_FLOORS`, a JSON map that is **empty
until measured**; per-room values would come from each room's own closed-hours energy
distribution. None invented.

**Gate.** typecheck clean; `Tests 3274 passed | 1 skipped (3275)`, 145 files; `✓ Compiled
successfully`; `check:silent` at the accepted 9, none mine; `swift build` complete. **`swift test`
UNPROVEN** — no Xcode, `TestingMacros` missing (already in the bus, 20 Sep). **23 tests, 9
mutations, all red.**

**Measured — and it refutes the approach.** 80 real windows, 20 h audio, held-out half of the
closed-hours set.

| rule | closed HELD-OUT | clinic cost | separation |
|---|---|---|---|
| speech ≥1000 ms | 38.6% | 73.0% | **−34.4pp** |
| ratio ≥0.2 | 9.1% | 48.7% | **−39.6pp** |

Silero at 0.3 does not rescue it (−33.5 to −38.2pp). **The gate rejects real clinic audio roughly
twice as often as segments false by construction.** Cause: closed-hours segments are *longer*
(median 1,941 ms vs 945 ms), so a 1 s floor rejects half the clinic band on duration alone; among
segments able to pass, closed 8.4% vs clinic 44.4%.

**Agreement with 83/70: no.** That figure came from multi-segment assembled clips; per segment the
direction reverses.

**Do not enable it.** The flag default is now the finding, not a precaution.

**Flags.** (1) No VAD endpoint exists — the router serves only `/route*`; `ETA_VAD_URL` is written
against a `/vad` that must be added and the router restarted. Not authorised here. (2) Empty VAD
answers judge nothing: 12 of 80 windows returned zero spans. (3) Closed hours means hour ≤7 —
reading it as `<7` loses 858 segments.

**Manual steps.** None. **Subagents.** None.
