# ETA — speech gate fixes. REFUTER RE-CHECK. 21 Sep 2026

Re-check of the six findings in `ETA-SPEECH-GATE-REFUTER-VERDICT-21-SEP-2026.md`, both halves at HEAD:

| repo | branch | was | now |
|---|---|---|---|
| Even-Transcription-Assistant | `vinay/speech-gate` | `f245547` | **`a404b16`** |
| ~/eta-router | `vinay/vad-endpoint` | `6126ebc` | **`108ff19`** |

Own detached worktrees `/tmp/refute-gate2`, `/tmp/refute-gate2-mut`, `/tmp/refute-vad2`; builder's worktrees never written to, nothing pushed, production `:8083` never restarted (pid 1706, still up from 20 Sep 07:16:27, `main` at `86661c6`). Per the order I re-checked **only** these findings.

## ALL SIX FIXED — PASS

| finding | status | how I checked |
|---|---|---|
| **F1** gate not wired | **FIXED** | `lib/jobs/kinds/diarize-window.ts:65` now calls `fetchWindowSpeech(bytes, "audio/webm")` when the flag is on and threads it into `diarizeWindow`. Mutations R3 (never ask) and R4 (ask even when off) both die. |
| **F2** M5/M6 survived | **FIXED** | R1 (absent VAD ⇒ `{ok:true,spans:[]}`, i.e. convict on no answer) dies. The old M5 no longer exists as code — the OFF branch was deleted, not patched. |
| **F3** stale comment | **FIXED** | `lib/stt/speech-gate.ts:174-178` now says the endpoint exists and what it returns. |
| **flag-OFF byte-identity** | **FIXED** | `ungatedSegments` deleted outright; `diarize-window.ts:185` assigns `rawSegments` unchanged when off. R2 (re-annotate on OFF) dies. |
| **/vad size cap** | **FIXED** | verified live, three ways (below). |
| **/vad queue behaviour** | **FIXED** | verified live: work whose client left is dropped, not run (below). |

**Mutations: 5 of 6 killed** (+ M8/M12 re-run and still green, accepted as unkillable per the order). One new survivor, R5, below.

### The router caps, live

Isolated instance on **8092** (`ETA_JOBS_DIR` redirected, all four engine URLs at a dead port), caps set small so every refusal could be exercised cheaply (`ETA_VAD_MAX_BYTES=2000000`, `ETA_VAD_MAX_AUDIO_S=10`):

```
27 MB wav, content-length declared  -> 413 {"error":"audio_too_large","limit_bytes":2000000,"declared_bytes":28799470}
27 MB wav, chunked (no content-len) -> 413 {"error":"audio_too_large","limit_bytes":2000000,"bytes":28799470}
20 s audio (over the 10 s cap)      -> 413 {"error":"audio_too_long","limit_s":10.0,"audio_s":20.0}
5 s audio (inside both caps)        -> 200 span_count 0
```

Both byte paths work — the declared-size refusal returns before the body is read, and the chunked case is caught after. The duration cap fires after `normalize_to_wav`, where the real cost is known. The earlier fail-closed battery still holds unchanged (`empty_body`, `bad_threshold`, `decode_failed`, 405 on GET).

**Happy-path regression, defaults, same window as last time:** `265 spans / 782,281 ms` at 0.5 and `223 spans / 807,481 ms` at 0.3 — the same answers as `6126ebc` (782,300 / 807,500; the ~20 ms is per-span rounding in the client's sum, not the server's).

### The queue fix, live

`/vad` now has its own `_VAD_SEM` instead of sharing `_ROUTE_SEM`, plus an `is_disconnected()` check before it starts. Tested: call A held the single slot with a 900 s window; call B queued behind it and its client was killed mid-queue. The server logged **`[eta-router] /vad: client gone before start; dropping`** exactly once, and A returned its 265 spans normally. The Mini no longer pays in full for an answer the app has already abandoned at its 120 s abort.

## Two small things, neither blocking

**S1 — a new stale comment, same class as F3.** `router_server.py:979-980` still reads *"Behind the same gate as a route call, so a backlog VAD pass cannot race a transcription for the Mini"* — directly above `async with _VAD_SEM`, which is precisely the gate it no longer shares. The change is correct and its rationale is explained properly at `:127-133`; the file now contradicts itself at the point of use. One comment.

Worth V knowing behind it: the fix deliberately **removes** the serialisation between `/vad` and `/route`, so a backlog VAD pass and a transcription can now run at the same time on a Mini that sits at `WARN_tightening`. A 900 s window costs ~4 s of VAD, so the added load is small — but it is a real change of posture, not just a refactor, and the old comment is the only place that still describes the old one.

**S2 — R5 survived: the *reason* is not pinned.** Changing the hand-off at `lib/jobs/kinds/diarize-window.ts:78` from `...(speech ? { speech } : {})` to `...(speech && speech.ok ? { speech } : {})` leaves the suite green. Measured consequence:

```
as shipped : {"verdict":"unjudged","reason":"vad_empty_window"}
as mutated : {"verdict":"unjudged","reason":"vad_unavailable"}
```

Both judge nothing, so behaviour is unchanged — but the stored row would misreport *why* it was not judged, and "we asked and it answered nothing" versus "we never got an answer" is the distinction the module's own header is built on. One assertion in the wiring test pins it.

Trivial: `unjudged_reason` still lists `"gate_off"` (`speech-gate.ts:65`), now unreachable since `ungatedSegments` was deleted — the only remaining mention in the tree.

## Gate, my run

`typecheck` exit 0. `npm test`: **`Test Files 147 passed (147)`, `Tests 3287 passed | 1 skipped (3288)`**, 103 s — fully green, including `e31b-atomicity R58` this time (it is ~1-in-5 flaky; see my 21 Sep SUPERSEDES line). `build` `✓ Compiled successfully in 8.4s`.

**Verdict: PASS.** Every finding is fixed and each fix is demonstrated rather than asserted — the wiring is pinned in both directions, OFF is byte-identical again, and the two router findings were checked against a live instance. S1 is a comment; S2 is one assertion.
