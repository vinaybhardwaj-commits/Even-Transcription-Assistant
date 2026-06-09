# Even Transcription Assistant — Build Plan

**Status:** Draft v0.1 — pending Sprint 0 green light from V
**Owner:** Dr Vinay Bhardwaj (PM) + Claude (engineering)
**Last updated:** 26 May 2026
**Repo (to create):** `vinaybhardwaj-commits/Even-Transcription-Assistant`
**Vercel project (to create):** `even-transcription-assistant` on team `team_yu1wWpsKdjsf90haai1ETJDG`, region `bom1`
**Live URL (to point):** `eta.llmvinayminihome.uk`
**Shorthand:** ETA

---

## 0. How to use this doc

This is the operational handbook for building ETA v1. It pulls together the three authoritative sources — the PRD, the Build Brief, the Source Catalog — into a single sprint-by-sprint plan with explicit scope, file lists, exit criteria, and dependencies.

The source documents stay authoritative for *what* and *why*:

- **`EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md`** — product behavior, data model (§6), API contract (§7), UX (§8), success criteria (§10). All 20 product decisions (§4.1–§4.20) are locked.
- **`COWORK-BUILD-BRIEF.md`** — working agreements, tech-stack locks, conventions, anti-patterns to refuse.
- **`EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md`** — file-by-file lift map from `OPD-Encounter-App` + `Even-CDMSS`.
- **Figma PDFs in this folder** — visual spec: Design System (5pp), Mobile Doctor App (117pp), Admin Desktop (19pp), Email Template (7pp), Flows (7pp).

This doc is authoritative for *how* and *when*: the build order, the per-sprint task lists, the file paths to touch, the exit gates, and the V-blocks-vs-Claude-blocks split. Updated daily as work progresses; ends each sprint with a brief "what shipped" note appended.

---

## 1. System at a glance

A mobile-first PWA for clinicians at Even Hospital. Doctor opens a personal URL (`eta.llmvinayminihome.uk/dr-{slug}-{token}`) on their phone, enters a 4-digit PIN, taps **Record**, and dictates the encounter. Hybrid live transcription combines Deepgram (streaming interim text) with Whisper (rolling 15-second chunks that silently swap in polished spans). The doctor can edit the transcript at any point — during recording, paused, after End.

On **Submit**, two pipelines fire in parallel: a note pipeline (clean → critique → revise) produces a structured **Medical Encounter Note** (mixed prose + structured vitals / Rx / referrals), and a CDMSS pipeline (HyDE → retrieve → draft → critique → revise) produces a violet-tinted **Clinical Decision Support** card with citations from the existing 304k-chunk knowledge base. Outputs ship via Resend HTML email to the recording doctor plus admin-managed global CCs plus per-encounter additions. Everything persists in a per-doctor library with re-send (no edit-and-resend in v1).

A separate hidden admin URL at `/{ADMIN_BASE_PATH}/` exposes nine desktop surfaces for V to onboard doctors, retry failed sends, investigate pipelines, and audit LLM activity. v1 is single-hospital, single-admin, no patient-facing surfaces, no formal compliance certification, no PDF attachments.

---

## 2. Architecture summary

### Stack (locked, no renegotiation per Brief §5)

| Layer | Choice |
|---|---|
| Frontend | Next.js 15.5.x App Router · React 19 · TS `strict: true` · Tailwind 3 · shadcn/ui where it saves time |
| Backend | Next.js API routes + server actions. No separate service. |
| DB ORM | Drizzle. Numbered migrations in `db/migrations/`. Schema mirrors PRD §6 exactly. |
| Auth | bcrypt cost 12 for password/PIN hashing. JWT (HS256) via `jose`. Two audiences: `doctor`, `admin`. Cross-class tokens rejected. |
| Audio storage | Cloudflare R2 (S3-compatible). Signed upload/download URLs only. Never public. Key pattern: `audio/{yyyy}/{mm}/{dd}/{encounter_id}.opus`. |
| Email | Resend. Webhook signature-verified. Retry: 3 attempts exponential. |
| LLMs (all via Ollama tunnel) | `llama3.1:8b` cleanup · `qwen2.5:14b` critique + revise + CDMSS draft · `nomic-embed-text` / `mxbai-embed-large` for KB retrieval. |
| Transcription | Deepgram streaming WebSocket (primary) + Whisper polish (secondary). |
| Hosting | Vercel `bom1` region. Full Node runtime. No edge functions. |
| Observability | Every LLM call writes a `trace` row. Every admin mutation writes an `audit_log` row. Both append-only, surfaced in admin. |

### What NOT to add (anti-patterns from Brief §9)

No hosted auth (Clerk/Auth0/Supabase). No paid LLM APIs (OpenAI/Anthropic/Google). No audio in DB. No skipping the trace write on an LLM call. No skipping the audit log on an admin mutation. No hard-delete without `?hard=true` + reconfirm. No sending emails for `status='failed'` encounters when `settings.block_on_critique_fail = true`. No cross-doctor data leakage (always filter by `doctor_id` from JWT). No external state library (zustand/redux/jotai). No CSS-in-JS. No analytics SDK — the audit + trace tables ARE the analytics.

### Two databases, two tunnels

- **`APP_DATABASE`** (new, Neon `bom1`) — encounters, notes, traces, sends, audits, recipients, doctors, admins, settings. Provisioned in Sprint 0. Schema in PRD §6.
- **`KB_DATABASE`** (existing, Neon `bom1`) — 304k+ MKSAP/StatPearls/UpToDate/OpenFDA/PubMed chunks. Currently **418,185 chunks live** (grew from the 304k figure in the docs). **Read-only** from ETA via `KB_DATABASE_URL`.
- **Ollama tunnel** — `https://llm.llmvinayminihome.uk/v1`. Models verified live: `qwen2.5:14b`, `llama3.1:8b`, `qwen2.5:7b`, `qwen2.5vl:7b`, `nomic-embed-text`, `mxbai-embed-large`, plus 3 specialty medical models.
- **Whisper tunnel** — `https://whisper.llmvinayminihome.uk` (whisper.cpp serving `large-v3-turbo`). Verified reachable.

### Identifier conventions (PRD §6.3)

| Prefix | Purpose | Example |
|---|---|---|
| `doc_` | Doctor | `doc_3p4n9q2x` (8-char nanoid) |
| `enc_` | Encounter | `enc_8h2k7a9b` (10-char nanoid) |
| `trace_` | LLM trace row | `trace_a7g3k2` (6-char nanoid) |
| `em_` | Email send event | `em_9k3h7m2a` (9-char nanoid) |
| uuid v4 | admin_user, audit_log, recipients | — |

All ID displays in UI use Roboto Mono per Design System.

### Vercel + secrets

- Team: `team_yu1wWpsKdjsf90haai1ETJDG` (verified — listed as "Hospital Product")
- Region: `bom1` (Mumbai latency for doctor + KB co-location)
- Auto-deploy on push to `main`. Preview deploys on PR.

Env vars required:

```
OLLAMA_BASE_URL              # https://llm.llmvinayminihome.uk/v1
WHISPER_BASE_URL             # https://whisper.llmvinayminihome.uk
DEEPGRAM_API_KEY             # V provides
APP_DATABASE_URL             # provisioned Sprint 0
KB_DATABASE_URL              # existing shared KB
RESEND_API_KEY               # V creates in Resend dashboard
RESEND_FROM_EMAIL            # transcripts@eta.llmvinayminihome.uk
RESEND_WEBHOOK_SECRET        # V generates in Resend dashboard
R2_ACCOUNT_ID                # V creates R2 bucket
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET                    # eta-audio
JWT_SECRET_DOCTOR            # 64-char random; generated Sprint 0
JWT_SECRET_ADMIN             # 64-char random; generated Sprint 0
ADMIN_BASE_PATH              # 32-char URL-safe random; generated Sprint 0
ADMIN_TOKEN                  # 64-char random; generated Sprint 0; bearer for /admin/* routes
```

All sensitive values live in Vercel encrypted env vars. Never logged. Never in commits. Never echoed in chat.

---

## 3. Lifts from predecessor repos

Source: `EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md` §10.9. The full table is in the catalog; the summary here is the build perspective.

### Tier 1 — verbatim or near-verbatim (Sprint 0)

From **OPD-Encounter-App** (`/tmp/opd2`):
- `src/lib/llm-trace/` — all 8 files (`stream.ts`, `ndjson-client.ts`, `format-duration.ts`, `model-labels.ts`, `stage-explainers.ts`, `heartbeat.ts`, `log.ts`, `background-registry.ts`)
- `src/components/llm-trace/` — `TracePanel.tsx`, `AiActivityList.tsx`, `BackgroundTraceToaster.tsx`
- `src/lib/transcribe.ts` — Deepgram client (`nova-3-medical`)
- `src/lib/whisper.ts` — Mac Mini whisper.cpp client
- `src/lib/transcribe-compare.ts` — parallel runner + judge prompt
- `src/lib/qwen.ts` — Ollama OpenAI-compat client with `signal: AbortSignal`
- `src/lib/auth.ts` — jose JWT cookie (rename cookie `opd_session` → `eta_session`)
- `src/components/TranscriptViewer.tsx`
- `/api/health` endpoint pattern

From **Even-CDMSS** (`/tmp/cdmss`):
- `lib/trace.ts` — `tracedChat()` wrapper. **All LLM calls go through this.** Writes trace_events row before+after every call.
- `lib/db.ts` — Neon HTTP driver (`neon()`, not `Pool`)
- `lib/stream.ts` — `makeNdjsonStream()` (identical to OPD's; CDMSS is simpler base)
- `lib/admin-gate.ts` — bearer + query-param admin auth
- `lib/calculators/citation-check.ts` — `stripHallucinatedCitations()` defensive guard
- `public/sw.js` — versioned, killswitch-aware service worker. Change cache name `even-cdmss-shell-v3` → `eta-shell-v1`.
- `public/manifest.webmanifest` — change name, theme color, start_url, icons
- `public/register-sw.js`
- `public/sw-killswitch.txt` — empty file; flip to `"killed"` to disable SW org-wide

### Tier 2 — lift and adapt (Sprint 1–2)

- `src/components/DictateButton.tsx` (OPD) — rewire endpoints to ETA API
- `src/components/VoiceQueryFab.tsx` (OPD) — adapt for mobile push-to-talk
- `src/components/AmbientRecorder.tsx` (OPD) — adapt for the long-form encounter flow
- `src/components/ComparisonCard.tsx` (OPD) — admin-only (hide from doctor surface)
- `stage-explainers.ts` — add new ETA surfaces: `note-pipeline`, `cdmss-analysis`, `transcribe-live`, `cleanup-live`, `cleanup-rolling`

### Tier 3 — build new (Sprint 1–4)

- `lib/cleanup.ts` — per-utterance Deepgram cleanup pass + Whisper rolling cleanup. Same prompt, same safety rail.
- `lib/note-pipeline.ts` — draft → critique → revise. Emits MedicalEncounterNote JSON per PRD §4.10 schema.
- `lib/cdmss-pipeline.ts` — HyDE → retrieve → draft → critique → revise. Emits CdmssAnalysis JSON per PRD §4.11 schema.
- `lib/encounter.ts` — encounter lifecycle (start, audio-chunk, finalize, status)
- `lib/email-template.tsx` — React Email or equivalent. Renders the §8.2 spec.
- `lib/email-send.ts` — Resend client + retry policy
- Mobile shell: PIN entry, home, recording, finalize, processing, library, settings
- Admin shell: 9 surfaces per PRD §4.16
- All 10 API namespaces per PRD §7

### Tier 4 — v2 (parked)

KB-grounded cleanup beyond the §4.11 CDMSS layer, Coach mode, ICD-10 extraction, qwen-vision OCR of paper notes, calculators (eGFR/NEWS2/ABG), OPD-Encounter-App integration, cross-app patient linkage.

---

## 4. Sprint 0 — Setup (~2 days · ~16h focused + ~3h V-blocked)

### Goal

A throwaway deploy lives at `eta.llmvinayminihome.uk`. `/api/health` returns all-green. Skeleton routes render. CI green. Every dependency listed in §2 above is reachable from the live deploy.

### Exit criteria (from PRD §9 + Brief §6)

- `https://eta.llmvinayminihome.uk/api/health` returns `{db: ok, llm: ok, whisper: ok, kb: ok}` with per-service latency
- PIN entry page (`/dr/[slug]`) and admin login page (`/{ADMIN_BASE_PATH}`) render the layout (no real auth wired)
- All §2 env vars set in Vercel
- All Tier 1 verbatim lifts present at correct paths
- Migration 0001 applied (all tables from PRD §6)
- README has bootstrap commands
- CI green on `main`

### Tasks

| # | Task | Hours | Blocker | Owner |
|---|---|---|---|---|
| 0.1 | GitHub repo init: `vinaybhardwaj-commits/Even-Transcription-Assistant`. Next.js 15.5.x + React 19 + TS strict + Tailwind + drizzle + shadcn. `.gitignore`, `tsconfig.json`, `package.json`, basic `app/layout.tsx`. | 0.5 | — | Claude |
| 0.2 | Vercel project `even-transcription-assistant` on `team_yu1wWpsKdjsf90haai1ETJDG`. Hook to repo. Confirm auto-deploy on `main`. Region `bom1`. | 0.5 | — | Claude |
| 0.3 | DNS `eta.llmvinayminihome.uk` → Vercel. I provide the CNAME target; V flips it in Cloudflare. | 0.5 | V (5 min Cloudflare click) | V |
| 0.4 | Provision Neon `APP_DATABASE` (separate project from KB). Region `bom1`. Branch `main`. Push `APP_DATABASE_URL` + non-pooling variant into Vercel env. | 1 | — | Claude |
| 0.5 | Cloudflare R2 bucket `eta-audio`. CORS for signed uploads from `eta.llmvinayminihome.uk`. Access key + secret. V creates the bucket + keys; I write the helper + CORS policy. | 1 | V (10 min Cloudflare click) | V + Claude |
| 0.6 | Resend setup: add `eta.llmvinayminihome.uk` (or `even.in` subdomain) to Resend, configure SPF + DKIM in Cloudflare DNS, generate `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET`, point webhook to `https://eta.llmvinayminihome.uk/api/webhooks/resend`. | 1.5 | V (15 min Resend + Cloudflare) | V + Claude |
| 0.7 | Generate secrets: `JWT_SECRET_DOCTOR`, `JWT_SECRET_ADMIN`, `ADMIN_BASE_PATH`, `ADMIN_TOKEN` via `openssl rand -base64 48` (or `32` for ADMIN_BASE_PATH). Paste into Vercel env. Never echo in chat. | 0.25 | — | Claude |
| 0.8 | Migration 0001 from PRD §6. Drizzle schema for `admin_user`, `doctor`, `pin_attempt`, `encounter`, `trace`, `recipient_global`, `recipient_per_doctor`, `send_event`, `audit_log`, `settings`. All indexes from spec. Identifier prefixes per §6.3. Seed `settings` row + V as the bootstrap admin. | 3 | 0.4 | Claude |
| 0.9 | Lift Tier 1 verbatim files (§3 above). Path rewrites, cache-version rename, Tailwind brand-class swaps. No new dependencies. | 3 | — | Claude |
| 0.10 | `/api/health` endpoint — probes APP_DATABASE, Ollama, Whisper, KB. Returns `{ok, latency_ms}` per service. | 1 | 0.8 | Claude |
| 0.11 | Skeleton routes: `/dr/[slug]/page.tsx` (PIN entry shell) + `/{ADMIN_BASE_PATH}/page.tsx` (admin token shell). No real auth wired. | 1.5 | 0.9 | Claude |
| 0.12 | `POST /api/auth/pin` stub. Accepts `{slug, token, pin}`, returns 200 stub response with correct error envelope (PRD §7.5). Sprint 1 wires bcrypt + JWT + lockout. | 1 | 0.8 | Claude |
| 0.13 | CI: GitHub Actions for lint + typecheck on PR. Vercel handles preview deploys natively. | 1 | — | Claude |
| 0.14 | First production deploy. README with bootstrap commands. Screenshot of `/api/health` all-green in the deploy notes. | 0.5 | all above | Claude |

### Files created

```
Even-Transcription-Assistant/
├── package.json                     # next 15.5, react 19, drizzle, jose, etc.
├── tsconfig.json                    # strict: true
├── tailwind.config.ts               # tokens from Design System (Sprint 1 fills out)
├── next.config.js
├── .github/workflows/ci.yml
├── README.md
├── db/
│   ├── schema.ts                    # drizzle schema mirroring PRD §6
│   └── migrations/
│       └── 0001_init.sql
├── app/
│   ├── layout.tsx
│   ├── (mobile)/
│   │   └── dr/[slug]/page.tsx       # PIN entry shell
│   ├── [admin_base_path]/
│   │   └── page.tsx                 # admin token entry shell
│   └── api/
│       ├── health/route.ts
│       └── auth/pin/route.ts        # stub
├── lib/
│   ├── auth.ts                      # FROM OPD; cookie → eta_session
│   ├── db.ts                        # FROM CDMSS
│   ├── llm.ts                       # FROM CDMSS; rename env to OLLAMA_BASE_URL
│   ├── trace.ts                     # FROM CDMSS (tracedChat)
│   ├── stream.ts                    # FROM CDMSS
│   ├── ndjson-client.ts             # FROM CDMSS
│   ├── admin-gate.ts                # FROM CDMSS
│   ├── transcribe.ts                # FROM OPD
│   ├── whisper.ts                   # FROM OPD
│   ├── transcribe-compare.ts        # FROM OPD
│   ├── qwen.ts                      # FROM OPD
│   ├── citation-check.ts            # FROM CDMSS
│   ├── llm-trace/                   # FROM OPD (8 files)
│   └── respond.ts                   # NEW — §7.5 error envelope helper
├── components/
│   └── llm-trace/                   # FROM OPD (3 files)
└── public/
    ├── sw.js                        # FROM CDMSS (rename cache)
    ├── manifest.webmanifest         # FROM CDMSS (rename name/theme/icons)
    ├── register-sw.js               # FROM CDMSS
    ├── sw-killswitch.txt            # FROM CDMSS (empty)
    └── icons/                       # ETA-branded 192 + 512
```

### Dependencies on V

1. Approve Sprint 0 plan (this section) — green light
2. Cloudflare DNS flip for `eta.llmvinayminihome.uk` (5 min click)
3. Cloudflare R2 bucket creation + API key (10 min click)
4. Resend domain add + SPF/DKIM DNS records + webhook secret (15 min)
5. Hand me `DEEPGRAM_API_KEY` (if I don't already have it)

---

## 5. Sprint 1 — Doctor recording loop (~5 days · ~40h)

### Goal

V records a complete encounter from PIN entry through finalize on his phone, with live transcript visible the whole time. Transcript matches audio to within minor cleanup edits.

### Exit criteria (PRD §9)

- V completes a 5+ minute encounter end-to-end on his phone
- Live transcript appears in real-time during recording
- Whisper polish swaps are silent and don't disrupt edits
- Pre-flight check catches an offline state and prompts to reconnect
- Backgrounding the app preserves audio + transcript state
- Submit transitions to processing screen (pipelines wired in Sprint 2)

### Design surfaces (read before this sprint)

From `Daily Dash EHRC/ETA/`:
- **v1.pdf** Design System (5pp) — already absorbed
- **Flows.pdf** (7pp) — 5 user journeys end-to-end
- **Mobile Doctor App.pdf** pages 1–55 — covers §8.1.1 PIN entry, §8.1.2 Home, §8.1.3 Recording active, §8.1.4 Recording paused, §8.1.5 Finalize/Review, §8.1.11 Pre-flight offline modal

### Tasks

| # | Task | Hours |
|---|---|---|
| 1.1 | Build `tailwind.config.ts` from Design System tokens (even.blue/navy/pink/ink + violet/emerald/amber/red semantics; spacing scale 4/8/12/16/20/24/32/40/64; radii sm/md/lg/xl/full). Inter font import. | 2 |
| 1.2 | Base components matching Design System (Button × 5 variants × 3 states, Card × 3 variants, Status badge × 5, Input field × 4 states, Numeric PIN pad). shadcn/ui where it fits. | 6 |
| 1.3 | PWA shell — `manifest.webmanifest` (ETA-branded), `sw.js` (cache name `eta-shell-v1`), `register-sw.js`. Install prompt. | 2 |
| 1.4 | §8.1.1 PIN entry — numeric pad UI, `POST /api/auth/pin` with bcrypt verify, JWT issue, cookie set, lockout escalation per §4.15 (5→15min, 10→1h+alert, 20→24h+alert, 30→disable). | 4 |
| 1.5 | §8.1.2 Home/Record start — Record / Library tab, patient-label optional field, pre-flight ping, recovery card for backgrounded encounters. | 3 |
| 1.6 | §8.1.3 Recording active — MediaRecorder API, Deepgram WebSocket via `POST /api/encounter/start` + `WS /api/encounter/{id}/stream`, live transcript renders, per-utterance `llama3.1:8b` cleanup pass, pulsing recording dot. | 8 |
| 1.7 | Whisper rolling polish — 15-second chunks POSTed to `WHISPER_BASE_URL/inference`, returned text replaces span in displayed transcript with cursor-focus suppression (queue if doctor is editing nearby). | 6 |
| 1.8 | §8.1.4 Recording paused — pause mic capture, transcript editable, resume restores. Edit-anytime per §4.3. `autocomplete="off"` + `spellcheck="false"` + `autocapitalize="off"` + `data-gramm="false"` on transcript field. | 2 |
| 1.9 | §8.1.5 Finalize/Review — full transcript editable, patient label editable, CC picker modal (admin global CCs default-checked + per-encounter additions), Submit button. | 4 |
| 1.10 | §8.1.11 Pre-flight offline modal — triggered when `GET /api/health/ping` times out. Try again / Cancel. | 1 |
| 1.11 | Dropout tolerance per §4.18 — Deepgram WebSocket exponential backoff reconnect (1s → 30s cap), MediaRecorder continues locally during drop, "Reconnecting…" indicator. | 2 |

### Files created / touched

- `tailwind.config.ts` (new)
- `app/layout.tsx` (touch — PWA registration)
- `app/(mobile)/dr/[slug]/page.tsx` (PIN entry — wire real auth)
- `app/(mobile)/dr/[slug]/home/page.tsx` (new)
- `app/(mobile)/dr/[slug]/record/[id]/page.tsx` (new)
- `app/(mobile)/dr/[slug]/finalize/[id]/page.tsx` (new)
- `app/api/auth/pin/route.ts` (touch — wire bcrypt + JWT + lockout)
- `app/api/auth/refresh/route.ts` (new)
- `app/api/auth/logout/route.ts` (new)
- `app/api/encounter/start/route.ts` (new)
- `app/api/encounter/[id]/stream/route.ts` (new — WS handler)
- `app/api/encounter/[id]/audio-chunk/route.ts` (new — multipart fallback)
- `app/api/encounter/[id]/finalize/route.ts` (new — stubbed; Sprint 2 fires pipelines)
- `app/api/health/ping/route.ts` (new — cheap probe, no DB)
- `lib/cleanup.ts` (new — per-utterance + rolling cleanup prompts)
- `lib/encounter.ts` (new — start, audio-chunk, finalize lifecycle)
- `lib/auth-lockout.ts` (new — failed-attempt escalation logic)
- `components/recorder/RecordingControls.tsx` (new)
- `components/recorder/TranscriptEditor.tsx` (new)
- `components/recorder/PreflightModal.tsx` (new)
- `components/CcPickerModal.tsx` (new)
- `components/PinPad.tsx` (new)
- `components/ui/*` (new — shadcn primitives)

### Dependencies on V

- Test recordings on V's iPhone + an Android (if available)
- Tune the per-utterance cleanup prompt against V's voice patterns

---

## 6. Sprint 2 — Pipeline + library (~5 days · ~40h)

### Goal

V records 5 encounters end-to-end. Each generates a structured note + CDMSS analysis with ≥1 citation. Library shows all 5 with correct grouping. Pipeline p50 < 60s.

### Exit criteria (PRD §9)

- §4.10 Medical Encounter Note schema enforced on `note_json`
- §4.11 CDMSS schema enforced on `cdmss_json`
- ≥1 citation per CDMSS suggestion that survives `citation-check.ts`
- Pipeline p50 < 60s on warm Mac Mini
- Library list shows date-grouped encounters with correct status badges
- Library detail renders the encounter, the note, and the violet CDS card
- Doctor can delete an encounter (tombstone-not-purge per §4.17)

### Design surfaces

- **Mobile Doctor App.pdf** pages 56–117 — §8.1.6 Submit processing, §8.1.7 Library list, §8.1.8 Library detail, §8.1.9 Settings, §8.1.10 Modals & toasts

### Tasks

| # | Task | Hours |
|---|---|---|
| 2.1 | `lib/note-pipeline.ts` — draft (qwen2.5:14b streaming) → critique (qwen2.5:7b) → revise (qwen2.5:7b). Enforces §4.10 schema. Co-extracts patient_name/age/sex/chief_complaint per §4.8. Wrapped in `tracedChat`. | 6 |
| 2.2 | `lib/cdmss-pipeline.ts` — HyDE (llama3.1:8b) → multi-query (4 variants) → hybrid retrieve (vector + BM25 RRF fusion per variant) → fused chunk pool → draft (qwen2.5:14b streaming) → critique → revise. Enforces §4.11 schema. Uses `citation-check.ts` to strip hallucinated chunk_ids. | 8 |
| 2.3 | `app/api/encounter/[id]/finalize/route.ts` — fire both pipelines in parallel, wait `Promise.all`, persist `note_json` + `cdmss_json`, transition `encounter.status` to `complete`. NDJSON stream events to client per `mc__llm-trace` pattern. | 3 |
| 2.4 | `app/api/encounter/[id]/status/route.ts` — SSE stream of per-stage events. Closes on `done` / `error` / `aborted`. | 2 |
| 2.5 | §8.1.6 Submit processing screen — dual `TracePanel` cards (note pipeline blue, CDS pipeline violet), per-stage check/spinner, progress bar, ETA per stage from `mcp__llm/stage-medians`. Cancel-and-edit escape hatch. | 4 |
| 2.6 | `app/api/library/route.ts` — paginated list, filter by status, search (v2 — disabled UI in v1). Filter by `doctor_id` from JWT. | 2 |
| 2.7 | §8.1.7 Library list — date-grouped, status badges, empty state, loading skeleton, pull-to-refresh, long-press context menu. | 3 |
| 2.8 | `app/api/encounter/[id]/route.ts` — GET full encounter (own only), PATCH edit per §4.3 (re-renders email but does NOT auto-resend), DELETE soft delete. | 2 |
| 2.9 | §8.1.8 Library detail — full note rendering (mixed prose + structured tables), violet CDS card, citation chips (tap-to-expand chunk preview), collapsed transcript, Re-send modal, Delete modal per §4.17. | 6 |
| 2.10 | §8.1.9 Settings — read-only profile, URL display + Copy, session info, Lock app, About. Wire `POST /api/settings/pin/change`. | 3 |
| 2.11 | §8.1.10 Modals & toasts — confirm modal, bottom-sheet modal, toast variants (success/error/info/warning). | 1 |

### Files created / touched

- `lib/note-pipeline.ts` (new)
- `lib/cdmss-pipeline.ts` (new)
- `lib/cdmss/expand.ts` (lift from CDMSS)
- `lib/cdmss/retrieve.ts` (lift from CDMSS — pay attention to `bm25Query` narrow-query pattern)
- `lib/cdmss/citation-check.ts` (already lifted Sprint 0)
- `lib/note-schema.ts` (new — Zod for MedicalEncounterNote per §4.10)
- `lib/cdmss-schema.ts` (new — Zod for CdmssAnalysis per §4.11)
- All `app/api/encounter/[id]/*` routes (touch / new)
- All `app/api/library/*` routes (new)
- All `app/api/settings/*` routes (new)
- `app/(mobile)/dr/[slug]/processing/[id]/page.tsx` (new)
- `app/(mobile)/dr/[slug]/library/page.tsx` (new)
- `app/(mobile)/dr/[slug]/library/[id]/page.tsx` (new)
- `app/(mobile)/dr/[slug]/settings/page.tsx` (new)
- `components/encounter/NoteRenderer.tsx` (new)
- `components/encounter/CdmssCard.tsx` (new)
- `components/encounter/CitationChip.tsx` (new)
- `components/encounter/PrescriptionTable.tsx` (new)
- `components/encounter/VitalsGrid.tsx` (new)
- `components/library/EncounterCard.tsx` (new)
- `components/ui/*` (additions)

---

## 7. Sprint 3 — Email + admin foundation (~4 days · ~32h)

### Goal

V onboards a second doctor via admin panel. That doctor records an encounter. Email arrives correctly formatted. Resend `email.opened` events appear in admin Sends dashboard.

### Exit criteria (PRD §9)

- Email renders correctly on Gmail mobile + desktop + at least one other client (Apple Mail / Outlook)
- Violet CDS card renders with correct treatment
- Subject line uses token template `[Even] {patient_name}, {patient_demo} · {chief_complaint} · {date}`
- Tokens rendered server-side at send time (reflects post-finalize edits)
- Resend webhook signatures verified
- Retry policy: 3 attempts exponential (60s, 5min, 30min)
- Admin login works (separate JWT audience from doctor)
- V onboards a second doctor end-to-end: create → generate URL → email URL → that doctor lands on PIN screen
- Every admin mutation writes an `audit_log` row

### Design surfaces

- **Email Template.pdf** (7pp) — inbox preview, desktop hero, mobile responsive, design rationale annotations
- **Admin Desktop.pdf** pages 1–8 — Surface 1 Dashboard, Surface 2 Doctors list, Surface 3 Doctor detail + onboard flow

### Tasks

| # | Task | Hours |
|---|---|---|
| 3.1 | `lib/email-template.tsx` — React Email components matching §8.2 spec. Header bar, title, summary, note sections (prose + tables for vitals/Rx/referrals), violet CDS card, References footer, "Open in app" deep link. Subject token rendering helper. | 6 |
| 3.2 | `lib/email-send.ts` — Resend client wrapper. Renders template server-side. Tags every send `app=eta`, `doctor=<id>`, `encounter=<id>`. Creates `send_event` rows. Honors `settings.block_on_critique_fail`. | 3 |
| 3.3 | `lib/email-retry.ts` — exponential backoff (60s, 5min, 30min). Background job triggered by `email.send` failure. Updates `send_event.status` through the funnel. After 3 retries, `failed_permanent`. | 2 |
| 3.4 | `app/api/webhooks/resend/route.ts` — signature verification with `RESEND_WEBHOOK_SECRET`. Looks up `send_event` by `resend_message_id`. Updates status (delivered/opened/bounced/complained). Writes audit_log entry. | 2 |
| 3.5 | Auto-send trigger — when `pipeline.process` completes successfully, fire `email.send`. Update encounter `send_status`. | 1 |
| 3.6 | `app/api/admin/auth/login/route.ts` + `logout` — separate JWT audience (`admin`). bcrypt verify against `admin_user.password_hash`. Admin token via Brief §4.16 ADMIN_TOKEN env var as bootstrap fallback. | 3 |
| 3.7 | `lib/with-audit.ts` — wrapper around admin mutation routes. Writes `audit_log` row in same transaction. Required for every admin POST/PATCH/DELETE. | 1 |
| 3.8 | `app/{ADMIN_BASE_PATH}/layout.tsx` — admin shell: sidebar, topbar with breadcrumb + search + notification + avatar. | 3 |
| 3.9 | `app/{ADMIN_BASE_PATH}/page.tsx` — §8.3.2 Dashboard. KPI cards (active doctors, encounters today, failed sends, locked doctors, LLM error rate). 7-day chart. Recent activity feed. Service health row. | 4 |
| 3.10 | `app/{ADMIN_BASE_PATH}/doctors/page.tsx` — §8.3.3 Doctors list. Filter (active/disabled/locked). Sortable columns. Status pills color-coded. Row-hover action menu. | 3 |
| 3.11 | `app/{ADMIN_BASE_PATH}/doctors/new/page.tsx` + `app/api/admin/doctors/route.ts` POST — onboard flow. Create doctor → generate slug + 4-char URL token (alphabet `abcdefghjkmnpqrstuvwxyz23456789` per §4.14) → bcrypt PIN → optionally email URL. | 3 |
| 3.12 | `app/{ADMIN_BASE_PATH}/doctors/[id]/page.tsx` — §8.3.3 Profile. Edit fields. Display URL + Copy. Rotate URL token. Reset PIN. Unlock account. Force logout. Disable / Enable. Soft delete. Recent encounters list. Audit log slice. | 5 |

### Files created / touched

- `lib/email/template.tsx` (new)
- `lib/email/send.ts` (new)
- `lib/email/retry.ts` (new)
- `lib/email/subject.ts` (new — token rendering)
- `lib/with-audit.ts` (new)
- `lib/admin-auth.ts` (new)
- `app/api/webhooks/resend/route.ts` (new)
- `app/api/admin/auth/login/route.ts` + `logout` (new)
- All `app/api/admin/doctors/*` routes (new)
- `app/{ADMIN_BASE_PATH}/layout.tsx` (new)
- `app/{ADMIN_BASE_PATH}/page.tsx` (new — Dashboard)
- `app/{ADMIN_BASE_PATH}/doctors/page.tsx` (new)
- `app/{ADMIN_BASE_PATH}/doctors/new/page.tsx` (new)
- `app/{ADMIN_BASE_PATH}/doctors/[id]/page.tsx` (new)
- Admin shell components: `Sidebar`, `Topbar`, `KpiCard`, `HealthRow`, `ActivityFeed` (new)
- `components/admin/DoctorTable.tsx` (new)
- `components/admin/DoctorProfileForm.tsx` (new)

---

## 8. Sprint 4 — Admin observability + remaining surfaces (~4 days · ~32h)

### Goal

V can investigate any encounter from any angle (transcript / note / CDMSS / send / traces / audit) and retry/delete from the UI. The system explains itself.

### Exit criteria (PRD §9)

- Encounter list filters by doctor, date, status, pipeline-vs-send state
- Encounter detail surfaces the 7-stage pipeline trace + tabbed body + send timeline + audit + danger zone
- LLM Traces list aggregates per-surface stats (count, errors, p50, p90)
- Trace detail shows full prompt + completion + request params + timing breakdown + sibling traces
- Sends dashboard shows Resend webhook funnel + per-domain delivery rate
- Settings sub-pages: global CCs, retention (read-only v1), Resend config (read-only), health
- All admin mutations audit-logged

### Design surfaces

- **Admin Desktop.pdf** pages 9–19 — Surface 4 Encounters list, Surface 5 Encounter detail (the investigation surface), Surface 6 LLM Traces list, Surface 7 Trace detail, Surface 8 Sends, Surface 9 Settings sub-pages

### Tasks

| # | Task | Hours |
|---|---|---|
| 4.1 | `app/{ADMIN_BASE_PATH}/encounters/page.tsx` — §8.3.4 Encounters list. Cross-doctor. Date-grouped. Filters (doctor, date range, status). Row-hover action menu. | 3 |
| 4.2 | `app/{ADMIN_BASE_PATH}/encounters/[id]/page.tsx` — §8.3.4 Encounter detail. Hero + 7-stage pipeline trace + tabbed body (Note / Transcript / CDMSS / Send / Audio / Audit) + right rail (Send status with per-recipient timeline, audit log, danger zone). | 6 |
| 4.3 | `app/api/admin/encounters/[id]/resend/route.ts` — re-fire `email.send`. Audit-logged. | 1 |
| 4.4 | `app/api/admin/encounters/[id]/route.ts` DELETE — soft delete. `?hard=true` for permanent (cascades traces, send_events; queues R2 object for deletion). Reconfirm modal in UI. | 2 |
| 4.5 | `app/{ADMIN_BASE_PATH}/traces/page.tsx` — §8.3.5 LLM Traces dashboard. Per-surface aggregates via `percentile_cont` query. Filter pills (surface / model / status / date). Direct port of OPD `src/app/llm/dashboard/page.tsx`. | 3 |
| 4.6 | `app/{ADMIN_BASE_PATH}/traces/[id]/page.tsx` — §8.3.5 Trace forensic detail. Full prompt + completion in code blocks. 5-card metric strip. Request params. Timing breakdown. Sibling traces. Direct port of OPD `src/app/llm/trace/[id]/page.tsx`. | 3 |
| 4.7 | `app/{ADMIN_BASE_PATH}/sends/page.tsx` — §8.3.6 Sends. Resend webhook event stream. KPIs (sent / delivered / opened / bounced). Delivery funnel viz. Status filters. Per-recipient domain table. | 4 |
| 4.8 | `app/{ADMIN_BASE_PATH}/sends/funnel/route.ts` + `app/api/admin/sends/[id]/resend/route.ts` — funnel aggregation + single-message resend. | 2 |
| 4.9 | `app/{ADMIN_BASE_PATH}/settings/global-cc/page.tsx` — §8.3.7. List editor: add, remove, save. | 2 |
| 4.10 | `app/{ADMIN_BASE_PATH}/settings/retention/page.tsx` — informational v1 ("Audio retained indefinitely. Doctor and admin deletion paths available."). v2 controls. | 0.5 |
| 4.11 | `app/{ADMIN_BASE_PATH}/settings/resend/page.tsx` — read-only display of `RESEND_FROM_EMAIL`, sandbox/production toggle. | 1 |
| 4.12 | `app/{ADMIN_BASE_PATH}/settings/health/page.tsx` — same probes as `/api/health` with traffic-light visual. | 1.5 |
| 4.13 | `app/api/admin/settings/route.ts` GET + PATCH — settings singleton CRUD. | 1 |
| 4.14 | Audit-log infinite-scroll + filters across admin (cross-cutting). | 2 |

### Files created / touched

- All `app/api/admin/encounters/*` routes (new)
- All `app/api/admin/traces/*` routes (new — port from OPD)
- All `app/api/admin/sends/*` routes (new)
- All `app/api/admin/settings/*` routes (new)
- All `app/{ADMIN_BASE_PATH}/encounters/*` pages (new)
- All `app/{ADMIN_BASE_PATH}/traces/*` pages (new — port from OPD)
- All `app/{ADMIN_BASE_PATH}/sends/*` pages (new)
- All `app/{ADMIN_BASE_PATH}/settings/*` pages (new)
- `components/admin/PipelineTrace.tsx` (new — 7-stage horizontal trace, matches mobile dual-card spec)
- `components/admin/SendTimeline.tsx` (new)
- `components/admin/AuditLogList.tsx` (new)
- `components/admin/HealthGrid.tsx` (new)

---

## 9. Sprint 5 — Hardening + launch (~3 days · ~24h)

### Goal

§10 launch metrics tracked. V signs off for broader rollout.

### Exit criteria (PRD §9, §10.1)

- Pipeline end-to-end completion ≥99%
- Email send success ≥98%
- Pipeline p50 < 60s · p95 < 90s
- 0 audio data loss in tested offline scenarios
- PIN auth median <1s
- 100% admin actions audit-logged
- Cost per encounter <$0.20
- Documentation complete

### Tasks

| # | Task | Hours |
|---|---|---|
| 5.1 | Performance pass: cold-start latencies on tunnel endpoints, request retry resilience, p95 latency budgets. Profile any p95 outliers. | 4 |
| 5.2 | PIN lockout production-hardening: per-slug rate limit (1/sec, 60/hr), abuse-pattern logging, IP-based throttling on the `/api/auth/pin` endpoint. | 3 |
| 5.3 | R2 deletion job — async worker that processes the queue of hard-deleted encounters and deletes their audio blobs. Idempotent. | 2 |
| 5.4 | `pin_attempt` 90-day TTL cron — daily job that trims rows older than 90 days. Only TTL table in v1. | 1 |
| 5.5 | Offline scenario test pass — record offline → reconnect → submit; record with mid-recording dropout → reconnect → resume; record with backgrounding mid-recording → foreground → resume. Document any data-loss cases (target: zero). | 4 |
| 5.6 | `README.md` — bootstrap, env-var checklist, deploy procedure, smoke-test commands. | 2 |
| 5.7 | `RUNBOOK.md` — ops procedures: how to investigate a failed send, how to investigate a stalled pipeline, how to rotate a doctor's URL token, how to unlock a doctor account, how to roll back a deploy, how to kill a bad service worker (the `sw-killswitch.txt` flip). | 3 |
| 5.8 | `ONBOARDING-SCRIPT.md` — V's onboarding script for new doctors. Step-by-step what to say + click + send. | 1 |
| 5.9 | `CARRYOVER.md` — handoff doc matching the OPD-Encounter-App / EvenOS pattern. Architecture summary, env vars, key patterns, gotchas, pending backlog. | 2 |
| 5.10 | Soft launch to 3–5 doctors at Even Hospital. Daily standup with V for first week. Triage issues. | 2 |

---

## 10. Cross-cutting concerns

### 10.1 Database migrations

- Numbered `db/migrations/0001_init.sql` etc.
- Migration runner reads `schema_migrations` table to avoid double-apply.
- Each migration wrapped in `BEGIN/COMMIT` with an `INSERT INTO schema_migrations` at end.
- For local dev: `npm run db:push` (drizzle direct push). For prod: migration applied via `POST /api/run-migrations` with Bearer `MIGRATION_SECRET`.
- Per OPD lesson: `splitSqlStatements` doesn't handle quoted strings with semicolons. Feed whole chunk to `pg.query()` (no parameters) and let Postgres' lexer parse.

### 10.2 Secrets and env vars

- All sensitive values in Vercel encrypted env (Sensitive type, not Plain).
- Generation: `openssl rand -base64 48` for JWT secrets and ADMIN_TOKEN; `openssl rand -hex 16` (32 chars) for ADMIN_BASE_PATH.
- Never echo a sensitive value in chat, commit message, PR description, or log line.
- Rotation: admin UI exposes "Rotate URL token" for doctors. JWT secret rotation requires deploy + re-login for all users.

### 10.3 LLM trace observability

- Every LLM call goes through `tracedChat()` from `lib/trace.ts`. No direct `llm.chat.completions.create()` allowed.
- `tracedChat()` writes a `trace_events` row before AND after every call. Captures full prompt, full response, latency, tokens, model.
- Routes that fire multi-stage pipelines call `startTrace('surface-name')` at top, emit progress events via `emit({ type: 'progress', stage, msg, ms })`, and `finishTrace(traceId, outcome)` at end.
- Heartbeat collapse per OPD v6 decision Q3: long LLM calls wrapped in `withHeartbeat(emit, stage, label, fn)` emit `<stage> (Ns on this phase)` every 5s. Client `pushTrace` collapses into one ticking row.
- `lib/qwen.ts` accepts `signal: AbortSignal` so client disconnect cancels Mac Mini fetch (saves wasted compute on abandoned encounters).

### 10.4 Admin audit logging

- Every admin POST/PATCH/DELETE wraps the handler in `withAudit(action, target, fn)`.
- `withAudit` writes an `audit_log` row in the same transaction as the mutation.
- Namespaced action strings: `doctor.create`, `doctor.disable`, `pin.reset`, `url.rotate`, `encounter.delete`, `encounter.resend`, `settings.update`, etc.
- Read endpoints not audited (too noisy; auth log is enough).
- Audit log surfaces in doctor detail panel + per-encounter audit log + cross-cutting audit infinite-scroll (Sprint 4).

### 10.5 Auth and authorization

- Doctor JWT: audience `doctor`, cookie `eta_session`, `HttpOnly` + `Secure` + `SameSite=Strict`, `Path=/{slug}-{token}/`, `Max-Age=30 days`, rolling renewal.
- Admin JWT: audience `admin`, cookie `eta_admin_session`, `Path=/{ADMIN_BASE_PATH}/`, otherwise same attributes.
- Cross-class tokens rejected at middleware layer.
- Every doctor-scoped endpoint filters by `doctor_id` from JWT, NEVER from query param or body. Cross-doctor leakage is the highest-priority anti-pattern.
- Admin can impersonate-view (read-only) any doctor's library via admin routes; cannot pose as a doctor (no admin → doctor JWT issuance).
- PIN rate limit: 1/sec per slug, 60/hr per slug, applied at API layer in addition to `failed_pin_attempts` escalation.

### 10.6 Error handling and retry

- All API responses go through `respond()` helper that enforces §7.5 error envelope:
  ```json
  { "error": { "code": "PIN_LOCKED", "message": "...", "retry_after_seconds": 900, "trace_id": "req_..." } }
  ```
- Error codes: `PIN_INVALID`, `PIN_LOCKED`, `PIN_NOT_SET`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED`, `PIPELINE_FAILED`, `SEND_FAILED`, `UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`.
- Email retry: 3 attempts exponential (60s, 5min, 30min). After 3, `failed_permanent` — manual resend only.
- Pipeline retry: NOT automatic. Failed pipelines surface in admin Encounter detail with [Retry processing] button. Manual.
- Transcription dropout: silent retry once for Whisper; exponential backoff reconnect for Deepgram WebSocket.

### 10.7 Mobile PWA

- Target viewport: 380px (iPhone SE) up to 768px (tablet portrait).
- 44pt tap targets minimum.
- MediaRecorder API + webm/opus encoding.
- Service worker cache name `eta-shell-v1`. Bump on every breaking change to invalidate prior installs.
- `sw-killswitch.txt` available at `/sw-killswitch.txt` — flip to `"killed"` to unregister all installed SWs in the field (escape hatch for bad SW deploys).
- iOS Safari hardening: `ndjson-client.ts` handles "Load failed" quirk; MediaRecorder pause/resume tested across iOS 14.3+ and Chrome.
- Background-recording resilience: iOS audio-session interruption (call comes in) → auto-pause + persist state to localStorage; foreground → restore.
- `autocomplete="off"` + `spellcheck="false"` + `autocapitalize="off"` + `data-gramm="false"` on every transcript edit surface.

### 10.8 Accessibility

- WCAG 2.1 AA color contrast on every text-on-background pair (Design System tokens are pre-validated).
- Numeric PIN pad buttons aria-labeled.
- PIN dots have aria-live region.
- Form inputs have `<label>` association.
- Status badges have icon + text (color is not the only signal).
- 14px body minimum (Design System lock).
- Keyboard navigation supported on admin desktop (mobile is touch-first).

---

## 11. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Mac Mini Ollama tunnel goes down mid-recording → cleanup pass fails | High | Cleanup pass is non-blocking — failure logs to trace dashboard, raw Deepgram text remains. UI never shows the failure to the doctor. |
| R2 | Whisper rolling chunk swap collides with doctor's active edit → text yanked from under cursor | High | Cursor-focus detection suppresses the swap. 200ms gentle highlight when swap was deferred for later. Tested on iOS Safari + Chrome. |
| R3 | qwen2.5:14b emits malformed JSON for note schema | Medium | `parseLooseJson` + critique pass + revise pass. Double-quote discipline in SYSTEM and REVISION prompts (anti-pattern memory from CDMSS). Zod validation at API boundary. |
| R4 | CDMSS pipeline cites a chunk_id not in the retrieved set | Medium | `citation-check.ts` `stripHallucinatedCitations()` defensive guard. Hallucinated citations dropped server-side before persistence. |
| R5 | Doctor records 30+ minute encounter, audio blob is huge | Low | R2 storage costs are negligible per encounter. Vercel function timeout 5min hard cap — chunked uploads + finalize separation handles this. |
| R6 | Resend webhook reaches us out of order or duplicated | Medium | Idempotency: `send_event.status` transitions are monotonic. Duplicate event = no-op. Out-of-order = latest event wins (status enum is total-ordered). |
| R7 | Deepgram WebSocket drops mid-recording, doctor loses audio | High | MediaRecorder continues locally during drop. Audio buffered locally. On reconnect, audio resumes streaming to Deepgram. Whisper rolling chunks independent — keep transcribing during the WS drop. |
| R8 | Doctor accidentally hits Submit before pipelines can complete | Low | Submit goes to processing screen; can't double-submit. Cancel-and-edit returns to finalize. |
| R9 | Admin URL leaks via screenshot / pasted in Slack | High | The PIN is the real security boundary. Admin URL plus PIN per §4.16 is the lock. URL discovery alone doesn't grant access. |
| R10 | Cross-doctor data leakage via query-param spoofing | Critical | Every doctor-scoped endpoint filters by `doctor_id` from JWT, never from query param. Code review checklist item. |
| R11 | Mac Mini reboot loses `OLLAMA_CONTEXT_LENGTH=16384` env → prompts silently clamp to 4096 | High | Documented in OPD CARRYOVER. Set in LaunchAgent persisted file. Verify on every Mac Mini reboot via `curl localhost:11434/api/ps`. |
| R12 | Sandbox `/sessions` disk fills during build (the pip install lesson) | Medium | Don't `npm install` in sandbox. Edit TS files; let Vercel's npm install run during deploy. Keep dev work in `/tmp` not `/sessions`. |

---

## 12. Success criteria

### Launch-day (must hold from day 1, per PRD §10.1)

| Criterion | Target |
|---|---|
| Pipeline end-to-end completion | ≥99% |
| Email send success (incl. retries) | ≥98% |
| Pipeline p50 latency | <60s |
| Pipeline p95 latency | <90s |
| Audio data loss in tested offline scenarios | 0 |
| PIN auth median latency | <1s |
| Admin actions audit-logged | 100% |
| Resend webhook reliability | 100% events processed |
| Cost per encounter | <$0.20 |

### 30-day adoption (PRD §10.2)

| Criterion | Target |
|---|---|
| Doctors onboarded | ≥5 |
| Total encounters | ≥50 |
| Active doctors (≥3 enc/wk) | ≥3 |
| Transcript edits per encounter | median ≤1 |
| "Did not need to re-do the note" | qualitative ≥70% |
| Send open rate | ≥50% |
| Investigation time on failures | <30s from dashboard to root cause |
| Doctor self-resolves PIN/URL issues without contacting V | ≥80% |

### Qualitative gates before broader rollout (PRD §10.3)

- V uses the system on his own patients for ≥1 week before doctor #2
- ≥2 doctors beyond V describe the system as "saving time"
- Zero PHI leaks: no `audit_log` entries indicating unauthorized cross-doctor access
- Pipeline trace screen has been used by V to investigate ≥1 real failure successfully

---

## 13. Out of v1 (parked for v2+)

From PRD §3.2, §4.20, §9 out-of-v1 list:

- Standalone "voice notes" (short-form dictation outside encounter context)
- Integration with OPD-Encounter-App as a recording source
- ICD-10 extraction with KB-cited evidence
- Coach mode (Socratic teaching on past encounters)
- Clinical calculators in-app (eGFR, NEWS2, ABG, hyponatremia, sepsis)
- qwen-vision OCR of photographed paper notes
- Patient-side outputs (anything sent to patients directly)
- Multi-hospital tenancy
- Cross-language transcription / translation (English + Hinglish only via Whisper defaults)
- HIS / EHR write-back (KareXpert, etc.)
- Self-service doctor signup
- Password / magic-link auth (PIN only)
- Native iOS / Android apps (PWA only)
- PDF email attachments (HTML only)
- Per-encounter granular retention controls (v1 is keep-forever)
- Search across past encounters (`q=<text>` query in `/api/library` is UI-disabled in v1)
- Editing past encounters post-submit (only re-send)
- Draft mode (save partial encounter pre-submit)
- Sharing encounters between doctors / handoff
- Formal compliance certification (HIPAA, DPDP audit pass) — see §4.20
- `admin_actions` table beyond the existing audit_log
- `/privacy` public route
- `/api/health/version` endpoint with commit SHA
- DPO contact in app footer
- Vendor due diligence documentation
- Background sync of audio chunks via Service Worker
- Recording fully offline-from-scratch (no network at start)

### v1.5 / v2 trigger conditions (PRD §4.20)

Compliance work gets promoted if any of these fires:

- First doctor outside Even Hospital is onboarded
- Any regulatory inquiry, audit, or stakeholder formal review
- Any compliance-relevant incident (real or near-miss)
- Even Hospital's internal counsel raises formalization as a requirement
- Doctor count exceeds ~5 (single-admin / single-policy assumptions strain)

---

## 14. References

- **`EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md`** — product spec (2,238 lines)
- **`COWORK-BUILD-BRIEF.md`** — working agreements + tech-stack locks
- **`EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md`** — extraction map from predecessor repos
- **`Daily Dash EHRC/ETA/Even Encounter Assistant — v1.pdf`** — Design System (5pp)
- **`Daily Dash EHRC/ETA/Even Encounter Assistant — Mobile Doctor App.pdf`** — mobile screens (117pp)
- **`Daily Dash EHRC/ETA/Even Encounter Assistant — Admin Desktop.pdf`** — admin surfaces (19pp)
- **`Daily Dash EHRC/ETA/Even Encounter Assistant — Email Template.pdf`** — email design (7pp)
- **`Daily Dash EHRC/ETA/Even Encounter Assistant — Flows.pdf`** — user journeys (7pp)
- **OPD-Encounter-App** — `vinaybhardwaj-commits/OPD-Encounter-App` (Tier 1 + 2 lifts)
- **Even-CDMSS** — `vinaybhardwaj-commits/Even-CDMSS` (Tier 1 + 2 lifts)
- **Figma file (cloud)** — https://www.figma.com/design/1MwbnF1HubCOyTEIn7EM5U

---

## Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 26 May 2026 | Vinay + Claude | Initial draft synthesizing PRD §9 + Brief §6 + Source Catalog §10 + §12 reply |

### Sprint exit log (filled as we go)

| Sprint | Exit date | What shipped | Lessons |
|---|---|---|---|
| 0 | — | — | — |
| 1 | — | — | — |
| 2 | — | — | — |
| 3 | — | — | — |
| 4 | — | — | — |
| 5 | — | — | — |
