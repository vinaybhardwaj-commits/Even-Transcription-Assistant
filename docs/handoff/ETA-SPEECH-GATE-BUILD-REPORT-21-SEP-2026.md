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

---

# Addendum 2 — Refuter's findings fixed. READY FOR REFUTER.

| repo | branch | commit |
|---|---|---|
| Even-Transcription-Assistant | `vinay/speech-gate` | **`2599664`** (base `45eedda`) |
| `~/eta-router` | `vinay/vad-endpoint` | **`108ff19`** (base `86661c6`) |

**F1 (blocker) — wired.** `lib/jobs/kinds/diarize-window.ts:65` fetches the VAD where the audio
already is, and only when the flag is on. Proved by `tests/unit/diarize-window-job-gate.test.ts`:
flag ON asks once with the window's own audio and records `["speech","non_speech"]`; flag OFF never
asks; flag ON with the VAD down asks, is refused, and stamps `unjudged`.

**F2 — M5 and M6 killed, on output.** M6 stays a defect and is pinned: ON with no VAD is
`unjudged`, never `non_speech`. M5 **inverts** — OFF storing `rawSegments` is now the required
behaviour, so the assertion is that OFF carries no gate key at all.

**F3 — stale comment rewritten** (`lib/stt/speech-gate.ts`).

**OFF is byte-identical.** `ungatedSegments` deleted, not fixed: 44 → 174 bytes per segment was the
cost of saying "unjudged" five times. Asserted by comparing `JSON.stringify` length and key sets
against the raw segments.

**Router.** `/vad` has its own `_VAD_SEM` (`ETA_VAD_MAX_INFLIGHT`, default 1), no longer queues
behind `/route`, and drops work whose client disconnected (499). `ETA_VAD_MAX_BYTES` (256 MB)
refuses a declared oversize **413 without reading the body**; `ETA_VAD_MAX_AUDIO_S` (3600) refuses
after decode, because Silero's cost tracks duration, not bytes.

Verified on **8092/8093**: empty body 400, bad threshold 400, declared oversize 413, 900 s against a
5 s cap 413 `audio_too_long`, garbage 400 `decode_failed`, happy path still exactly 265 spans /
782,281 ms. **:8083 was never restarted** and `~/eta-router` stayed on `main` throughout.

**Gate.** typecheck clean; `Tests 3287 passed | 1 skipped (3288)`, 147 files; `✓ Compiled
successfully`; `check:silent` at the accepted 9, none mine; `swift build` complete; `swift test`
UNPROVEN (no Xcode). **36 gate tests; 6 mutations, all red.**

**A correction to Addendum 1.** That mutation round ran against a baseline that was already red: I
deleted `ungatedSegments` without re-running the file importing it, so one "kill" I reported was a
pre-existing failure. This round is against a verified-green 36. The Refuter's F2 was right about
more than it knew.

**Not fixed, and not asked to be:** M8 (`if (!roomId) return global`) and M12
(`Array.isArray(parsed)`) remain unobservable guards, the same class as the `if (!base)` one —
three in this diff, as the verdict says.

**Unchanged:** the measurement still refutes enabling the gate (−34.4pp at the 1 s floor, −33.5pp at
Silero 0.3). The flag stays OFF. **Superseded:** nothing.
