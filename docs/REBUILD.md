# ETA / Evenscribe — Rebuild Guide

How to stand up this app from the source in this repo. Written for an engineer (or an AI agent)
copying the system. Pair with [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`DATA-MODEL.md`](DATA-MODEL.md).

## 0. External services you must provision

| Need | Service used here | Notes |
|---|---|---|
| App DB | Neon Postgres | accessed via the serverless **HTTP** driver |
| KB DB | Neon Postgres + pgvector | read-only knowledge base of medical reference chunks; embeddings via `EMBED_MODEL`. You must supply your own corpus + embeddings for the CDS step. |
| Audio | Cloudflare R2 (S3-compatible) | bucket + standard and admin key pairs; CORS must allow the app origin for presigned PUT |
| Email | Resend | API key, from-address, svix webhook secret |
| Live English ASR | Deepgram | WebSocket token minted server-side |
| Indic ASR + translate | Sarvam (Saaras v3) | REST; optional streaming relay |
| LLM | Ollama (OpenAI-compatible) | qwen2.5:14b (note), llama3.1:8b (CDS), nomic-embed-text (KB). Self-hosted here on a Mac Mini behind a Cloudflare tunnel; any OpenAI-compatible endpoint works. |
| Whisper ASR | whisper.cpp server | rolling medical-term accuracy; self-hosted |
| Diarization | pyannote service | `/diarize` + `/enroll`; returns per-speaker embeddings. See `ETA-MAC-MINI-BACKEND-HANDOVER.md` + `ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md`. |
| (optional) Scribe-lab engines | ElevenLabs Scribe v2, eka.care | for the STT Engine Lab only |

The Mac-Mini backend (Ollama, Whisper, pyannote, Sarvam relay) is documented in
`docs/ETA-MAC-MINI-BACKEND-HANDOVER.md`. The app only needs the HTTPS/WSS URLs + secrets in env;
swap in any equivalent endpoints.

## 1. Configure

```bash
npm install
cp .env.example .env.local
```

Fill every variable in `.env.example` (grouped by subsystem; values are placeholders here). Minimum
to boot the core record→note→email loop: APP DB, R2, Resend, Deepgram, an OpenAI-compatible LLM
(`OLLAMA_BASE_URL`), and the auth/admin secrets. Sarvam/Whisper/diarization/STT-lab are additive.

## 2. Database

```bash
# Local: push the Drizzle schema
npm run db:push
# Prod parity: apply the canonical SQL migrations idempotently
curl -s -X POST <app-url>/api/run-migrations -H "Authorization: Bearer $MIGRATION_SECRET"
```

Migrations are the source of truth for prod (0001–0026; 0013 skipped). The KB DB is separate and
read-only; populate it with your own embedded reference corpus or stub the CDS retrieval.

## 3. Run / build

```bash
npm run dev            # local
npm run typecheck      # the real type gate (Vercel build runs this)
npx vitest run         # unit tests
npm run check:silent   # empty-catch gate
```

There is **no committed `package-lock.json`** — install with `npm install` (Vercel + CI do too).
Do not add npm dependencies casually; the project deliberately hand-rolls things (e.g. the `/buglog`
markdown renderer, the System Map) to keep installs reproducible. `tsconfig` excludes
`tests`/`vitest.config.ts`/`playwright.config.ts` so the prod typecheck stays clean.

## 4. Deploy

Host on Vercel (region near your users; this deployment uses `bom1`). Set all env vars (Sensitive).
Push to `main` → auto-build/deploy; a failed build never deploys. Then:

```bash
curl -s <app-url>/api/health          # ok:true + all services green
node scripts/smoke.mjs                # BASE_URL=<app-url> for a non-mutating canary
```

Wire the hourly stuck-`processing` reaper (`vercel.json` cron → `/api/admin/reap-stuck`) and the
GitHub Actions CI (`.github/workflows/ci.yml`) + nightly e2e (`e2e.yml`).

## 5. First admin + first clinician

1. Bootstrap an admin via `/api/admin/bootstrap` (Bearer `ADMIN_TOKEN`) or the seeded admin flow, then sign in at the admin base path.
2. In the admin console create a clinician (name, type, email) → it generates a slug + PIN.
3. Open `/{slug}`, enter the PIN, record a test encounter, and confirm the note generates and emails.

## 6. Subsystem deep-dives (ported design docs)

- Product spec: `EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md`, `ETA-V2-PRD.md` (+ `-RESCOPE`).
- Build plan / lift map: `ETA-BUILD-PLAN.md`, `EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md`.
- Multilingual: `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md`.
- STT Engine Lab: `ETA-STT-ENGINE-LAB-PRD.md`.
- Voiceprint/diarization: `ETA-VOICEPRINT-RETENTION-PRD.md`, `ETA-DIARIZE-SERVICE-HANDOVER.md`, `ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md`.
- Audio failsafe: `ETA-AUDIO-FAILSAFE-PRD.md`.
- Backend infra: `ETA-MAC-MINI-BACKEND-HANDOVER.md`.
- Known issues / history: `../content/ETA-BUG-LOG.md`, `ETA-OPEN-ITEMS.md`, `ETA-BACKLOG-SCOPED.md`.

> Note: the ported PRDs/runbooks reflect their authoring dates and may lag the shipped system.
> Where they differ, `ARCHITECTURE.md` + `DATA-MODEL.md` + the code are authoritative.
