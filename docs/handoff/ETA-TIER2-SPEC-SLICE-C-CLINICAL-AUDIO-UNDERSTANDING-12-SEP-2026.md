# ETA Tier 2 Slice C — Clinical Audio Understanding (router, diarize, emotion, fanout)

Status: SPEC v1.0, 12 Sep 2026 17:45 IST. Base: `vinay/release-b1` @ `df42143` (Slice B + both hotfixes, in production, migrations through 0082). Supersedes the "Slice C = audio download/stitch" ordering in `ETA-TIER2-SPEC-v1.0-MCP-REDESIGN-12-SEP-2026.md §5`; day-download and standalone stitch move to Slice C2. Source of tunnel facts: `LLM-HOME-APIS-MANUAL` (11 Sep 2026) plus live probes run from the Mini on 12 Sep, recorded in §2.

## 0. Goal

ETA transcribes Bengaluru OPD consultations — Kannada, Hindi and English, frequently in one sentence — through `whisper large-v3-turbo`, an English-only model, because that is the only engine the code has ever called. A router that races Whisper against IndicConformer 600M and SraVaani per VAD segment, with a hallucination guard, has been running on the same Mac mini the whole time. This slice makes the tunnel's clinical audio stack reachable from the MCP as jobs, and settles by measurement whether `route` should replace Whisper as the default engine for room audio.

Three capabilities, one unit: **what was said** (router), **who said it** (diarize), **how it was said** (emotion on the patient span).

## 1. Scope

In: `lib/stt/registry.ts` and new engine adapters, `lib/jobs/kinds/*` (new kinds), `lib/jobs/constants` (window sizing), `lib/mcp/tools/*` (four tool surfaces), `lib/health/*` (capability probes per service), `room_turn_speaker` write path, `transcription_run` persistence, one migration if §7 requires it, tests.

Out: day-manifest download and standalone stitch (Slice C2); tool regroup to ≤25 and aliases (Slice E); `ask_llm` / `embed` (Slice D); the `WhisperResult` discriminated union (§8, listed but deferred); SurgVLP (§9, excluded on licence); Cloudflare Access tokens on the tunnel (governance, V's call, not a code change); note-gen consuming speaker-tagged transcript (Tier 3, this slice only produces the tags).

## 2. Measured facts (12 Sep 2026, from the Mini)

All nine tunnel hostnames verified live. `stt` correctly returns 426 Upgrade Required to a GET, being a WebSocket relay.

| Call | Input | Wall time | Ratio to audio |
|---|---|---|---|
| `whisper /inference` | 11 s speech (jfk.wav) | 2.3 s | 0.21× |
| `route /route` (3 engines) | 11 s speech | 6.8 s | 0.62× |
| `route /route` (3 engines) | 30 s clinic chunk | **105.2 s** | **3.51×** |
| `emotion /inference` (WavLM, MPS) | 11 s speech | **41.2 s** | **3.75×** |

`route` response, observed: `ok, segments[], transcript_native, transcript_english, dominant_language, language_timeline, segmentation, candidates, engine_versions, sec`. Each segment: `start_s, end_s, lang, engine, text`. `engine_versions` reports `whisper: large-v3-turbo, indicconformer: 600M, sravaani: SraVaani-1.0`.

`emotion` response, observed: `ok, model_key, model, device, labels, top[], duration_s, inference_s`. Hard cap 60 s; `max_duration_s: 60.0` in `/health`.

`whisper /inference` returns `{text}` only by default. `verbose_json` adds duration (and is what production already sends).

**The load constraint this creates.** whisper-server, the shim, the router and the room recorder for Home Office all run on the same Mac mini (12 cores). Whisper.cpp serialises requests. Every call in this slice therefore competes with a live clinical recording, and `route` at 3.5× realtime on a 30 s window is the expensive one. Window sizes in §4 are derived from these ratios, not chosen.

## 3. Decisions (mine; D12–D20 continue the D1–D11 series)

| # | Decision |
|---|---|
| D12 | `route` becomes a registry engine, **not** the default. The default flips only after the §6 bake-off on `stt_gold` shows it beats Whisper. Evidence before default. |
| D13 | Every tunnel call is a job step over a bounded window. No tunnel call is made synchronously from a tool. |
| D14 | Window size per engine is computed from the measured ratio in §2 against 60 % of `MAX_STEP_MS`, and stored as a constant with its measurement date in the header. `route` → 30 s, `emotion` → 30 s, `whisper` → 120 s. A step never begins a window it cannot finish inside its budget. |
| D15 | Emotion runs on the patient span only, which means diarize must have run. `whole_clip: true` is an explicit override, never the default. |
| D16 | Diarize is its own job kind; its output persists to `room_turn_speaker`, the table that already exists and that nothing currently writes for this path. |
| D17 | Per-segment `engine` and `lang` are persisted alongside the text. A transcript whose provenance is unknown cannot be compared, and the whole bake-off depends on it. |
| D18 | `scribe_run_stt_fanout` is the bake-off instrument, not a separate harness — N engines over the same window set, writing `transcription_run` rows the existing leaderboard already reads. |
| D19 | SurgVLP / PeskaVLP is excluded from ETA. CC BY-NC-SA 4.0 is non-commercial; Even is a commercial hospital. It belongs to OT Black Box as research. |
| D20 | No auth work in this slice. The nine tunnel endpoints have no API key and carry patient audio; a Cloudflare Access service token is the right fix and is V's call, separately. |

## 4. Window sizing

`MAX_STEP_MS` is 200 s and `LEASE_MS` 240 s with a 30 s margin floor (Slice B, `lib/jobs/types.ts`). A step targets **60 % of the step budget** — 120 s — leaving headroom for fetch, join and persistence either side of the model call.

```
window_seconds(engine) = floor(120 / measured_ratio(engine))
  route    3.51×  →  34 s  → use 30 s
  emotion  3.75×  →  32 s  → use 30 s   (also under the service's own 60 s cap)
  whisper  0.21×  → 571 s  → use 120 s  (capped by prudence, not by the ratio)
```

These constants carry a documentary header naming the measurement date and the clip used, in the house style of `lib/bench-bus-constants.ts`. A test asserts `window_seconds(e) * ratio(e) * 1000 < MAX_STEP_MS` for every engine, so the pair cannot drift back into the Slice B shape where three 200 s steps were claimed against a 240 s lease.

## 5. Tools and job kinds

Four tool surfaces, +4 on the current 50. Slice E regroups.

| Tool | Scope | Job kind(s) | Returns |
|---|---|---|---|
| `scribe_transcribe_range` (extended) | invoke | `transcribe_window` per window | `{job_id, status_pointer}` — gains `engine: whisper\|route\|indic\|sravaani`, default `whisper` until D12 flips |
| `scribe_run_stt_fanout` | invoke | one `transcribe_window` per (window × engine) | `{job_id, status_pointer, run_ids[]}` |
| `scribe_diarize_clip` | invoke | `diarize_clip` | `{job_id, status_pointer}` → speaker spans on `room_turn_speaker` |
| `scribe_emotion_clip` | invoke | `emotion_clip` | `{job_id, status_pointer}` → label scores per span |
| `scribe_tunnel_health` | read | — | per-service capability verdict, §7 |

Every new tool follows the Slice B contracts exactly: pointers not payloads to a read token, `error_code` to read scope with free-text `error` gated on invoke, per-kind scope enforced inside `submitJob`, and `runner` required on every mutating write.

## 6. The bake-off — how `route` earns the default

1. Select the `stt_gold` windows that contain Indic or code-mixed speech. If that set is empty or unlabelled, the first task is labelling it, and the Researcher reports that before anything is built.
2. `scribe_run_stt_fanout` over those windows with `engines=[whisper, route, indic, sravaani]`, writing `transcription_run` rows with per-segment `engine` and `lang`.
3. Compare on the leaderboard the runs already feed. Report WER or the closest available measure against the gold text, plus the router's own `engine` mix per segment.
4. **The decision is mine, taken on that table.** `route` becomes the default for room audio only if it wins on code-mixed windows without regressing English-only ones. If it wins on Indic and loses on English, the answer is routing by room or by `dominant_language`, not a blanket flip.

Cost note for step 2: at 3.51× realtime, fanout over N windows × 4 engines is serialised on one Mac mini that is also recording. Run it outside clinic hours, and cap concurrency at one runner.

## 7. Capability probes, not liveness

The `/api/health` whisper probe now POSTs a 0.5 s webm fixture and asserts a 200 with a parseable object, caching the verdict for 60 s and reporting `checked_at` / `age_s` / `cached` (shipped `df42143`). `scribe_tunnel_health` extends the same discipline to every service in scope: each probe POSTs a fixture that exercises the real path and asserts a parseable, service-specific response. A `/healthz` that a shim can answer without touching its backend proves nothing and is not a probe.

Per service: `route` (fixture → at least one segment with an `engine` field), `indic` (fixture + `language=kn`), `sravaani` (fixture), `emotion` (fixture → a `top[]` with a label), `diarize` (fixture → a span list). Each carries its own budget and cache window; none may hang the composite.

## 8. Carried, not fixed here

- `WhisperResult`'s `ok: false` still means both "the call failed" and "the call succeeded and the room was quiet". The hotfix branches on the constant; the structural fix is a discriminated union that makes `if (!w.ok)` fail to compile. It touches every consumer and belongs in its own slice.
- `recordFailure` below the cap sets `lease_owner = NULL` on a row it leaves `running`, so the row accepts no writer until the lease expires. Fail-safe, bounded by ≤ 240 s, deferred from Slice B.
- Thirteen API routes are covered only by source-text greps (list in the Slice B build report). Debt, tracked, not this slice.
- 162 pre-existing type errors across 27 quarantined unit test files, now visible because `tsc` finally typechecks the test tree. The quarantine list may only shrink.

## 9. Excluded

SurgVLP / PeskaVLP (`surgvlp.llmvinayminihome.uk`, port 8087) is CC BY-NC-SA 4.0 — research and non-commercial only. It is not wired into ETA. If OT Black Box wants zero-shot surgical phase classification, that is a separate system with a separate licence posture.

## 10. Research required before building

The Builder does not start until these are settled and written down. Marked UNVERIFIED until a Researcher reports each with evidence.

1. `diarize /diarize` request shape — a probe with `clinician_centroids=[]` as a form field returned a non-JSON body in 1.0 s. Settle it against the service's own source on the Mini, not the manual. Same for `/enroll`.
2. Whether `whisper /inference` with `response_format=verbose_json` returns per-segment timings, and in what shape.
3. `lib/stt/registry.ts` — the adapter interface an engine must satisfy, and what `resolveRouting("room")` currently decides.
4. `transcription_run` columns — whether per-segment engine/lang can be persisted without a migration, and how the leaderboard reads it.
5. `stt_gold` — how windows are keyed, and whether any are labelled as Indic or code-mixed.
6. `room_turn_speaker` — its schema and what, if anything, writes it today.
7. `route /route/job` — the async response shape and its polling endpoint, and whether it is worth using instead of our own windowing for long audio.
8. `emotion` behaviour on input over 60 s — 400, truncation, or silent success. This decides whether our 30 s window is a guard or a convenience.

## 11. Builder brief (written after §10 returns)

Standard form: goal, exact scope, allowed changes, what to verify, what not to do, output format, output cap, known facts. Default loop Fable → Builder → Refuter unchanged. The Refuter's first target in this slice is the 60 s health-probe cache from the hotfix, which merged without an independent adversarial pass.
