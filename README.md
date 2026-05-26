# Even Transcription Assistant (ETA)

Mobile-first PWA for clinicians at Even Hospital. Doctor records the encounter, an LLM pipeline produces a structured Medical Encounter Note + CDMSS-grounded analysis, the output ships via email.

**Status:** Sprint 0 — scaffolding. Not yet deployed.
**Live URL (target):** https://eta.llmvinayminihome.uk
**Vercel project:** `even-transcription-assistant` on team `team_yu1wWpsKdjsf90haai1ETJDG`, region `bom1`

## Source docs

All authoritative. See `Daily Dash EHRC/ETA/` (V's working folder):

- `EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md` — product spec (2,238 lines). 20 product decisions locked in §4.
- `COWORK-BUILD-BRIEF.md` — working agreements + tech-stack locks.
- `EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md` — file-by-file lift map from OPD + CDMSS.
- `ETA-BUILD-PLAN.md` — operational handbook: per-sprint scope, file lists, exit criteria.
- Figma PDFs: Design System, Mobile Doctor App (117pp), Admin Desktop, Email Template, Flows.

## Stack

Next.js 15.5 + React 19 + TypeScript strict + Tailwind 3 + Drizzle ORM (Neon Postgres). Mobile-first PWA. Hosted on Vercel `bom1`.

LLMs go through the Mac Mini Ollama tunnel (`OLLAMA_BASE_URL`). Transcription is hybrid Deepgram streaming + Whisper polish. Email via Resend. Audio in Cloudflare R2.

## Local dev

```bash
npm install
cp .env.example .env.local
# fill in .env.local with values from 1Password / Vercel env
npm run db:push        # apply schema to APP_DATABASE
npm run dev            # localhost:3000
```

## Build + typecheck

```bash
npm run lint
npm run typecheck
npm run build
```

## Database

Two Neon DBs:

- **APP_DATABASE** (new) — encounters, notes, traces, sends, audits. Schema in `db/schema.ts`. Migrations in `db/migrations/`.
- **KB_DATABASE** (existing, shared with OPD + CDMSS) — 418k+ MKSAP / StatPearls / UpToDate / OpenFDA / PubMed chunks. Read-only from ETA.

Migrations run via Drizzle Kit (`npm run db:push` for local; `db/migrations/*.sql` are the canonical SQL for prod via `/api/run-migrations` endpoint).

## Health checks

```bash
curl https://eta.llmvinayminihome.uk/api/health        # full probe
curl https://eta.llmvinayminihome.uk/api/health/ping   # cheap (mobile pre-flight)
```

## Service worker killswitch

Per `Even-CDMSS` pattern. Flip `public/sw-killswitch.txt` body to `killed` and deploy to unregister all installed SWs in the field.

## Lifted code

See `ETA-BUILD-PLAN.md` §3 for the full lift map. Sprint 0 lifts:

- From OPD: `lib/llm-trace/*` (8 files), `components/llm-trace/*` (3 files), `lib/transcribe.ts`, `lib/whisper.ts`, `lib/transcribe-compare.ts`, `lib/qwen.ts`.
- From CDMSS: `lib/trace.ts`, `lib/db.ts` (renamed to `db-neon-http.ts`), `lib/llm.ts`, `lib/cdmss-{stream,ndjson-client}.ts`, `lib/admin-gate.ts`, `lib/citation-check.ts`, `public/sw.js`, `public/manifest.webmanifest`, `public/register-sw.js`, `public/sw-killswitch.txt`.

`lib/auth.ts` is **new** (ETA-specific PIN+JWT model). The lifted OPD `auth.ts` is at `lib/auth-opd-reference.ts.bak` for reference.

## License

Internal to Even Hospital. Not for redistribution.
