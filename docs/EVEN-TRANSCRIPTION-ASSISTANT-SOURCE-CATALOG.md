# Even Transcription Assistant — Source Catalog & Extraction Plan

**Author:** Claude (under V's direction)
**Date:** 26 May 2026
**Status:** v0.2 — pre-PRD scan with GitHub code-level verification of both repos complete. Catalog of reusable assets from `OPD-Encounter-App` and `Even-CDMSS`.
**Purpose:** Single source of truth for what code, features, and infrastructure carries forward into the new Even Transcription Assistant mobile-first app. Built BEFORE the UI/Figma work and BEFORE the new PRD.
**Source priority used:** Project knowledge documents first, then GitHub repo clone + code read for verification.

**Changelog:**
- **v0.2 (this rev)** — Added §10 Even-CDMSS code-level verification with file-by-file pattern map (cloned + read). Confirmed Even-CDMSS is PUBLIC (carryover doc called it "private" — stale). Added PWA service worker to Tier 1 lifts. Added calculator/safety-regex/citation-check patterns. Added canonical RAG route scaffold.
- **v0.1** — Initial scan from project knowledge docs only.

---

## 0. Critical finding (READ FIRST)

**The three relevant repos and what's actually in each (verified 26 May 2026):**

| Repo | Status | Verified contents |
|---|---|---|
| `vinaybhardwaj-commits/OPD-Encounter-App` (public) | ✅ Active | Next.js 15.5.18 + React 19 OPD encounter app. **178 commits, 109 tags.** Latest tag `v6.1-shipped` at `df50a57`. Has the dual-engine transcription stack we want. |
| `vinaybhardwaj-commits/Even-CDMSS` (public — **not private** as the 20 May carryover claimed) | ✅ Active | Next.js 15.5.18 + React 19 + Neon pgvector + Ollama bridge. **95 commits, 25 tags, 118 files, ~98.9% TypeScript.** Cloned + inspected directly. Has /ask, /ddx, /coach, /drugs, /review, /topics, /search, /calculators (5), /admin surfaces. **Already a PWA** (service worker + manifest). |
| `vinaybhardwaj-commits/even-staff-portal` (public) | ⚠️ Legacy | Still the **old static HTML portal** (Google-Sheets-CMS, GitHub Pages). Only 17 commits, just `index.html` + `README.md`. **None of the CDMSS code has migrated here yet** despite the v1 PRD plan. |

**Implication:** The Staff Portal V1 PRD (21 May 2026) planned to merge `Even-CDMSS` → `even-staff-portal` (Sprint SP.0 → SP.8), but that migration hasn't shipped to GitHub `main` yet. The Vercel project `evenstaffportal` running v1.7+ work either deploys from a branch on `Even-CDMSS` (more likely), or from a different repo we haven't seen.

**For our purposes**: extract from `Even-CDMSS` and `OPD-Encounter-App` directly. The static `even-staff-portal` repo is not a source.

**Cross-link:** The KB Neon database (`KB_DATABASE_URL`, 304k chunks of MKSAP/StatPearls/UpToDate/OpenFDA/PubMed) is already **shared between OPD-Encounter-App and `evenstaffportal`** per `OPD-ENCOUNTER-APP-CARRYOVER.md` §11. The new Transcription Assistant can read from the same KB on day one if we want clinical grounding.

---

## 1. New app at a glance (working assumption — to be locked in PRD)

**Name:** Even Transcription Assistant
**Form factor:** Mobile-first web app (PWA-ready)
**Users:** Doctors (Even Hospital + Even Hospital System, and possibly external pilots)
**Two primary workflows:**
1. **Patient encounter recording** — long-form ambient recording of a patient visit, transcribed and LLM-cleaned into structured notes (SOAP / chief complaint / assessment / plan).
2. **Medical voice notes** — short ad-hoc dictations (clinical thoughts, follow-up reminders, teaching pearls, draft messages), transcribed and tagged.

**Stack (proposed, to confirm in PRD):**
- Next.js 15 + React 19 + Tailwind 3 (matches both source projects, lets us copy code 1:1)
- **New Neon Postgres DB** — separate from OPD + Even-CDMSS, but read-only access to `KB_DATABASE_URL` if/when we add CDMSS grounding
- **New GitHub repo** — `vinaybhardwaj-commits/even-transcription-assistant` (suggested)
- **New Vercel project** — `even-transcription-assistant` on the same `bom1` Mumbai region as the others, same `team_yu1wWpsKdjsf90haai1ETJDG` team
- **Existing Cloudflare tunnels** (no new infra needed):
  - `llm.llmvinayminihome.uk/v1` → Ollama on Mac Mini (qwen2.5:14b, llama3.1:8b, qwen2.5vl:7b, nomic-embed-text, mxbai-embed-large)
  - `whisper.llmvinayminihome.uk` → whisper.cpp on Mac Mini (whisper large-v3-turbo)
- **Auth:** new JWT cookie pattern based on OPD's `src/lib/auth.ts` (jose HS256); no SSO until v2

---

## 2. Asset inventory — OPD-Encounter-App (transcription side)

### 2.1 The transcription stack (the core ask)

This is the lift-and-shift backbone of the new app. All five files below land verbatim or near-verbatim.

| File (in OPD repo) | What it does | Lift verbatim? |
|---|---|---|
| `src/lib/transcribe.ts` | Deepgram client — `nova-3-medical` model. POST to Deepgram's REST API with audio bytes, returns `{transcript, latency_ms}`. Reads `DEEPGRAM_API_KEY` env. | ✅ Yes |
| `src/lib/whisper.ts` | Mac Mini `whisper.cpp` HTTP client. POST multipart to `WHISPER_BASE_URL/inference` (`localhost:8080` via Cloudflare tunnel). Returns `{transcript, latency_ms}`. | ✅ Yes |
| `src/lib/transcribe-compare.ts` | Parallel runner: fires Deepgram + Whisper concurrently with `Promise.allSettled`, then runs a **qwen2.5:14b judge prompt** that compares the two transcripts on clinical correctness/completeness/fidelity and emits a winner + per-engine score (1–10). Has `emit + signal` hooks for v6 LLM trace streaming. Persists a row to `transcription_comparisons`. | ✅ Yes — this is THE primary asset |
| `src/lib/qwen.ts` | Generic Ollama OpenAI-compatible chat client. Reads `LLM_BASE_URL` + `LLM_API_KEY`. Supports `{signal: AbortSignal}` for cancellable calls (v6 decision Q5). Supports `parseLooseJson` for structured outputs. | ✅ Yes |
| `src/lib/qwen-vision.ts` | qwen2.5vl:7b client for lab-PDF OCR. **Only needed in v2 if we want to OCR handwritten notes / lab reports the doctor photographs during a voice note.** Defer. | ⏳ v2 candidate |

### 2.2 Transcription UI components

| Component | What it does | Lift verbatim? |
|---|---|---|
| `src/components/DictateButton.tsx` | Push-to-hold or click-to-toggle dictation button. Renders `<TracePanel surface="transcribe-compare">` once recording stops. Uses MediaRecorder API; encodes to webm/opus. Calls `/api/encounters/[id]/dictations` (in OPD) — endpoint URL will change for new app. | ✅ Mostly — rewire endpoint URL |
| `src/components/VoiceQueryFab.tsx` | Floating action button for "ask the chart" / voice query. Push-to-talk. After release: Deepgram transcribes → qwen reasons → reply. Shows TracePanel during the multi-stage call. **Direct match for the new app's "Medical voice notes" workflow.** | ✅ Adapt heavily |
| `src/components/AmbientRecorder.tsx` | Long-form ambient recording controller. Starts/stops, manages chunked uploads, shows live duration. **Direct match for the "Patient encounter recording" workflow.** | ✅ Adapt |
| `src/components/TranscriptViewer.tsx` | Read-only transcript display with timestamps, speaker turns if Deepgram diarization is on. | ✅ Yes |
| `src/components/ComparisonCard.tsx` (referenced from build history v6.0 Phase 2 sprint B) | Side-by-side Deepgram vs Whisper transcript with scores + winner highlight + download icons. **Optional in new app** — v1 might hide the comparison and just show the winning transcript; admin trace dashboard reveals the underlying compare. | ⏳ Optional |

### 2.3 Cloudflare tunnel infrastructure (no new work needed)

Already live; the new app just sets env vars to reuse them.

| Tunnel | Cloudflare hostname | Mac Mini target | What it serves |
|---|---|---|---|
| LLM | `https://llm.llmvinayminihome.uk/v1` | `localhost:11434` (Ollama) | All text + vision LLM inference. OpenAI-compatible `/v1/chat/completions` endpoint. |
| Whisper | `https://whisper.llmvinayminihome.uk` | `localhost:8080` (whisper.cpp server) | Audio transcription via POST multipart to `/inference`. Verified live 26 May 2026. |

**Mac Mini config invariants:**
- `OLLAMA_CONTEXT_LENGTH=16384` set via `launchctl setenv` + persisted in LaunchAgent. **Critical** — without it, prompts silently clamp to 4096 tokens (Even-CDMSS-Ollama-num_ctx-Fix.md has the full runbook).
- whisper.cpp running as a server process on port 8080. Verify with `curl -X POST https://whisper.llmvinayminihome.uk/inference -F file=@sample.wav -F response_format=json`.
- Cloudflare DNS proxied (orange cloud) on both subdomains. Tunnel config at `~/.cloudflared/config.yml` with ingress rules for both hostnames.

### 2.4 Database — transcription comparisons schema

OPD migration v36 (`transcription_comparisons`). The new app can copy this verbatim and add encounter/note-specific fields.

```sql
CREATE TABLE transcription_comparisons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  encounter_id    UUID,                   -- nullable in new app (voice notes have no encounter)
  section         TEXT,                   -- e.g. 'chief_complaint', 'voice_note', 'ambient_full'
  audio_blob_url  TEXT,                   -- Vercel Blob URL
  audio_mime      TEXT,                   -- e.g. 'audio/webm;codecs=opus'
  audio_duration_seconds NUMERIC,
  deepgram_transcript TEXT,
  whisper_transcript  TEXT,
  deepgram_latency_ms INTEGER,
  whisper_latency_ms  INTEGER,
  judge_deepgram_score NUMERIC(4,2),
  judge_whisper_score  NUMERIC(4,2),
  judge_winner    TEXT,                   -- 'deepgram' | 'whisper' | 'tie' | NULL on error
  judge_rationale TEXT,
  trace_id        UUID                    -- FK to llm_traces.id, ON DELETE SET NULL
);
CREATE INDEX ON transcription_comparisons (created_at DESC);
CREATE INDEX ON transcription_comparisons (encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX ON transcription_comparisons (trace_id) WHERE trace_id IS NOT NULL;
```

Useful SQL for stats (from `WHISPER-TUNNEL-SETUP.md` §6):
```sql
SELECT COUNT(*) AS n,
       AVG(judge_deepgram_score)::numeric(4,2) AS dg_mean,
       AVG(judge_whisper_score)::numeric(4,2)  AS w_mean,
       AVG(deepgram_latency_ms)::int           AS dg_lat_ms,
       AVG(whisper_latency_ms)::int            AS w_lat_ms,
       COUNT(*) FILTER (WHERE judge_winner='whisper')::float / COUNT(*) AS w_win_rate
FROM transcription_comparisons
WHERE judge_winner IS NOT NULL;
```

### 2.5 LLM Trace Panel system — port wholesale (already proven 2× — staff portal → OPD)

This is the v6.0 capstone from OPD, originally built in staff portal as v2.0.3b. **Same files port a third time into the new app.**

**Foundation files (`src/lib/llm-trace/` — 8 files, ~600 LOC total):**
- `stream.ts` — server-side NDJSON helper. `makeNdjsonStream()` returns `{stream, emit, close}`. Defines `ProgressEvent` union.
- `ndjson-client.ts` — client-side `consumeNdjson(resp, onEvent)`. Handles iOS Safari "Load failed" quirk.
- `format-duration.ts` — `'4.2s'` / `'1:21'` formatter.
- `model-labels.ts` — `sanitizeModelNames` + `modelLabel` (the function that hides "qwen2.5:14b" from clinician UI per v4 design lock).
- `stage-explainers.ts` — per-surface explainer copy. **Will need new surface entries for the transcription assistant** (e.g. `ambient-encounter`, `voice-note`, `note-cleanup`, `coding-extract`).
- `heartbeat.ts` — `withHeartbeat(emit, stage, label, fn)` ticks every 5s during a long LLM call.
- `log.ts` — `openTrace` + `finalise` + `listForEncounter/Patient`. Writes to `llm_traces` table.
- `background-registry.ts` — in-memory client-side fire registry.

**Component files (`src/components/llm-trace/` — 3 files):**
- `TracePanel.tsx` (~430 LOC) — the visual panel. Live progress bar + ETA + per-stage explainer + heartbeat collapse + trace ID footer + "View trace ↗" link. **The mobile-tuned variant for ~380px viewport is already on the OPD v6.2 polish backlog** — we should ship that variant first in the new app.
- `AiActivityList.tsx` — collapsible "AI activity (N)" section.
- `BackgroundTraceToaster.tsx` — bottom-right pills that poll `/api/[scope]/traces` every 3s.

**Database schema — migration v39 (`llm_traces`):**
```sql
CREATE TABLE llm_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surface         TEXT NOT NULL,           -- 'ambient-encounter' | 'voice-note' | 'note-cleanup' | etc.
  doctor_email    TEXT,
  encounter_id    UUID,                    -- nullable; rename to note_id / generic 'context_id' in new app?
  patient_id      UUID,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  total_ms        INTEGER,
  status          TEXT,                    -- 'running' | 'success' | 'error'
  error_message   TEXT,
  events          JSONB,                   -- full event array
  prompt_chars    INTEGER,
  completion_chars INTEGER,
  model           TEXT
);
-- 4 indexes: (surface, started_at DESC), (encounter_id, started_at DESC) WHERE encounter_id IS NOT NULL,
--           (patient_id, started_at DESC) WHERE patient_id IS NOT NULL, (doctor_email, started_at DESC)
```

**Why this matters for the new app:** every transcription run is a multi-stage LLM pipeline (record → upload → transcribe Deepgram in parallel with Whisper → judge → clean / SOAP-structure → optionally extract ICD-10 or comorbidities). The TracePanel turns the unavoidable 5-30 second wait into legible feedback. Without it, doctors stare at a spinner and lose trust within two sessions.

### 2.6 Auth pattern (cookie JWT via jose)

`src/lib/auth.ts` from OPD — HS256 cookie named `opd_session`. Rename cookie to `eta_session` (or similar) for the new app. Same `JWT_SECRET` env var pattern. Same middleware-based route protection. Pattern is short, well-tested, and battle-hardened across both source projects.

### 2.7 Storage (Vercel Blob)

OPD uses `BLOB_READ_WRITE_TOKEN` for lab PDFs, prescription PDFs, dictation audio. The new app uses Vercel Blob for the audio files (record-once, upload, then transcribe). Audio files retained per V's retention policy (suggest 90 days for voice notes, indefinite for patient encounters subject to legal review).

### 2.8 Health endpoint pattern

`/api/health` from OPD probes DB + LLM tunnel + Whisper tunnel + KB. Direct copy for the new app — single endpoint that proves every dependency is alive in one curl. Critical for monitoring + smoke tests after every deploy.

---

## 3. Asset inventory — CDMSS side (currently in private `Even-CDMSS` repo)

### 3.1 CDMSS databank

| Property | Value |
|---|---|
| Database | Neon Postgres (`DATABASE_URL` in CDMSS env, **same as `KB_DATABASE_URL` in OPD env**) |
| Region | ap-southeast-1 (Singapore) |
| Extensions | `pgvector`, default `english` ts_config |
| Total chunks | 304,399 (per OPD `/api/health`) — older CDMSS carryover (20 May) said 188,409; growth between then and now |
| Sources | MKSAP 19, StatPearls (8,981 articles), UpToDate 21.3 (partial), OpenFDA, PubMed (added in OPD v3.10 KB arc) |
| Schema | `mksap_chunks` table — see `EVEN-CDMSS-CARRYOVER-20-MAY-2026.md` §"Database Schema" |
| Embedding | `nomic-embed-text:latest` (768-dim) — verified working in production |
| HyDE rewriter | `qwen2.5:7b` (for medical-acronym expansion: HFrEF, ARDS, COPD, ICU, etc.) |

**For the Transcription Assistant**: the KB is **read-only** to us. We grant access via the `KB_DATABASE_URL` env var if/when we want to ground LLM cleanup with clinical evidence (e.g. "you said the patient has HCC — here's the staging criteria you may want to capture"). v1 likely doesn't need this; v2 onwards does.

### 3.2 Retrieval pipeline (the 8-stage compound LLM system from `EVEN-STAFF-PORTAL-v1_7-PRD.md` §2a)

```
1. Query expansion (HyDE)         llama3.1:8b
2. Multi-query variant generation llama3.1:8b
3. Hybrid retrieval               mxbai-embed-large vector cosine + Postgres tsvector BM25, fused via RRF
4. Cross-encoder reranking        llama3.1:8b (judge backend) OR BGE
5. Source-quality weighted fusion deterministic TS
6. Draft answer (streaming)       qwen2.5:14b
7. Critique audit                 qwen2.5:7b
8. Revision                       qwen2.5:7b
```

**For the Transcription Assistant — what we DO take and what we DON'T:**

| Stage | Use in v1? | Use in v2+? |
|---|---|---|
| 1. HyDE expansion | ⏳ Optional — useful if we want to retrieve KB chunks relevant to a freshly transcribed encounter for the LLM cleanup step | ✅ |
| 2. Multi-query variants | ❌ Probably overkill for note-cleanup | ⏳ |
| 3. Hybrid retrieval | ⏳ Same as #1 — only if KB grounding is in scope | ✅ |
| 4. Reranking | ❌ | ⏳ |
| 5. Source-quality fusion | ❌ | ⏳ |
| 6. Draft (qwen 14b) | ✅ **Yes** — this is the SOAP / cleanup / extraction model | ✅ |
| 7. Critique | ⏳ Useful when the LLM emits structured fields (ICD-10 codes, drug names) where hallucination is high-cost | ✅ |
| 8. Revision | ⏳ Pair with critique | ✅ |

### 3.3 LLM analysis patterns

These are the patterns the CDMSS work proved out. They become the conventions of the new app.

**Pattern 1 — `tracedChat(traceId, label, params)` wrapper for all LLM calls.**
From `lib/trace.ts` in CDMSS. Auto-instruments every call: writes a `trace_events` row before + after, captures `prompt_tokens`, `completion_tokens`, latency, model. **D11.3 removed the direct `llm` import from every route in favor of `tracedChat`.** The new app adopts this on day one.

**Pattern 2 — Per-phase field whitelist on server + MERGE on client.**
From the drug-lookup pipeline (D10 + D12.3). When a multi-phase LLM pipeline emits structured JSON across phases, the server enforces a whitelist of fields each phase can set, AND the client merges phase payloads rather than replacing. Otherwise Phase 3 wipes Phase 2's data on result. **Direct relevance:** the encounter-cleanup pipeline will likely emit `{cc, hpi, exam, assessment, plan}` across multiple LLM calls. Same pattern applies.

**Pattern 3 — Cache-then-NDJSON.**
v6 decision Q8 from OPD. Cache check runs FIRST and returns plain JSON regardless of `Accept` header. Only cache misses branch into NDJSON streaming. Client branches on response `content-type`. **For transcription cleanup**: identical transcripts (within a session) shouldn't re-hit the LLM. Hash the transcript, cache the structured output.

**Pattern 4 — Dual JSON/NDJSON endpoints (v6 decision Q8).**
Every LLM route inspects `req.headers.get('accept')`. If `application/x-ndjson`, returns streaming Response with `X-Trace-Id` header. Otherwise returns legacy JSON. **Both branches MUST emit the same payload shape** — back-compat is non-negotiable.

**Pattern 5 — AbortSignal threading (v6 decision Q5).**
Route's `req.signal` → new `AbortController` → `qwenJson({ signal })` → Mac Mini `fetch.abort`. Client disconnect cancels the call. **Saves Mac Mini cycles when the doctor closes the app mid-transcription.**

**Pattern 6 — Heartbeat collapse (v6 decision Q3).**
Server emits `<stage> (Ns on this phase)` every 5s via `withHeartbeat(emit, stage, label, fn)`. Client's `pushTrace` collapses consecutive heartbeats into a single ticking row per phase. Keeps the TracePanel readable during the long qwen 14b drafting phases.

**Pattern 7 — JSON-mode output discipline.**
`parseLooseJson` is used everywhere because qwen2.5:14b drops double quotes under critique. **Every prompt that expects structured output MUST tell the model "use double quotes" in BOTH the SYSTEM and the REVISION prompts.** (Anti-pattern memory from CDMSS — don't relearn it.)

**Pattern 8 — Wide-prompt density discipline (D12.1 lesson).**
"Be comprehensive" produces 6% max_tokens utilization. Name the exact length per field + show a worked example with target density to push qwen to 40–50%. **Relevant for note-cleanup**: don't just ask "rewrite this as a SOAP note", specify "Subjective: 3–8 sentences. Objective: bulleted list of measured findings + vital signs only. …"

**Pattern 9 — BM25 narrow-the-query (D12.2 lesson).**
`plainto_tsquery` ANDs every stemmed term. Wide boilerplate queries against 304k chunks AND-fail to zero hits. **Fix is `opts.bm25Query` with focused high-IDF terms** — drug name, chief complaint, topic, ICD-10 keyword. Relevant only if we add KB grounding.

**Pattern 10 — `OLLAMA_CONTEXT_LENGTH=16384` is non-negotiable.**
Set on the Mac Mini via `launchctl setenv`. Per-request `options.num_ctx` is silently ignored if the model is already running at a smaller context. Verify on every Mac Mini reboot with `curl localhost:11434/api/ps | jq '.models[].context_length'`.

### 3.4 Completion tracking (forensic trace dashboard)

The full schema and UX is in `LLM-TRACE-PANEL-PRD.md` and `EVEN-STAFF-PORTAL-v1_7-PRD.md` §"Feature A — Forensic Trace System". For the Transcription Assistant, the relevant lift is:

- **`/llm/trace/[id]/page.tsx`** — forensic detail page. Shows every event, every prompt (raw), every retrieval pool, every critique, every revision. Downloadable as JSON + Markdown.
- **`/llm/dashboard/page.tsx`** — admin aggregates (count / errored / error% / p50 / p90 per surface) with filters by surface / status / doctor / date range. Already shipped in OPD as v6.1 — same code lifts.
- **Trace ID copy chip + "View trace ↗" deep link** in TracePanel — surfaces the trace ID inline on every answer so V can paste it into a bug report or a debugging session.

**For the Transcription Assistant, define these surfaces upfront:**
- `transcribe-compare` (Deepgram vs Whisper)
- `note-cleanup` (raw transcript → structured note)
- `voice-note-extract` (voice note → tags + action items)
- `ambient-encounter` (long-form encounter → SOAP)
- `coding-extract` (assessment text → ICD-10 codes) — v2
- `kb-ground` (cleanup grounded in CDMSS chunks) — v2

### 3.5 Markdown + Mermaid + custom-block rendering (from staff portal v1.7)

`react-markdown` + `remark-gfm` + a custom block renderer (the `dosing-card` proof-of-concept). Pattern: model emits ` ```json` inside a fenced block with a discriminator tag, React component switches on the tag and renders a styled card.

**For the Transcription Assistant — likely v1 candidates for custom blocks:**
- `action-items` — checklist of follow-up tasks the doctor mentioned ("order CBC, schedule f/u in 2 weeks")
- `rx-draft` — prescription block with drug / dose / route / frequency / duration
- `referral-draft` — referral letter draft with target specialty + clinical question
- `differential-tree` — DDx the doctor verbalized while thinking aloud
- `coding-codes` — extracted ICD-10 codes with confidence

The `dosing-card` is a useful reference implementation to copy verbatim and then add new block types.

### 3.6 Coach mode (Socratic teaching) — possible v2 surface

The CDMSS `/coach` surface (D14.0 — "Show answer" escape hatch) runs a Socratic teaching loop: the doctor describes a case, the coach asks clarifying questions, the doctor answers, the coach probes deeper, and eventually reveals the canonical answer + identifies knowledge gaps. **For the Transcription Assistant, the "Coach me on this encounter" affordance lets a doctor turn a recorded encounter into a teaching moment for themselves or a junior.** Defer to v2 but architecturally compatible — the trace + KB stack supports it.

---

## 4. New app — proposed architecture (working)

### 4.1 Top-level structure

```
even-transcription-assistant/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── notes/                     # voice notes
│   │   │   │   ├── route.ts               # GET list / POST create
│   │   │   │   ├── [id]/
│   │   │   │   │   ├── route.ts           # GET / PATCH / DELETE
│   │   │   │   │   ├── transcribe/        # POST audio → run transcribe-compare pipeline
│   │   │   │   │   ├── cleanup/           # POST transcript → structured note
│   │   │   │   │   └── traces/            # GET trace history
│   │   │   ├── encounters/                # patient encounters
│   │   │   │   └── [id]/
│   │   │   │       ├── route.ts
│   │   │   │       ├── transcribe-chunk/  # POST chunk during ambient recording
│   │   │   │       ├── finalize/          # POST when recording stops → cleanup + SOAP
│   │   │   │       └── traces/
│   │   │   ├── llm/
│   │   │   │   ├── stage-medians/route.ts # rolling 30d p50 per stage
│   │   │   │   └── dashboard/route.ts     # admin aggregates
│   │   │   ├── health/route.ts            # DB + LLM + Whisper + KB probes
│   │   │   └── run-migrations/route.ts
│   │   ├── (mobile)/                      # Mobile-first routes
│   │   │   ├── page.tsx                   # Home — Record / Library / Settings
│   │   │   ├── record/                    # Recording UI
│   │   │   ├── notes/[id]/page.tsx        # View / edit a note
│   │   │   └── library/page.tsx           # Searchable history
│   │   ├── llm/                           # Trace surfaces (admin)
│   │   │   ├── trace/[id]/page.tsx
│   │   │   └── dashboard/page.tsx
│   │   └── admin/                         # Hidden admin URL pattern (from staff portal SP.0)
│   ├── components/
│   │   ├── llm-trace/                     # PORTED from OPD/staff portal
│   │   │   ├── TracePanel.tsx             # Mobile-tuned variant
│   │   │   ├── AiActivityList.tsx
│   │   │   └── BackgroundTraceToaster.tsx
│   │   ├── recorder/
│   │   │   ├── AmbientRecorder.tsx        # PORTED from OPD
│   │   │   ├── PushToTalk.tsx             # NEW (touch-optimized version of VoiceQueryFab)
│   │   │   └── RecordingControls.tsx      # NEW
│   │   ├── notes/
│   │   │   ├── NoteCard.tsx
│   │   │   ├── NoteEditor.tsx             # post-cleanup edit surface
│   │   │   ├── TranscriptViewer.tsx       # PORTED from OPD
│   │   │   └── ComparisonCard.tsx         # PORTED from OPD (admin-only?)
│   │   └── markdown/
│   │       ├── MdRenderer.tsx             # react-markdown + remark-gfm
│   │       ├── MermaidBlock.tsx
│   │       └── blocks/
│   │           ├── ActionItemsCard.tsx
│   │           ├── RxDraftCard.tsx
│   │           └── …
│   └── lib/
│       ├── llm-trace/                     # PORTED 8 files from OPD verbatim
│       ├── transcribe.ts                  # PORTED from OPD verbatim
│       ├── whisper.ts                     # PORTED from OPD verbatim
│       ├── transcribe-compare.ts          # PORTED from OPD verbatim
│       ├── qwen.ts                        # PORTED from OPD verbatim
│       ├── cleanup.ts                     # NEW — raw transcript → structured note pipeline
│       ├── voice-note-extract.ts          # NEW — voice note → tags + action items
│       ├── note-grounding.ts              # v2 — KB-grounded enrichment
│       ├── auth.ts                        # PORTED from OPD (cookie name change)
│       ├── db.ts                          # PORTED from OPD
│       ├── kb.ts                          # PORTED from OPD (v2)
│       ├── trace.ts                       # PORTED from CDMSS (tracedChat wrapper)
│       └── migrations.ts                  # NEW migration runner
└── …
```

### 4.2 Environment variables (initial draft)

| Var | Source | Notes |
|---|---|---|
| `POSTGRES_URL` | new Neon DB | Main app DB — encounters, notes, traces, comparisons |
| `POSTGRES_URL_NON_POOLING` | new Neon DB | For migrations |
| `KB_DATABASE_URL` | **same Neon DB as OPD + Even-CDMSS** | Read-only, for KB grounding (v2) |
| `LLM_BASE_URL` | `https://llm.llmvinayminihome.uk/v1` | Reuse existing tunnel |
| `LLM_API_KEY` | reuse from OPD/CDMSS | Same Mac Mini Ollama bearer |
| `WHISPER_BASE_URL` | `https://whisper.llmvinayminihome.uk` | Reuse existing tunnel |
| `JWT_SECRET` | new | Cookie auth for `eta_session` (or similar) |
| `MIGRATION_SECRET` | new | Bearer for `/api/run-migrations` |
| `INTERNAL_API_SECRET` | new | Bearer for cross-app calls (if we end up linking back to OPD or staff portal) |
| `BLOB_READ_WRITE_TOKEN` | Vercel auto | Audio file storage |
| `DEEPGRAM_API_KEY` | reuse | Cloud transcription leg |
| `APP_URL` | new | Canonical base URL |
| `ADMIN_BASE_PATH` | new | Hidden admin URL (32-char random) — pattern from staff portal SP.0 |
| `TRACE_RETENTION_DAYS` | new | Default forever for v1; cron-driven purge later if needed |

### 4.3 Migration plan (initial draft)

| Version | Name | What |
|---|---|---|
| v1 | `bootstrap` | doctors, sessions tables; jose JWT cookie auth |
| v2 | `notes_core` | `voice_notes` table (id, doctor_id, created_at, duration_seconds, audio_blob_url, status, transcript_raw, transcript_clean, tags JSONB) |
| v3 | `encounters_core` | `patient_encounters` table (id, doctor_id, patient_label TEXT, created_at, ended_at, status, audio_blob_url, transcript_raw, structured_note JSONB) — patient_label is a free-text identifier in v1 (no patient table); v2 can link to a patient registry if needed |
| v4 | `transcription_comparisons` | Direct port of OPD v36 |
| v5 | `llm_traces` | Direct port of OPD v39 |
| v6 | `note_action_items` | Extracted action items from voice notes (note_id, text, due_date NULLABLE, completed BOOL) |
| v7 | `coding_codes` | Extracted ICD-10 from encounter notes (encounter_id, code, label, confidence) — v2 |

### 4.4 Mobile-first design considerations (informs Figma stage)

From v3.9 PRD §8 ("Mobile responsiveness" parking lot) and OPD v6.2 backlog ("Mobile-tuned TracePanel variant for ~380px viewport"):

- **Target viewport: 380px wide minimum** (iPhone SE) up to 768px (tablet portrait).
- **PWA-ready** — install-to-home-screen, offline-capable shell, background sync for upload-when-online.
- **Big touch targets** — 44pt minimum (Apple HIG).
- **One-thumb operation** — primary recording UI should be reachable without two hands. FAB pattern.
- **Audio capture: MediaRecorder API + webm/opus** — works on Chrome, Safari (iOS 14.3+), Firefox.
- **Background recording resilience** — handle iOS audio-session interruptions (call comes in, then user resumes).
- **Battery-aware** — long ambient encounters can drain phones; show duration prominently.
- **Patient-consent banner** — every recording starts with a one-tap "Patient consents to recording" gate. Document in PRD §legal.
- **No new "Qwen" branding** — match v4 design lock from OPD. AI is `✨`, never named.
- **Sentence case headers, no subtitles, 1–2 word buttons** — match OPD v4 UX.

---

## 5. What we explicitly DO NOT take from the source projects (v1 scope guard)

| Asset | Why not in v1 |
|---|---|
| OPD's encounter editor (sections 1–7, comorbidities, diagnostics, Rx, plan) | Different product. The Transcription Assistant is a recording + cleanup tool, not an EHR encounter editor. v2 could integrate as an OPD plugin. |
| OPD's full LabResultsEditGrid + lab PDF OCR via qwen-vision | Not a transcription concern. |
| OPD's DDI scan + Rx coherence + comorbidity inference | These are EHR-grade safety checks that need the full patient context. Defer to v2 if we add patient linkage. |
| Staff Portal Sewa, Bulletin, Videos, Contacts | Out of product scope. |
| Staff Portal v1.7 markdown infographics library beyond the 4 v1 blocks above | Defer — match the dosing-card precedent only for v1. |
| The OPD plan-prediction v5.1 (qwen 14b plan suggester) | Too encounter-specific; the new app's "what next" pattern (action items) is lighter-weight. |
| The 8-stage CDMSS retrieval pipeline (HyDE → variants → hybrid → rerank → fusion → draft → critique → revise) at full depth | v1 cleanup uses just stage 6 (draft) + optionally stage 7-8 (critique/revise). KB-grounded cleanup with the full pipeline is v2. |
| The `coach` Socratic loop | v2 candidate. |
| The CDMSS calculators (eGFR, ABG, NEWS2, hyponatremia, sepsis) | Out of scope unless V wants them in the new app — they'd be a natural complement to a voice note that says "compute his eGFR" but that's v2+. |

---

## 6. Extraction recommendations summary (the build-list)

Numbered so V can check them off.

### Tier 1 — Lift verbatim (do this in sprint 0)
1. ✅ `src/lib/transcribe.ts` (Deepgram client)
2. ✅ `src/lib/whisper.ts` (Whisper client)
3. ✅ `src/lib/transcribe-compare.ts` (parallel + judge)
4. ✅ `src/lib/qwen.ts` (Ollama OpenAI-compat client with `signal` support)
5. ✅ `src/lib/auth.ts` (jose JWT cookie)
6. ✅ `src/lib/db.ts` (Vercel Postgres pool)
7. ✅ `src/lib/llm-trace/*` (all 8 files)
8. ✅ `src/components/llm-trace/TracePanel.tsx` (with mobile variant adjustment)
9. ✅ `src/components/llm-trace/AiActivityList.tsx`
10. ✅ `src/components/llm-trace/BackgroundTraceToaster.tsx`
11. ✅ `src/components/TranscriptViewer.tsx`
12. ✅ Migration files v36 (`transcription_comparisons`) + v39 (`llm_traces`)
13. ✅ `/api/health` endpoint pattern
14. ✅ Cloudflare tunnel env vars (`LLM_BASE_URL`, `WHISPER_BASE_URL`, `LLM_API_KEY`, `DEEPGRAM_API_KEY`)

### Tier 2 — Lift and adapt (sprint 1–2)
15. ⚙️ `src/components/DictateButton.tsx` → rewire endpoints to new API
16. ⚙️ `src/components/VoiceQueryFab.tsx` → become primary "voice note" UI
17. ⚙️ `src/components/AmbientRecorder.tsx` → primary "encounter recording" UI
18. ⚙️ `src/components/ComparisonCard.tsx` → admin-only or hidden behind a toggle
19. ⚙️ `lib/trace.ts` from CDMSS (`tracedChat` wrapper)
20. ⚙️ Hidden admin URL pattern (`ADMIN_BASE_PATH` env + middleware) from staff portal SP.0
21. ⚙️ `stage-explainers.ts` — add new surface entries for transcription pipelines

### Tier 3 — Build new (sprint 1–2)
22. 🆕 `lib/cleanup.ts` — raw transcript → structured SOAP / note pipeline
23. 🆕 `lib/voice-note-extract.ts` — voice note → tags + action items
24. 🆕 Mobile shell: home page, recording UI, library, settings
25. 🆕 PWA manifest + service worker (upload-when-online)
26. 🆕 Patient-consent gate before first recording
27. 🆕 Custom markdown blocks: `action-items`, `rx-draft`, `referral-draft`, `coding-codes`
28. 🆕 Migration v6 (`note_action_items`) and v7 (`coding_codes`)

### Tier 4 — v2 candidates (defer)
- KB-grounded cleanup (full 8-stage retrieval pipeline)
- Coach mode on a recorded encounter
- ICD-10 extraction with KB-cited evidence
- qwen-vision OCR of photographed paper notes
- Calculator integration (eGFR / NEWS2 / etc. triggered from voice notes)
- Integration with OPD-Encounter-App as a recording source for OPD encounters
- Cross-app patient linkage

---

## 7. Open questions to resolve before PRD

1. **Workflow distinction** — Are "patient encounter recording" and "medical voice notes" two separate top-level workflows in the UI, or one unified "record" flow that branches based on tagging? My recommendation: two separate flows, because the post-recording processing pipelines are different (SOAP structure vs tags+actions), and the UX context is different (during patient visit vs anytime).
2. **Patient context** — Do encounters get linked to a patient record? If yes, do we copy OPD's patient model, build a lightweight `patient_label` free-text field, or read patients from an external source (KareXpert HIS)?
3. **Multi-doctor** — Single doctor (V personally) or multi-doctor with auth? Same JWT cookie pattern in OPD supports both; just a decision on signup vs invite-only.
4. **Consent UX** — Every recording explicitly gated by patient consent, or one-time consent per patient? Legal/policy question.
5. **Offline mode** — How aggressive? PWA shell + offline recording with sync-on-online, or fully offline-capable transcription (would require WebAssembly Whisper in the browser)? My recommendation: PWA + record-offline-upload-online for v1; in-browser Whisper is a v3+ research project.
6. **Audio retention** — How long do raw audio blobs persist after successful transcription? Suggest 30 days for voice notes, indefinite for patient encounters (with admin-managed purge).
7. **Compliance surface** — DPDP Act 2023 (India)? Any explicit medico-legal audit trail requirements beyond `llm_traces`?
8. **Cleanup output format** — SOAP only, or selectable (SOAP / problem-oriented / chronological)?
9. **Recording length cap** — OPD's voice query is push-to-talk (short). Ambient encounter recording has no soft cap in OPD. New app: do we want a hard cap (e.g. 30 min) or rely on the doctor to stop?
10. **Mobile-only or also tablet/desktop?** — The redesign brief is mobile-first but tablets are common in clinics. Recommend mobile-first with responsive scaling up to tablet; desktop is "viewer mode" for the library / admin only.

---

## 8. What to do next

This catalog is the input to:

1. **UI design (Figma)** — once V locks the workflow distinction (Q1) and patient context (Q2), the mobile screens fall out: home → record → recording-in-progress → review-transcript → cleaned-note → library. Plus admin trace surfaces (likely desktop).
2. **PRD** — once Figma converges, the PRD codifies the full system: scope (locked decisions), data model, API surfaces, UX flows, sprint plan SP.0 → SP.N, success criteria, risk register.
3. **Build** — sprint 0 lifts Tier 1, sprint 1 wires the recording loop end-to-end (record → upload → transcribe-compare → clean → save), sprint 2 polishes mobile UX + custom markdown blocks, sprint 3 ships PWA, sprint 4+ as needed.

---

## 9. Running build list (the memory anchor)

Tracked here so context flattening doesn't lose it. Append-only.

- [ ] V to confirm: workflow distinction (encounters vs voice notes as 1 or 2 flows)
- [ ] V to confirm: patient linkage approach
- [ ] V to grant access (or extract locally) to private `Even-CDMSS` repo for the `lib/trace.ts` + Markdown infographic patterns
- [ ] Provision new Neon DB for the Transcription Assistant
- [ ] Create new GitHub repo `vinaybhardwaj-commits/even-transcription-assistant`
- [ ] Create new Vercel project `even-transcription-assistant` on bom1
- [ ] Add new env vars to Vercel (full list in §4.2)
- [ ] Sprint 0: Tier 1 lifts (transcribe stack + trace stack + auth + db)
- [ ] Sprint 1: Build recording loop end-to-end
- [ ] Sprint 2: Mobile-first UI per Figma
- [ ] Sprint 3: PWA + offline recording
- [ ] v2 backlog: KB grounding, Coach mode, calculators, qwen-vision OCR

---

## 10. Even-CDMSS code-level verification (v0.2 — cloned + read 26 May 2026)

Repo cloned, all 118 files enumerated, key `lib/` and `public/` files read end-to-end. The patterns described in the carryover docs are real and live on `main`. **The README in the repo is stale** (only mentions /ask, /search, /browse, /practice, /topics) — the actual `/app` tree has many more surfaces.

### 10.1 Repo at a glance

```
Even-CDMSS/   (118 files, ~98.9% TypeScript)
├── app/
│   ├── ask/   ddx/   coach/   drugs/   review/   search/   topics/   nav.tsx   page.tsx
│   ├── calculators/{egfr,abg,sepsis-bundle,hyponatremia,news2}/page.tsx
│   └── api/
│       ├── ask/route.ts                       (100 lines — the canonical RAG pipeline)
│       ├── ddx/route.ts
│       ├── coach/{start,respond,end}/route.ts
│       ├── drugs/{lookup,interactions}/route.ts
│       ├── calculators/
│       │   ├── {egfr,abg,sepsis-bundle,hyponatremia,news2}/route.ts
│       │   ├── sepsis-bundle/sidebar/route.ts
│       │   ├── typical-latency/route.ts
│       │   └── tooltip/route.ts
│       ├── topics/route.ts   search/route.ts
│       ├── digest/generate/route.ts
│       ├── flashcards/{review,due}/route.ts
│       ├── practice/next/route.ts
│       ├── books/{route.ts,[book]/chapters/{route.ts,[chapter]/route.ts}}
│       ├── health/route.ts                    (63 lines, edge runtime)
│       ├── log/query/route.ts
│       ├── debug-{stats,search}/route.ts
│       └── admin/
│           ├── traces/{route.ts,[traceId]/route.ts}
│           ├── statpearls-pilot/route.ts
│           ├── ollama-ps/route.ts             (Mac Mini health probe)
│           ├── bm25-diag/route.ts             (D12.2 BM25 debug)
│           ├── tooltip-cache/bump/route.ts
│           └── migrate{,-v2,-v6,-v7,-v8}/route.ts
├── components/
│   ├── TracePanel.tsx                          (104 lines — the simpler base; OPD's 430-line version is the superset)
│   ├── HealthPill.tsx   HelpCard.tsx   ErrorBoundary.tsx
│   └── calculators/
│       ├── CalculatorShell.tsx                 (the declarative shell, same for all 5)
│       └── {EgfrCalculator,News2Calculator,AbgCalculator,HyponatremiaCalculator,SepsisBundleCalculator}.tsx
├── lib/
│   ├── llm.ts          (18 lines — OpenAI SDK pointed at Ollama tunnel)
│   ├── db.ts           (21 lines — Neon HTTP driver + Chunk type)
│   ├── stream.ts       (44 lines — makeNdjsonStream + ndjsonHeaders)
│   ├── trace.ts        (121 lines — startTrace, logEvent, finishTrace, tracedChat, logStreamComplete)
│   ├── ndjson-client.ts (55 lines — iOS Safari "Load failed" hardened)
│   ├── expand.ts       (32 lines — HyDE rewriter via llama3.1:8b)
│   ├── retrieve.ts     (139 lines — vector + BM25 RRF fusion, bm25Query override)
│   ├── coach.ts        (125 lines — Socratic + reveal prompts, parseLooseJson, computeAccuracy, isRevealIntent)
│   ├── drugs.ts        (84 lines)
│   ├── admin-gate.ts   (16 lines — Bearer or ?token=)
│   └── calculators/
│       ├── types.ts                            (declarative CalculatorConfig + FormField + CalculatorResult)
│       ├── safety-regex.ts                     (drug-dose + fluid-volume + fluid-rate redaction)
│       ├── citation-check.ts                   (strip hallucinated chunk_id citations)
│       ├── static-fallbacks.ts                 (interpretation text when LLM bridge is down)
│       └── math/
│           ├── {egfr,news2,abg,hyponatremia,sepsis-bundle}.ts   (pure functions, no LLM)
│           └── __tests__/*.test.ts             (math tests for every calculator)
└── public/
    ├── sw.js                                   (76 lines — versioned, killswitch-aware service worker)
    ├── register-sw.js
    ├── sw-killswitch.txt                       (write "killed" to disable SW org-wide)
    ├── manifest.webmanifest                    (PWA manifest, standalone + portrait)
    └── icon-{192,512}.png                      (maskable)
```

### 10.2 The CDMSS canonical RAG route (this is the reference pattern)

`app/api/ask/route.ts` is 100 lines and captures the entire pattern. Skeleton:

```typescript
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();
  // ... validate

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('ask', { question, bookFilter });

  // Fire-and-forget IIFE — return the stream immediately
  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    try {
      emit({ type: 'progress', stage: 'expanding', msg: 'Rewriting query…' });
      const result = await retrieve(question, { topK: 8 });
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${result.hits.length}…`, ms: Date.now() - t0 });
      emit({ type: 'sources', items: sources });

      const completion = await tracedChat(traceId, 'answer', {
        model: TEXT_MODEL,
        messages: [...],
        temperature: 0.2,
        stream: true,
        options: { num_ctx: 16384 },
        keep_alive: '15m',
      });

      let fullContent = '';
      for await (const part of completion) {
        const delta = part.choices?.[0]?.delta?.content ?? '';
        if (delta) { fullContent += delta; emit({ type: 'token', content: delta }); }
      }
      await logStreamComplete(traceId, 'answer', fullContent, llmStart);
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      outcome = 'error';
      emit({ type: 'error', message: String(e.message) });
    } finally {
      await finishTrace(traceId, outcome, outcomeMsg);
      close();
    }
  })();

  const headers = ndjsonHeaders();
  headers.set('X-Trace-Id', traceId);
  return new Response(stream, { headers });
}
```

**For the Transcription Assistant — every multi-stage LLM route uses this exact scaffold.** Note-cleanup, voice-note-extract, encounter-finalize all follow it. The differences are: the stages list, the stage messages, the model + prompts, whether we stream tokens or just emit a final `result`. The plumbing is identical.

### 10.3 Trace schema (`traces` + `trace_events`)

CDMSS uses two tables (OPD's `llm_traces` collapses these into one with JSONB events). For the new app I recommend the CDMSS shape because it makes the dashboard query much simpler and supports `parent_trace_id` linking out-of-the-box.

```sql
CREATE TABLE traces (
  trace_id        UUID PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  feature         TEXT NOT NULL,                       -- 'ask' | 'ddx' | 'note-cleanup' | etc.
  input           JSONB,                                -- the request payload
  status          TEXT NOT NULL DEFAULT 'running',     -- 'running' | 'success' | 'error' | 'partial'
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  total_ms        INTEGER,
  meta            JSONB,                                -- feature-specific (e.g. egfr stage, ckd-epi result)
  parent_trace_id UUID REFERENCES traces(trace_id)     -- chain related calls
);
CREATE INDEX ON traces (feature, started_at DESC);
CREATE INDEX ON traces (user_id, started_at DESC);
CREATE INDEX ON traces (status) WHERE status != 'success';
CREATE INDEX ON traces (parent_trace_id) WHERE parent_trace_id IS NOT NULL;

CREATE TABLE trace_events (
  trace_id    UUID NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,                         -- monotonic per trace
  kind        TEXT NOT NULL,                            -- 'llm_request' | 'llm_response' | 'llm_error' | 'progress' | 'retrieve' | …
  stage       TEXT,                                     -- 'expanding' | 'retrieving' | 'generating' | …
  payload     JSONB,                                    -- full request/response bodies (this is the forensic gold)
  latency_ms  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trace_id, seq)
);
CREATE INDEX ON trace_events (trace_id, seq);
```

The `tracedChat` wrapper inserts a `trace_events` row before AND after every LLM call, capturing the full prompt + response + usage + latency. **Forensic completeness without any caller boilerplate.**

### 10.4 Reusable patterns from `lib/` (every one is small)

| File | LOC | What carries forward |
|---|---|---|
| `lib/llm.ts` | 18 | Verbatim. OpenAI SDK pointed at `${OLLAMA_BASE_URL}/v1` with `apiKey: 'ollama'`. Plus `embedQuery` + `vectorLiteral`. Rename env var to `LLM_BASE_URL` to match OPD convention. |
| `lib/db.ts` | 21 | Verbatim. Neon HTTP driver (`neon()` not `Pool` — important gotcha for dynamic SQL, must cast to `(q,p) => Promise<T[]>`). |
| `lib/stream.ts` | 44 | Verbatim. Add new stages to the `Stage` union for transcription pipelines. |
| `lib/trace.ts` | 121 | Verbatim. `tracedChat` becomes the only way LLM calls are made in the new app. |
| `lib/ndjson-client.ts` | 55 | Verbatim. The iOS Safari "Load failed" handling is critical for mobile. |
| `lib/expand.ts` | 32 | Lift if/when KB grounding lands (v2). HyDE-lite for medical acronyms. |
| `lib/retrieve.ts` | 139 | Lift if/when KB grounding lands (v2). Pay attention to `bm25Query` override pattern. |
| `lib/admin-gate.ts` | 16 | Verbatim for admin routes. |
| `lib/calculators/safety-regex.ts` | ~100 | **Optional but valuable.** Already-tested regex that redacts `5 mg`, `100 mL/hr`, etc. while preserving `5 mg/dL` (lab units) and fluid TYPES. Useful if transcript cleanup ever needs to scrub doses for safety. |
| `lib/calculators/citation-check.ts` | 17 | **Take this.** `stripHallucinatedCitations(section, retrievedIds)` — strips any `[n]` citation pointing to a chunk_id not in the actually-retrieved set. Core defensive pattern when LLM emits citations. |
| `lib/coach.ts` | 125 | Lift if Coach mode comes back (v2). Includes `parseLooseJson` which is independently useful. |

### 10.5 PWA infrastructure — straight lift to mobile-first

`public/sw.js` (76 lines) — this is the gold. Already proven on iOS Safari + Android Chrome through CDMSS production use. **Direct lift to the Transcription Assistant.**

Cache strategy:
- **Network-first for navigations** — page loads always try network; fall back to cache on offline. Means a broken cached response can never permanently block the app.
- **Network-first for `/api/*`** — never cache RAG / LLM / transcription responses. Stale data is worse than no data here.
- **Cache-first for static assets** — JS, CSS, images. Falls through to network if not cached.
- **Versioned cache** (`even-cdmss-shell-v3` → rename `even-eta-shell-v1` for new app). Activate handler drops all caches not matching the current version → heals any prior broken state on every SW update.
- **Killswitch** — fetches `/sw-killswitch.txt`. If the body is `"killed"`, the SW unregisters itself and reloads all clients without SW. **Critical escape hatch** — if a bad SW version ever ships, V can flip this single text file to kill all installed copies in the field.

`public/manifest.webmanifest` — change the name, theme color (`#1F4E79` → Even Blue `#0055ff`), `start_url`, and icons. Otherwise direct copy. `display: standalone`, `orientation: portrait` are right for a mobile-first recorder.

`public/register-sw.js` — small loader script imported from the layout, registers the SW + handles update notifications.

**For Even Transcription Assistant**: PWA support is huge — doctors can install it to home screen, get full-screen recording UX, and the network-first strategy gracefully handles the "recording finished but I'm on a lift with no signal" case (the audio sits in Vercel Blob queue, transcription kicks off when signal returns). I'd lift the SW on day 1, not defer to sprint 3.

### 10.6 Calculator architecture — reference pattern, not a v1 lift

The calculator module is a model of how to add features without ceremony. Worth reading the pattern even if we don't ship calculators in the new app:

1. **Pure math + tests** (`lib/calculators/math/*.ts` + `__tests__/*.test.ts`). Zero LLM. Always works offline.
2. **Declarative config** (`lib/calculators/types.ts` → `CalculatorConfig` → `FormField[]`). One config object defines fields, units, bounds, tooltips, defaults, API path, result sections.
3. **Shared shell** (`components/calculators/CalculatorShell.tsx`). Renders form + paste mode + result card from props. All 5 calculators share it.
4. **API route per calculator** (~150–400 LOC each). Pattern: validate → compute deterministically → start trace → fire LLM interpretation with graceful fallback → push to session context if relevant → log to `user_queries` → return result with `X-Trace-Id`.
5. **Idempotency cache** — in-process LRU with 5-min TTL. Double-click protection without DB ceremony.
6. **Parent trace linking** — if the request includes `parent_trace_id`, the trace's parent is set, so the full call chain is visible in `/admin/traces`.

**For the Transcription Assistant — the "extract structured data from a transcript" feature has the same shape**: declarative spec of what to extract, pure deterministic parser where possible, LLM fallback with static fallback as floor, traced end-to-end, optionally chained from a parent trace (the original transcription).

### 10.7 Updates to the build list (§6)

Adding to Tier 1 verbatim lifts (these become items #15–#21 of the original Tier 1):

15. ✅ `lib/llm.ts` from Even-CDMSS (OpenAI SDK + Ollama)
16. ✅ `lib/db.ts` from Even-CDMSS (Neon HTTP driver)
17. ✅ `lib/stream.ts` from Even-CDMSS (same as OPD; CDMSS is simpler base)
18. ✅ `lib/trace.ts` from Even-CDMSS (the `tracedChat` wrapper + start/log/finish)
19. ✅ `lib/ndjson-client.ts` from Even-CDMSS (iOS Safari hardened)
20. ✅ `lib/admin-gate.ts` from Even-CDMSS (bearer/token auth for admin)
21. ✅ `lib/calculators/citation-check.ts` from Even-CDMSS (hallucination guard)
22. ✅ `public/sw.js` from Even-CDMSS (PWA service worker — change cache name)
23. ✅ `public/manifest.webmanifest` from Even-CDMSS (change name + theme + start_url)
24. ✅ `public/register-sw.js` from Even-CDMSS
25. ✅ `public/sw-killswitch.txt` — empty file for the killswitch pattern
26. ✅ Migration: `traces` + `trace_events` tables (use CDMSS shape, not OPD's single-table shape — see §10.3)
27. ✅ Canonical RAG route scaffold from `app/api/ask/route.ts` (100-line skeleton, see §10.2)

Adding to Tier 2 lift-and-adapt:

28. ⚙️ `lib/calculators/safety-regex.ts` — adapt to transcript cleanup if doses-in-voice-notes is a safety concern
29. ⚙️ `lib/expand.ts` + `lib/retrieve.ts` — wire up only if KB grounding lands in v1

### 10.8 New env var alignment (cross-app naming)

The two source apps use slightly different env var names. For the new app, pick one convention:

| Concept | OPD-Encounter-App uses | Even-CDMSS uses | Recommendation for new app |
|---|---|---|---|
| Ollama tunnel base | `LLM_BASE_URL` (with `/v1`) | `OLLAMA_BASE_URL` (no `/v1` — code appends it) | **`LLM_BASE_URL` with `/v1`** — matches OPD, and the OpenAI SDK expects the `/v1` suffix |
| Ollama bearer | `LLM_API_KEY` | not used (hardcoded `'ollama'`) | **`LLM_API_KEY`** if we ever lock down the tunnel; otherwise unused |
| Whisper tunnel | `WHISPER_BASE_URL` | n/a | `WHISPER_BASE_URL` |
| DB | `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` | `DATABASE_URL` | **`DATABASE_URL`** — Neon convention, matches the Vercel-Neon integration |
| KB DB | `KB_DATABASE_URL` | (same DB as main) | `KB_DATABASE_URL` pointing to the existing shared KB Neon |
| Admin gate | `ADMIN_BASE_PATH` (URL secret) + `ADMIN_TOKEN` (bearer) | `ADMIN_TOKEN` (bearer only) | **Both** — URL secret for the admin landing, bearer token for the admin API routes |
| Migration secret | `MIGRATION_SECRET` | n/a (admin endpoints) | `MIGRATION_SECRET` for explicit migration runs |
| Cron secret | `CRON_SECRET` | n/a | `CRON_SECRET` if we add cron jobs |
| Demo mode | `DEMO_MODE` | n/a | `DEMO_MODE` for showcasing without real data |

### 10.9 Updated cross-reference table — where to lift each piece from

| Capability | Lift from | File path | Notes |
|---|---|---|---|
| Transcribe (Deepgram) | OPD | `src/lib/transcribe.ts` | Verbatim |
| Transcribe (Whisper) | OPD | `src/lib/whisper.ts` | Verbatim |
| Dual compare + judge | OPD | `src/lib/transcribe-compare.ts` | Verbatim |
| Push-to-talk UI | OPD | `src/components/VoiceQueryFab.tsx` | Adapt to mobile |
| Ambient recording UI | OPD | `src/components/AmbientRecorder.tsx` | Adapt |
| Dictate button | OPD | `src/components/DictateButton.tsx` | Rewire endpoints |
| Compare card | OPD | `src/components/ComparisonCard.tsx` | Admin-only |
| Transcript viewer | OPD | `src/components/TranscriptViewer.tsx` | Verbatim |
| TracePanel (full polish) | OPD | `src/components/llm-trace/TracePanel.tsx` (430 lines) | Verbatim — superset of CDMSS version |
| TracePanel (simpler base) | Even-CDMSS | `components/TracePanel.tsx` (104 lines) | Reference only — OPD version supersedes |
| TracePanel mobile variant | NEW | — | Build per OPD v6.2 backlog spec |
| AI activity list | OPD | `src/components/llm-trace/AiActivityList.tsx` | Verbatim |
| Background toaster | OPD | `src/components/llm-trace/BackgroundTraceToaster.tsx` | Verbatim |
| Trace forensic detail page | OPD | `src/app/llm/trace/[id]/page.tsx` | Verbatim |
| Trace admin dashboard | OPD | `src/app/llm/dashboard/page.tsx` | Verbatim |
| LLM client (OpenAI SDK + Ollama) | Even-CDMSS | `lib/llm.ts` | Verbatim |
| NDJSON server stream | Even-CDMSS or OPD | `lib/stream.ts` (both identical) | Verbatim |
| NDJSON client consumer | Even-CDMSS or OPD | `lib/ndjson-client.ts` | Verbatim — iOS hardened |
| tracedChat wrapper + trace lifecycle | Even-CDMSS | `lib/trace.ts` | Verbatim |
| Neon DB client | Even-CDMSS | `lib/db.ts` | Verbatim — extend with new table types |
| Auth (JWT cookie) | OPD | `src/lib/auth.ts` | Verbatim — rename cookie |
| Admin gate (token) | Even-CDMSS | `lib/admin-gate.ts` | Verbatim |
| Health endpoint | OPD or Even-CDMSS | `app/api/health/route.ts` | Adapt — add Whisper probe |
| HyDE query rewriter (v2) | Even-CDMSS | `lib/expand.ts` | Verbatim if/when KB lands |
| Hybrid retrieval (v2) | Even-CDMSS | `lib/retrieve.ts` | Verbatim if/when KB lands |
| Citation hallucination guard | Even-CDMSS | `lib/calculators/citation-check.ts` | Verbatim |
| Safety regex (optional) | Even-CDMSS | `lib/calculators/safety-regex.ts` | Adapt if dose-redaction in transcripts is needed |
| PWA service worker | Even-CDMSS | `public/sw.js` | Verbatim — change cache name |
| PWA manifest | Even-CDMSS | `public/manifest.webmanifest` | Change name + theme + start_url + icons |
| PWA killswitch | Even-CDMSS | `public/sw-killswitch.txt` | Verbatim (empty file) |
| Coach Socratic loop (v2) | Even-CDMSS | `lib/coach.ts` | If/when Coach lands |
| `parseLooseJson` helper | Even-CDMSS | inline in `lib/coach.ts` | Extract to its own lib file |
| Calculator pattern (v2) | Even-CDMSS | `lib/calculators/*` + `components/calculators/*` | Reference only |
| Cloudflare tunnel for LLM | shared infra | n/a — set `LLM_BASE_URL` env | Existing |
| Cloudflare tunnel for Whisper | shared infra | n/a — set `WHISPER_BASE_URL` env | Existing |
| Shared KB Neon (v2) | shared infra | n/a — set `KB_DATABASE_URL` env | Existing |

---

**End of catalog v0.2.** Both source repos verified end-to-end at the code level. Ready for V's review and the next phase (Figma).

The next step on V's roadmap (per the opening conversation) is the interface design in Figma. Before that, three blocking decisions from §7 would unblock the screen design:
1. Workflow distinction — encounters and voice notes as separate flows, or unified?
2. Patient linkage — copy OPD model, free-text label, or external HIS read?
3. Multi-doctor vs single-user — affects sign-in screen and library scoping.
