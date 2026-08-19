# Even Scribe — Operator MCP stack inventory
## Evidence map of every real interface (no invented APIs)

| | |
|---|---|
| Status | Design inventory for the Operator MCP PRD |
| Date | 19 August 2026 (IST) |
| Repo | https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant (public) |
| HEAD | `b907bc50` — Kickoff D timeline.md (pushed 18 Aug 2026 14:21 IST / 08:51 UTC) |
| Method | GitHub raw + API only. No clone. No PRs. No implementation. |
| Scope | What exists in `main` today, with file path + what it does. |

This is the **interface map** the Operator MCP must wrap. It is not a PRD and it does not invent routes. Local design docs under `/workspace` were used only as cross-check; every route, table, env name, and Mini path below is cited from repo source.

---

## 0. Topology (what is actually deployed)

```
Doctor PWA  /{slug}          ── live STT + enroll/identify ──► Vercel app
Room Bench  /room/{slug}     ── 5-min WebM tape + mark     ──► Vercel app
Admin       /admin/*         ── cookie eta_admin_session   ──► Vercel app
Brain       /api/brain/*     ── Bearer BRAIN_SERVICE_TOKEN ──► same Vercel app
                                                              (Cloud Run skeleton in brain/ is NOT the live host)
Mini tunnels *.llmvinayminihome.uk
  whisper.cpp     WHISPER_BASE_URL          POST /inference
  pyannote+ECAPA  DIARIZE_BASE_URL          GET /health, POST /diarize, POST /enroll
  IndicConformer  INDICCONFORMER_BASE_URL   GET /healthz, POST /inference
  Ollama          OLLAMA_BASE_URL           /v1 OpenAI-compat
  Sarvam WS relay NEXT_PUBLIC_STT_RELAY_URL (client-visible)
Cloud STT
  Deepgram        DEEPGRAM_API_KEY          live WS (browser) + REST (lab/submit)
  Sarvam          SARVAM_API_KEY            REST windows + batch (lab/note)
  ElevenLabs      ELEVENLABS_API_KEY        lab REST
  EkaScribe       EKACARE_*                 lab, DISABLED (0026)
Stores
  App Neon        DATABASE_URL / APP_DATABASE_URL     HTTP neon()
  Brain role      BRAIN_DATABASE_URL                  WS Pool (same Neon, own role)
  KB Neon         KB_DATABASE_URL                     read-only pgvector
  R2              R2_BUCKET (eta-audio)
```

Live host: `https://www.evenscribe.app` (homepage field on the repo still says the old Vercel preview URL).

**Not present in the repo:** Redis, `/api/mcp`, `GET /api/brain/rooms/:id/cues`, a replay runner, a warehouse watcher, a fuse, Cloud Run IAM for the brain (A2 re-homed to Vercel after that blocked).

---

## 1. Speech-to-text providers

Registry: `lib/stt/registry.ts` maps `adapter_key` → code. Rows live in `stt_engine` (migration `db/migrations/0018_stt_engine.sql` plus later seeds). Lab health probes every adapter: `GET /api/admin/stt-lab/health` (`app/api/admin/stt-lab/health/route.ts`).

### 1.1 Engines that exist in code

| Engine id (`stt_engine.id`) | Adapter | How invoked | Live vs async | Env | Where it actually runs |
|---|---|---|---|---|---|
| `deepgram` | `lib/stt/adapters/deepgram.ts` → `lib/transcribe.ts` | **PWA live:** browser opens Deepgram WS with a minted temp key. **Lab/note:** REST via adapter. | Live WS + sync REST. `streaming:true`, `async:false` | `DEEPGRAM_API_KEY`, `DEEPGRAM_PROJECT_ID` | Cloud Deepgram. Token mint is Vercel. |
| `whisper` | `lib/stt/adapters/whisper.ts` → `lib/whisper.ts` | **PWA live:** rolling deltas → R2 buffer → Mini. **Lab/note:** same Mini `/inference`. | Rolling REST, not streaming. `streaming:false` | `WHISPER_BASE_URL` | **Mac Mini** whisper.cpp (`POST {WHISPER_BASE_URL}/inference`). |
| `sarvam` | `lib/stt/adapters/sarvam.ts` → `lib/sarvam.ts` | **PWA live:** sequential ≤30s windows via Vercel proxy. **Lab/note long-form:** Sarvam **batch** job (`sarvamBatchTranslate`, `maxWaitMs` 150s). Optional Mini WS relay. | Live = sync REST windows. Note = batch. `streaming:true` in capabilities (relay). | `SARVAM_API_KEY`, `SARVAM_STT_MODEL` (default `saaras:v3`), `NEXT_PUBLIC_STT_RELAY_URL`, `STT_RELAY_URL`, `STT_RELAY_SECRET` | Cloud Sarvam. Relay (if used) is **Mini**. |
| `indicconformer` | `lib/stt/adapters/indicconformer.ts` | **PWA live box:** `POST /{slug}/api/transcribe/indic-live` (needs explicit IN-22 language from Sarvam). **Lab:** adapter; skips non-Indic (`skipped_non_indic`). | Sync REST. Seeded `stages:["note"]` in 0027; live box exists anyway. | `INDICCONFORMER_BASE_URL` (default `https://indic.llmvinayminihome.uk`), `INDICCONFORMER_DECODING` (`rnnt`\|`ctc`) | **Mac Mini** `POST {base}/inference`, health `GET {base}/healthz`. |
| `indicconformer_scribe` | `lib/stt/adapters/indicconformer-scribe.ts` | Lab scribe-tier only (Indic ASR → Even note-gen). | Sync, note stage | same as above | Mini ASR + Mini/Vertex note LLM |
| `elevenlabs` | `lib/stt/adapters/elevenlabs.ts` | Lab REST `https://api.elevenlabs.io/v1/speech-to-text`. Seeded **disabled** in 0018. | Sync REST. Capabilities claim `streaming:true` but the adapter is REST-only. | `ELEVENLABS_API_KEY`, `ELEVENLABS_STT_MODEL` (default `scribe_v2`) | Cloud ElevenLabs |
| `elevenlabs_scribe` | `lib/stt/adapters/elevenlabs-scribe.ts` | Lab composite: ElevenLabs ASR → Even note LLM. Seeded **enabled** in 0026. | Sync, note stage | `ELEVENLABS_API_KEY` | Cloud + Mini/Vertex |
| `ekascribe` | `lib/stt/adapters/ekascribe.ts` | Lab only. **Disabled** (`enabled=false`, `fanout_enabled=false`) by `db/migrations/0026_elevenlabs_scribe.sql`. Adapter kept. | `async:true` (only async engine) | `EKACARE_CLIENT_ID`, `EKACARE_CLIENT_SECRET`, `EKASCRIBE_MODEL`, `EKASCRIBE_SCRIBE_TEMPLATE`, `EKASCRIBE_SCRIBE_COMPANION_TEMPLATE` | eka.care cloud |
| `even_pipeline` | **virtual** — no adapter | Lab scribe row filled from `encounter.note_json`. Health short-circuits `ok:true`. | n/a | none | In-process / existing encounter |

Fanout-on flags from seeds (may have been flipped in prod via Engines tab): Deepgram / Whisper / Sarvam / even_pipeline / elevenlabs_scribe ON; IndicConformer pair seeded `fanout_enabled=false` (0027); ElevenLabs ASR seeded off; EkaScribe forced off (0026). **Do not treat seed as live routing** — read `GET /api/admin/stt-lab/engines`.

### 1.2 Doctor PWA live path (this is the phone product)

Auth: doctor JWT cookie (`eta_session`, Path=`/{slug}`). Slug must match claims.

| Route | File | What it does |
|---|---|---|
| `POST /{slug}/api/transcribe/deepgram-token` | `app/[slug]/api/transcribe/deepgram-token/route.ts` | Mints a 10-min Deepgram temp key (`lib/deepgram-token.ts`). Body `{ encounter_id? }`. Returns `{ key, expires_at, ttl_seconds }`. Browser then talks to Deepgram **directly**. |
| `POST /{slug}/api/transcribe/sarvam-live` | `app/[slug]/api/transcribe/sarvam-live/route.ts` | Multipart `audio` + `block_idx`. Sarvam code-mix window (≤~25s). Returns `{ text, language_code, latency_ms, error }`. Soft-fail. |
| `POST /{slug}/api/transcribe/whisper-chunk` | `app/[slug]/api/transcribe/whisper-chunk/route.ts` | Multipart **delta** + `encounter_id` (must start `enc_`). Appends to R2 `whisper-buffer/{encounter_id}.webm`, then Mini Whisper `/inference`. Caps 60 MB. |
| `POST /{slug}/api/transcribe/indic-live` | `app/[slug]/api/transcribe/indic-live/route.ts` | Multipart `audio` + `language` (Sarvam-locked IN-22). IndicConformer native-script box. |
| `POST /{slug}/api/transcribe/cleanup` | `app/[slug]/api/transcribe/cleanup/route.ts` | Live utterance cleanup (LLM). Not an STT engine. |
| `POST /{slug}/api/translate-live` | `app/[slug]/api/translate-live/route.ts` | Gemini Flash live English toggle (`NEXT_PUBLIC_ETA_LIVE_FLASH`). |

Client hooks (not HTTP, but they are the live ear):

| Hook | File | Engine |
|---|---|---|
| `use-deepgram-live` | `lib/use-deepgram-live.ts` | Deepgram WS (flag `NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT`) |
| `use-sarvam-rolling` / `use-sarvam-streaming` | `lib/use-sarvam-rolling.ts`, `lib/use-sarvam-streaming.ts` | Sarvam REST windows / Mini relay |
| `use-whisper-rolling` | `lib/use-whisper-rolling.ts` | Whisper deltas |
| `use-indic-rolling` | `lib/use-indic-rolling.ts` | IndicConformer live box (`NEXT_PUBLIC_ETA_INDIC_LIVE_BOX`, default ON) |
| `use-language-router` | `lib/use-language-router.ts` | Display router: EN→Deepgram, Indic→Sarvam+Indic (`NEXT_PUBLIC_ETA_LANG_ROUTER`, default ON) |

Submit-time note path (not live): `POST /{slug}/api/encounters/[id]/process` runs the encounter pipeline (Whisper refine, Sarvam batch translate+diarization, Mini `/diarize`, note LLM). Fanout is a **separate** admin/cron path.

### 1.3 Room Bench tape path

**No STT on the day path.** Kickoff B live sink (`NEXT_PUBLIC_ETA_LIVE_SINK`, default **OFF**) cuts 250 ms slices in-memory and posts **counters only** (`type: live_sink_stats`). Comment in `lib/use-live-sink.ts`: "NO STT, NO embeddings, NO Mini, NO raw audio leaves the browser."

Tape is 5-min self-contained WebM → R2. Replay runner that would emit `stt_turn` cues is **design only** (`SCRIBE-BRAIN-READJUST-AFTER-B-18-AUG-2026.md`); **not in the repo**.

### 1.4 STT Lab path (admin cookie or `MIGRATION_SECRET`)

| Route | Methods | File | What it does |
|---|---|---|---|
| `/api/admin/stt-lab/engines` | GET, PATCH | `app/api/admin/stt-lab/engines/route.ts` | List / toggle `enabled`, `fanout_enabled`, cost |
| `/api/admin/stt-lab/health` | GET | `…/health/route.ts` | Probe every adapter (virtual engines skip) |
| `/api/admin/stt-lab/routing` | GET, PUT | `…/routing/route.ts` | Matrix `stage ∈ {live,note}` × `language_bucket ∈ {english,indic}` → `engine_id` (`stt_routing`) |
| `/api/admin/stt-lab/run-fanout` | POST | `…/run-fanout/route.ts` | Drain `stt_fanout_job`. Body flags: `limit`, `backfill`, `status`, `reset`, `score`, `rescore`, `dedup`, `scribe`, `missing`, `translate`, `translateStatus`, `encounterId`. Auth: admin cookie **or** `Authorization: Bearer $MIGRATION_SECRET`. **Encounter-shaped only** — no Bench chunk target. |
| `/api/admin/stt-lab/runs` | GET | `…/runs/route.ts` | Encounters that have batch ASR `transcription_run` rows |
| `/api/admin/stt-lab/runs/[id]` | GET | `…/runs/[id]/route.ts` | One encounter's per-engine runs |
| `/api/admin/stt-lab/gold` | GET | `…/gold/route.ts` | Gold set + candidates + per-engine WER |
| `/api/admin/stt-lab/gold/[id]` | GET/PUT (exists) | `…/gold/[id]/route.ts` | One gold label |
| `/api/admin/stt-lab/leaderboard` | GET `?lang=&since=&tier=` | `…/leaderboard/route.ts` | Composite leaderboard |

UI: `/admin/stt-lab` (`app/admin/stt-lab/page.tsx`, `components/admin/SttLabClient.tsx`).

### 1.5 What `/api/health` actually probes for STT

`GET /api/health` (`app/api/health/route.ts`) probes: App DB, KB DB, Ollama, **Whisper**, Resend, R2. It does **not** probe Deepgram, Sarvam, IndicConformer, ElevenLabs, EkaScribe, or Pyannote. Those are only on STT-lab health (admin cookie).

---

## 2. Pyannote / diarization / embeddings / centroids

### 2.1 Where it runs

**Mac Mini only.** FastAPI at `DIARIZE_BASE_URL` (documented public host `https://diarize.llmvinayminihome.uk` → `localhost:8001`). Not Vercel. Not Cloud Run. Not in-process.

Evidence:

- Client: `lib/diarize.ts` — `POST {DIARIZE_BASE_URL}/diarize` (timeout `DIARIZE_TIMEOUT_MS`, default 90000). Soft-fail.
- Enroll: `lib/enroll.ts` — `POST {DIARIZE_BASE_URL}/enroll` (60s). Returns `{ ok, embedding_base64 }` 192-dim ECAPA.
- Handover: `docs/ETA-DIARIZE-SERVICE-HANDOVER.md` — pyannote.audio 3.3.2 + `speaker-diarization-3.1` + OSD `segmentation-3.0` + SpeechBrain ECAPA `spkrec-ecapa-voxceleb`. Stateless. No DB on the Mini. HF token stays on the Mini.

`GET /api/health` does **not** probe this URL. There is no first-class "pyannote health" route on Vercel.

### 2.2 Mini contract (from handover + Vercel clients)

| Mini route | Called by | Returns |
|---|---|---|
| `GET /health` | nothing in the Vercel app | `{ ok, device, models: ["pyannote-3.1","ecapa-voxceleb"] }` |
| `POST /diarize` multipart | `runDiarize()` from submit `/process` | speakers (idx, label, type clinician\|patient\|attender\|nurse\|other, optional `clinician_id`/`confidence`/`embedding_base64`), `transcript_segments` (timing only, **no text**), `overlap_windows`, `aggregates`, `latency_ms`, `model_versions` |
| `POST /enroll` multipart | `runEnroll()` from doctor/admin enroll + live identify | `{ ok, embedding_base64, dim }` |

`/diarize` request fields Vercel actually sends: `audio`, `encounter_id`, `clinician_centroids` (JSON array of `{clinician_id, full_name, centroid_base64}`), `manual_relabels`, optional `batch_threshold`. Mini default batch threshold **0.70**. Live identify threshold on Vercel is **0.78** (hardcoded in `app/[slug]/api/voice/identify/route.ts`). Passive include gate `PASSIVE_VOICEPRINT_GATE` default **0.82**. Far-field probe (`ETA-FARFIELD-PROBE-EVIDENCE-17-AUG-2026.md`) showed 0.55–0.62 vs the phone centroid — those phone thresholds are **wrong for the room**.

### 2.3 Vercel voice / diarize routes

Doctor-cookie (`/{slug}`):

| Route | File | What it does |
|---|---|---|
| `POST /{slug}/api/voice/enroll` | `app/[slug]/api/voice/enroll/route.ts` | Multipart `clip_*`. Mini `/enroll` each clip, R2 `voice-samples/{clinicianId}/{id}.{ext}`, insert `voice_sample`, recompute `voice_print` centroid. Needs ≥3 embeddings. |
| `POST /{slug}/api/voice/identify` | `app/[slug]/api/voice/identify/route.ts` | Window → Mini `/enroll` → cosine vs stored centroid. `{ enrolled, name, confidence, identified }` at 0.78. Binary you-vs-not. |
| `POST /{slug}/api/voice/stt-token` | `app/[slug]/api/voice/stt-token/route.ts` | Exists (onboarding STT token). |
| `POST /{slug}/api/voice/transcribe-window` | `app/[slug]/api/voice/transcribe-window/route.ts` | Window STT for enroll wizard. Also `app/api/voice/transcribe-window/route.ts` (unslugged twin). |

Admin-cookie:

| Route | File |
|---|---|
| `POST /api/admin/doctors/[id]/voice-enroll` | admin enroll |
| `POST /api/admin/doctors/[id]/voice-retrain` | recompute centroid from stored samples (no Mini if embeddings exist) |
| `GET /api/admin/doctors/[id]/voice-samples` | list samples |
| `GET /api/admin/doctors/[id]/voice-samples/[sampleId]/audio` | presigned sample audio |
| `GET /api/admin/doctors/[id]/voice-samples/[sampleId]/embedding` | embedding floats |
| `DELETE /api/admin/doctors/[id]/voice-samples/[sampleId]` | drop sample |
| `GET /api/admin/doctors/[id]/voiceprint/embedding` | centroid download |
| `GET/POST /api/admin/diarization-eer` | EER harness over `encounter.speakers` + `identification_label` |

UI: `/admin/diarization`, `/admin/doctors/[id]/voice`.

### 2.4 Brain clusters vs doctor prints

| Store | Table | Dim | Lifetime |
|---|---|---|---|
| Doctor print | `voice_print.centroid` bytea + `voice_sample.embedding` | 192 float32 (768 bytes) | Permanent, clinician-scoped |
| Same-day slot | `speaker_cluster.centroid` bytea, `kind` `doctor`\|`other` | same 192 | Dies at IST day rollover (schema comment). **Nothing in the repo writes this table yet.** `GET /state` only reads it. |

One centroid family (ECAPA 192). Designer lock: do not run a second Pyannote-embed production stack (`SCRIBE-BRAIN-IDENTITY-PYANNOTE-18-AUG-2026.md`). Mini `/diarize` is **async / submit-time** (doctor encounter). Forbidden on the live 250 ms Bench path.

---

## 3. Databases and object stores

### 3.1 App Neon — `DATABASE_URL` / `APP_DATABASE_URL` / `APP_DATABASE_URL_UNPOOLED`

Driver: HTTP `neon()` in `lib/db.ts` / `lib/db-neon-http.ts`. Migrations through **0043** via `POST /api/run-migrations` (`MIGRATION_SECRET`).

`doctor` table was **dropped** (`db/migrations/0015_drop_doctor.sql`). Identity is `clinician`. `db/schema.ts` is stale on that point.

**Known tables (created or still referenced by migrations / SQL):**

| Table | Migration / file | What lives there |
|---|---|---|
| `schema_migrations` | 0001+ | version runner |
| `admin_user` | 0001 / `db/schema.ts` | admin accounts |
| `clinician` | 0010 | doctors / dietitians / physios. PIN, slug, status |
| `pin_attempt` | 0001 | doctor PIN audit (90d TTL comment) |
| `encounter` | 0001 + many ALTERs | doctor PWA consult: audio key, transcripts, note_json, diarize columns, `input_mode`/`editor_text` (0037) |
| `trace` | 0001 | per-stage forensic LLM rows (capture/transcribe/clean/critique/revise/cdmss/email) |
| `llm_traces` | 0002 | per-pipeline UX traces (admin `/admin/traces` reads **this** table) |
| `recipient_global` / `recipient_per_doctor` | 0001 | email CC lists |
| `send_event` | 0001 | Resend delivery |
| `audit_log` | 0001 | admin/doctor/system actions |
| `settings` | 0001 + 0005 | singleton + launch-readiness attestation cols |
| `transcription_run` | 0006 + 0019 | per-engine per-encounter STT/scribe runs |
| `identification_label` | 0008 | EER ground truth (`encounter_id`,`speaker_idx`,`is_correct`) |
| `voice_print` | 0007 | one ECAPA centroid per clinician |
| `voice_sample` | 0017 | enrollment + passive samples |
| `stt_engine` | 0018 | registry |
| `stt_fanout_job` | 0019 | one job per encounter |
| `stt_lab_config` | 0019 | singleton budget/concurrency |
| `stt_gold` | 0020 | gold transcripts |
| `stt_routing` | 0021 | live/note × english/indic |
| `nabh_requirements` | 0038 | NoteGen NABH floor (reference data) |
| `expansion_log` | 0039 | NoteGen shorthand expansions |
| `room` | 0041 | Bench rooms (not clinicians). slug, pin_hash, lockout, disabled_at |
| `bench_session` | 0041 | one recording day. status `recording`\|`paused`\|`ended`. ids `bs_…` |
| `bench_chunk` | 0041 | 5-min WebM rows. `r2_key`, `upload_state` pending\|verified\|gap |
| `bench_event` | 0043 | durable kiosk events. kind open set; this build writes **`consult_mark`**. `brain_status` `sent`\|`failed` |
| `room_day` | 0042 | brain day key `(room_id, ist_date)` ids `rd_…` |
| `visit` | 0042 | visit graph. state CHECK `called`\|`in_chair`\|`at_diagnostics`\|`ended`\|`unknown` |
| `speaker_cluster` | 0042 | same-day centroids |
| `cue` | 0042 | evidence log. `type` **OPEN SET**, no CHECK. `payload` jsonb nullable |

Brain tables are created by the **app** migration runner on this database. They are read/written at runtime through `BRAIN_DATABASE_URL` (own role, WS pool). `lib/bench-timeline.ts` is explicit: "Same Neon database, different role (decision B8) — the app role is not assumed to have grants on brain tables."

### 3.2 Brain role — `BRAIN_DATABASE_URL`

`lib/brain/db.ts`. WebSocket `Pool` (needed for `BEGIN` + `pg_advisory_xact_lock` + insert + read + `COMMIT`). Lazy: missing env → 503 `brain_db_not_configured`, app otherwise keeps working.

### 3.3 KB Neon — `KB_DATABASE_URL`

`lib/kb-db.ts`, `lib/kb-retrieve.ts`. Read-only. Table actually queried: **`mksap_chunks`** (pgvector `embedding <=>`). Shared CDMSS corpus. Probe: `GET /api/kb/probe?q=&topK=` gated by `ADMIN_TOKEN` bearer — this **does** return search hits (not just up/down). `GET /api/health` only `SELECT 1` on this URL.

### 3.4 R2 — bucket `R2_BUCKET` (example `eta-audio`)

`lib/r2.ts`. Prefixes the code actually builds:

| Prefix | Helper | What |
|---|---|---|
| `encounters/{encounterId}.{ext}` | `audioObjectKey` | doctor PWA recording |
| `whisper-buffer/{encounterId}.webm` | `whisperBufferKey` | ephemeral live Whisper concat (deleted on finalize) |
| `bench/{room_slug}/{YYYY-MM-DD}/{session_id}/chunk_{idx 5-pad}.webm` | `benchChunkKey` | **immutable** tape. Date segment is **UTC** of session start (`ymdUtc` in `lib/bench.ts`), not IST. |
| `voice-samples/{clinicianId}/{id}.{ext}` | `sampleAudioKey` | enrollment clips. Passive samples **reuse** the encounter key, they do not copy audio. |

No code path lists the bucket. Presign GET/PUT/HEAD only. Admin CORS fixer: `POST /api/admin/r2-cors-fix`. Day zip is assembled on the fly (`GET /api/bench/sessions/{id}/download`), not stored.

### 3.5 Other stores

| Store | Exists? |
|---|---|
| Redis | **No.** No client, no env, no table. |
| Local / browser | Kiosk IndexedDB `eta-bench` until HEAD-verify (Room Bench Phase A). Not remotely readable. |
| Cloud Run container state | None. Brain state is Neon. |
| Pulse / warehouse PG | **Not connected.** No watcher in repo. Join is a later replay step. |

What lives where (operator view):

| Object | Where |
|---|---|
| Doctor transcripts / notes | App Neon `encounter` + `transcription_run` |
| Doctor audio | R2 `encounters/` |
| Bench tape | R2 `bench/` + App Neon `bench_session` / `bench_chunk` |
| Consult marks | App Neon `bench_event` (durable) + brain `cue` (best-effort) |
| Brain graph | Neon `room_day` / `visit` / `speaker_cluster` / `cue` via brain role |
| Voiceprints | App Neon `voice_print` / `voice_sample` + R2 `voice-samples/` |
| STT lab | App Neon `stt_*` + `transcription_run` |
| LLM traces | App Neon `llm_traces` (dashboard) and `trace` (per-stage) |
| KB | KB Neon `mksap_chunks` |
| Timeline.md | **Not stored.** Generated on GET. |

---

## 4. Brain

Live host is **this Vercel app**, not Cloud Run. `brain/` remains a byte-identical future container (`brain/src/server.ts`, `brain/README-DEPLOY.md`). A2 commit `9b2715a` after Cloud Run IAM blocked.

### 4.1 Routes that exist

| Route | Auth | File | Behaviour |
|---|---|---|---|
| `POST /api/brain/cues` | `Authorization: Bearer $BRAIN_SERVICE_TOKEN` (constant-time SHA-256). Missing env → 503 `service_token_not_configured`. | `app/api/brain/cues/route.ts` | Body `{ room_id, type, at?, payload? }`. `type` max 64 chars, **open set**. 1 MB body. 404 `unknown_room`. Resolves **today IST** `room_day` (server clock, not `at`). Advisory lock → insert cue → echo graph. **No fuse. No visit writes.** Returns `{ ok, cue_id, cue_at, state }`. |
| `GET /api/brain/rooms/:id/state?ist_date=YYYY-MM-DD` | same bearer | `app/api/brain/rooms/[id]/state/route.ts` | Read-only. Never creates a day. Default date = today IST. |
| `GET /api/brain/health` | **open** | `app/api/brain/health/route.ts` | `{ ok, now, db:{ok,latency_ms}, config:{db_env_set,token_env_set,ws_available,missing[]}, service:"even-scribe-brain", home:"vercel-app", version }`. Always HTTP 200; `ok` is the truth. Names env **names** only. |

**There is no `GET /api/brain/rooms/:id/cues`.** Confirmed: tree has only `cues/route.ts` (POST), `rooms/[id]/state/route.ts`, `health/route.ts`. `lib/brain/state.ts` has `SQL_CUE_INSERT` and no `SQL_CUE_SELECT`.

### 4.2 State shape (actually returned)

From `lib/brain/state.ts` `Graph`:

```
{
  room_id, room_day_id | null, ist_date,
  visits: [{ id, individual_uid, consult_uid, state, pstart_at, confidence, end_reason, speaker_cluster_ids, updated_at }],
  active_visit_id,          // last visit with state === "in_chair", else null
  clusters: [{ id, kind, visit_id, first_seen_at, last_seen_at, has_centroid }],  // no vector
  confidence: null,         // skeleton — no fuse
  as_of
}
```

Nothing in the repo `INSERT`s into `visit` or `speaker_cluster`. A live `GET /state` will typically be empty visits/clusters with a `room_day_id` once any cue has landed today.

### 4.3 Cue types **actually posted by shipped code**

Open set. Producers in this repo:

| type | Producer | When |
|---|---|---|
| `live_sink_stats` | `POST /api/bench/brain-proxy` ← `lib/use-live-sink.ts` | Only if `NEXT_PUBLIC_ETA_LIVE_SINK=1`. ≤1/min counters. No audio. |
| `consult_mark` | same proxy, Kickoff C (`6b9e2fe`) | Kiosk "Mark consult". Durable `bench_event` first, then best-effort cue `{ source: "kiosk" }`. |

**Mentioned in comments / PRDs but no producer in `main`:** `stt_turn`, `speaker_match`, `pqm_called`, `dx_event`, `pulse_note`. Replay runner + warehouse join are design-only.

### 4.4 Auth notes

- Token env name: **`BRAIN_SERVICE_TOKEN`** (`lib/brain/db.ts` `TOKEN_ENV`).
- Kiosk never sees it. Proxy injects the bearer server-side.
- Optional `BRAIN_BASE_URL` overrides where the proxy POSTs (same-origin `/api/brain/cues` by default). Used for fail-open proof / future container.

---

## 5. Bench / live session control

Kiosk: `/room/{slug}`. Cookie `eta_room_session` (HS256 on `JWT_SECRET_DOCTOR`, `aud:"room"`). Login/logout: `app/room/[slug]/api/login/route.ts`, `…/logout/route.ts`.

### 5.1 Session verbs (exist)

| Verb | Route | Auth | File |
|---|---|---|---|
| Start day | `POST /api/bench/sessions` `{ label?, mic_label? }` | room cookie | `app/api/bench/sessions/route.ts` → inserts `bench_session` status `recording` |
| Pause / Resume / End | `PATCH /api/bench/sessions/{id}` `{ action: "pause"\|"resume"\|"end", notes? }` | room cookie, session must belong to room | `app/api/bench/sessions/[id]/route.ts` |
| Presign chunk | `POST /api/bench/upload-url` `{ session_id, idx, content_type? }` | room cookie | returns PUT + HEAD URLs; `{ already_verified: true }` if row exists |
| Verify chunk | `POST /api/bench/chunks` | room cookie | server `headObject` size match, then `upload_state='verified'` |
| Mark consult | `POST /api/bench/brain-proxy` `{ type:"consult_mark", at?, session_id?, payload? }` | room cookie | durable-first; 409 `no_active_session`; 15s debounce is **client-only** |
| Live-sink heartbeat | `POST /api/bench/brain-proxy` `{ type:"live_sink_stats", payload }` | room cookie | whitelist; 45s in-process throttle; fail-silent 200 `{ ok, brain: recording\|unsure\|down }` |

**There is no HTTP "start the mic."** Start day only creates the row. Capture is the browser `MediaRecorder`. An MCP `scribe_start_day` cannot press the mic — the MCP PRD already bans it.

### 5.2 Admin observe (exist)

| Route | Auth | Returns |
|---|---|---|
| `GET /api/bench/sessions` | admin | last 200 sessions + chunk rollups (no `room_id` / `ist_date` / `status` **query filters** — those would be new) |
| `GET /api/bench/sessions/{id}` | admin | session + chunk list. **Does not include `bench_event` marks.** |
| `GET /api/bench/sessions/{id}/manifest` | admin | `manifest.json` + per-chunk presigned GET (1h) |
| `GET /api/bench/sessions/{id}/timeline` | admin | generated `timeline.md` (marks + brain visits). Not stored. |
| `GET /api/bench/sessions/{id}/download` | admin | STORE zip of chunks + manifest + timeline.md |
| `GET /api/bench/rooms` | admin | rooms, no PIN |
| `POST /api/bench/rooms` | admin | create room, returns `pin_plaintext` once |
| `PATCH /api/bench/rooms` | admin | `reset_pin` \| `disable` \| `enable` |

UI: `/admin/bench`, `/admin/bench/[id]` (`BenchConsultMarks` reads marks via SQL in the RSC, not via a dedicated GET).

Live-sink flag: `NEXT_PUBLIC_ETA_LIVE_SINK` — **OFF in prod** (`lib/live-flags.ts`). Flag-off = today's Bench, hook unmounted.

---

## 6. Admin / debug / lab surfaces

### 6.1 HTTP APIs (`eta_admin_session` unless noted)

| Area | Routes |
|---|---|
| Auth | `POST /api/admin/login`, `POST /api/admin/logout`, `POST /api/admin/password`, `POST /api/admin/bootstrap` (`ADMIN_TOKEN`) |
| Dashboard | `GET /api/admin/dashboard` |
| Clinicians | `GET/POST /api/admin/doctors`, `GET/PATCH /api/admin/doctors/[id]`, `POST …/reset-pin`, `…/rotate-url`, `…/email-url`, plus voice-* above |
| Admins | `GET/POST /api/admin/admins`, `PATCH/DELETE /api/admin/admins/[id]` |
| Encounters | `GET /api/admin/encounters?bucket=&window=&limit=&offset=&doctor_id=&note_type=`, `GET /api/admin/encounters/[id]`, `GET …/audio-url` (presign), `POST …/resend` |
| Sends | `GET /api/admin/sends` |
| Traces | `GET /api/admin/traces?surface=&status=&window=&limit=&offset=` (**`llm_traces`**), `GET /api/admin/traces/[id]` |
| Recipients | `GET/POST /api/admin/recipients`, `PATCH/DELETE /api/admin/recipients/[id]` |
| STT lab | §1.4 |
| Diarization EER | `GET/POST /api/admin/diarization-eer` |
| Launch | `GET /api/admin/launch-readiness` |
| LLM self-test | `POST /api/admin/llm-selftest` |
| Ops | `POST /api/admin/reap-stuck` (`MIGRATION_SECRET` or cron), `POST /api/admin/resume-processing`, `POST /api/admin/r2-cors-fix` |
| Health | `GET /api/health` (open), `GET /api/health/ping`, `GET /api/brain/health` (open), `GET /api/kb/probe` (`ADMIN_TOKEN`) |
| Migrations | `POST /api/run-migrations` (`MIGRATION_SECRET`) |
| Webhook | `POST /api/webhooks/resend` (`RESEND_WEBHOOK_SECRET`) |

### 6.2 Pages (cookie UI, not MCP-ready)

`/admin`, `/admin/doctors`, `/admin/doctors/[id]`, `/admin/doctors/[id]/voice`, `/admin/encounters`, `/admin/encounters/[id]`, `/admin/sends`, `/admin/traces`, `/admin/traces/[id]`, `/admin/stt-lab`, `/admin/bench`, `/admin/bench/[id]`, `/admin/diarization`, `/admin/admins`, `/admin/system-map`, `/admin/settings`, `/admin/settings/health`, `/admin/settings/launch-readiness`, `/admin/settings/resend`, `/admin/settings/retention`, `/admin/settings/global-cc`.

`/admin/system-map` (`components/admin/SystemMap.tsx`) is a **page** that composes `/api/health` + flags. There is **no** `GET /api/admin/system-map` JSON sibling.

---

## 7. Env vars and service tokens (names only)

`.env.example` claims to list every `process.env` read. **It is stale.** Missing at least the brain + Gemini + later live flags.

### 7.1 Tokens / secrets (treat as admin-class)

| Name | Used for |
|---|---|
| `BRAIN_SERVICE_TOKEN` | Bearer on `/api/brain/cues` and `/state`. Injected by bench-proxy. |
| `ADMIN_TOKEN` | Bootstrap + `GET /api/kb/probe` |
| `MIGRATION_SECRET` | `/api/run-migrations`, reap-stuck, STT fanout bearer |
| `CRON_SECRET` | optional extra cron auth |
| `ADMIN_PASSWORD_CURRENT` | shared admin password (legacy) |
| `JWT_SECRET_DOCTOR` | doctor PIN sessions **and** room JWTs |
| `JWT_SECRET_ADMIN` | admin sessions |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_PROJECT_ID` | live token + REST |
| `SARVAM_API_KEY` | Sarvam |
| `STT_RELAY_SECRET` | Mini Sarvam relay HMAC |
| `ELEVENLABS_API_KEY` | lab |
| `EKACARE_CLIENT_ID` / `EKACARE_CLIENT_SECRET` | lab, disabled |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` | email |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | app R2 |
| `R2_ADMIN_ACCESS_KEY_ID` / `R2_ADMIN_SECRET_ACCESS_KEY` | admin download / CORS |
| `LLM_API_KEY` | Ollama bearer (default `"ollama"`) |
| `OPENAI_API_KEY` | optional gold term extraction |
| `GCP_SA_KEY` | Vertex Gemini (`lib/gcp-auth.ts`) |
| `PLAYWRIGHT_DOCTOR_PIN` / `SMOKE_ADMIN_PASSWORD` | CI only |

There is **no** `SCRIBE_MCP_TOKEN` yet (MCP PRD proposes it).

### 7.2 URLs / roles / stores

`DATABASE_URL`, `APP_DATABASE_URL`, `APP_DATABASE_URL_UNPOOLED`, `BRAIN_DATABASE_URL`, `KB_DATABASE_URL`, `OLLAMA_BASE_URL`, `LLM_BASE_URL`, `WHISPER_BASE_URL`, `INDICCONFORMER_BASE_URL`, `DIARIZE_BASE_URL`, `BRAIN_BASE_URL`, `NEXT_PUBLIC_STT_RELAY_URL`, `STT_RELAY_URL`, `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET`, `APP_URL`, `ADMIN_BASE_PATH`, `RESEND_FROM_EMAIL`.

### 7.3 Models / flags (client `NEXT_PUBLIC_*` inlined at build)

`NOTE_MODEL`, `CDS_MODEL`, `CDS_DRAFT_MODEL`, `CDS_CRITIQUE_MODEL`, `CDS_REVISE_MODEL`, `HYDE_MODEL`, `CLEANUP_MODEL`, `TEXT_MODEL`, `EMBED_MODEL`, `TOP_K`, `SARVAM_STT_MODEL`, `ELEVENLABS_STT_MODEL`, `EKASCRIBE_*`, `STT_GOLD_EXTRACT_MODEL`, `INDICCONFORMER_DECODING`, `DIARIZE_TIMEOUT_MS`, `PASSIVE_VOICEPRINT_GATE`, `GCP_PROJECT`, `GCP_LOCATION`, `GEMINI_MODEL`, `GEMINI_FLASH_MODEL`, `GEMINI_ALL`, `GEMINI_NOTE`, `GEMINI_CDS`, `GEMINI_NATIVE`, `ETA_NOTE_PARALLEL_INDIC`, `ETA_INDIC_COMPREHENSION`.

Flags: `NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS`, `NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT`, `NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD`, `NEXT_PUBLIC_ETA_INDIC_LIVE_BOX` (default ON), `NEXT_PUBLIC_ETA_BACKGROUND_PROCESSING` (default ON), `NEXT_PUBLIC_ETA_LANG_ROUTER` (default ON), `NEXT_PUBLIC_ETA_MIC_PREFLIGHT` (default ON), `NEXT_PUBLIC_ETA_AUDIO_WATCHDOG` (default ON), `NEXT_PUBLIC_ETA_LIVE_FLASH` (default ON), `NEXT_PUBLIC_ETA_HEADER_GUARD` (default ON), **`NEXT_PUBLIC_ETA_LIVE_SINK` (default OFF)**, `NEXT_PUBLIC_ETA_NOTEGEN` (default ON).

Platform: `VERCEL_GIT_COMMIT_SHA`, `VERCEL_REGION`. CI: `BASE_URL`, `EXPECT_SHA`, `SMOKE_*`, `PLAYWRIGHT_*`.

### 7.4 Cookies (not env, but they are the other auth)

| Cookie | Audience |
|---|---|
| `eta_session` | doctor, Path=`/{slug}` (`lib/cookie.ts`; `.env.example` wrongly says `rounds_session`) |
| `eta_admin_session` | admin, Path=/ |
| `eta_room_session` | room kiosk, Path=/ |

---

## 8. Gaps — product exists, no HTTP API (or no operator-readable API)

These are the sibling GETs / probes an MCP would need. Not invented product; they wrap data that already lives in Neon/R2/Mini.

| Gap | Why it matters | What already exists |
|---|---|---|
| **`GET /api/brain/rooms/:id/cues`** | Cannot list evidence. State does not include `last_cues[]`. | `cue` rows + `SQL_CUE_INSERT` only |
| **Pyannote on `GET /api/health`** | Cannot ask "is the Mini diarize up?" without admin STT-lab cookie, and STT-lab does not probe `DIARIZE_BASE_URL` either | Mini `GET /health`; Vercel never calls it |
| **IndicConformer / Deepgram / Sarvam / ElevenLabs on `/api/health`** | Open health is Whisper-only for STT | `GET /api/admin/stt-lab/health` (admin cookie) |
| **Brain on `/api/health`** | Two health endpoints | `GET /api/brain/health` is open — MCP can just call both |
| **`GET /api/admin/system-map` JSON** | System map is a React page | compose `/api/health` + flags + stt-lab health |
| **Session marks on `GET /api/bench/sessions/{id}`** | Marks are SQL in an RSC + timeline.md | `listBenchConsultMarks` in `lib/bench.ts` |
| **List/filter sessions** (`room_id`, `ist_date`, `status`) | `GET /api/bench/sessions` returns last 200, no query params | same SQL, no filters |
| **List cues / clusters as admin** | Clusters only appear inside `/state` (boolean `has_centroid`, no vector — good) | tables exist |
| **STT fanout on a Bench chunk** | Lab is `encounter_id`-shaped. Cannot replay `bs_zcfegzwn` chunk 3 through the registry without a new job type | `POST /api/admin/stt-lab/run-fanout` |
| **Replay runner** | Design step 1 after Kickoff B. Not in tree | would POST `/api/brain/cues` |
| **Fuse / visit writes** | Picture is empty until something writes `visit` | schema + `GET /state` ready |
| **Warehouse watcher** | No Metabase/PG poller in repo | PRD only |
| **Compare a clip to today's clusters** | Identify is doctor-cookie, one centroid, 0.78 | Mini `/enroll` + `speaker_cluster` unread for match |
| **List voiceprints without scraping doctor detail** | No `/api/admin/voiceprints` | `voice_print` join `clinician` |
| **`.env.example` completeness** | Missing `BRAIN_*`, `GEMINI_*`, `GCP_*`, `NEXT_PUBLIC_ETA_LIVE_SINK`, later flags | code is source of truth |
| **`SCRIBE_MCP_TOKEN` / `/api/mcp`** | Do not exist | proposed in MCP PRD only |

### 8.1 Do not pretend these are APIs

- Mini SSH / `~/eta-diarize/server.py` — Mini-local. MCP talks through Scribe.
- IndexedDB `eta-bench` — kiosk only.
- Pulse / PQM / 7404 — warehouse, not in this repo.
- `brain/` Cloud Run Dockerfile — not the live door.
- Raw Neon SQL / raw R2 listing — no route, and the MCP PRD already forbids exposing them.

---

## 9. Auth matrix (for MCP wrapping)

| Surface | Gate | MCP implication |
|---|---|---|
| `/api/brain/*` cues+state | `BRAIN_SERVICE_TOKEN` | MCP is a **client** of these. Do not mint this token for the kiosk. |
| `/api/brain/health` | open | wrap as-is |
| `/api/health` | open | wrap as-is; incomplete graph |
| `/api/bench/*` write | `eta_room_session` | kiosk verbs. MCP write would need a service stand-in or admin-equivalent. |
| `/api/bench/*` read + rooms CRUD | `eta_admin_session` | wrap behind MCP admin token |
| `/api/admin/*` | `eta_admin_session` (some also `MIGRATION_SECRET`) | same |
| `/{slug}/api/transcribe/*` and `/voice/*` | doctor cookie + slug | live WS/token mint should **not** be MCP-invoked |
| `/api/kb/probe` | `ADMIN_TOKEN` | already bearer; returns KB **text previews** |
| Mini services | unauthenticated behind tunnel | never call from MCP with Scribe's keys copied out |

---

## 10. Corrections vs the 19 Aug MCP PRD draft

The draft (`EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md`) is directionally right. Concrete fixes from this inventory:

1. **Brain tables are not "just App Neon via `sql`."** Created by the app migrator; runtime access is `BRAIN_DATABASE_URL` (WS). Timeline already uses the brain pool for visits.
2. **`llm_traces` ≠ `trace`.** Admin traces API reads `llm_traces` (0002). `trace` is the older per-stage table.
3. **`doctor` is gone.** Use `clinician`.
4. **`.env.example` doctor cookie name is wrong** (`rounds_session` vs `eta_session`).
5. **`GET /api/health` does not probe Pyannote, Indic, Deepgram, Sarvam, or brain.** STT-lab health does engines, not Pyannote.
6. **Only two cue types are produced today:** `consult_mark`, `live_sink_stats`. The rest are schema comments.
7. **Bench list/detail APIs have no date/room filters and no marks array.**
8. **Fanout cannot target a Bench chunk.**
9. **Cloud Run brain is not live.** `home: "vercel-app"` on `/api/brain/health`.
10. **R2 Bench date folder is UTC**, not IST — `ymdUtc`. Operators grepping IST dates on keys will miss objects.

---

## 11. Source index (files this inventory leaned on)

Routes: every `app/**/route.ts` listed in the `main` tree (403 blobs).  
STT: `lib/stt/registry.ts`, `lib/stt/adapters/*`, `lib/whisper.ts`, `lib/sarvam.ts`, `lib/deepgram-token.ts`, `lib/live-flags.ts`.  
Voice: `lib/diarize.ts`, `lib/enroll.ts`, `lib/voice-samples.ts`, `docs/ETA-DIARIZE-SERVICE-HANDOVER.md`.  
Brain: `lib/brain/{auth,db,state,lock}.ts`, `app/api/brain/**`, `db/migrations/0042_brain_tables.sql`.  
Bench: `lib/bench.ts`, `lib/bench-timeline.ts`, `lib/use-live-sink.ts`, `lib/r2.ts`, `lib/room-auth.ts`, `app/api/bench/**`, `0041`/`0043`.  
Stores: `db/schema.ts` (partial / stale), migrations 0001–0043, `lib/kb-db.ts`, `lib/kb-retrieve.ts`.  
Env: `.env.example` (incomplete), `lib/llm/gemini.ts`, `lib/env.ts`.  
HEAD history: `b907bc50` D, `6b9e2fe` C mark, `2b59ad1` B live-sink, `9b2715a`/`d58e163` A2, `a0e8e96` A.

Local design docs cross-checked, not treated as APIs: `EVEN-SCRIBE-AMBIENT-BRAIN-PRD.md`, `SCRIBE-BRAIN-*.md`, `SCRIBE-BENCH-CONSULT-MARK-BUILDER-BRIEF-18-AUG-2026.md`, `SCRIBE-POC-PILOT-ADDENDUM-18-AUG-2026.md`, `ETA-FARFIELD-PROBE-EVIDENCE-17-AUG-2026.md`, `EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md`.
