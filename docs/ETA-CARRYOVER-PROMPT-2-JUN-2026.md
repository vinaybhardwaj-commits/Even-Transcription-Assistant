# ETA / Evenscribe — MASTER CARRYOVER PROMPT (2 Jun 2026)

> **HOW TO USE THIS FILE:** Paste this entire document as the FIRST message of a new Cowork thread. It boots the next session to the exact current state of the Even Transcription Assistant (ETA / Evenscribe) with zero context loss. It is self-contained: the repo, every secret/env var/PAT, the service map, the deploy loop, the build history in brief, and the open/next-up work. **This file supersedes `ETA-CARRYOVER-PROMPT-31-MAY-2026.md` and all older ETA carryover/boot prompts.**

---

## 0. WHO YOU ARE + WHAT THIS PROJECT IS

You are continuing development of **Evenscribe**, internally **ETA — Even Transcription Assistant** (also "Even Encounter Assistant", "Even Assistant"). I am **V (Dr. Vinay Bhardwaj)** — Hospital Product Manager / GM for Even Hospital (Race Course Road), a neurologist now in an operations-heavy product role. I build HIS/MIS/EHR tooling for **EHRC** (Even Health & Research City). ETA is one of several apps I run; this thread is **ETA only**.

**Product in 30 seconds:** Mobile-first PWA for clinicians. A clinician opens their personal URL on phone, enters a 4-digit PIN, taps the red Record button, and dictates a patient encounter. Live: Deepgram WebSocket streams an English transcript; for Indian languages a Sarvam codemix box scrolls near-real-time (rolling REST "refine + commit", or true streaming via a Mac Mini relay); Whisper rolls cumulative passes on a Mac Mini for medical-term accuracy; every 250 ms chunk persists to IndexedDB **and** an in-memory failsafe for crash/recovery. On Submit: chunks concatenate to one WebM blob → upload browser→R2 via presigned PUT → `/finalize-upload` → `/process` (Sarvam batch translate for non-English → transcript cleanup → pyannote diarization + voiceprint naming → note generation qwen2.5:14b → CDS/CDMSS llama3.1:8b + pgvector KB RAG). The clinician lands on a structured note + a Clinical Decision Support card, edits inline, picks recipients, sends via Resend. Admin at `/admin` manages clinicians, recipients, traces, diarization, the STT Engine Lab, **and (new this session) admins, encounter audio playback/download, a published bug log, and a system map.**

**Working style I expect:** Be concise and direct. Ask clarifying questions before big actions. After every change: **build green → deploy → verify live (`/api/health` shows the new `sha`) → `npm run smoke` → update docs/memory.** A failed build never deploys (prod holds the last good sha). Use the task list. Keep new subsystems isolated. Verify risky external APIs from the sandbox before wiring. **One firm boundary:** I do NOT create login accounts, set/enter passwords, or grant admin access on V's behalf even when authorized — I build the tooling and V performs the actual account/credential action (this is why Aditya's admin account is V's to add via the new Admins page).

---

## 1. REPO, HOST, AND HOW TO DEPLOY

| Resource | Value |
|---|---|
| GitHub repo | `vinaybhardwaj-commits/Even-Transcription-Assistant` |
| **GitHub PAT** | `<REDACTED>` |
| **Current HEAD** | **`8a24949`** (bug-log B20; last code/feature HEAD = `bec4929` System Map) |
| Vercel team | `team_yu1wWpsKdjsf90haai1ETJDG` (Hospital Product) |
| Vercel project | `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z` (`even-transcription-assistant`) |
| Vercel region | `bom1` (Mumbai) |
| Primary domain | **evenscribe.app** (apex 307 → `www.evenscribe.app`) |
| Health probe | https://www.evenscribe.app/api/health |
| Stack | Next.js 15.5 + React 19 + TS strict + Tailwind 3; Drizzle schema authority + **Neon HTTP driver** (`@neondatabase/serverless`); jose JWT HS256 (separate doctor/admin audiences); bcryptjs cost 12; nanoid ids; @aws-sdk S3 for R2; Resend SDK + svix HMAC; openai SDK (points at Mac Mini Ollama). **No build step locally — Vercel Pro auto-deploys on push to `main`.** |

### Deploy loop (the routine every change follows)
```bash
# 1. Clone (sandbox can't reach the home LAN, but CAN reach the public HTTPS tunnels + Vercel + GitHub).
#    NOTE: /tmp is wiped between sessions AND sometimes mid-session — re-clone whenever the dir is gone.
PAT=<REDACTED>
export HOME=/tmp
cd /tmp && rm -rf eta-work
git clone https://${PAT}@github.com/vinaybhardwaj-commits/Even-Transcription-Assistant.git eta-work
cd eta-work && git config user.email vinay.bhardwaj@even.in && git config user.name "Vinay Bhardwaj"

# 2. edit → commit → push main
git add -A && git commit -m "..." && git push origin main

# 3. poll for the new sha to go live (Vercel auto-build; a FAILED build never deploys)
for i in $(seq 1 12); do
  sha=$(curl -s https://www.evenscribe.app/api/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('sha',''))")
  echo "$i: live=$sha"; [ "${sha:0:7}" = "<new-short-sha>" ] && break; sleep 15
done

# 4. verify health + run the smoke canary
node scripts/smoke.mjs   # 9/9 expected (stt-lab.health SKIPs without SMOKE_ADMIN_* creds)
```
**Sandbox notes:** no `npm install` in the sandbox (no disk / `/sessions` is full with V's mounted iCloud data — don't touch it). So **verify via the deploy-loop + `node --experimental-strip-types` for pure-logic checks**, NOT a local build. Bash calls cap ~45 s — keep poll loops short and avoid >40 s sleeps. **Brace/paren balance check** new files with `node -e` before pushing (Vercel build is the typecheck gate).

### Run a DB migration against prod
Migrations live in `db/migrations/NNNN_name.sql`. Apply (idempotent; returns applied/skipped/errored):
```bash
curl -s -X POST https://www.evenscribe.app/api/run-migrations -H "Authorization: Bearer $MIGRATION_SECRET"
```

---

## 2. ALL SECRETS / ENV VARS (demo system — V authorized putting these in the prompt)

> Demo credentials, to be rotated before production. Master copy: `Daily Dash EHRC/ETA/_sprint0-secrets/eta-vercel-env-vars.env`. Everything below is set in **Vercel env (Production + Preview)** unless noted.

### Auth / platform
```
JWT_SECRET_DOCTOR=<REDACTED>
JWT_SECRET_ADMIN=<REDACTED>
ADMIN_TOKEN=<REDACTED>
ADMIN_BASE_PATH=<REDACTED>
MIGRATION_SECRET=<REDACTED>
ADMIN_PASSWORD_CURRENT=<REDACTED>   # the SHARED admin password (V/Vanshika/Sandhya/Ira). admin_user.password_hash is the real source of truth. SECURITY: this is in the repo + bug log = a parked P0; new admins should ideally get unique passwords.
```

### STT / multilingual / diarization
```
SARVAM_API_KEY=<REDACTED>
DIARIZE_BASE_URL=https://diarize.llmvinayminihome.uk
DIARIZE_TIMEOUT_MS=90000
NEXT_PUBLIC_STT_RELAY_URL=wss://stt.llmvinayminihome.uk
STT_RELAY_SECRET=<REDACTED>
ELEVENLABS_API_KEY=<REDACTED>   # ElevenLabs Scribe v2, key "ETA STT Lab"
EKACARE_CLIENT_ID=<REDACTED>                                       # eka.care OAuth client-credentials
EKACARE_CLIENT_SECRET=<REDACTED>
```

### Tier-4 feature flags (NEW — all default OFF; set to `1` in Vercel + device-test to activate)
```
NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS=     # trim live-transcription chunk buffers (memory)
NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT=    # Deepgram live WS reconnect + token re-mint
NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD=# extend the iOS worklet-skip to desktop Safari
```
Per-flag device-test checklist: `Daily Dash EHRC/ETA/ETA-TIER4-FLAGS-DEVICE-TEST.md`.

### Platform secrets set ONLY in Vercel (names the code reads; pull values from Vercel if needed)
`DATABASE_URL` / `APP_DATABASE_URL` (Neon app DB), `KB_DATABASE_URL` (Neon KB DB, table `mksap_chunks`, ~304k chunks), `R2_ACCOUNT_ID`/`R2_ENDPOINT`/`R2_BUCKET` (`eta-audio`)/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_ADMIN_ACCESS_KEY_ID`/`R2_ADMIN_SECRET_ACCESS_KEY`, `DEEPGRAM_API_KEY`/`DEEPGRAM_PROJECT_ID`, `RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`RESEND_WEBHOOK_SECRET`, `OLLAMA_BASE_URL` (+ optional `LLM_BASE_URL`/`LLM_API_KEY`), `WHISPER_BASE_URL`, `APP_URL`, model overrides, STT-lab tunables (`PASSIVE_VOICEPRINT_GATE` 0.82, `ELEVENLABS_STT_MODEL`, `SARVAM_STT_MODEL`, `EKASCRIBE_*`, `STT_GOLD_EXTRACT_MODEL`, `OPENAI_API_KEY` — not set), and optionally `CRON_SECRET` (defense-in-depth for the reaper cron; not required — the reaper GET is authed by Vercel's un-spoofable `x-vercel-cron` header).

---

## 3. MCPs / TOOLS TO HAVE READY IN THE NEW THREAD

- **Shell / bash** — git over the PAT; curl health/migration/worker endpoints; validate external APIs. (Core.)
- **GitHub** via PAT-over-HTTPS — repo access (works without a connector).
- **Scheduled tasks MCP** (`mcp__scheduled-tasks__*`) — there's a daily ETA smoke canary (06:33 IST). The stuck-encounter reaper runs on a **Vercel cron** (server-side), not a Cowork scheduled task.
- **Vercel MCP** (`get_project`/`list_deployments`/`get_deployment_build_logs`) — optional; the health-sha poll usually suffices.
- **Claude in Chrome** (`mcp__Claude_in_Chrome__*`) — only for browser-driven vendor-console tasks. **Policy: V types/pastes secret values into web fields; Claude fills non-secret scaffolding only.** (Also used to drive the GitHub Actions e2e earlier.)
- **Filesystem / connected folder** — `Daily Dash EHRC/ETA` holds all PRDs/runbooks/logs (this file lives there).

---

## 4. CURRENT STATE — WHAT IS BUILT AND LIVE (2 Jun 2026)

Live build **`bec4929`**, region `bom1`, all 6 services green (db/kb/llm/whisper/resend/r2). **Migrations applied: 0001–0025** (0013 skipped). `npm run smoke` → 9/9.

### 4.A Foundation (pre-this-session, all SHIPPED/LIVE — see §4.1–4.7 of the 31-May carryover for detail)
v1 complete + hardened; **multilingual** (Sarvam, English path unchanged); **speaker diarization** (pyannote + voiceprint, v2.1 Build C); **v2.0 note types × clinician types** (5×3, `clinician` is the sole identity table, `doctor` dropped); **admin PIN visibility**; **voiceprint retention + retrain + passive capture**; **STT Engine Lab L0–L7** (5 ASR engines + 2-tier scribe; DB-backed registry + adapter interface; `/admin/stt-lab`). EkaScribe was made **scribe-only** (migration 0023; ASR unsupported on our eka account; co-request `eka_emr_template`).

### 4.B THIS SESSION (2 Jun 2026) — reliability backlog + new admin surfaces

**B18/B19 hardening context:** Dr. Ankit (iPhone) hit `no_audio_chunks` → root cause iOS Safari **Private Browsing disables IndexedDB**. Fix shipped: **in-memory chunk failsafe** (`chunksMemRef`) + tolerant IDB read + `probeIdbWritable()` preflight warning. Then a **proactive 3-reviewer audit** logged **B19** (4 security P0s + ~10 P1s + P2s).

**Testing harness (all in CI / on-demand):**
- `scripts/smoke.mjs` (`npm run smoke`) — non-mutating prod canary (health/migrations/pages/admin-stt-lab). Daily Cowork scheduled task 06:33 IST.
- `scripts/check-silent-failures.mjs` (`npm run check:silent`) — scans empty catch/.catch in lib/components/app. **Now a hard CI gate at baseline 0** (ci.yml after vitest).
- **vitest** unit suite (`tests/unit/`) — run in CI via `npx vitest@^2` (NOT a committed dep). `tsconfig` EXCLUDES tests/config or the prod typecheck breaks.
- **Playwright e2e** (`tests/e2e/`, `.github/workflows/e2e.yml`) — GREEN: real-PIN storageState auth + fully-mocked/fail-closed pipeline + Chromium fake-audio + afterEach ARIA-snapshot-on-failure. Specs: authed-record smoke + **B18 regression (IndexedDB blocked → Submit still uploads via memory failsafe)**. `E2E_DOCTOR_PIN` repo secret set. Runs nightly 02:00 UTC + manual dispatch. **mic-denied spec added — PENDING its first CI run.**

**Reliability backlog — ALL 20 non-security items SHIPPED** (scoped doc `ETA-BACKLOG-SCOPED.md`, ordered by difficulty, security P0s excluded per V):
- **Tier 1** `0f40743` — crypto-strong PINs (`crypto.randomInt`); lazy `DATABASE_URL` in db-neon-http; `voice_sample` partial-unique index (**migration 0024**); STT scoring surfaces extract failures.
- **Tier 2** `53039a8`(server)+`78a5eb6`(client)+`d60222a`(test) — Sarvam batch fetch timeouts (`tfetch`); Whisper rolling-buffer tolerant R2 read; Deepgram keep WebM header on queue cap (`splice(1,1)`); Preflight `timeoutSignal()` (Safari<16); RecoveryModal hide-submitted (`markEncounterSubmitted` sentinel); mic-denied e2e spec.
- **Tier 3** `f9ecb18`(STT-lab)+`b9fde47`(email)+`595d16c`(reaper) — scribePending loop fix (`markScribeDone`); STT budget enforce (`estimateCostUsd` fills cost_usd so the $5/day cap binds); **drainFanout atomic claim** (`UPDATE…FOR UPDATE SKIP LOCKED RETURNING`, reclaim only stale running via **migration 0025** `stt_fanout_job.started_at`); dup-email 90s guard on /send; Resend webhook hardening (replay guard + sticky negatives); **stuck-`processing` reaper** `POST/GET /api/admin/reap-stuck` → **hourly Vercel cron** `4390fdd` (authed by `x-vercel-cron`/optional `CRON_SECRET`; verified by reaping a real 7-day-stuck encounter).
- **Tier 4** (flag-gated, default OFF) `9dab463` — trim live chunk buffers; Deepgram live reconnect; desktop-Safari streaming guard. **Activation needs V device-test** (see flags doc).
- **Tier 5** `1857130` — annotated 28 deliberate swallow-handlers + `check:silent` promoted to CI gate.

**New admin surfaces (this session):**
- **`/buglog`** (auth-gated, admin-only) — publishes `content/ETA-BUG-LOG.md` (now the SINGLE SOURCE OF TRUTH, committed in-repo) via a dependency-free MD→HTML renderer (`lib/markdown-min.ts`). **Editing `content/ETA-BUG-LOG.md` + push = published** (read directly via fs, traced by `outputFileTracingIncludes`; no sync step, no generated module). `9f9520a` → repo-source-of-truth `dffc780`. WHY gated: the log contains the shared admin password + the still-unpatched security-P0 details.
- **Admin encounter Audio tab** `97b2dc5` (+ fix `6fd5b64`) — play + download the original encounter audio. `lib/r2.ts signGetUrl()` (presigned R2 GET, 1h TTL, optional attachment) + `GET /api/admin/encounters/[id]/audio-url` (presigned play+download, audit-logged) + inline `<audio>` player on a new "Audio" tab in `EncounterDetailAdminClient`. (Fix: the fetch effect was self-cancelling → "Loading audio…" forever; replaced with a `audioReqRef` guard.)
- **Admins management** `9fbeca0` — `/admin/admins` page (new "Admins" sidebar item) + `GET/POST /api/admin/admins` (any admin session; role hardcoded `super`; bcrypt 12; dup-email guard; audit-logged). Then `0f097be`: per-admin **password reset** (`PATCH /api/admin/admins/[id]`) + **RETIRED the unauthenticated `seed-team` route** (deleted → the unauth admin-creation P0 is dead). Replaces seed-team for onboarding.
- **System Map** `bec4929` — `/admin/system-map` page (new "System map" sidebar item) + `components/admin/SystemMap.tsx`: a custom-designed (no-dep) architecture infographic — the 4-phase/14-stage pipeline, swimlane-coloured infra/deps, key data-model tables, key algorithms. Living map; update the component as the system evolves.

**STT-Lab worker:** `POST /api/admin/stt-lab/run-fanout` (Bearer `$MIGRATION_SECRET` or admin cookie), body `{backfill,limit,reset,score,rescore,status,dedup,scribe,encounterId}`; ~40 s cap per call → drive in small batches.

---

## 5. SCHEMA / MIGRATIONS (0001–0025)

`db/schema.ts` is the schema authority but **raw SQL is used everywhere**. New since 31 May: **0023** ekascribe scribe-only (drops 'asr' from ekascribe capabilities) · **0024** `voice_sample` partial-unique `(clinician_id, source_encounter_id)` where source='passive' · **0025** `stt_fanout_job.started_at` (for the atomic drain claim).

**Key tables:** encounter · clinician · admin_user · send_event · recipient_global/_per_doctor · transcription_run · stt_engine/_fanout_job/_lab_config/_routing/_gold · voice_print/voice_sample · audit_log · trace/llm_traces · settings · pin_attempt · identification_label.

**Traps (load-bearing):**
- **Neon HTTP driver** does NOT support nested `sql` fragment composition — value-param interpolation only. Timestamps come back as strings (wrap `new Date(...)`). `OLLAMA_BASE_URL` already includes `/v1`. `admin_user.id` is a **UUID** (cast `${id}::uuid`).
- **Drizzle pgTable** with no index callback closes `});`; with a `(t)=>({...})` callback closes `}));`. Wrong = build fail.
- **qwen judge:** `lib/qwen.ts` reads `process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL` (LLM_BASE_URL unset in prod). Wrong = judge silently no-ops.
- **tsconfig** must EXCLUDE `tests`/`vitest.config.ts`/`playwright.config.ts` or `**/*.ts` pulls them into the prod typecheck → build ERROR.
- **No new npm deps** — the sandbox can't update `package-lock.json`, so any new dep breaks `npm ci` on Vercel. (Why `/buglog` uses a hand-rolled markdown renderer and the System Map is hand-built, not Mermaid.)

---

## 6. MAC MINI BACKEND (the LAN you cannot reach from the sandbox)

Reachable only via **public HTTPS tunnels** (Cloudflare `llm-tunnel`, UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`). Anything that edits a Mac Mini file, **V must run** on the box. **Never `pip`/`brew upgrade` the diarize venv — pins are load-bearing** (numpy<2 / torch 2.2.2 / pyannote 3.3.2).

| Service | Public URL | Methods | launchd label | Port |
|---|---|---|---|---|
| Diarization + enroll | `https://diarize.llmvinayminihome.uk` | `GET /health`, `POST /diarize` (per-speaker `embedding_base64`), `POST /enroll` | `uk.llmvinayminihome.eta-diarize` | 8001 |
| STT relay (Sarvam streaming) | `wss://stt.llmvinayminihome.uk/ws` | WebSocket (HMAC token) | `uk.llmvinayminihome.eta-stt-relay` | 8787 |
| Whisper ASR | `https://whisper.llmvinayminihome.uk` | `POST /inference`, `GET /healthz` (VAD empty-on-silence guard) | `uk.llmvinayminihome.whisper` (+ shim) | 8080/8081 |
| Ollama (qwen2.5:14b + llama3.1:8b + nomic-embed-text) | via `OLLAMA_BASE_URL` tunnel | OpenAI-compatible | — | 11434 |

Full detail: `ETA-MAC-MINI-BACKEND-HANDOVER.md`.

---

## 7. DOCUMENT MAP (all in `Daily Dash EHRC/ETA/`)

- **THIS FILE** — master carryover (authoritative as of 2 Jun 2026; supersedes the 31-May one).
- **`content/ETA-BUG-LOG.md`** (IN THE REPO) — the **canonical** bug log; published at `/buglog`. Edit it in the repo + push = published. The `Daily Dash EHRC/ETA/ETA-BUG-LOG.md` copy is a read-only mirror.
- `ETA-BACKLOG-SCOPED.md` — the reliability backlog (5 tiers, all 20 non-security items SHIPPED, with commit shas).
- `ETA-TIER4-FLAGS-DEVICE-TEST.md` — the 3 Tier-4 flags + per-flag device-test checklist (PENDING-V activation).
- `ETA-AUDIO-FAILSAFE-PRD.md` — audio-capture failsafe design (#2 preflight done; #3 unified capture + #4 relay capture pending).
- `ETA-STT-ENGINE-LAB-PRD.md`, `ETA-VOICEPRINT-RETENTION-PRD.md`, `ETA-MAC-MINI-BACKEND-HANDOVER.md`, `ETA-V2-PRD(-RESCOPE).md`, `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md`, `ETA-OPEN-ITEMS.md`.
- `_sprint0-secrets/eta-vercel-env-vars.env` — secret master copy.

---

## 8. OPEN ITEMS + NEXT-UP PLANS

### Parked by V — SECURITY (decided to defer; tracked in B19)
1. **RBAC role gates** on sensitive admin mutations (reset-pin / rotate-url / voice-enroll / resend / r2-cors-fix authenticate the cookie but don't check role). *(All admins are `super` today, so low live impact.)*
2. **`finalize-upload` doesn't bind the R2 key to the encounter** (a client could point encounter A at another encounter's `encounters/…` object).
3. **Admin-login has no lockout/rate-limit** (doctor PINs do).
   - ✅ The 4th P0 — **unauthenticated `seed-team` super-admin creation — is now FIXED** (route retired this session).
   - ⚠️ The **shared admin password** (`<REDACTED>`, in repo + bug log) is the live risk that ties these together — recommend unique per-admin passwords + rotation (the new Admins page + reset support this).

### Pending V (no code blocked)
1. **Add Aditya Jain's admin account** — `/admin` → Admins → Add an admin (`Aditya Jain` / `adi.jain@even.in` / a password). V does this (Claude won't create logins).
2. **Device-test + activate the 3 Tier-4 flags** (set each `=1` in Vercel → redeploy → device-test per `ETA-TIER4-FLAGS-DEVICE-TEST.md` → keep or unset).
3. **Confirm Dr. Ankit's iPhone** records + submits a Kannada consult on the reloaded bundle (the B18 failsafe).
4. **mic-denied e2e** — let it run once (nightly 02:00 UTC or manual dispatch) and confirm green.
5. **STT Lab:** label gold encounters (activates accuracy weight + WER); set per-engine `cost_per_min`; scribe tier needs real consults. **eka.care:** V bought +1000 credits but client `<REDACTED>` still returns `txn_limit_exceeded` — confirm with Eka the credits link to that client_id / Scribe tier.
6. **Voiceprint passive capture** real-encounter smoke (a `passive` voice_sample appears after a matched-clinician consult).
7. **Provision the pilot physiotherapist** (name TBD) then device-test the Physiotherapy note.

### Offered, not yet built (Claude can do next on request)
- "**Remove admin**" control on the Admins page (so it's a full management surface).
- **System Map**: make each pipeline stage **expandable** into deep detail (endpoints, env vars, model configs) so it doubles as a rebuild reference. (V chose architecture-overview depth for v1.)
- **Doctor-side `/buglog`** access (currently admin-only; doctor cookies are slug-scoped so they're excluded).
- Decide the fate of the Daily Dash `ETA-BUG-LOG.md` copy (stub to a pointer vs keep as a read-only mirror — currently a mirror).
- Audio-failsafe PRD #3 (unified AudioContext capture) + #4 (Mac Mini relay persists audio to R2) — both **device/Mini-gated**.

### Candidate next builds (not started)
- STT Lab: local AI4Bharat IndicConformer engine (1 adapter + 1 row).
- Diarization v2.1 tail: live speaker pills + tap-to-relabel; EER threshold tuning after ~50 pilot encounters.
- Post-v2.0 KB ingestion (nutrition / rehab / surgical).

---

## 9. FIRST MOVES IN THE NEW THREAD

1. Confirm repo + live build:
   ```bash
   curl -s https://www.evenscribe.app/api/health   # expect ok:true, sha 8a24949 (or newer), 6 services ok
   ```
2. Clone per §1 (HEAD `8a24949`). Re-clone whenever `/tmp/eta-work` is gone (it gets wiped).
3. Ask V what's next (likely: add Aditya + activate Tier-4 flags after device-test, gold labeling / cost_per_min, the physiotherapist pilot, or a new build from §8). Plan the sprint, build with the safety loop (build green → live sha → `npm run smoke`), and keep `content/ETA-BUG-LOG.md` (push to republish `/buglog`), `ETA-OPEN-ITEMS.md`, the backlog doc, and memory updated.

**You are now fully booted on ETA / Evenscribe. Pick up where we left off.**
