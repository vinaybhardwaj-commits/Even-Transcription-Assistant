# Emotion lane — coverage audit (23 Sep, e2e box, read-only)

**Question:** what does the emotion lane do today (Workstream I, order EMOTION-WS-I.md, step 1).
**Owner:** Builder (e2e box) **Date:** 2026-09-23 **Status:** done — one residual gap (flag values).

## What's verified from code (`lib/emotion/{gate,client,segments,store}.ts`, migration `0089`)

- Two flags, both throw on an unrecognised value: `EMOTION_ENABLED` gates compute+storage;
  `EMOTION_SURFACE_ENABLED` gates clinician visibility, and nothing calls `canSurfaceEmotion()`
  today regardless of its value.
- Model: `Aniemore/wavlm-emotion-v1-crosslingual` only — emotion2vec is never selected (Mini has
  RAM for one model). 7 labels: anger, disgust, enthusiasm, fear, happiness, neutral, sadness.
- Runs only for a window whose `room_diarize_window` row is `ok`; reads speakers from
  `room_turn_speaker`; writes per-speaker-run segments to `room_span_emotion` plus one
  `room_emotion_window` summary row.
- **Silence/low-signal**: a diarized speaker-run under the service's live `min_speech_s` (from
  `/health`, never hardcoded) is never sent, recorded `unscorable_unsent`. A span the service
  refuses after sending is `unscorable` (distinct from a model fault). Window states:
  `ok | failed | no_segments`; segment states: `scored | skipped | failed`.
- Cap read live from `/health.max_duration_s` every job, refused outside [10, 60]s, no fallback
  constant. Retry bound: `EMOTION_MAX_ATTEMPTS` in the enqueue scan, not the DB.

## Verified live (2026-09-23, via direct GET, no secret needed)

`GET https://emotion.llmvinayminihome.uk/health` → `ok:true, model loaded:true, device:mps,
max_duration_s:60, min_speech_s:1.5, wavlm subfolder:int8, rss_mb:68.3, available_ram_mb:2952.5`.
5x round-trip on `/health` alone (not a scoring call): **0.89-1.96s** — tunnel+TLS floor, not
inference latency (real inference p50/p95 below, from stored job data, no live call needed).

## Live numbers (Neon, `kit/neon-select.mjs`, last 7 days — unblocked 18:39 by Fable)

`room_emotion_window` by state: **ok 311, no_segments 377, failed 38, diarize_stale 5** (731 total;
`no_segments`/`diarize_stale` aren't failures — no attributed speech, or diarize re-ran after the
job planned segments). 1,285 `bench_window` rows closed in 7 days; 521 have a
`room_diarize_window.state='ok'` row. 521 vs 731 don't reconcile 1:1 (different timestamp anchors:
window creation vs job `scored_at`) — don't read it as a coverage percentage.

`room_span_emotion` by state (7d): **wavlm scored 5,264, failed 41, unscorable 1,507; skipped
14,283, unscorable(unsent) 2,338** (skipped/unsent carry no model — never sent). `emotion2vec`: zero
rows, confirms the code comment (never selected). Per-turn vs per-window: neither — `buildRuns()`
merges consecutive same-speaker turns into a run, `planSegments()` chunks each to `cap_s`; the
14,283 `skipped` are turns that straddled a chunk boundary (code's own accounting, not a bug).

**p50/p95 model-inference latency** (real, from `room_span_emotion.inference_s`, n=5,290 scored
segments, 7 days): **p50 0.58s, p95 3.51s** per segment. This is inference time only (Mini, `mps`),
not the full job wall-clock (fetch+decode+network) — `timing_json` on `room_emotion_window` has
that breakdown if a follow-up wants it; not pulled here to keep this file inside 60 lines.

**Flag values**: still can't read them directly (this box's Vercel token 403s on
`filter_project_envs` for `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z` — permission scope, not a bug). Not
blocking in practice: the data proves `EMOTION_ENABLED` is on (rows scored today), and the code
proves `EMOTION_SURFACE_ENABLED`'s value is currently inert (nothing calls `canSurfaceEmotion()`).

## Backlog plan — L7, real throughput now measured

**Real backlog: 1,183 diarize-ok windows have no `room_emotion_window` row at all** (never
attempted). ~16.6 segments/window scored on average → ~19,640 segments to clear.

**Box replica throughput, measured 23 Sep** (10 real clips, 6-25s each, cuda, same model/subfolder
as production): 7/10 scored (3 near-silent, matching production's own unscorable rate), **0.682s
wall-clock per segment average, 20x realtime**. Consistent with the Mini's own stored p50 (0.58s,
`mps`) — same order of magnitude, GPU-to-GPU, as expected.

**ETA to clear: ~19,640 × 0.682s ≈ 13,400s ≈ 3.7 hours of GPU-exclusive inference**, single
worker, sequential. Real number now, not a placeholder — box replica is running
(`BOX-REPLICA.md`). Contention caveat: this box's T4 is shared (diar-lab's grid searches, this
lab's own VAD work); wall-clock will stretch under `flock /home/eta/gpu.lock` queueing with other
lanes. A quiet window (e.g. overnight per `RULING-MINI-NIGHT-LAB.md`'s hours) would hit closer to
the 3.7h floor.

**Write path (unchanged from the original proposal, now backed by a working replica): the box
must call the *same* job code (`lib/jobs/kinds/emotion-window.ts`) against the same Neon tables**
— a second worker draining the existing queue, not a parallel pipeline or a shadow schema. This
still needs someone to actually point a worker loop at `lib/jobs/kinds/emotion-window.ts`'s logic
using the box's `/inference/wavlm/segments` endpoint instead of the Mini's — not written here
(this order's step 3 says propose, not run); the replica proves the compute side is ready.

