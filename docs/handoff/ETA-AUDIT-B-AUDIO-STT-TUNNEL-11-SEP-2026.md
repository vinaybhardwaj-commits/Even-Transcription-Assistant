# B — Audio → STT → LLM tunnel audit

Repo: `Even-Transcription-Assistant`, HEAD `5dff406`. All facts below are read directly from
code on the live clone unless marked UNVERIFIED. File:line citations given where load-bearing.

## Audio storage

- **Live-recording durability (browser)**: `lib/chunk-store.ts` — IndexedDB (`eta-recordings` DB,
  `chunks` store, key `${encounter_id}|${idx-8-padded}`). This is a **crash-recovery buffer for
  the recording tab**, not the room-tape archive — chunks are Blobs kept client-side until
  submit, then purged (`purgeEncounter`) with a `submitted` sentinel row to prevent duplicate
  recovery prompts (chunk-store.ts:191-221). Not relevant to room/time-range audio.

- **Canonical raw audio (server, R2)**: `lib/r2.ts`. R2 client is S3-compatible via
  `@aws-sdk/client-s3` (region `"auto"`), configured by `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`.
  - **Room-tape ("Bench") chunk key** (r2.ts:76-87):
    `bench/{room_slug}/{YYYY-MM-DD}/{session_id}/chunk_{idx:05}.webm`
    (backup mic lane: `backup_chunk_{idx:05}.webm`, same session folder).
    Comment: "Everything under the `bench/` prefix is immutable by convention: no code path
    deletes or overwrites under it" (PRD D6).
  - Single-encounter (non-room) recording key: `encounters/{encounterId}.{ext}` (default webm).
  - Rolling Whisper buffer key: `whisper-buffer/{encounterId}.webm` (cleaned up post-submit).
  - Joined/stitched clip key (see "Stitching" below): `clips/{session_id}/{start}-{end}-{source}.webm`.
  - Codec/format: chunks are `.webm` (MediaRecorder output, Opus audio inside WebM container);
    joined clips are also webm by default, optionally `.ogg` (`JoinFormat`), same libopus codec
    either way (bench-join.ts:193-198). No explicit sample-rate constant found in this scope —
    UNVERIFIED (would live in the recorder/MediaRecorder config, out of scope per task).
  - Access: `signPutUrl` (browser direct upload, bypasses Vercel's ~4.5MB body cap), `signGetUrl`
    (admin playback/download, default 1h expiry, supports `downloadFilename` →
    `Content-Disposition: attachment`, and Range requests since it's a plain presigned GET),
    `signHeadUrl` (verify landed chunk), `headObject`/`getObjectBytes`/`putObjectBytes`/
    `deleteObject` server-side helpers. All R2 ops have a 45s hard timeout
    (`R2_OP_TIMEOUT_MS`, r2.ts:47) including the body-stream read, to stop a stalled connection
    from hanging a background `after()` step forever.
  - Retention: no code-level TTL/lifecycle policy found on `bench/` or `clips/`; both are
    described as permanent/immutable by comment. `whisper-buffer/` is deleted after submit or by
    orphan sweep. Bucket-level lifecycle rules (if any) are Cloudflare R2 config, not in this repo
    — UNVERIFIED.

- **Chunk → room/time mapping**: chunk rows live in Postgres table `bench_chunk` (session_id,
  idx, source [primary|backup], r2_key, content_type, started_at, ended_at, upload_state). A
  session (`bench_session`) belongs to a room (`room_id`); `bench-range.ts` and `bench-window.ts`
  both read `bench_chunk` keyed by `session_id`.

- **Windows from chunks**: `lib/bench-window.ts` (415 lines) is the writer that turns verified
  chunks into `bench_window` rows on a **15-minute grid aligned to the IST hour** (`WINDOW_MS =
  15*60*1000`, IST offset baked into `slotStartFor`). Key rules, confirmed in code:
  - A slot closes only when its full 15-minute span is covered by `upload_state='verified'`
    chunks (coverageOf/runIntervals, bench-window.ts:141-196) — coverage is measured over
    **maximal runs of consecutive chunk indices** (a rotation seam is not a gap; a missing index
    is a real gap). No time-based tolerance.
  - Session span comes **only** from the chunks' own `ended_at` (`tapeEndMs`), never from
    `bench_session.ended_at` — the header documents a real incident where relying on
    `ended_at` silently dropped 6 hours of verified audio.
  - **Window close only enqueues** — confirmed at bench-window.ts:397-402: on the open→closed
    edge, if the room's Transcript switch is on, it calls `enqueueSubject("bench_window", id,
    "asr")` and nothing else. No engine call, no join, no cue is fired here — "this runs inside
    the chunk route's `after()` hook, and a paid API call has no business on the tail of a
    recording request."
  - `bench_window` also carries `source_mic` (one row per slot, not one per mic — the backup lane
    is usually near-silent and is dropped by `decideBinding`'s per-session binding rule).

- **Existing stitch/concat code — YES, it exists** (this directly answers the "download + stitch"
  ask): see "Range-transcribe / stitching" below. There is a real joining microservice
  (`services/audio-join/`, Cloudflare Containers) already wired into the MCP range-transcribe
  path. `lib/bench-range.ts` documents that **v1 serves only a single covering chunk** for range
  queries and stitching across chunks was originally deferred ("D2: stitching is v1.1") — but
  `lib/bench-join.ts` + `lib/mcp/tools/bench.ts`'s `scribe_transcribe_range` show that the
  multi-piece join has since been built (U2 in the header comments of `lib/mcp/tools/bench.ts`).

- **Signed-URL/download route**: yes — `signGetUrl` (r2.ts:125-142) is the mechanism; used by
  admin audio playback/download and by the MCP tools. No public/anonymous download route found;
  everything goes through server-side R2 client + presign, gated by admin auth or MCP tool auth.

## Range-transcribe path today (step list)

This is the existing on-demand "audio by clock time" path (PRD §10, S3), driven via the MCP tool
`scribe_transcribe_range` (also `scribe_extract_audio`) in `lib/mcp/tools/bench.ts`:

1. Operator gives a room + `HH:MM[:SS]` IST (or ISO) start/end. `lib/bench-range.ts:
   parseOperatorTime` anchors clock-time parsing to the **session's own IST date** (not the R2
   folder's UTC date — these can differ for sessions starting after 18:30 UTC).
2. `resolveRange(chunks, startMs, endMs, source)` (bench-range.ts:78-98) finds every `bench_chunk`
   row of the chosen mic that overlaps `[start,end)`, in idx order, with per-chunk offset/duration.
   Result is `{kind: "none"|"single"|"multi", covering}`.
3. **If `single`**: download that one chunk from R2 (`getObjectBytes`) and run Whisper directly
   (`transcribeWithWhisper`, lib/whisper.ts) — text covers only that chunk, not the exact window.
4. **If `multi`** (U2, the built stitching path):
   - Refuse if the window is >30 min (`refuseIfTooLong`, `JOIN_MAX_MS = 30*60_000`,
     bench-join.ts:26-33 — the same constant is duplicated in the joining service's own
     `join-core.mjs` on purpose, since they're on opposite sides of a network boundary).
   - Refuse if **any room is currently recording** (D15) — checked via
     `roomsRecordingNow()`/`pickRecordingRooms` (bench-join.ts:113-182), which reuses the exact
     same "is this room really recording" logic as `scribe_diff_room` (session rollup + kiosk
     listener freshness + reaper stall rule) rather than re-implementing it, and treats a
     crashed-tab session stuck in `recording` state as NOT recording.
   - `buildJoinRequest(sessionId, covering, startMs, endMs, source, now, format?)` builds a
     `{pieces:[{key,idx}], trim:{start_ms,end_ms}, out_key, meta, format?}` body. `out_key` is
     deterministic: `clips/{session_id}/{startStamp}-{endStamp}-{source}.webm` — asking for the
     same window twice overwrites one object, doesn't grow the archive.
   - `callJoinService(req)` (bench-join.ts:260-312) POSTs to `${AUDIO_JOIN_URL}/join` with
     `Authorization: Bearer ${AUDIO_JOIN_TOKEN}` and an `x-join-request-id` header, 90s timeout
     (`JOIN_TIMEOUT_MS`). **Never throws** — an unset URL/token, unreachable box, timeout, or
     in-service refusal (e.g. `join_already_running` — the service self-mutexes) all degrade to
     `{ok:false, error, hop?}` so the caller can fall back to the pre-existing multi-piece answer
     (D10) rather than error out.
   - On success, the joined clip is stored under `clips/` in the same R2 bucket, with R2 custom
     metadata (`ClipMeta`: session_id, requested_start/end, source, created_at) — never deleted
     by this code (D3).
   - `scribe_transcribe_range` then runs Whisper (`transcribeWithWhisper`) on the **joined clip**,
     with a scaled timeout (`whisperTimeoutForClip`, min 90s / max 180s, `duration_ms/3`) so text
     covers the actual requested window, not a 5-minute slab (D9).
   - Every answer (join succeeded, join skipped/degraded, or single-chunk) writes a window
     "completeness" cue via `buildWindowCue` / `turnsAnswer` (bench.ts:1457+), naming the engine
     (`whisperAdapter.key`), segment counts, language, `sourceUsed`, and whether it stopped early —
     this write path fails safe (never removes an already-successful transcript on a write error).
   - This whole read+join+transcribe+write flow only runs as `dryRun=false`/real invoke of the MCP
     tool — there's a separate `scribe_replay_session` (dry-run only, writes nothing) and
     `scribe_replay_write` (writes to a scratch room/day, refuses non-`ended` sessions) for replay
     scenarios — these are a different feature (cue replay), not range audio transcription.
5. **Dispatch today happens only three ways**, all manual (no cron): the admin bench-drain UI/API
   (`app/api/admin/bench/drain/route.ts` — GET inspects a session's windows+job+run state, POST
   drains one window or up to N queued windows of a session; explicitly documented as
   "MANUAL ONLY... no cron... the operator asks for each pass, and the answer says what it cost"),
   `app/api/admin/bench/run-waiting/route.ts`, or the MCP `scribe_transcribe_range` tool above.
   Window-close (`bench-window.ts`) only *enqueues*, it never drains/transcribes.

## STT adapters table

All 9 adapters registered in `lib/stt/registry.ts:15-25` (`ADAPTERS` map). "Status" combines
adapter-file self-description + KNOWN-FACTS (engine `enabled` flag lives in the `stt_engine` DB
table, not in code, so live/dark/dead below is code-comment-sourced except where I could confirm
the code's own fail-closed/soft-fail behavior):

| adapter_key | file | status | used by pipeline | model/target | streaming |
|---|---|---|---|---|---|
| `whisper` | adapters/whisper.ts → lib/whisper.ts | **live** — Mini tunnel, primary engine for room tape + note pipeline fallback | live(browser)? (capabilities say stages `["live","note"]`), STT lab, room tape (range-transcribe always uses this one directly, bypassing routing) | whisper.cpp `ggml-large-v3-turbo` on Mac Mini via `WHISPER_BASE_URL` | false (single POST, `verbose_json` segments) |
| `sarvam` | adapters/sarvam.ts → lib/sarvam.ts | live | STT lab, batch translate/diarize path (`with_diarization` in diarize.ts comments) | Sarvam cloud API | false |
| `deepgram` | adapters/deepgram.ts | live (per KNOWN FACTS: browser-live fallback) | live browser pipeline (fallback) | Deepgram cloud | true (per `lib/deepgram-token.ts`, `use-deepgram-live.ts` — token-based) |
| `indicconformer` | adapters/indicconformer.ts | live | STT lab / note-time Indic fallback (`stages:["note"]` only, capabilities.ts:26) | AI4Bharat IndicConformer-600M on Mac Mini via `INDICCONFORMER_BASE_URL` (default `https://indic.llmvinayminihome.uk`) | false |
| `indicconformer_scribe` | adapters/indicconformer-scribe.ts | live (scribe-tier wrapper around indicconformer + generateNote) | note-gen assist path | same Mini model | false |
| `gemini` | adapters/gemini.ts | **dark per KNOWN FACTS** (migration 0073) — code deliberately fail-closed, does NOT go through the soft-fallback `routedChat()` used elsewhere, specifically so a Gemini STT-lab run can never silently be served by qwen (the file cites a real incident: 367 audits mislabelled `gemini-2.5-pro` were actually `qwen2.5:14b` for 4 days) | STT lab only (Build 3 §A) | Gemini via Vertex (`getVertexAccessToken`) | false, no segment/word timings (never becomes the segmenter) |
| `elevenlabs` | adapters/elevenlabs.ts | **dead per KNOWN FACTS** (code present, needs `ELEVENLABS_API_KEY`; no positive evidence found in this pass that it is enabled in `stt_engine` — DB-driven, UNVERIFIED from code alone) | STT lab (historical) | ElevenLabs Scribe v2, `POST /v1/speech-to-text` | capabilities declare `streaming:true` but this adapter's own `transcribe()` is a single non-streaming multipart POST — capability flag looks aspirational/inherited, not implemented here |
| `elevenlabs_scribe` | adapters/elevenlabs-scribe.ts | tied to elevenlabs — same status caveat | scribe-tier (note) wrapper | ElevenLabs | false |
| `ekascribe` | adapters/ekascribe.ts | **disabled per KNOWN FACTS**; code is a full async job client (login → presigned S3 upload → init transaction → poll) | historical/paid alt (async job model, serves both ASR tier and note tier via `generateNote()`) | eka.care cloud (`api.eka.care`) | async (poll-based), not streaming |

Routing: `lib/stt/routing.ts` `resolveRouting(stage, bucket)` — `stage ∈ {live, note, diarize,
room}`, `bucket ∈ {english, indic, default}` — reads `stt_routing` table for an admin-pinned
`engine_id`; falls back to `default` bucket row, then to `null` (built-in default logic) if the
row is missing, `'auto'`, the engine is disabled, or has no code adapter. **Never throws** — any
DB error also resolves to `null` (default behavior). This confirms the KNOWN FACT that
`resolveRouting("room")` exists as a formal stage; I did not find the specific default chain
(Sarvam → Whisper-on-Mini-first for language+segments) spelled out as a literal fallback list in
`routing.ts` itself — that logic lives in the caller (likely `room-drain.ts`, not fully read this
pass — UNVERIFIED exact order, though consistent with KNOWN FACTS).

## Tunnel endpoint inventory

All three Mini services (Whisper, Diarize/pyannote+ECAPA, IndicConformer) plus the Ollama/LLM
tunnel are reached over Cloudflare Tunnel hostnames (`*.llmvinayminihome.uk` seen in comments).

| endpoint | host env var | called from | purpose | used? |
|---|---|---|---|---|
| `POST {WHISPER_BASE_URL}/inference` | `WHISPER_BASE_URL` | `lib/whisper.ts: whisperAttempt` (called by adapters/whisper.ts, bench.ts range-transcribe, room-drain) | transcribe one clip, `verbose_json` (text+segments+language), decoder pinned to greedy/temp=0/beam=1/best_of=1, one retry on transport failure only (not on timeout/4xx/empty_transcript) | **yes**, primary |
| `GET {WHISPER_BASE_URL}/inference` | same | adapters/whisper.ts `health()` | liveness probe (200/<500/501 = ok) | yes |
| `POST {DIARIZE_BASE_URL}/diarize` | `DIARIZE_BASE_URL` | `lib/diarize.ts: runDiarize` | full diarization: speaker clusters, role labels, overlap windows, speech-time aggregates, per-speaker ECAPA embeddings (`embedding_base64`) — gated by a client-side queue slot (`lib/diarize-gate.ts`, depth 1) because the Mini service is single-worker uvicorn and serialises | **yes** |
| `POST {DIARIZE_BASE_URL}/enroll` | same | `lib/enroll.ts` | enroll/average a clinician voiceprint centroid from N sentence embeddings | yes (clinician enrollment flow) |
| `GET {DIARIZE_BASE_URL}/health` | same | `lib/mcp/tools/health.ts: probePyannote`, `lib/mcp/tools/voice.ts: scribe_voice_health` | liveness + reports `device`/`models` | yes |
| `POST {INDICCONFORMER_BASE_URL}/inference` | `INDICCONFORMER_BASE_URL` (default `https://indic.llmvinayminihome.uk`) | `adapters/indicconformer.ts` | Indic-only ASR (IN-22 language required, no auto-detect, no code-switch, native script out) | yes (note-stage fallback) |
| `GET {INDICCONFORMER_BASE_URL}/healthz` | same | `adapters/indicconformer.ts: health()` | liveness | yes |
| `POST {LLM_BASE_URL or OLLAMA_BASE_URL}/chat/completions` | `LLM_BASE_URL` (falls back to `OLLAMA_BASE_URL`) | `lib/qwen.ts: qwenJson`, `lib/llm/gemini.ts: routedChat`'s ollama branch, `lib/cdmss-stub.ts` | OpenAI-compatible chat endpoint on Ollama; `qwen2.5:14b`, JSON mode, temp 0.2 (qwen.ts default) or note-specific 0; used for note-gen (via `routedChat`) and CDMSS stub | **yes**, primary local LLM |
| `GET {OLLAMA_BASE_URL}/models` | `OLLAMA_BASE_URL` | `lib/admin/dashboard.ts` | health/dashboard probe of what models Ollama has loaded | yes (admin dashboard only) |
| `POST {OLLAMA_BASE_URL}/embeddings` | `OLLAMA_BASE_URL` (comment: env var already includes `/v1`) | `lib/kb-embed.ts` | `nomic-embed-text` embeddings for the KB/RAG pipeline | yes (KB retrieval, not STT/note pipeline) |
| — (no fixed path, uses `OLLAMA_BASE_URL` base directly per llm.ts comment, OpenAI SDK) | `OLLAMA_BASE_URL` | `lib/llm.ts`, `lib/llm-cleanup.ts` | `llm-cleanup.ts` calls a `CLEANUP_MODEL` (`llama3.1:8b` default) for light text cleanup, 8s timeout | yes, small side-use, not the main note model |
| `POST {AUDIO_JOIN_URL}/join` | `AUDIO_JOIN_URL` (+ `AUDIO_JOIN_TOKEN` bearer) | `lib/bench-join.ts: callJoinService` | stitch N R2 chunk keys into one trimmed clip, written back to R2 under `clips/` | **yes** — this is the audio-stitching service the operator wants; already wired into `scribe_transcribe_range`. NOT on the Mini/Ollama tunnel — it's a separate Cloudflare Containers service (`services/audio-join/`), not read in depth (its container code is out of this scope per task instructions, but its HTTP client contract is fully mapped above). |

No `/emotion` or similar affect-detection endpoint found anywhere in `lib/` or `app/` for any of
`DIARIZE_BASE_URL`, `WHISPER_BASE_URL`, `INDICCONFORMER_BASE_URL`, or `OLLAMA_BASE_URL` — a
`grep -rn "emotion"` across `lib` and `app` returned zero matches. Per KNOWN FACTS this was
"UNVERIFIED" — this pass makes it **confirmed absent from client code** (the Mini service itself
could still expose more routes than this client ever calls, which this repo can't show).

## Note generation

- `lib/note-generation.ts`, `generateNote(transcript, opts)` — **input is a single `transcript:
  string`** (no separate speaker-tagged parameter exists in the function signature at all).
  Its caller, `app/[slug]/api/encounters/[id]/process/route.ts`, builds that string entirely from
  the `encounter.transcript_raw` column (confirmed by direct grep — every assignment in the
  pipeline writes into `row.transcript_raw`, and it's the only transcript field read before
  calling into note-gen downstream). This **confirms the KNOWN FACT**: note-gen consumes
  `transcript_raw` (a plain English string), not any speaker-tagged structure like
  `TaggedEntry[]` from `diarize.ts`'s `reconcileTagged`.
- Model: `qwen2.5:14b` (`NOTE_MODEL`, overridable via env), temperature 0, 240s timeout, JSON mode.
  Routed through `routedChat()` (`lib/llm/gemini.ts`) with `surface:"note", tier:"flash"` — Gemini
  only serves this when `GEMINI_ALL`/`GEMINI_NOTE=1` AND Vertex is configured; otherwise (and on
  any Gemini error) it **soft-falls-back to local qwen silently** — this is the opposite fail
  mode from the STT-lab Gemini adapter, and the note-gen path explicitly accepts that trade-off
  (comment: "Soft-fails to qwen on any error").
- Six distinct system prompts exist by `noteType`: default clinic note (`SYSTEM`),
  `general_medical` (inpatient round), `operative_procedure`, `dietetic_consult`, `physiotherapy`,
  `discharge_summary`, `opd_prescription` (`SYSTEM_RX`) — all instruct the model to translate
  faithfully to English, never invent content, and leave undiscussed sections empty.
  `nativeReference` (original-language transcript) can be passed as a secondary/reference block
  appended after the primary English transcript, capped at 9000 chars.
- Output: a `NoteResult` JSON object (`AnyNote`) with sections (chief_complaint, HPI, PMH,
  medications, allergies, exam, assessment, plan{investigations,treatment,follow_up}), stored via
  the caller (`process/route.ts`) — not traced to its exact DB column in this pass (out of the
  file list given; the route clearly persists back into the `encounter` row alongside
  `transcript_raw` updates).
- Evaluation/gold set: `admin/stt-gold-window` and `admin/stt-leaderboard` and `admin/stt-spend`
  routes exist (confirmed directory listing under `app/api/admin/`), plus `lib/stt/leaderboard.ts`,
  `lib/stt/window-leaderboard.ts`, `lib/stt/scoring.ts`, `lib/stt/window-scoring.ts`, `lib/stt/wer.ts`
  — a full WER/scoring/leaderboard system keyed off gold windows exists in code. Contents of these
  files were not read in this pass (budget) — their **existence and naming** is confirmed, their
  internal scoring logic is UNVERIFIED beyond what the filenames imply.

## Voice identity

Speaker-cluster centroids (`lib/stt/speaker-clusters.ts`) are 192-dim ECAPA embeddings
(`EMBEDDING_DIMS=192`, base64 of 768 raw little-endian float32 bytes — migration 0042), matched by
cosine similarity against a per-room-day set of running-mean centroids. Every cluster this slice
writes is `kind='other'` — the `speaker_cluster.kind` column is CHECK-constrained to
`('doctor','other')` and the code deliberately never writes `'doctor'`, because the only two
enrolled voiceprints are "May-vintage, never refreshed from real audio, zero passive samples," and
PRD §1.9 explicitly excludes matching against them at this slice; a talk-time heuristic for "who's
the doctor" was considered and rejected as "a manufactured label ... right often enough to be
trusted and wrong often enough to matter." Clusters are anonymous and scoped strictly per
`room_day` — never joined across days even for the same real person. The match threshold has
**no code default** (`readThreshold` returns a named error `threshold_unset`/`threshold_invalid`
rather than falling back to a guessed value like 0.7) and is explicitly NOT the same number as the
existing enrolled-clinician thresholds (0.78 live-identify, 0.82 passive-capture) since those
compare against a named enrolled centroid, a different comparison. The frozen calibration tape is
named in code: `CALIBRATION_SESSION_ID = "bs_z3gpbh6e"` (24 Aug Cardiology session), swept over
thresholds `[0.5 … 0.9]` step 0.05. Matched turns are written to `room_turn_speaker`
(`(window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id)`), populated from
`lib/stt/diarize-job.ts`. `voice_print` (clinician enrollment) is a separate table/flow driven by
`lib/enroll.ts` against the same `DIARIZE_BASE_URL/enroll` endpoint — enroll and room-cluster
matching are two distinct identity systems sharing only the embedding format and the Mini service.

## Gaps for on-demand stitch+Whisper

What the operator capability needs vs. what exists today:

1. **Stitching across an arbitrary room/time range already exists** via
   `scribe_transcribe_range`/`scribe_extract_audio` (MCP tools) → `bench-range.resolveRange` →
   `bench-join.buildJoinRequest`/`callJoinService` (Cloudflare Containers `audio-join` service) →
   Whisper on the joined clip. This is NOT a gap; it needs to be exposed/orchestrated for the
   operator's "download → stitch → send to Whisper on demand" ask rather than rebuilt.
2. **Hard ceiling: 30 minutes per joined window** (`JOIN_MAX_MS`). A longer range must be split
   into ≤30-min calls by the caller; no chained/looping join exists in this repo.
3. **Joining is refused while the room is recording** (D15) — an operator wanting "live room, last
   hour" cannot join mid-recording; only closed/ended windows, or windows from a session not
   currently live, can be joined. A workaround (single-chunk-at-a-time, no stitch) still works but
   loses the "one continuous clip" property.
4. **The join service itself (`services/audio-join/`) was explicitly out of scope for this
   researcher** — its actual behavior (ffmpeg concat, ordering guarantees, silence-gap handling
   between non-contiguous covering chunks, `join_already_running` mutex semantics) is UNVERIFIED
   from this pass; only its HTTP contract (as called from `bench-join.ts`) is mapped.
5. **No generic "any engine" plug-in for range-transcribe** — `scribe_transcribe_range` is
   hard-wired to `whisperAdapter` (bench.ts:86, "T3 — the operator path's transcriber, named by
   the adapter rather than typed into a payload"). Routing another engine (Sarvam, Gemini,
   IndicConformer) into an on-demand range call would need new plumbing; `resolveRouting("room",
   bucket)` exists as a formal concept but I did not find it consulted inside the range-transcribe
   MCP tool itself in this pass — UNVERIFIED whether it's wired in or bypassed entirely (the code
   comment strongly suggests bypassed, since it names the adapter directly rather than resolving
   via routing).
6. **No download route for a raw stitched file independent of transcription** — today's join
   pipeline produces a clip specifically as an input to Whisper inside the same MCP tool call;
   there's a presign (`signGetUrl`) that could serve the resulting `clips/...` key back to an
   operator, but I did not find a dedicated "give me back the audio file" MCP tool/route distinct
   from the transcribe-range tool in this pass — UNVERIFIED, worth a targeted follow-up read of
   `lib/mcp/tools/bench.ts` around `scribe_extract_audio` specifically (only partially read here).
7. **No batch/multi-window orchestration** — every join+transcribe is one window, one MCP call;
   an operator wanting "the whole afternoon" would need N sequential calls (each ≤30 min, each
   its own `AUDIO_JOIN_URL` POST + Whisper POST), with no code-level batching/queueing for that.
8. **Range-transcribe result writes a window "completeness" cue but the transcript's persistence
   target beyond that cue** (does it land in `transcription_run`? in `bench_window.clip_r2_key`?)
   was not fully traced in this pass — the `admin/bench/drain` route's SELECT does show
   `transcription_run` joined by `(subject_type='bench_window', subject_id=w.id)` with
   `stt_engine_id`, `metrics_json`, `detected_language`, `latency_ms` — so the schema clearly
   exists and is used by the drain path; whether `scribe_transcribe_range`'s ad-hoc join+Whisper
   calls also write into `transcription_run` (vs. just returning text over MCP) is UNVERIFIED.

## Open questions

- Does `scribe_transcribe_range` persist its Whisper output into `transcription_run` /
  `bench_window`, or is it read-only/ephemeral per call? (see Gap 8)
- Is `resolveRouting("room", bucket)` actually consulted anywhere in the live room-tape drain
  path (`room-drain.ts`, not read this pass), or is Whisper truly hard-pinned end-to-end for room
  tape as `bench.ts`'s range-transcribe tool suggests?
- What are `services/audio-join/`'s actual concat semantics for non-contiguous chunks inside one
  requested window (e.g. a chunk-index gap mid-window) — does it silently splice over the gap,
  insert silence, or refuse? (out of scope per task, flagged for the audio-join-focused researcher)
- Confirm current `stt_engine.enabled` values for `elevenlabs`, `ekascribe`, `gemini` directly from
  the DB (this pass could only confirm code-level fail-closed/soft-fail *design*, not the live
  `enabled` bit, which is DB state not in this repo).
- Exact sample rate / bitrate of MediaRecorder-produced webm chunks (not located this pass; likely
  in a room-recorder or bench-related recording-start file explicitly out of scope here).
