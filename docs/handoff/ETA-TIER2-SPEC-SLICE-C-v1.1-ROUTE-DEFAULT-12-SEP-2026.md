# ETA Tier 2 Slice C v1.1 — Route becomes the default; diarize and emotion follow

Status: SPEC v1.1, 12 Sep 2026 18:00 IST. **Supersedes v1.0** (`ETA-TIER2-SPEC-SLICE-C-CLINICAL-AUDIO-UNDERSTANDING-12-SEP-2026.md`), whose §6 bake-off and D12 "evidence before default" are both withdrawn — see §1. Base: `vinay/release-b1` @ `df42143` in production (local HEAD `2afb75e`, two docs commits ahead). Research: `docs/handoff/ETA-TIER2-C-RESEARCH-12-SEP-2026.md` (8 items, VERIFIED unless marked).

## 0. What changed from v1.0, and why

v1.0 said route earns the default by beating Whisper on gold code-mixed windows. **That corpus does not exist and cannot be assembled by building anything.** Live counts, 12 Sep: `stt_gold` = **3 rows**, 1 labelled, **0 Indic** (the single label is `en-in`); `stt_gold_window` = 5 rows, all from one conditional Cardiology seed, none language-labelled; `room_turn_speaker` = **0 rows** — the 5-minute diarize cron has never written in production.

V ruled: **switch to route now on the prior.** An English-only model on code-mixed OPD consultation is wrong by construction; the change is reversible by one routing row. This spec therefore drops the bake-off gate and replaces it with §3 — making the prior cheaply falsifiable.

Two further v1.0 corrections from research: `resolveRouting` takes **two** arguments (`stage`, `bucket`) — `resolveRouting("room")` does not exist and will not compile; and per-segment engine data needs **no migration** (`metrics_json` jsonb takes it) but the `transcription_run` leaderboard groups by `tr.engine` and will not see it.

## 1. Goal

Make `route` the engine for room audio, with the reversal and the tripwires that a no-comparison switch requires. Then give the system, for the first time, speaker spans (diarize) and affect on the patient's speech (emotion).

## 2. C1 — route as the default

**Order matters. The fallback row is added before the default is changed.**

1. **Add the missing `(room,'default')` routing row** pointing at the current engine (`sarvam`). Today both room buckets resolve to `sarvam` and there is no default, so any `'auto'` or deletion fails every window with `no_engine` (`lib/stt/routing.ts:17-20`). This row is the safety net for everything that follows.
2. **Register a `route` adapter** satisfying `SttAdapter` (`lib/stt/types.ts:47-58`: `key`, `capabilities`, `transcribe()`, `health()`; `generateNote?` optional). Nine adapters exist, all unconditional.
3. **Transport, by duration.** ≤ 30 s → sync `POST /route` (multipart; also returns the `segmentation` block). > 30 s → `POST /route/job` (JSON body, `audio_url`, server-side fetch) wrapped in our own job kind: submit, then poll `GET /route/job/{id}` (~93 ms submit, ~100 ms per poll). **Because the router windows internally (`window_s` 180 outer, Silero VAD inner with a 30 s / 1 s-overlap fallback), our step is submit-and-poll and `MAX_STEP_MS` stops constraining audio length.** v1.0's window-sizing section is therefore moot for the long path; it survives only for the ≤ 30 s sync path.
4. `audio_url` is a **presigned R2 URL**, read-only, single object, TTL ≥ 2× expected job duration (floor 600 s). Ruling: this is not a new exposure class — the audio bytes already cross the same unauthenticated tunnel by multipart today, and a short-TTL single-object URL is strictly less than that. Revisit when Cloudflare Access lands.
5. **Persist `language_timeline` verbatim** into `metrics_json` under one key. Do not rebuild it — the router already emits per span `{start_s, end_s, lang, engine, chars}`, which is exactly what v1.0 proposed to construct. Keep the array small (one run = one window or one job); `metrics_json` is merged by several writers via `||`, so a large array makes every merge rewrite it.
6. **Flip room routing to `route`**, both buckets.

**The reversal, written down before the switch:** set the two room rows back to `sarvam`. One UPDATE per row, no deploy, no migration. This must appear verbatim in the build report.

## 3. Falsifying the prior without gold

Shipping on a prior is only defensible if the prior is cheap to disprove. Four signals, none needing ground truth:

| Signal | Source | What it would show |
|---|---|---|
| Per-span engine mix | `language_timeline[].engine` | If spans are overwhelmingly `whisper`, the switch is **inert** and we learned that in a day |
| Per-span language mix | `language_timeline[].lang` | The first real measurement of how much non-English is actually spoken in our rooms |
| Empty-transcript rate | existing `silent_window` outcome | A regression against the Whisper baseline already in history |
| Characters per audio-second | run text ÷ window ms | A crude yield measure; a sharp drop is a red flag without needing to know the right answer |

**Shadow sampling.** On a sampled fraction of windows, run Whisper as a second `transcription_run` over the same audio. That costs one extra engine pass on a minority of windows and produces exactly the side-by-side V would otherwise have had to construct by hand. Each pair he adjudicates becomes a gold row — so the corpus grows from work already happening rather than from a labelling project.

Fanout (`scribe_run_stt_fanout`) is still the instrument that does this; it is no longer a gate on shipping.

**Leaderboard consequence, settled:** one `transcription_run` per (window × engine) means `tr.engine` is correct per run and the existing `GROUP BY tr.engine` aggregate works unchanged. Router-internal per-span attribution is a diagnostic read by a separate small query. No leaderboard change is required. Note honestly that with 3 gold rows the leaderboard's WER/CER columns are near-empty regardless.

## 4. C2 — diarize (first live path)

`POST /diarize` requires **`audio` AND `encounter_id`** (both, `server.py:129-135`); `clinician_centroids` is a JSON string of `{clinician_id, full_name, centroid_base64}`. Response: `encounter_id, speakers, transcript_segments, overlap_windows, aggregates, latency_ms, model_versions`; one span = `{start_ms, end_ms, speaker_idx, overlap}` — **timings only, no text**. ~1.5× realtime measured. `/enroll` needs only `audio`.

Speaker attribution is therefore an **alignment**, not a transcription: join diarize spans against transcript timings. Use Whisper's `verbose_json` **word-level** timings (`{word, start, end, t_dtw, probability}`) where available — word timings make the join accurate where segment timings would smear across speaker changes. Caveat from research: a word's start can precede its parent segment's start.

Write to `room_turn_speaker` (composite PK `(window_id, source_ref)`, SQL-only, no drizzle model). This table has one writer (`lib/stt/diarize-job.ts:377`, behind two env gates off by default) and **zero readers**; C3 becomes its first reader.

## 5. C3 — emotion on the patient span

`POST /inference`, WavLM default (7 labels) or `?model=emotion2vec` (9). Response `ok, model_key, model, device, labels, top[], duration_s, inference_s`.

- **Windows align to diarize spans, not router VAD spans** — the point is affect on the patient's speech, so the speaker boundary is the right boundary. This settles the fork research declined to decide.
- **Read the duration cap from `/health` at runtime.** Live is 60 s; the code default is 120 s (`EMOTION_MAX_DURATION_S`), so a spec citing the source would be wrong by 2×. Rejection is a hard 400 at a strict `>` (59 s → 200, 61 s → 400), cheap (~0.4 s, before any model runs). The truncation branch in the service is dead code — do not design against truncation.
- **Keep the model warm.** Cold start measured 39.6 s vs 1.0 s warm for the same 11 s clip — a 40× cliff. Either a periodic warm ping or an explicitly longer first-call budget.

## 6. Rules the adapters must follow

- **Branch on `ok`, never on HTTP status.** `/enroll` returns **HTTP 200 on failure** with `ok:false`; `/diarize` returns real 4xx. This is the health-probe disease one service over.
- **Do not regenerate types or migrations from the drizzle model.** `db/schema.ts` is stale for `transcription_run` by **11 columns** that live code reads and writes (`subject_type`, `subject_id`, the whole 0072 receipt block, `receipt_complete`). Anything generated from it silently drops them.
- **Do not start enforcing `capabilities` in `resolveRouting`.** It never checks them today, and `sarvam` serves the room stage without declaring `stages:["room"]` — switching the check on would break the current default the moment it lands. Add `route` with correct capabilities, leave the check off, log the inconsistency as debt.
- `even_pipeline` is enabled in `stt_engine` with **no code adapter** — routable in the table, silently null in code. Disable it or guard it.
- `/route/job` **drops the `segmentation` block** the sync path returns, so the async path cannot report whether VAD or the fixed-window fallback produced the spans. Accepted for now; a one-line router change request (copy it into the job dict) is logged separately.

## 7. Carried

The `WhisperResult` discriminated union (`ok:false` still means both "call failed" and "room was quiet"). `recordFailure` nulling `lease_owner` on a still-running row (fail-safe, ≤240 s). 13 routes covered only by source-text greps. 162 pre-existing type errors across 27 quarantined test files. The 60 s health-probe cache merged without an independent Refuter pass — first target for this slice's Refuter.
