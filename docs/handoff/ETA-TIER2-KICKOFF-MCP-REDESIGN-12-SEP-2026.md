# ETA Tier 2 Spec v1.0 — Scribe MCP Redesign (jobs, audio tools, tunnel tools, guards)

Status: SPEC v1.0, 12 Sep 2026. Base: `vinay/release-b1` @ `7e5e572` (production `eb6884e`, migrations through 0081, room-recorder 0.1.22 on `test`, 0.1.21 on `stable`). Rulings D2–D6 in `SCRIBE-UPGRADE-PLAN-11-SEP-2026.md §7`; Tier 1 record in `docs/handoff/ETA-TIER1-ROLLOUT-12-SEP-2026.md`. Audit facts from `C-mcp-audit.md` and `B-audio-stt-tunnel.md`. No app (Swift) change in this tier.

## 0. Goal

Turn the operator door from "39 read tools named after tables, two of them useful for audio, none of them able to wait" into a surface an operator (human or agent) can drive a day's work through: submit long audio work as jobs, pull a whole day to disk, measure audio content, reach every Mini service, and be told the truth fast when something downstream hangs. Four guards this week exposed ship first.

## 1. Slices (each = Builder → Refuter → promote; A can go same day)

| Slice | Contents | Migration | Touches |
|---|---|---|---|
| A — Guards & hygiene | §2 | — | lib/mcp/**, lib/room-install.ts, assign-channel route, audit |
| B — Jobs | §3 | 0082 `scribe_job` | lib/jobs/**, app/api/jobs/**, vercel.json cron, lib/mcp/tools/jobs.ts |
| C — Audio tools | §4 | — (+ audio-join container `measure`) | lib/mcp/tools/audio.ts, lib/bench-join.ts, services/audio-join |
| D — Tunnel tools | §5 | — (+ env `EMOTION_BASE_URL`) | lib/mcp/tools/tunnel.ts, lib/emotion.ts |
| E — Surface regroup | §6 | — | lib/mcp/handler.ts, registry, tool descriptions |

Order A → B → C → D → E. C and D depend on B (every call > 20 s is a job). E last so aliases cover everything.

## 2. Slice A — guards & hygiene

1. **assign-channel version floor.** `POST /api/admin/installs/{id}/assign-channel` refuses `channel:"test"` when the install's reported `app_version` < 0.1.22 → 409 `APP_TOO_OLD` (reuse `appVersionAtLeast`, floor constant `TEST_CHANNEL_MIN_APP_VERSION = "0.1.22"`). `stable` unaffected. Fleet card's "Move to test" control disabled with the same reason.
2. **Audit row on assign-channel.** `assignInstallChannel` (lib/room-install.ts:1441) writes `audit_log` `install.assign_channel` {install_id, room_id, from, to, actor}. The poll's self-clear writes `install.channel_reported` {install_id, channel} once per transition (not per poll).
3. **Per-token scopes (D4).** `SCRIBE_MCP_TOKENS` = JSON `{ "<sha256 of token>": {"actor":"operator-v","scopes":["read","invoke","write"]}, ... }`. `checkMcpBearer` (auth.ts) resolves the map first, falls back to `SCRIBE_MCP_TOKEN` as actor `mcp:operator-v1` all scopes (nothing breaks). `audit_log.actor_id` = resolved actor. Add one read-only token for watchers.
4. **`detail` flag.** `scribe_diff_room`, `scribe_day_report`, `scribe_system_map`, `scribe_fuse_report` accept `detail: "summary" | "full"` (default `summary`). Summary = the fields an operator reads first (room_state, flags, drift_since, listener_state, recording, last_piece_at, counts); full = today's payload. `scribe_diff_room` description cut to ≤ 150 words; the long text moves to `docs/operator-mcp/TOOL-NOTES.md`.
5. **Named downstream timeouts.** Every outbound fetch from a tool (Whisper, pyannote, join, Ollama, Gemini, R2) gets an explicit budget strictly below the tool budget and returns `{error:"<service>_timeout", elapsed_ms, budget_ms}` — never a shape-only degrade. Table in `lib/mcp/budgets.ts`: read tools 55 s → downstream 40 s; invoke 115 s → downstream 90 s. Anything that legitimately needs longer becomes a job (Slice B).
6. **MCP `listChanged`.** `initialize` advertises `tools.listChanged: true`; on deploy the handler's tool-set hash changes and the next `tools/list` from any client is honoured (clients that cache still need a reconnect — documented in TOOL-NOTES).
7. **`scribe_fleet`** (read): the `/api/admin/bench/fleet` payload through the MCP door (proxy-blocked from agent shells today). `detail` applies.

Tests: floor refusal both sides of 0.1.22; audit rows present; token map resolution + fallback + scope refusal `-32001`; summary/full shapes; timeout envelope for each service (mocked hang); `listChanged` in initialize; fleet parity with the admin route.

## 3. Slice B — jobs (D2)

Migration 0082 `scribe_job`: `id text PK (job_…)`, `kind text`, `args jsonb`, `status text CHECK (queued|running|done|failed|cancelled)`, `step text`, `progress jsonb`, `result jsonb`, `error text`, `actor text`, `created_at`, `started_at`, `updated_at`, `finished_at`, `lease_until timestamptz`, `attempts int DEFAULT 0`. Index `(status, created_at)`.

Runner: `POST /api/jobs/run` (bearer `JOBS_RUNNER_SECRET`), invoked by (a) `after()` on submit and (b) `vercel.json` cron every minute (Pro allows 1 min). Each invocation claims ≤ 3 queued/expired-lease jobs (`FOR UPDATE SKIP LOCKED`, lease 240 s), runs **one step** per claim, persists `step`/`progress`, releases. Steps are ≤ 200 s by construction, so the 300 s route ceiling never matters. `attempts` > 3 → `failed`. Kinds are step machines declared in `lib/jobs/kinds/*.ts`: `transcribe_range` (resolve → join → transcribe → write), `stitch` (resolve → join pieces × N → manifest), `audio_measure`, `emotion_clip`, `diarize_clip`, `stt_fanout`, `day_manifest`.

MCP: `scribe_job_submit(kind, args)` → `{job_id}` in < 2 s (scope per kind); `scribe_job_status(job_id, include_result)`; `scribe_job_list(status?, kind?, limit)`; `scribe_job_cancel(job_id)` (only queued/running; running honoured at the next step boundary). Existing `scribe_transcribe_range` and `scribe_extract_audio` gain `async: true` which submits the equivalent job and returns its id; default behaviour unchanged for one release.

Tests: claim/lease/skip-locked under concurrency; step persistence after a simulated crash mid-step; cancel at boundary; attempts cap; `after()` kick; cron route auth.

## 4. Slice C — audio tools

1. **`scribe_day_manifest(room, ist_date, source=both, expires_h=6)`** (read; job kind `day_manifest` when > 500 chunks). Every `bench_chunk` of every session that IST day: `{session_id, idx, source, r2_key, sha256, bytes, started_at, ended_at, url}` presigned for `expires_h` (cap 12 h). Never inlines bytes.
2. **`eta-pull-day`** — `tools/eta-pull-day.mjs` in the repo (runs on a Mac with Node 22): takes a manifest URL or the MCP token + room + date, downloads in parallel (8), verifies sha256 and size, writes `~/ETA-audio/{room-slug}/{date}/{session_id}/chunk_00000.webm …` + `manifest.json`, optional `--concat` runs `ffmpeg -f concat -c copy` per session (no re-encode) and `--wav` transcodes to 16 kHz mono WAV. No server change beyond (1).
3. **`scribe_stitch(room|session_id, start, end, source?, format=webm|wav)`** (invoke → job `stitch`). Splits any range into ≤ 30 min pieces, joins each via `AUDIO_JOIN_URL/join` (existing contract), returns `{pieces:[{start,end,clip_key,url}], total_ms}`. Refusal `room_recording` stays for the *live* session only — a range wholly inside an ended session joins even while the room records a new one (`bench-join.ts pickRecordingRooms` narrowed to the session, not the room).
4. **`scribe_audio_measure(clip_key | room+range)`** (invoke → job `audio_measure`, D5). `services/audio-join` gains `POST /measure {key}` running ffmpeg `astats` + `silencedetect -n -55dB -d 2` + `ebur128`; returns `{rms_dbfs, peak_dbfs, lufs_i, lra, clip_samples, silence_spans:[{start_ms,end_ms}], speech_ratio}`; result stored as R2 custom metadata on the clip (`measure_v1`) and in the job result. Per-room floor calibration (R2.5) reads these later.
5. **`scribe_transcribe_range` gains `engine`** from `lib/stt/registry.ts` (`whisper` default; `sarvam`, `indicconformer`, `gemini` allowed if `stt_engine.enabled`); persists a `transcription_run` row (subject bench_window or ad-hoc range) so the leaderboard sees it.
6. **`scribe_run_stt_fanout(clip_key | range, engines[])`** (invoke → job `stt_fanout`): N engines on one clip → N `transcription_run` rows + WER vs gold when a gold window overlaps.

Tests: manifest completeness vs `bench_chunk`; presign expiry; stitch piece math at 29/30/31/61 min; measure JSON shape from a fixture WAV (silent, clipped, speech); engine allow-list; fanout rows.

## 5. Slice D — tunnel tools

Env: `EMOTION_BASE_URL` (= `https://emotion.llmvinayminihome.uk`). New `lib/emotion.ts` client: `POST /inference` multipart `file`, optional `model=wavlm|emotion2vec`; one global lock on the Mini and 120 s max clip → client serialises and never sends > 110 s.

1. **`scribe_ask_llm(prompt, system?, surface="operator", model?, json=false, max_tokens≤2048)`** (invoke): `routedChat` with a new `operator` surface; provider label DERIVED from the call (rule: never typed); returns `{provider, model, text|json, latency_ms, usage}`. 10 s hard cap Ollama, 30 s Gemini; longer → job.
2. **`scribe_embed(texts[≤16])`** (read): `OLLAMA_BASE_URL/embeddings` nomic-embed-text; returns vectors + dims.
3. **`scribe_diarize_clip(clip_key, clinician_ids?)`** (invoke → job `diarize_clip`): `DIARIZE_BASE_URL/diarize` on a clip; returns speakers, segments, overlap, per-speaker embedding refs (embeddings stored, not inlined).
4. **`scribe_emotion_clip(clip_key | range, model?)`** (invoke → job `emotion_clip`): cuts ≤ 110 s pieces, serialises through `/inference`, returns per-piece `{start_ms,end_ms,top[5],labels}`; with `by_turn:true` uses the diarize segments as pieces. Feeds the S5 slow lane.
5. **`scribe_tunnel_health`** (read): one probe per service — whisper, diarize, indic, emotion, ollama `/models`, audio-join — with latency; replaces the three separate health tools under aliases.

Tests: emotion client refuses > 110 s and serialises; provider label derived; embed dims; tunnel health shape with one service down.

## 6. Slice E — surface regroup (D6)

Five groups, ≤ 25 primary tools; every old name kept as an alias for one release with a `deprecated_alias_of` field in its description:

| Group | Primary tools |
|---|---|
| Rooms | `scribe_rooms` (list+state, `detail`), `scribe_room_command`, `scribe_set_audio_input`, `scribe_start/stop/pause/resume_recording`, `scribe_fleet`, `scribe_watch_rooms` (digest of flags/drift/offline across rooms) |
| Tape | `scribe_day_manifest`, `scribe_get_recording`, `scribe_stitch`, `scribe_transcribe_range`, `scribe_audio_measure`, `scribe_day_report` |
| Brain | `scribe_cues` (list+post), `scribe_visit` (pin+clinician), `scribe_fuse_run`, `scribe_fuse_report` |
| Lab | `scribe_stt` (engines+routing+runs), `scribe_run_stt_fanout`, `scribe_encounters`, `scribe_traces`, `scribe_kb_probe` |
| Jobs & health | `scribe_job_*`, `scribe_health` (composite, `detail`), `scribe_tunnel_health`, `scribe_ask_llm`, `scribe_embed`, `scribe_diarize_clip`, `scribe_emotion_clip` |

## 7. Out of scope (Tier 3)

Whisper-only auto-drain cron (D3), speaker-tagged input to note-gen, `resolveRouting` in the room-tape path, HMAC-signed command rows, per-room silence floor calibration. Router on the Mini stays untouched.

## 8. Builder brief (CC on the Mini, tmux `scribe`; one slice per kickoff)

Branch `vinay/tier2-<slice>` from the current `vinay/release-b1` HEAD. Allowed files per slice table in §1 plus tests. Gates: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run check:silent` — all must match or exceed baseline (1776 tests, 9 accepted findings). Do not: touch `apps/room-recorder`, publish any release, run a migration outside preview, change `LISTENER_FRESH_MS`/`ACK_WAIT_MS`, or alter any tool's default output shape except where §2.4 says. Output: `docs/handoff/ETA-TIER2-<SLICE>-BUILD-REPORT-<date>.md` ≤ 60 lines: commits, test counts, every seam interpreted differently.

## 9. Refuter brief (separate CC session; never the Builder)

Diff against this spec; rerun all gates. Per slice, break it: A — a `test` assignment to a 0.1.21 install must 409; a scope-less token must get `-32001` on write tools; a mocked 5-minute Whisper hang must return `whisper_timeout` inside 45 s on a read tool. B — kill the runner mid-step and prove the job resumes at the same step with `attempts` +1; two runners must not double-claim. C — 61-minute stitch yields 3 pieces with exact boundaries; measure on a silent fixture reports one span covering the file. D — a 300 s clip to emotion is refused client-side before any network call; provider label equals what the tunnel actually answered. Verdict ≤ 40 lines with a safe-to-promote yes/no.
