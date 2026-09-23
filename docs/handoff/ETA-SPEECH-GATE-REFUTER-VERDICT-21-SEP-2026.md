# ETA — speech gate. REFUTER VERDICT (both halves). 21 Sep 2026

One verdict covering both branches, per `RULINGS-21-SEP-afternoon.md`:

| repo | branch | commit | base |
|---|---|---|---|
| Even-Transcription-Assistant | `vinay/speech-gate` | `f245547` | `45eedda` |
| ~/eta-router | `vinay/vad-endpoint` | `6126ebc` | `86661c6` |

Refuted from my own detached worktrees (`/tmp/refute-gate`, `/tmp/refute-mut`, `/tmp/refute-vad`); the builder's `gate-wt` and `router-wt` were never written to, nothing was pushed, production `:8083` was not restarted. Evidence: `docs/handoff/scratch/ETA-SPEECH-GATE-REFUTER-EVIDENCE-21-SEP-2026.md`, with harness and raw VAD data archived beside it.

## PASS-WITH-FIXES

The measurement holds and is stronger than the report claims. The router half passes outright. All three fixes are on the app half.

**F1 — the gate has no VAD to speak to (claim 1 overstated).** `fetchWindowSpeech` (`lib/stt/speech-gate.ts:188`) is imported by exactly one file: `tests/unit/speech-gate.test.ts:182`. `diarizeWindow`'s `speech` parameter (`lib/stt/diarize-window.ts:148`) is supplied by no caller — `lib/jobs/kinds/diarize-window.ts:58-64` is the only one, and it already holds the audio at `:52`. **Failure scenario:** set `DIARIZE_SPEECH_GATE=1` and `lib/stt/diarize-window.ts:180` substitutes `{ok:false, reason:"vad_unavailable"}`, so every segment of every window is stamped `unjudged`. The gate is inert at both flag settings — a pure function, not a running gate. The route it would call now exists and works (see below), so this is one argument, not a design gap.

**F2 — the wiring is executed under test but unasserted.** My M5 (off-path stores `rawSegments`, so OFF stops meaning unjudged) and M6 (absent VAD defaults to `{ok:true, spans:[]}`) both survive the suite. Control: a `throw` at `lib/stt/diarize-window.ts:178` turns **17 tests red across 3 files**, so the site is covered — nothing asserts what the gate returns there. **Failure scenario for M6:** flag on, no VAD supplied, every segment stamped `non_speech` — the conviction-on-absent-VAD the file header forbids — and the suite stays green.

**F3 — stale in shipped source.** `lib/stt/speech-gate.ts:178-182` still reads "THE ENDPOINT DOES NOT EXIST YET. The router serves `/healthz`, `/route`, …". The addendum corrects it; the file a future reader opens does not.

**Flag OFF is not byte-identical to 45eedda** (the check ordered). Behaviour is identical — same segment count, same `room_turn_speaker` rows, same outcome, and every consumer reads through `parseDiarizeSegments`, which ignores the new keys. Storage is not: `ungatedSegments` (`lib/stt/speech-gate.ts:158-167`) adds five keys to every segment in `room_diarize_window.segments_json`, **44 → 174 bytes**, ≈8 MB/day at 19 Sep's 320 closings, ≈60 MB to re-diarize the 2,514 never-handled windows.

**Mutations: 13 of 17 killed.** Survivors: M5 and M6 above, plus M8 (`if (!roomId) return global`) and M12 (`Array.isArray(parsed)`) — two further unobservable guards of the same class as the `if (!base)` one the builder disclosed. Three unkillable guards in this diff, not one.

**Gate, my run.** typecheck exit 0. `npm test`: `Tests 1 failed | 3240 passed | 1 skipped (3280)` in 433 s — `tests/unit/e31b-atomicity.test.ts > R58` (`expected 'ok' to be 'rate_limited'`) failed under concurrent load and passes 26/26 alone: a load-sensitive 1/sec-limiter flake, not a branch defect. `✓ Compiled successfully in 10.4s`. `check:silent` 9, all pre-existing, none in the three changed source files. No Swift in the diff.

**Claim 5 CONFIRMED and strengthened.** Recomputed independently from the raw `vad_results.jsonl`: full population **−35.0pp** at the 1 s floor (builder's held-out half −34.4pp), −39.9 and −41.9 on the ratio rules, −33.8 at Silero 0.3. The held-out split is genuine and exhaustive — TUNE 39.1% and HELD-OUT 38.6% average to my all-population 38.9% — and immaterial, because the 1,000 ms floor came from split-speaker's 83/70 knee in the ledger, not from this data. Not a VAD-failure artefact: over the 54 windows where Silero returned more than 5 spans, closed 33.3% vs clinic 66.4%, **−33.1pp**. Root cause the report does not name: Silero hears **24,048 s of speech in 36,000 s of empty night-time room (66.8%)** against **4,738 s in 35,993 s of clinic (13.2%)**. The VAD is inverted on this audio — which is why every threshold tested is negative, and why no threshold on this signal can work.

**Claim 6 CONFIRMED** — documented behaviour, not a workaround. `lib/bench-join.ts:113-125` and `lib/mcp/tools/bench.ts:977-987` are cited correctly, but the line that makes the claim true is `lib/mcp/tools/bench.ts:1053-1056` (with `presignCovering` at `:910-924`), uncited. Traced for `res.kind === "multi"` only.

## The router half — `vinay/vad-endpoint` @ 6126ebc: PASS

Tested live on an isolated instance on **port 8092**, with `ETA_JOBS_DIR` redirected (it defaults to production's `~/eta-router/jobs`, `router_server.py:80`) and all four engine URLs pointed at a **closed port on purpose**, so any transcription would fail loudly.

- **Speech spans only, no transcription.** Proved twice: the handler's AST (lines 906-961) contains only audio-normalisation, Silero and stdlib calls — `transcribe_norm_wav` (`:568`), `_route_blocking` (`:867`) and `vad_segments` (`:258`) appear nowhere in it; and live, with every engine URL dead, the 900 s window still returned 200.
- **Fails closed, 8 of 8.** `empty_body`, five `bad_threshold` variants (`abc`, `0`, `1`, `-0.5`, `1.5`), `decode_failed` on garbage, 405 on GET. Instance RSS stayed at 49-51 MB throughout, so **every rejection returns before `import torch`**. All eight map to `vad_unavailable` in the client (`lib/stt/speech-gate.ts:205` keys on HTTP status), which judges nothing.
- **Exact agreement with direct Silero, at two thresholds.** Same window: 0.5 → **265 spans / 782.3 s**; 0.3 → **223 spans / 807.5 s** — both identical to the builder's direct `get_speech_timestamps` rows. `?threshold=` is honoured and echoed.
- **End to end through MY worktree's client and gate** (not the builder's `gate-wt`): 346 segments → **213 speech / 133 non_speech / 0 unjudged**, the builder's claim reproduced exactly, 900 s judged in 5.7 s wall.
- **An empty answer really does stay empty.** 5 s of digital silence → HTTP 200 with `span_count: 0`, not `vad_segments()`' fixed-window fallback; the client maps it to `vad_empty_window`, which judges nothing. This is the route's headline claim and it holds live.
- **NEW — the 48 kHz trap is defended, and now measured.** The builder asserted `normalize_to_wav` makes it safe but never measured it. Same window at 48 kHz: **267 spans / 783.0 s** against 16 kHz's 265 / 782.3 s — **0.09% apart**. Ledger's 48 kHz trap does not reach `/vad`.
- **Production untouched.** pid **1706**, started **Sun Sep 20 07:16:27**, unrestarted and predating this session; `~/eta-router` on `main` at `86661c6` with only the five pre-existing untracked files; `healthz` 200 after my instance stopped. The `~/eta-router/jobs` writes at 14:30-14:54 are production's own `/route` work — `/vad` never references `JOBS_DIR`, and my instance's own job dir stayed empty. No leaked temp dirs; 8091 and 8092 free again.

**Two flags on the router half** (neither a defect against the three questions asked): `/vad` shares `_ROUTE_SEM` with `/route`, so a call queued behind a long transcription can outlast the client's 120 s abort — the client safely returns `vad_unavailable` while the server finishes work nobody reads; and there is **no server-side size or duration cap** — `raw = await req.body()` reads the whole body into memory before any check. Both worth settling before this is pointed at a backlog.

**NOT RUN:** whether the clinic-hours cost falls on real doctor speech — one read-only `room_turn_speaker` query, refused by this sandbox's production-read gate. Three weaker measures agree on direction.

**Filing.** The raw data behind the central number lived only in the builder's session scratchpad; I copied `vad_results*.jsonl` into `docs/handoff/scratch/` with my harness.

**Agreed with the builder: do not enable the flag.** `/vad` makes the gate runnable; the measurement still says it should not be run. No commit — this order names none. Holding both branches.
