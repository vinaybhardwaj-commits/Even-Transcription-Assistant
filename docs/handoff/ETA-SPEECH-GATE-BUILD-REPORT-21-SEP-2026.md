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

---

# Addendum — /vad built, D15 recorded. READY FOR REFUTER.

**READY FOR REFUTER.** Two branches, both unpushed:

| repo | branch | commit |
|---|---|---|
| Even-Transcription-Assistant | `vinay/speech-gate` | **`69ae896`** (base `45eedda`) |
| ~/eta-router | `vinay/vad-endpoint` | **`6126ebc`** (base `86661c6`) |

**/vad** — `router_server.py:905`. Posted audio → `normalize_to_wav` (16 kHz mono) → the Silero
already loaded here → `{ok, spans[], span_count, speech_ms, audio_ms, threshold, latency_ms}`.
`?threshold=` overrides, default `ETA_VAD_THRESHOLD`. Behind `_ROUTE_SEM`, so a backlog pass waits
for a transcription rather than racing it.

It deliberately does **not** call `vad_segments()`: that helper merges spans into `SEG_SEC` chunks
and, on emptiness, returns fixed windows (`fixed-window-vad-empty`). Right for `/route`, fatal
here — a gate that cannot tell "found nothing" from "found these" would condemn a window on a VAD
failure. `/vad` returns `[]` honestly; the client maps that to `vad_empty_window`, which judges
nothing.

**Verified.** Against the direct silero run on two real 15-minute windows: 265 spans / 782.3 s and
0 spans / 0.0 s — both exact. End-to-end through the real client and gate: 346 segments → 213
speech / 133 non-speech / 0 unjudged. Tested on a second instance on **port 8091**; production
**8083 was not restarted** and its tree is unmodified on `main`.

Restart the test instance with:
`cd <router worktree> && ETA_ROUTER_PORT=8091 ~/eta-router/.venv/bin/uvicorn router_server:app --host 127.0.0.1 --port 8091`

**D15, the behaviour relied on** (per ruling §2):
- `lib/bench-join.ts:113-125` — D15 is a CLIENT-side guard, not a refusal the joining service
  issues. `callJoinService` would join mid-clinic.
- `lib/mcp/tools/bench.ts:977-987` — `roomsRecordingNow()` refuses with `error: "room_recording"`
  **and still returns `covering_chunks`**, each carrying `presigned_get`, `offset_in_chunk_s` and
  `duration_s`, with the hint "the covering pieces below are available now".
- 20 h of window audio was assembled from those pieces with ffmpeg locally. No join was requested;
  no clip was created; nothing was written back.

**Gate (final).** typecheck clean; `Tests 3279 passed | 1 skipped (3280)`, 145 files; `✓ Compiled
successfully`; `check:silent` at the accepted 9, none mine; `swift build` complete; `swift test`
UNPROVEN (no Xcode, `TestingMacros`). **28 tests; 13 mutations, 12 red.**

**The one mutation that will not go red, stated rather than hidden:** removing the `if (!base)`
guard in `fetchWindowSpeech` changes nothing observable — with no URL, `base.replace(…)` throws
before `fetch` is reached and the catch returns the same `vad_unavailable`. The test asserts fetch
is never called, which is true either way. The guard is defence in depth, not proven behaviour.

**Unchanged by all of this:** the measurement still refutes enabling the gate (separation −34.4pp
at the 1 s floor, −33.5pp at Silero 0.3). `/vad` makes the gate *runnable*, not *right*. The flag
stays OFF.

**Superseded:** nothing. I have not superseded another pane's line.
