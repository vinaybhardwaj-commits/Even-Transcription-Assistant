# ETA / Evenscribe — Architecture

The accurate, current-state engineering overview. The deeper design rationale lives in the
ported PRDs (see [`docs/README.md`](README.md)); where an older PRD conflicts with this file,
**this file wins** (the PRDs predate parts of the shipped system).

## 1. Shape

A single Next.js 15.5 App-Router project on Vercel (`bom1`), backed by Neon Postgres (HTTP driver),
Cloudflare R2 (audio), Resend (email), and a private **Mac-Mini backend** (LLM + Whisper +
pyannote diarization + Sarvam streaming relay) reachable only over Cloudflare tunnels. The browser
is a mobile-first PWA with a service worker.

```
Browser PWA ──HTTPS──> Vercel (Next.js, bom1) ──HTTP──> Neon Postgres (APP + KB)
   │  live ASR                 │                  ──S3───> Cloudflare R2 (audio)
   ├─ Deepgram WS (English)    │                  ──API──> Resend (email) ──webhook(svix)──┐
   ├─ Sarvam REST/relay (Indic)│                  ──tunnel> Mac-Mini: Ollama (qwen/llama/embed)
   └─ IndexedDB + mem failsafe  └──────────────────tunnel> Mac-Mini: Whisper, pyannote, Sarvam relay
```

## 2. Identity & auth

- **Clinicians** authenticate with a 4-digit **PIN** at their personal slug `/{slug}` (e.g. `/dr-name-xxxx`). A `jose` JWT (audience `doctor`, `JWT_SECRET_DOCTOR`) is set as a slug-scoped cookie. `pin_attempt` enforces lockout. `clinician` is the sole identity table (the legacy `doctor` table was dropped in migration 0015; `clinician.id` preserved the old ids).
- **Admins** log in with email+password (bcrypt) at the obscured admin base path; JWT audience `admin` (`JWT_SECRET_ADMIN`), cookie `eta_admin_session` (Path=/, so it reaches `/buglog`). `admin_user` table. All admins are currently role `super`.
- Clinician types: `physician | dietitian | physiotherapist`, which gates the note-type picker.

## 3. Recording → note pipeline

**Capture (client).** `MediaRecorder` emits ~250 ms webm/opus chunks. Each chunk is written to
IndexedDB *and* an in-memory array (`chunksMemRef`) — the failsafe that survives iOS Private
Browsing (where IndexedDB is disabled) and crashes. Live transcript:
- English → Deepgram WebSocket (token minted server-side).
- Indic/multi → `useSarvamRolling` posts a bounded recent window to `/{slug}/api/transcribe/sarvam-live` every ~2 s (a "growing-window refine + commit" model), or true streaming via the Mac-Mini relay (`NEXT_PUBLIC_STT_RELAY_URL`). The window is byte-capped (`lib/live-window.ts`, ≤3.5 MB) to stay under Vercel's serverless request-body limit.

**Submit.** All chunks concatenate into one blob → `POST /upload-url` (presigned) → browser `PUT`
to R2 → `POST /finalize-upload` records `audio_object_key`/bytes/duration on the encounter.

**Process** (`POST /{slug}/api/encounters/[id]/process`, streamed NDJSON; `maxDuration=300`):
1. Non-English → Sarvam **batch** STT-translate over the full R2 audio → English transcript (`transcript_original` + `detected_language` retained).
2. Transcript cleanup + leading-hallucination/ad guard (`lib/transcript-guard.ts`).
3. pyannote **diarization** (Mac-Mini `/diarize`) + **voiceprint** matching → named speakers; tagged transcript reconciled by time-overlap.
4. **Note generation** (qwen2.5:14b) — one of 5 note schemas by `encounter.note_type` (clinic / general medical / operative / dietetic / physiotherapy).
5. **Clinical decision support** (CDS/CDMSS, llama3.1:8b) for note types that warrant it: HyDE query expansion → pgvector KB retrieval (`KB_DATABASE_URL`) → draft → citation **critique** loop → revise. Soft-fail/tiered; never blocks the encounter.
The stream emits per-stage progress events then a `final` event with the persisted note + CDS.
**It persists to the DB regardless of whether the client keeps reading** — so a dropped client
stream is recoverable (the client auto-retries the idempotent route).

**Deliver.** Clinician edits the note inline, selects recipients (global + per-clinician + ad-hoc),
sends via Resend. Delivery status arrives via svix-verified webhooks (replay-guarded, sticky negatives).

## 4. STT Engine Lab

A test-bed to compare ASR/scribe engines on accuracy/speed/cost. Registry (`stt_engine`) + code
adapters (`lib/stt/adapters/*`) so a new engine = 1 adapter + 1 row. Two tiers: **ASR**
(transcript → WER/agreement/blinded-judge) and **Scribe** (audio → finished note, rubric-scored
vs the `even_pipeline` reference). Offline fan-out queue (`stt_fanout_job`) + scoring. Engines:
Deepgram, Whisper, Sarvam, ElevenLabs (ASR); **`elevenlabs_scribe`** (ElevenLabs ASR → Even
note-gen) is the showcased scribe competitor as of migration 0026; **EkaScribe is disabled**
(too costly — adapter/row kept, reversible). **IndicConformer-600M** (AI4Bharat, local
Mac-Mini, Indic-only, submit-time fallback) is registered as `indicconformer` (ASR) +
`indicconformer_scribe` (scribe), fanout-off until its tunnel is exposed — see
[`IndicConformer-Integration-Handoff.md`](IndicConformer-Integration-Handoff.md). Admin UI at `/admin/stt-lab`.

## 5. Resilience patterns (hard-won; see the bug log)

- **Audio failsafe**: IndexedDB + in-memory dual write; tolerant R2 reads; recovery modal.
- **Service worker** (`public/sw.js`): network-first navigations, offline-503 for GET `/api/`, cache-first for hashed static assets, and it **never intercepts non-GET** (so the long `/process` NDJSON stream is never SW-proxied — that caused a Safari "FetchEvent.respondWith … Load failed"). Killswitch via `public/sw-killswitch.txt`. Bump `SHELL_CACHE` on every SW change.
- **Idempotent `/process`** + client one-shot auto-retry on a dropped stream.
- **Stuck-`processing` reaper** (`/api/admin/reap-stuck`, hourly Vercel cron).
- **Smoke canary** (`scripts/smoke.mjs`) post-deploy + daily; **CI** typecheck+vitest+silent-gate per push; **Playwright** e2e nightly.

## 6. Database driver gotchas (load-bearing)

The Neon **HTTP** driver (`neon()` from `@neondatabase/serverless`) — not a pool — is used with
raw tagged-template SQL everywhere. It does **not** support nested `sql` fragment composition
(value-param interpolation only); GROUP-BY-alias needs a nested subquery; timestamps come back as
strings (wrap `new Date(...)`); `OLLAMA_BASE_URL` already includes `/v1`; `admin_user.id` is a UUID
(cast `${id}::uuid`). `tsconfig` must **exclude** `tests`/`vitest.config.ts`/`playwright.config.ts`
or the prod typecheck pulls them in and fails. No committed lockfile → **no new npm deps** (would
break `npm install` parity); that's why `/buglog`'s markdown renderer and the System Map are hand-rolled.

See [`docs/DATA-MODEL.md`](DATA-MODEL.md) for tables/migrations and [`docs/REBUILD.md`](REBUILD.md)
to stand it up from scratch.
