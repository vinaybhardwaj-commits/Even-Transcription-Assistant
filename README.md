# Even Transcription Assistant (ETA / "Evenscribe")

Mobile-first PWA for clinicians at Even Hospital. A doctor opens a personal URL on
their phone, enters a 4-digit PIN, taps record, and dictates a patient encounter.
A multi-engine pipeline produces a structured medical note plus a knowledge-base–grounded
clinical decision-support card; the clinician edits inline and emails it to recipients.

- **Live:** https://www.evenscribe.app (apex `evenscribe.app` 307 → www)
- **Health probe:** https://www.evenscribe.app/api/health
- **Hosting:** Vercel project `even-transcription-assistant`, team `team_yu1wWpsKdjsf90haai1ETJDG`, region `bom1` (Mumbai). Auto-deploys on push to `main`.
- **Status:** production, in clinical pilot. Migrations `0001`–`0026` applied. v1 + multilingual + speaker diarization + 5 note-type/clinician-type model + voiceprint retention + STT Engine Lab all shipped.

> **Reading this to understand or rebuild the app?** Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
> then [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) and [`docs/REBUILD.md`](docs/REBUILD.md).
> [`docs/README.md`](docs/README.md) indexes the full design/spec/runbook set.

## What it does (end to end)

1. **Capture** — doctor PIN-logs into `/{slug}`, taps record. `MediaRecorder` emits ~250 ms webm/opus chunks; each chunk persists to IndexedDB **and** an in-memory failsafe (crash/Private-Browsing recovery). Live transcript: Deepgram WebSocket for English; for Indic languages a rolling Sarvam REST window (or true streaming via a Mac-Mini relay) shows a code-mixed transcript.
2. **Submit & store** — chunks concatenate into one webm blob → presigned `PUT` to Cloudflare R2 → `/finalize-upload`.
3. **Process** (`/process`, streamed NDJSON) — Sarvam batch translate (non-English) → transcript cleanup → pyannote speaker diarization + voiceprint naming → note generation (qwen2.5:14b) → clinical decision support (llama3.1:8b) grounded in a pgvector knowledge base via HyDE retrieval + a citation-critique loop.
4. **Deliver** — structured note + CDS card; clinician edits, picks recipients, sends via Resend (svix-verified delivery webhooks).
5. **Observe** — admin console: clinicians, recipients, encounters, audio playback, LLM traces, diarization EER, the STT Engine Lab, a published bug log, and a system map.

## Stack

Next.js 15.5 (App Router) · React 19 · TypeScript strict · Tailwind 3 · Drizzle schema
authority with the **Neon serverless HTTP driver** (`@neondatabase/serverless`) · jose JWT (HS256,
separate doctor/admin audiences) · bcryptjs · `@aws-sdk/client-s3` for R2 · Resend + svix · the
`openai` SDK pointed at a self-hosted Ollama. LLM/ASR heavy lifting runs on a private Mac-Mini
backend reachable via Cloudflare tunnels (see [`docs/ETA-MAC-MINI-BACKEND-HANDOVER.md`](docs/ETA-MAC-MINI-BACKEND-HANDOVER.md)).

Project size: ~27 pages, ~66 API routes, ~46 components, ~76 lib modules, 19 tables, migrations 0001–0026.

## Local dev

```bash
npm install
cp .env.example .env.local      # fill in real values from Vercel env (never commit them)
npm run dev                      # localhost:3000
```

## Build / test / deploy

```bash
npm run typecheck                # tsc --noEmit (the real type gate; Vercel build runs this)
npx vitest run                   # unit tests (tests/unit/**)
npm run check:silent             # no empty catch/.catch in critical paths (CI gate)
npm run smoke                    # non-mutating production canary (BASE_URL overridable)
```

CI (`.github/workflows/ci.yml`) runs typecheck + vitest + the silent-failure gate on every push.
E2E (`.github/workflows/e2e.yml`, Playwright) runs nightly + on manual dispatch. There is **no
committed lockfile** — Vercel and CI both install with `npm install`.

### Deploy

Push to `main` → Vercel auto-builds and deploys (region `bom1`). A failed build never deploys
(prod holds the last good sha). Run DB migrations against prod:

```bash
curl -s -X POST https://www.evenscribe.app/api/run-migrations -H "Authorization: Bearer $MIGRATION_SECRET"
```

## Databases

- **APP** (`APP_DATABASE_URL` / `DATABASE_URL`) — encounters, clinicians, notes, sends, traces, voiceprints, STT-lab. Schema in `db/schema.ts`; canonical SQL in `db/migrations/*.sql`. See [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).
- **KB** (`KB_DATABASE_URL`) — read-only pgvector knowledge base (~300k+ MKSAP/StatPearls/etc. chunks) shared with sibling apps. Used by the CDS retrieval step.

## Security notes (read before sharing access)

- All real secrets live in **Vercel env** (Sensitive). This repo and its docs use placeholders + `.env.example`; secret *values* have been redacted from the documentation.
- Known parked items are tracked in [`content/ETA-BUG-LOG.md`](content/ETA-BUG-LOG.md) (B19): admin-login has no rate-limit, some admin mutations lack role gates, `finalize-upload` doesn't bind the R2 key to the encounter, and a shared admin password should be rotated to per-admin credentials. Address these before any external exposure.

## License

Internal to Even Hospital. Not for redistribution.
