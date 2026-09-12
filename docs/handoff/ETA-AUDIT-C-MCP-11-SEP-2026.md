# Scribe MCP Server Audit (read-only) — 11 Sep 2026

Researcher pass for the orchestrator. All facts cited `file:line` against
`$HOME/mnt/MiniDev/Even-Transcription-Assistant` (repo `Even-Transcription-Assistant`,
branch `vinay/release-b1`, HEAD `5dff406`, live at `www.evenscribe.app`). No edits made.
Inferences are marked UNVERIFIED.

## 0. Which repo the connector actually talks to

`$HOME/mnt/eta-operator-mcp` is **not a separate wrapper server**. It is a `git worktree`
of the *same* `Even-Transcription-Assistant` repo (`package.json` name field is identical:
`even-transcription-assistant`), checked out on branch `feat/operator-mcp`, tip
`592213d3` (20 Aug 2026, "Remount resume slice 5" — a room-recorder commit, unrelated to
the MCP door despite the branch name). Its `node_modules` is a symlink to
`/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/node_modules`. That parent repo
(`$HOME/mnt/dev/Even-Transcription-Assistant`) is itself on `feat/room-recorder` at
`d7df4b1` (29 Aug), a month stale relative to MiniDev.

The MiniDev checkout (branch `vinay/release-b1`, `5dff406`, 10 Sep) is the live, current
tree. `app/api/mcp/route.ts:1-11` and `app/api/mcp/[key]/route.ts` both dispatch into the
one shared `lib/mcp/handler.ts`, and the route's own comment says the path-key door exists
**"for Claude's custom-connector UI, which takes only a URL"** — i.e. this is the door the
"Scribe_MCP" connector hits. `eta-operator-mcp` and `dev/Even-Transcription-Assistant` are
stale side-branches and should be ignored for this audit (per instructions) and for any
redesign — they are not what is deployed.

## 1. Transport & auth

- **Protocol**: hand-rolled JSON-RPC 2.0 over HTTP POST. No SSE, no MCP session ids —
  stateless "Streamable-HTTP JSON responses" (`lib/mcp/handler.ts:8,96`).
  `PROTOCOL_VERSIONS = ["2025-06-18","2025-03-26","2024-11-05"]`, latest offered first
  (`handler.ts:42-43`); `initialize` echoes back whichever of the three the client asked
  for, else falls back to latest (`handler.ts:175-177`).
- **Two doors, one handler**: `/api/mcp` (header `Authorization: Bearer <SCRIBE_MCP_TOKEN>`,
  `app/api/mcp/route.ts:26-29`) and `/api/mcp/<token>` (path-key form, for the Claude
  connector UI which only accepts a URL — `handler.ts:4-9`). Both call
  `lib/mcp/auth.ts:checkMcpBearer`, so they cannot expose different tool sets.
- **Auth**: SHA-256 both sides + `timingSafeEqual` constant-time compare
  (`lib/mcp/auth.ts:33-35`). Missing `SCRIBE_MCP_TOKEN` env → 503
  `mcp_token_not_configured` (fail closed); bad/absent bearer → 401 `unauthorized`
  (`auth.ts:27-37`). One token, one principal, scopes = **all** of `read|invoke|write`
  (`auth.ts:19-20,37`) — there is no per-operator token and no partial-scope token in
  this build; the "scope" plumbing exists but currently gates nothing (every registered
  tool is reachable by the one token).
- **Timeouts**: per-tool `Promise.race` against a hard deadline — 55 s for
  read/write tools, 115 s for `scope:"invoke"` tools (`extract_audio`,
  `transcribe_range`) (`handler.ts:44-45,224-229`). Route-level `maxDuration = 300` s
  (Vercel's per-plan ceiling) with a comment explaining it was raised from 120 s because a
  cold container wake (1-3 s) + ffmpeg join + clip download + full-window Whisper is now
  three legs, not one (`app/api/mcp/route.ts:16-20`). Body cap 256 KB
  (`handler.ts:46,120-121`).
- **Error mapping**: JSON-RPC codes -32700 parse, -32600 invalid request, -32601 method
  not found, -32602 invalid params, -32603 internal, and a custom **-32001
  `scope_or_tool_unavailable`** (HTTP 403) for an unregistered tool or an out-of-scope call
  (`handler.ts:205-218`). Tool handlers themselves are fail-safe by contract
  (`lib/mcp/registry.ts:38-44`, `failSafe`): a thrown error becomes
  `{ ...empty_shape, degraded:true, error }` inside a normal 200 JSON-RPC result, never a
  5xx — "only auth is hard" (`handler.ts:23`). A tool that DOES throw past its own
  `failSafe` wrapper is still caught at `callTool` and turned into
  `{ error, degraded:true }` (`handler.ts:230-233`) — so nothing in this door can 500 the
  MCP response itself; a hung tool instead silently eats its whole timeout budget (55s/115s)
  before the caller gets anything back — this is one root cause of "unreliable/slow"
  (below).
- **Per-tool rate limits**: none found anywhere in `lib/mcp/*`. No token bucket, no
  per-IP or per-tool cooldown.
- **Logging**: one `audit_log` row per `tools/call`, best-effort (a failed insert only
  `console.warn`s, never fails the call) — `lib/mcp/audit.ts:43-61`. Only an allow-listed
  set of arg keys is stored (`audit.ts:19-26`; ids, dates, filters, flags — never free
  text, payloads or URLs); a `q` string is recorded as `q_len` only (`audit.ts:38-39`).
  `actor_type='system'`, `actor_id='mcp:operator-v1'` — every call looks identical in the
  log regardless of which human is driving the connector (no operator identity is
  distinguishable downstream of the one shared token).

## 2. The 39 tools

All defined in `lib/mcp/tools/*.ts`, aggregated in `lib/mcp/handler.ts:29-49`.
"Output shape" = what comes back with **no** `include_*` flags set.

| Tool | file:line | rw | Key inputs | Default output | include_* flags | Tables/services | Known failure modes (in code) |
|---|---|---|---|---|---|---|---|
| scribe_health | health.ts:140-146 | read | none | composite: app/kb/r2/whisper/ollama/resend probes, brain health, STT engine probes, Pyannote probe, bench listeners | none | app DB, brain pool, R2/Whisper/Ollama/Resend health routes, Mini `/health` | every sub-probe soft-fails to `{ok:false}` (health.ts:44-93); Pyannote 5s timeout (health.ts:23,32); listeners empty + note "bus not migrated" pre-0044 |
| scribe_system_map | health.ts:148-184 | read | none | scribe_health payload + flag states + env-set booleans + store/route topology | none | same as above | no secrets, but env booleans only — can't tell *which* value is wrong, only that it's set |
| scribe_list_rooms | brain.ts:81-128 | read | include_scratch | id/slug/name/enabled/last session | include_scratch | app DB `room`,`bench_session` | none obvious |
| scribe_get_state | brain.ts:130-146 | read | room/room_id/room_slug, ist_date | visits[], active_visit_id, clusters[] (no vectors) | none | brain pool `room_day`,`visit`,`speaker_cluster` | ambiguous free-text room name throws `AmbiguousRoomError`, returned as `ambiguous_room` |
| scribe_list_cues | brain.ts:148-192 | read | room, since/until, cursor, type, limit≤200 | cue list, `summary` = first 80 chars of payload | include_payload | brain pool `cue` | cap 200/page; must page via `cursor`/`next_cursor` — pre-K2 a >200-cue day was unreachable past page 1 (brain.ts:150 comment) |
| scribe_post_cue | brain.ts:326-372 | **write** | room, type, at, payload, source | `{ok,cue_id,cue_at,state_summary}` | — | brain via same-origin `POST /api/brain/cues` w/ server `BRAIN_SERVICE_TOKEN` | blocks 8 machine cue types by name (`POST_CUE_BLOCKED_TYPES`, brain.ts:233-242); brain unreachable → `brain_unreachable`/`brain_timeout` (brain.ts:298-299), 5s timeout (brain.ts:198) |
| scribe_pin_visit | brain.ts:376-406 | **write** | room, phase, visit_id\|individual_uid | `{ok,cue_id,...,visit_table_touched:false}` | — | brain (cue only) | same brain-unreachable modes as post_cue |
| scribe_list_sessions | bench.ts:161-… | read | room, ist_date, status, limit≤200 | session+chunk rollups | none | app DB `bench_session`,`bench_chunk` | — |
| scribe_get_session | bench.ts:305-320 | read | session_id | session+chunks+backup_chunks+events+marks | none | `bench_session`,`bench_chunk`,`bench_event` | bad/missing id → named error, never 500 |
| scribe_get_recording | bench.ts:327-424 | read | session_id, mode (manifest\|timeline\|chunk\|zip), chunk_idx, source | **manifest mode returns presigned GET URLs (1h) for every chunk already** — this is the "download raw audio chunk" capability the operator wants, and it exists today | (mode itself is the control) | R2 (`signGetUrl`) | zip mode cannot be presigned (streamed by admin route, needs admin cookie) → pointer only, not bytes (bench.ts:349-357); presign failure degrades URL to `null`, never throws |
| scribe_start_recording | bench.ts:503-530 | **write** | room, override_pause | ack/ok + room/listener/active_session context | — | `bench_command`/`bench_listener` via `sendAndWait` | **needs a listening kiosk** (`kiosk_not_listening` if no poll within 10s, bench-commands.ts `LISTENER_FRESH_MS`); idempotent (`already_recording`); `room_paused` unless `override_pause` (audited); ack wait 8s, `ack_timeout` if kiosk slow to flush; bus down/not-migrated → named error, never a fake session row |
| scribe_pause_recording | bench.ts:555-559 (via `simpleVerb`) | **write** | room | ack/ok | — | same bus | needs listener; kiosk answers `not_recording` if nothing recording |
| scribe_resume_recording | bench.ts:560-564 | **write** | room | ack/ok | — | same bus | needs listener; `not_paused` if not paused |
| scribe_stop_recording | bench.ts:565-569 | **write** | room | ack/ok | — | same bus | needs listener; **"DOES NOTHING to a session whose kiosk is GONE"** — must fall back to `scribe_close_orphaned_session` |
| scribe_close_orphaned_session | bench.ts:575-601 | **write** | room | `{ok,session_id,ended_at,chunks_before,chunks_after,evidence}` | — | `bench_session` (server-side, no kiosk involved) | refuses by name (`kiosk_attached`) if a kiosk is actually polling and claims the session — cannot stop a live recording; this is the repair path for the "kiosk tab died, room deadlocked until 30-min reaper" bug (bench.ts:572-578 comment) |
| scribe_mark_consult | bench.ts:607-… | **write** | room, at, note | `{...,event_row,brain_status}` | — | `bench_event` then brain cue | durable-first: writes the event row even with **no active session** (`no_active_session`, never a blocking 409) |
| scribe_extract_audio | bench.ts:860-917 | **invoke** | room/session, start,end, source | single chunk → presigned clip + offsets; multi-chunk spanning → **joined single clip** via Cloudflare Containers join service, or degraded multi-piece list if join unavailable | — | R2 + `services/audio-join` (Cloudflare Containers) | refused by name over 30 min (`window_too_long`) or while **any** room is recording (`room_recording`) (bench.ts:862); join-service unreachable degrades to per-piece links, never an error page; U4 mic-lost logic can silently answer from backup mic |
| scribe_transcribe_range | bench.ts:1668-1799 | **invoke** | room/session, start,end, engine=whisper, language, dry_run(default true) | text for the resolved window + `turns[]` speech-turn cues (dry_run=true → not written) | dry_run:false to write | R2, Mini Whisper (`lib/whisper`), brain scratch graph | **this is the on-demand Whisper-on-arbitrary-range tool the operator wants — it already exists**, incl. join-then-transcribe for spanning windows; `no_audio_in_range`, `chunk_missing_in_r2`, `clip_download_failed`; single-chunk branch transcribes the WHOLE chunk (text ≠ just the window; trimming "is v1.1" per bench.ts:1797) |
| scribe_list_commands | bench.ts:1806-1848 | read | room, status, limit≤200 | bus queue rows | none | `bench_command` | — |
| scribe_day_report | bench.ts:1990-2047 | read | room, ist_date | sessions[] with `tape_ended_at` (chunk clock, not stored `ended_at`), per-mic counts, gaps, consult marks, mic story, remount events | **none — no include_* at all; always full detail, no summary mode** | `bench_session/_chunk/_event` | no labels/notes (identity risk avoided) |
| scribe_diff_room | bench.ts:2283-… | read | room (optional; sweeps all enabled rooms if omitted) | **enormous** — listener/recording/last-cue/last-piece + room_state + a dozen "live monitor" fields (paused_listener, paused_session, stranded_audio, ended_disagrees, warehouse_silent_ms, transcript/visit lanes, …) | **none** | listener bus, `bench_session`, brain cues, `lib/room-facts` shared module | the single **densest, noisiest** tool in the surface — its own description string is ~2,400 words; no way to ask for just the room_state summary without the whole live-monitor payload — direct evidence for "poor output / needs include_* flags" complaint, except here there ISN'T one |
| scribe_replay_session | bench.ts:2568-2637 | read (dry-run only) | session_id, limit≤1000 | ordered cue list the session *would* have produced live; **writes nothing, ever** (not a flag — no write path exists in this tool) | — | `bench_event` | event read capped at 2000 rows, named if hit |
| scribe_replay_write | bench.ts:2670-2793 | **write** | session_id, limit≤500 | write counts into a **scratch** graph only | — | brain (via `postBrainCue`, scratch room/day) | refuses non-`ended` sessions (`session_not_ended`); 45s internal time-budget + max-3-consecutive-failure circuit breaker, reports `stopped_early`; idempotent on (session_id,type,at) |
| scribe_fuse_run | fuse.ts:115-192 | **write** | room_day_id (must be scratch), arm(rules\|hybrid\|flash), dry_run(default true) | draft visits (dry) or written counts | — | brain `visit` (scratch only) | refuses any non-scratch day by name before reading anything; hybrid/flash arms fail closed if the answering LLM provider isn't `gemini:*` |
| scribe_set_visit_clinician | fuse.ts:205-300 | **write** | visit_id, clinician_id, expected_updated_at | before/after clinician attribution | — | brain `visit`, `audit_log` | optimistic concurrency — stale write **loses** (named `stale_write`), never silently overwrites; post-close changes audited |
| scribe_list_encounters | encounters.ts:21-74 | read | bucket, window, doctor_id, note_type, limit/offset, include_identity | status/timings/pipeline flags only | include_identity | app DB via `lib/encounter/admin` | — |
| scribe_get_encounter | encounters.ts:76-158 | read | encounter_id, include_identity, include_text | pipeline/pointer bundle, audio as R2 key only (never presigned here) | include_identity, include_text | same | — |
| scribe_list_traces | encounters.ts:160-190 | read | surface, status, window, limit/offset | id/status/timing/error, no prompt text | — | `llm_traces` | — |
| scribe_get_trace | encounters.ts:192-223 | read | trace_id, include_prompts, include_identity | events/timings; `has_request_input`/`has_result_summary` booleans only by default | include_prompts, include_identity | `llm_traces` | — |
| scribe_fuse_report | fuse-report.ts:87-… | read | room_day_id, arm, include_identity | marks-vs-warehouse-vs-visits-vs-tape scoreboard, silence gaps, turn/tape rollups | include_identity | brain + bench (cross-source, scratch-aware via `realRoomIdFor`) | this is the richest analytic tool; no size cap visible on `silence`/`incomplete` lists for a very long day |
| scribe_store_stats | stores.ts:66-124 | read | none | per-table counts (bench sessions/chunks, encounters, STT engines, brain cues/room-days split live vs scratch) | — | app DB + brain pool | each count is its own fail-safe query — a broken table nulls its own field + `degraded`, never fails the whole tool |
| scribe_kb_probe | stores.ts:126-168 | read | q, topK≤10, include_text | `{ok,embed_ms,query_ms,hit_count}` only | include_text | KB Neon pgvector via `lib/kb-retrieve` | never logs query text (only `q_len` in audit) |
| scribe_list_stt_engines | stt.ts:66-80 | read | none | engine registry rows | — | `stt_engine` | — |
| scribe_stt_health | stt.ts:82-92 | read | none | per-engine adapter health probe | — | STT adapters (Deepgram/Sarvam/Whisper/IndicConformer/ElevenLabs/EkaScribe) | virtual engines auto-ok; adapter throw → per-engine `{ok:false,error}` |
| scribe_stt_routing | stt.ts:94-106 | read | none | stage×language→engine matrix | — | `stt_routing`,`stt_engine` | — |
| scribe_list_stt_runs | stt.ts:108-159 | read | limit≤200, include_identity | per-subject (encounter OR bench_window) batch-run rollup | include_identity | `transcription_run`,`encounter`,`bench_window` | — |
| scribe_get_stt_run | stt.ts:161-232 | read | subject_id (or encounter_id alias), include_text, include_identity | per-engine scores; transcript char-counts only by default | include_text, include_identity | same + `stt_gold` | — |
| scribe_voice_health | voice.ts:28-34 | read | none | Pyannote/ECAPA Mini probe | — | Mini `DIARIZE_BASE_URL/health` | 5s timeout, soft-fail |
| scribe_list_voiceprints | voice.ts:36-63 | read | none | clinician/voiceprint rollup, no embeddings | — | `voice_print`,`clinician` | — |
| scribe_list_voice_samples | voice.ts:65-111 | read | clinician_id, include_urls | sample metadata | include_urls (presigned 1h) | `voice_sample`/R2 | — |
| scribe_get_clusters | voice.ts:115-152 | read | room, ist_date | speaker clusters, no vectors | — | brain pool `speaker_cluster` | table "usually empty — nothing writes it yet" (voice.ts:13 comment) — dead read surface today |
| scribe_llm_health | llm.ts:145-169 | read | none | per-surface `{provider (verbatim gemini:<model>\|ollama\|none), ok, latency_ms}` + `warning:"silent_fallback"` | — | `routedChat()` live probe (Gemini/Ollama), not a stored table | 10s hard cap per surface, sequential (6 surfaces ≈ worst-case ~1 min); **this is a health probe only — there is no general-purpose "ask the LLM tunnel anything" tool** (gap, see §5d) |

## 3. Remote control path (S2)

Chain for `scribe_start/pause/resume/stop_recording`:
1. Resolve room by id/slug/free-text name (`brain.ts:resolveRoom`); ambiguous free-text
   name → `AmbiguousRoomError` listing every match (bench.ts:446-448).
2. Read `bench_listener` for that room (`getListener`, imported from
   `lib/bench-commands`) — a kiosk tab polls this row; **"a listener" means a poll within
   `LISTENER_FRESH_MS`** (bench.ts:453-462, imported constant, not redefined here).
3. `start` additionally reads `findActiveSession` and runs `decideStart` (idempotency +
   consent-pause logic) before ever touching the bus (bench.ts:517-525).
4. `INSERT bench_command` (`insertCommand`, source:"mcp") then `waitForAck` up to
   `ACK_WAIT_MS` (8 s) for the kiosk to poll it and write back a result row
   (`sendAndWait`, bench.ts:470-501). This is **polling by the kiosk, not a websocket** —
   the kiosk's own poll interval is the latency floor (1-2 s per the PRD, §8 line 245,
   269).
5. If no ack in 8 s: distinguishes "never delivered" (`kiosk_not_listening`) from
   "delivered but slow" (`ack_timeout`, e.g. `end_day` still flushing) by checking whether
   the listener polled again after the insert (bench.ts:476-490) — a genuinely useful
   distinction, not just a timeout.
6. **Idempotency**: `start` on an already-recording room returns
   `{already_recording:true, session_id}` rather than a second tape (bench.ts:523).
7. **override_pause**: `start` on a consent-paused room is refused (`room_paused`) unless
   `override_pause:true`, which is passed through and audited (bench.ts:509,519,525).
8. **Kiosk asleep / gone entirely**: every simple verb (`pause`/`resume`/`stop`) refuses
   up front with `kiosk_not_listening` if the bus reports no fresh poll (bench.ts:546) —
   no command row is ever written to a dark room. If the kiosk *was* alive and then its
   tab died mid-session, `stop` is a permanent no-op (the kiosk owns ending its own
   session) and the room deadlocks until either the 30-minute reaper fires or an operator
   calls `scribe_close_orphaned_session`, which is a distinct server-side repair path that
   itself refuses if a kiosk is still attached (`kiosk_attached`, bench.ts:591-593).

There is no websocket and no push from server→kiosk beyond the polled command row; the
"listener table" (`bench_listener`) plus its `last_poll_at` freshness window is the entire
liveness signal.

## 4. Docs vs code

PRD (`docs/operator-mcp/EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md`, 19 Aug, rev 3e) names these
tools that are **NOT implemented** anywhere in `lib/mcp/tools/*.ts` (confirmed by grep for
`name: "scribe_`):
- `scribe_watch_rooms` — the PRD's multi-room snapshot + **push notification** mechanism
  ("Notice without being asked", PRD §goal 6, lines 354/365/379/431). No push/webhook/
  polling-routine code exists in `lib/mcp/*` at all — this is a **total gap**, not a
  partial one: the connector cannot proactively surface a stalled tape, a down Pyannote,
  or a listener drop; an operator must think to call `scribe_diff_room` or `scribe_health`.
- `scribe_explain_state` — "evidence trail for the current picture" (PRD line 361, 435).
  Not implemented; `scribe_fuse_report` and `scribe_list_cues` are the closest substitutes
  but neither is framed as "why does the brain think this".
- `scribe_get_visit` — cross-room, cross-day patient thread by `individual_uid` (PRD line
  360, 437). Not implemented.
- `scribe_run_stt_fanout` — run multiple STT engines against a Bench chunk/extract (PRD
  line 201, 443). Not implemented; `scribe_list_stt_runs`/`scribe_get_stt_run` only read
  fanout results that already exist from the encounter-side lab, not from Bench audio.
- `scribe_compare_voice`, `scribe_diarize_clip` (PRD line 449). Not implemented.

Implemented tools **not** in this PRD (added later — the in-file comments attribute them
to a separate, unread "ETA-MCP-UPGRADE PRD" and "Fuse slice" documents referenced only in
code, e.g. bench.ts:31-79's "U1"–"U4" headers):
`scribe_llm_health`, `scribe_fuse_run`, `scribe_fuse_report`, `scribe_set_visit_clinician`,
`scribe_replay_write`, `scribe_close_orphaned_session`. `scribe_diff_room`'s "live monitor"
fields (paused/stranded/ended_disagrees/warehouse_silent_ms/lanes) are also additions on
top of the PRD's original, much smaller `scribe_diff_room` description (compare PRD line
355's one-sentence description to the ~2,400-word description actually in code).

`SCRIBE-MCP-STACK-INVENTORY-19-AUG-2026.md` was staged but not deep-read in this pass
(budget); it documents the stack **as of `b907bc50`**, i.e. before any of S2/S3/U1-U4/Fuse
slices existed, so it is stale relative to current code by construction and should be
treated as historical, not authoritative, by the redesign.

## 5. Capability gaps vs the operator's wants

| # | Want | Status | Evidence |
|---|---|---|---|
| a | Chunk download / signed URL | **Exists today.** | `scribe_get_recording` mode=`chunk` or `manifest` returns presigned R2 GET URLs (1 h) per chunk, both primary and backup mic streams (bench.ts:355-424). |
| b | Stitch | **Exists today**, but only as a side-effect of (c) below — there is no standalone "just stitch and hand me the file" tool; stitching only happens inside `scribe_extract_audio`/`scribe_transcribe_range` when a requested window spans >1 chunk, via the Cloudflare Containers `services/audio-join` service (bench.ts:876-912, `lib/bench-join`). Refused over 30 min or while any room is recording; degrades to per-piece links if the join service is down. |
| c | On-demand Whisper/tunnel transcribe of an arbitrary range | **Exists today.** `scribe_transcribe_range` (bench.ts:1668-1799) — arbitrary clock window → resolves chunks → joins if needed → Whisper → text + speech-turn cues, `dry_run` gate before any write. |
| d | Full use of the LLM tunnel endpoints | **Partial/gap.** Only `scribe_llm_health` exists, and it is a **read-only probe** ("fires ONE trivial one-word probe per surface", llm.ts:4-23) — it tells you which provider (gemini/ollama) is answering each of 6 fixed surfaces, but there is no tool to send an arbitrary prompt to the Gemini/Ollama tunnel for ad-hoc use. `lib/llm/gemini.ts`'s `routedChat` is called only in this probe form. |
| e | Fleet/release control (publish channel, rollback, adopt install) | **Gap by design — explicit non-goal.** PRD §4 non-goals: "Hosting the MCP on a third-party box we do not already trust", "Reset PIN, create admin, rotate JWT secrets, run migrations from an assistant" (PRD lines 117,120); §1a forbids shipping a `RoomRecorderClient` command-poll or running a prod migration from this door at all. No route or tool for kiosk build/version fleet management was found anywhere in `lib/mcp/*`. |
| f | Audio-content inspection (levels, silence, clipping) | **Partial.** `scribe_fuse_report`'s `silence` field reports warehouse-event gaps (not audio silence) computed from the cue timeline, never from the waveform (fuse-report.ts:10-13,90). `lib/bench-levels.ts` (`parseMicLevelPair`, imported at bench.ts:82) exists and is read by `scribe_diff_room`'s mic-story fields, but that is mic-connected/level-pair status, not clipping/RMS/loudness analysis of the audio content itself. No tool computes silence/clipping from the actual PCM. |
| g | Config/mic change on a room | **Gap.** No tool in `lib/mcp/tools/*` writes room config (mic assignment, room enable/disable, kiosk config). `scribe_list_rooms` is read-only; room `enabled` is read via `disabled_at IS NULL` (brain.ts:59) but nothing sets it. |

## 6. Output quality — default vs behind-flag (four sampled tools)

- **scribe_get_session** (bench.ts:305-320): default already returns the full session +
  chunk list (r2 keys, times, upload_state, gaps) + backup chunks + events + marks — **no
  include_* flags at all on this tool**; it's a "give me everything about this session"
  tool by design and that's appropriate for its scope (one session).
- **scribe_get_encounter** (encounters.ts:76-158): default is a genuinely thin summary
  (status/timings/pipeline booleans, audio as an R2 **key only**, transcript **char
  counts only**, no patient label, no doctor name/email). `include_identity` adds
  patient_label_raw + doctor identity; `include_text` adds every transcript/note/cdmss/
  native-analysis/diarization text field. This is the model the PRD's privacy section
  (§16) intends and it's applied consistently.
- **scribe_day_report** (bench.ts:1990-2047): **no include_* flags** — always returns
  every session's full per-mic chunk counts, coverage gaps, consult marks, mic events and
  remount events for the day. For a busy multi-session day this is already a large,
  non-trimmable payload; there is no "just the summary" mode.
- **scribe_system_map** (health.ts:148-184): default is the full composite health
  picture (all DB/service probes) + flag states + env-set booleans + store/route
  topology — again no flags to slim it down, though its constituent parts
  (`composeHealth`) are already individually fail-safe so a broken sub-probe doesn't
  balloon the response with a stack trace.

**Pattern**: `include_*` flags are used consistently and well where the payload could
carry **patient identity or free text** (encounters, traces, cues, stt runs, voice
samples, kb hits) — that's a real privacy-by-default design, not an accident. But the two
tools that are actually *big by volume* rather than sensitive (`scribe_day_report`,
`scribe_diff_room`, `scribe_system_map`) have **no volume-control flag at all** — that is
the concrete root of the "thin/noisy, needs include_* flags" complaint: the flags that
exist are the wrong axis (privacy) for the tools that are actually noisy (verbosity).

## 7. Five worst structural problems (for the redesign)

1. **`scribe_diff_room`'s description string alone is ~2,400 words** and its default
   payload has no summary mode (bench.ts:2284-2286) — every call pays for the full
   live-monitor field set (paused/stranded/lanes/ended_disagrees/warehouse_silent_ms/…)
   whether the caller wants one boolean or the whole picture. This is the single biggest
   concrete instance of "poor output, needs include_* flags" — and it's the one tool that
   conspicuously lacks any.
2. **Remote control latency floor is the kiosk's own poll interval + an 8 s ack wait**
   (`ACK_WAIT_MS`, bench.ts:474) with no faster path — `scribe_start_recording` et al.
   cannot be made to feel instant without changing the kiosk's poll cadence, which is
   explicitly out of scope for a quick MCP fix (this is a genuine architectural ceiling,
   not a code defect).
3. **One shared token, one principal, all scopes** (`auth.ts:36-37`) — every MCP client
   (this connector included) is indistinguishable in the audit log
   (`actor_id='mcp:operator-v1'` always) and there is no way to grant a
   read-only caller without also granting `write`/`invoke`. The scope check machinery
   exists (`handler.ts:214-217`) but is currently vestigial since one token carries every
   scope.
4. **A hung tool eats its entire timeout budget silently** — `failSafe`/`callTool`
   guarantee a *shape*, but not *speed*: a tool whose downstream fetch hangs (Mini
   Whisper, Pyannote, the join service) blocks for up to 115 s (invoke scope) before the
   race timeout fires (`handler.ts:224-229`), and the caller has no visibility into partial
   progress meanwhile. Combined with Vercel's 300 s route ceiling (`route.ts:20`), this is
   the direct cause of "unreliable/slow" reports for cross-mic-join or Whisper-heavy calls.
5. **Fleet/kiosk-config control is a hard non-goal, not a missing feature** — the PRD
   explicitly forbids reaching outside this Vercel app's own DB/R2/brain/STT-lab surface
   (§4 non-goals: no third-party hosting, no migrations, no PIN/JWT changes from an
   assistant). If the operator wants publish-channel/rollback/adopt-install control, that
   is a new product decision requiring a new lock, not a bug in the current tool set — the
   redesign needs to flag this as a scope question for the designer, not silently add a
   tool for it.

## Notes on scope not covered (per instructions)

`apps/room-recorder/**` and `lib/stt/**` were not read in depth. The join service
(`services/audio-join`, Cloudflare Containers) and `lib/bench-join`/`lib/bench-source`
were read only through their call sites in `bench.ts`, not their own source — sufficient
to confirm behavior (30-min refusal, recording-guard, mic-lost fallback) but not to audit
their own reliability.
