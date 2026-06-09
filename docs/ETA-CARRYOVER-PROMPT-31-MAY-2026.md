# ETA / Evenscribe — MASTER CARRYOVER PROMPT (31 May 2026)

> **HOW TO USE THIS FILE:** Paste this entire document as the FIRST message of a new Cowork thread. It boots the next session to the exact current state of the Even Transcription Assistant (ETA / Evenscribe) with zero context loss. It is self-contained: it has the repo, every secret/env var/PAT, the service map, the deploy loop, the full build history in brief, and the open/next-up work. This file supersedes all older ETA carryover/boot prompts.

---

## 0. WHO YOU ARE + WHAT THIS PROJECT IS

You are continuing development of **Evenscribe**, internally **ETA — Even Transcription Assistant** (also "Even Encounter Assistant", "Even Assistant"). I am **V (Dr. Vinay Bhardwaj)** — Hospital Product Manager / GM for Even Hospital (Race Course Road), a neurologist now in an operations-heavy product role. I build HIS/MIS/EHR tooling for **EHRC** (Even Health & Research City). ETA is one of several apps I run; this thread is **ETA only**.

**Product in 30 seconds:** Mobile-first PWA for clinicians. A clinician opens their personal URL on phone, enters a 4-digit PIN, taps Record, and dictates a patient encounter. Live: Deepgram WebSocket streams a transcript; for non-English a Sarvam codemix box scrolls in near-real-time (or true streaming via a Mac Mini relay); Whisper rolls 10s cumulative passes on a Mac Mini for medical-term accuracy; llama3.1:8b cleans filler per utterance; IndexedDB persists every 250ms chunk for crash recovery. On Submit: audio uploads browser→R2 via presigned PUT; `/process` streams NDJSON events — speaker diarization (Mac Mini pyannote) → note generation (qwen2.5:14b structured JSON) → real CDMSS (HyDE → KB retrieve from MKSAP → draft → critique → revise → cite). The clinician lands on a structured note + a Clinical Decision Support card with citation chips, edits inline, picks recipients, and sends via Resend. Admin at `/admin` manages clinicians, recipients, traces, diarization EER, and the STT Engine Lab.

**Working style I expect:** Be concise and direct. Ask clarifying questions before big actions. Build sprint-by-sprint with a safety checklist; after every change: build green → deploy → verify live (`/api/health` shows the new `sha`) → tag → update docs/memory. A failed build never deploys (prod holds the last good sha). Use the task list. Keep new subsystems isolated. Verify risky external APIs from the sandbox before wiring them.

---

## 1. REPO, HOST, AND HOW TO DEPLOY

| Resource | Value |
|---|---|
| GitHub repo | `vinaybhardwaj-commits/Even-Transcription-Assistant` |
| **GitHub PAT** | `<REDACTED>` |
| Current HEAD | `d815c20` (STT Lab L7 polish — Health tab virtual-engine fix) |
| Vercel team | `team_yu1wWpsKdjsf90haai1ETJDG` (Hospital Product) |
| Vercel project | `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z` (`even-transcription-assistant`) |
| Vercel region | `bom1` (Mumbai) |
| Primary domain | **evenscribe.app** (apex 307→ `www.evenscribe.app`) |
| Legacy domain | `eta.llmvinayminihome.uk` (still mirrors all routes) |
| Health probe | https://www.evenscribe.app/api/health |
| Stack | Next.js 15.5 + React 19 + TS strict + Tailwind 3; Drizzle schema authority + **Neon HTTP driver** (`@neondatabase/serverless`); jose JWT HS256 (separate doctor/admin audiences); bcryptjs cost 12; nanoid ids; @aws-sdk S3 for R2; Resend SDK + svix HMAC; openai SDK (points at Mac Mini Ollama). **No build step locally — Vercel Pro auto-deploys on push to `main`.** |

### Deploy loop (the routine every change follows)
```bash
# 1. Clone (sandbox can't reach the home LAN, but CAN reach the public HTTPS tunnels + Vercel + GitHub)
PAT=<REDACTED>
cd /tmp && rm -rf eta-fix
git clone https://${PAT}@github.com/vinaybhardwaj-commits/Even-Transcription-Assistant.git eta-fix
cd eta-fix && HOME=/tmp git config user.email vinay.bhardwaj@even.in && HOME=/tmp git config user.name "Vinay Bhardwaj"

# 2. edit → commit → push main
git add -A && git commit -m "..." && git push origin main

# 3. poll for the new sha to go live (Vercel auto-build; a FAILED build never deploys)
for i in $(seq 1 20); do
  sha=$(curl -s https://www.evenscribe.app/api/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('sha','')[:7])")
  echo "$i: live=$sha"; [ "$sha" = "<new-short-sha>" ] && break; sleep 12
done

# 4. tag the capstone
git tag <name>-shipped && git push origin <name>-shipped
```
**Webhook lag trap:** if the serving sha doesn't update after ~60s, push an empty commit (`git commit --allow-empty`).

### Run a DB migration against prod
Migrations live in `db/migrations/NNNN_name.sql`; each ends with `INSERT INTO schema_migrations (version,name) VALUES (N,'...') ON CONFLICT DO NOTHING`.
```bash
curl -s -X POST https://www.evenscribe.app/api/run-migrations \
  -H "Authorization: Bearer $MIGRATION_SECRET"
```

---

## 2. ALL SECRETS / ENV VARS (demo system — V authorized putting these in the prompt)

> These are demo credentials and will be rotated before anything goes to production. Master copy also lives at `Daily Dash EHRC/ETA/_sprint0-secrets/eta-vercel-env-vars.env`. Everything below is already set in **Vercel env (Production + Preview)** unless noted.

### Auth / platform (in the secrets file)
```
JWT_SECRET_DOCTOR=<REDACTED>
JWT_SECRET_ADMIN=<REDACTED>
ADMIN_TOKEN=<REDACTED>
ADMIN_BASE_PATH=<REDACTED>
MIGRATION_SECRET=<REDACTED>
ADMIN_PASSWORD_CURRENT=<REDACTED>   # admin_user.password_hash is the real source of truth
```

### STT / multilingual / diarization (in the secrets file)
```
SARVAM_API_KEY=<REDACTED>
DIARIZE_BASE_URL=https://diarize.llmvinayminihome.uk
DIARIZE_TIMEOUT_MS=90000
NEXT_PUBLIC_STT_RELAY_URL=wss://stt.llmvinayminihome.uk
STT_RELAY_SECRET=<REDACTED>
# --- STT Engine Lab competitors (added 31 May) ---
ELEVENLABS_API_KEY=<REDACTED>   # ElevenLabs Scribe v2, key "ETA STT Lab"
EKACARE_CLIENT_ID=<REDACTED>                                       # eka.care OAuth client-credentials
EKACARE_CLIENT_SECRET=<REDACTED>
```

### Platform secrets set ONLY in Vercel (values not in the secrets file — pull from Vercel dashboard if needed)
These are already configured in Vercel (Production + Preview). The full env-var NAME surface the code reads:
`DATABASE_URL` / `APP_DATABASE_URL` (Neon app DB), `KB_DATABASE_URL` (Neon KB DB, shared w/ CDMSS, table `mksap_chunks`), `R2_ACCOUNT_ID` / `R2_ENDPOINT` / `R2_BUCKET` (`eta-audio`) / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ADMIN_ACCESS_KEY_ID` / `R2_ADMIN_SECRET_ACCESS_KEY`, `DEEPGRAM_API_KEY` / `DEEPGRAM_PROJECT_ID`, `RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `RESEND_WEBHOOK_SECRET`, `OLLAMA_BASE_URL` (+ optional `LLM_BASE_URL` / `LLM_API_KEY`), `WHISPER_BASE_URL`, `APP_URL`, model overrides (`NOTE_MODEL`/`CDS_*_MODEL`/`CLEANUP_MODEL`/`HYDE_MODEL`/`EMBED_MODEL`/`TEXT_MODEL`/`TOP_K`), STT-Lab tunables (`PASSIVE_VOICEPRINT_GATE` default 0.82, `ELEVENLABS_STT_MODEL` default `scribe_v2`, `SARVAM_STT_MODEL`, `EKASCRIBE_MODEL`/`EKASCRIBE_ASR_TEMPLATE`/`EKASCRIBE_SCRIBE_TEMPLATE`, `STT_GOLD_EXTRACT_MODEL` default `gpt-4o-mini`, `OPENAI_API_KEY` for cloud term extraction — NOT yet set).

**Known minor:** the two eka/ElevenLabs secret vars were saved non-Sensitive in Vercel (visible in dashboard). Optional hardening: re-add as Sensitive.

---

## 3. MCPs / TOOLS TO HAVE READY IN THE NEW THREAD

The dev loop runs almost entirely on **bash (git over the PAT) + web_fetch + the public HTTPS tunnels**. To reproduce everything done so far, have these ready:

- **Shell / bash** — git clone/commit/push via the PAT; curl the health/migration/worker endpoints; validate external APIs. (Core — always available.)
- **GitHub** connector or PAT-over-HTTPS — repo access (PAT above works without the connector).
- **Vercel MCP** (`mcp__...__get_project` / `list_deployments` / `get_deployment_build_logs`) — handy to read build logs when a deploy fails; optional (the health-sha poll usually suffices).
- **Claude in Chrome** (`mcp__Claude_in_Chrome__*`) — needed only for browser-driven tasks like creating API keys in vendor consoles or pasting env vars into the Vercel dashboard. Used 31 May to mint the ElevenLabs + eka.care keys. **Policy:** I (V) type/paste the actual secret values into web fields; you fill non-secret scaffolding only.
- **Filesystem / connected folder** — the `Daily Dash EHRC/ETA` folder holds all PRDs/runbooks/logs (this file lives there).

No other MCP is required to continue ETA work.

---

## 4. CURRENT STATE — WHAT IS BUILT AND LIVE (31 May 2026)

Live build `d815c20`, region `bom1`, all 6 services green (db / kb / llm / whisper / resend / r2). Migrations applied: **0001–0022** (0013 intentionally skipped).

### 4.1 v1 (complete, hardened) — `eta-v1-complete` @ `7eac196`
Feature-complete encounter→note→CDMSS→email PWA + admin. 14 post-launch bugs investigated/fixed (B1–B14, see `ETA-BUG-LOG.md`). Domain on evenscribe.app. Super-admins: Vinay, Sandhya, Vanshika, Ira.

### 4.2 Multilingual transcription — SHIPPED
Sarvam AI as 3rd engine. Non-English encounters show native-script near-live (codemix) box and produce an **English** note (Sarvam translate at submit; `transcript_original` + `detected_language` preserved). English path 100% unchanged (Deepgram). `transcription_run` table logs every engine per encounter. Whisper unusable for Indian languages; Sarvam sync caps at 30s → long-form uses Sarvam **batch** API. Live streaming via a Mac Mini relay (`wss://stt.llmvinayminihome.uk`). Live language **auto-detect→lock** (word-count-weighted vote). PRD: `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md`.

### 4.3 Speaker diarization (v2.1 Build C) — SHIPPED / LIVE
Submit-time pyannote diarization + overlap + ECAPA clinician-ID on the Mac Mini (`/diarize`), surfaced to admin (Speakers tab, Gantt timeline) and doctor (speaker summary + tagged conversation + live "you/another voice" pill). Voice enrollment wizard + admin kiosk (`/enroll`). EER harness at `/admin/diarization` (collects ground truth; threshold tuning waits for ~50 pilot encounters). Note speaker-tagging: non-English via Sarvam batch `with_diarization` reconciled to pyannote named speakers; English-via-Deepgram tagging is future.

### 4.4 v2.0 — note types × clinician types — **COMPLETE (S0–S8)** `v2-s8-complete` @ `a022258`
5 note types (Clinic Encounter, General Medical, Operative/Procedure, Dietetic Consult, Physiotherapy) × 3 clinician types (physician, dietitian, physiotherapist). Each has distinct schema/prompt/view/editor/email subject; CDMSS ON for clinic+general, OFF for operative/dietetic/physio (`noteTypeHasCdmss()` gate). **`clinician` is now the SOLE identity table** — the old `doctor` table was dropped (migration 0015) after FK repoint (0014). Pilot dietitian Afshan Kamar provisioned (`/dr-afshan-kamar-kn4c`). Pilot physiotherapist account UNPROVISIONED (name TBD — V). Minor cleanup left: schema.ts still declares a stale `doctor` pgTable (cosmetic — raw SQL everywhere).

### 4.5 Admin PIN visibility — SHIPPED `admin-pin-visibility-shipped` @ `750e5e4`
Super-admins see + auto-refresh each clinician's 4-digit PIN (`clinician.pin_plaintext`, migration 0016, gated role=super). All active clinicians backfilled to their PINs. dr-vinay PIN = **6110**; Afshan PIN = **3359**. (Earlier HOTFIX `43063e7`: six `.tsx` page reads still `FROM doctor` post-drop → 500s, switched to `clinician`.)

### 4.6 Voiceprint retention + retrain + passive capture — SHIPPED / LIVE
- **Sprint A** `voiceprint-retention-sprintA-shipped` @ `0d0cefd`: new `voice_sample` table (migration 0017) — one row per clip (192-d ECAPA embedding + R2 audio key + source enrollment|passive). Both enroll routes now retain audio to R2 and **accumulate** (recompute centroid from ALL samples; no more overwrite). Admin "Voice samples" panel on the clinician detail page: list / download audio / download embedding / download centroid / per-sample delete / Retrain. Legacy samples are embedding-only (audio was discarded pre-31-May).
- **Sprint B (passive capture)** `voiceprint-retention-sprintB-apphook-shipped` @ `f72e3d7` + Mac Mini `/diarize` change applied & verified: `/diarize` now returns per-speaker `embedding_base64` (raw float32[192], L2 norm ≠1). `/process` appends a `passive` voice_sample for the matched clinician (embedding + encounter-audio ref) at confidence ≥ `PASSIVE_VOICEPRINT_GATE` (0.82); below-gate retained but not averaged. **Open: V's real-encounter app-side smoke test** (record as a matched clinician → a passive sample appears in the panel). PRD: `ETA-VOICEPRINT-RETENTION-PRD.md`.

### 4.7 STT ENGINE LAB — **COMPLETE L0–L7** `stt-lab-complete` @ `b70a280` (+ polish `d815c20`)
A backend admin test-bed (`/admin/stt-lab`) that compares every speech-to-text engine on accuracy / speed / cost / reliability so we can pick the best medical stack and route different engines to different circumstances. **Architecture: DB-backed engine registry (`stt_engine`) + a code adapter interface (`lib/stt/adapters/<key>.ts` implementing `SttAdapter`). A new engine = 1 adapter file + 1 registry row → it auto-joins health, fan-out, scoring, leaderboard, routing with zero schema/UI change** (proven by L6 ElevenLabs).
- **L0** registry + adapter interface + per-engine health probe + STT Lab nav/Health tab.
- **L1** offline fan-out: `transcription_run` extended (tier/cost/wer/cer/med_term_recall/agreement/judge/note cols) + `stt_fanout_job` queue + `stt_lab_config` ($5/day budget); on-submit `after()` hook + admin worker route; backfilled all 25 audio encounters.
- **L2** reference-free scoring: inter-engine **agreement** (token-Levenshtein) + **blinded N-engine LLM judge** on Mini `qwen` (A/B/C labels).
- **L3** gold set (migration 0020): verbatim-reference labeling UI + **WER/CER** + **medical-term recall** (cloud extraction if `OPENAI_API_KEY` set, else qwen).
- **L4** dashboard: composite 0–100 **Leaderboard** (configurable weights) + **Runs** browser (side-by-side transcripts, gold word-diff, winner) + **Engines** tab (enable/fanout/cost edit).
- **L5** stage×language **routing** (migration 0021): `stt_routing` table + resolver; note/English enforced server-side in `finalize-upload`, live advisory, diarize single-engine. Safe/reversible — defaults to current behaviour until an admin sets an override.
- **L6** **ElevenLabs Scribe v2** adapter (4th competitor; plug-in path proven).
- **L7** **Ekascribe (eka.care)** adapter — async OAuth client-credentials job (presigned upload → S3 → init → poll) with `transcribe()` (ASR) + `generateNote()` (scribe) — **and the two-tier scoring**: ASR tier (audio→transcript vs verbatim gold) + **Scribe tier** (audio→finished note via Ekascribe, scored by a qwen rubric vs the clinician-edited note; the virtual `even_pipeline` competitor = our own transcribe→LLM note, migration 0022). The polish at `d815c20` makes the adapter-less virtual engine read as "virtual · no probe" on the Health tab instead of a false error.

**5 ASR engines** (deepgram, whisper, sarvam, elevenlabs, ekascribe) + **2-tier scribe** (ekascribe vs even_pipeline). Leaderboard signal so far (NO gold labeled yet): deepgram ~61 / sarvam ~48 / whisper ~44 / elevenlabs ~38 (accuracy weight activates once gold is labeled). PRD: `ETA-STT-ENGINE-LAB-PRD.md`.

**STT-Lab operating notes (worker):** `POST /api/admin/stt-lab/run-fanout` with `Authorization: Bearer $MIGRATION_SECRET`, body `{backfill,limit,reset,score,rescore,status,dedup,scribe}`; each call caps ~40s server-side, so drive in small batches.

---

## 5. SCHEMA / MIGRATIONS (0001–0022)

`db/schema.ts` is the schema authority but **raw SQL is used everywhere** (Drizzle is not the query layer). Migration files in `db/migrations/`:

```
0001_init · 0002_llm_traces · 0003_note_edited · 0004_encounter_status_draft_partial
0005_launch_readiness_attestation · 0006_multilingual_transcription · 0007_diarization
0008_identification_label · 0009_tagged_transcript · 0010_clinician_table · 0011_encounter_note_type
0012_clinician_backfill · 0014_repoint_fks · 0015_drop_doctor · 0016_clinician_pin_plaintext
0017_voice_sample · 0018_stt_engine · 0019_stt_fanout · 0020_stt_gold · 0021_stt_routing
0022_stt_even_pipeline      (0013 was skipped — no such file)
```

**Hard-won schema trap (cost two build holds):** a Drizzle `pgTable` with **no** index callback must close `});`; one **with** a `(t)=>({...})` callback closes `}));`. Getting this wrong = "Expected a semicolon" build fail (prod safely holds).

**Neon HTTP driver traps:** it does **NOT** support nested `sql` fragment composition — only value-param interpolation (build WHERE clauses as `${bucket}='all' OR col=${bucket}`, not by composing fragments). Timestamps come back as strings (wrap `new Date(...)`). `OLLAMA_BASE_URL` already includes `/v1`.

**qwen judge trap:** `lib/qwen.ts` must read `process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL` (LLM_BASE_URL is unset in prod; the rest of the app uses OLLAMA_BASE_URL). Getting this wrong = judge silently no-ops.

---

## 6. MAC MINI BACKEND (the LAN you cannot reach from the sandbox)

The sandbox reaches these only via their **public HTTPS tunnels** (Cloudflare `llm-tunnel`, UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`). Anything that edits a Mac Mini file, **I (V) must run** on the box. **Never `pip`/`brew upgrade` the diarize venv — the pins are load-bearing** (numpy<2 / torch 2.2.2 / pyannote 3.3.2).

| Service | Public URL | Methods | launchd label | Port |
|---|---|---|---|---|
| Diarization + enroll | `https://diarize.llmvinayminihome.uk` | `GET /health`, `POST /diarize` (returns per-speaker `embedding_base64`), `POST /enroll` | `uk.llmvinayminihome.eta-diarize` | 8001 |
| STT relay (Sarvam streaming) | `wss://stt.llmvinayminihome.uk/ws` | WebSocket (HMAC token) | `uk.llmvinayminihome.eta-stt-relay` | 8787 |
| Whisper ASR | `https://whisper.llmvinayminihome.uk` | `POST /inference`, `GET /healthz` (empty-on-silence VAD guard live) | `uk.llmvinayminihome.whisper` (+ shim) | 8080/8081 |
| Ollama (LLM, qwen2.5:14b + llama3.1:8b + nomic-embed-text) | via `OLLAMA_BASE_URL` tunnel | OpenAI-compatible | — | 11434 |

Full detail: `ETA-MAC-MINI-BACKEND-HANDOVER.md`. server.py (`~/eta-diarize/server.py`) current sha `a2f1f643…`, backup `server.py.bak.20260531-052952`.

---

## 7. DOCUMENT MAP (all in `Daily Dash EHRC/ETA/`)

- **THIS FILE** — master carryover (authoritative as of 31 May 2026).
- `ETA-OPEN-ITEMS.md` — living open-work tracker (started / planned / pending-V).
- `ETA-BUG-LOG.md` — post-launch bug log (B1–B16).
- `ETA-STT-ENGINE-LAB-PRD.md` — STT Lab PRD (L0–L7, all shipped).
- `ETA-VOICEPRINT-RETENTION-PRD.md` — voiceprint retention/passive capture (A + B).
- `ETA-VOICEPRINT-PASSIVE-CAPTURE-MAC-MINI-TASK.md` — Mini `/diarize` embedding runbook (done).
- `ETA-MAC-MINI-BACKEND-HANDOVER.md` — Mac Mini service contracts + pins.
- `ETA-V2-PRD.md` / `ETA-V2-PRD-RESCOPE.md` — v2.0 note-types PRD (complete).
- `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md` — multilingual testbed.
- `_sprint0-secrets/eta-vercel-env-vars.env` — secret master copy.
- (older boot prompts `ETA-NEXT-THREAD-BOOT-PROMPT.md` / `ETA-CARRYOVER.md` are superseded by this file.)

---

## 8. OPEN ITEMS + NEXT-UP PLANS

### Pending V (no code blocked on these)
1. **STT Lab — label gold encounters** (`/admin/stt-lab` Gold set tab) → activates the accuracy weight + real WER on the leaderboard. Today the composite leans on speed/reliability only.
2. **STT Lab — set per-engine `cost_per_min` in the Engines tab** → enables cost scoring + running-cost tracking. (ElevenLabs account funded Rs.1000 / ~$12 on 31 May; eka.care is OAuth. Running-cost tracking is a TODO once cost_per_min is set.)
3. **STT Lab — scribe tier needs real medical consults** (Ekascribe correctly rejects non-clinical audio).
4. **Voiceprint passive capture** — record a real consult as a matched clinician → confirm a `passive` voice_sample appears in the admin Voice samples panel.
5. **Provision the pilot physiotherapist** (name TBD) via the admin Physiotherapist selector → then device-test the Physiotherapy note.
6. **Device tests** of all 5 note types + B14/streaming fixes; clean-Marathi consult confidence check.

### Optional / cosmetic
- Add `OPENAI_API_KEY` in Vercel to switch medical-term extraction to cloud (`STT_GOLD_EXTRACT_MODEL` default gpt-4o-mini).
- Re-add the two STT-Lab secret env vars as **Sensitive** in Vercel.
- Remove the stale `doctor` pgTable from schema.ts (cosmetic).
- Soft-deleted test clinician `doc_cqcwzd7q` still present (reset-pin refuses deleted rows, as expected).
- Update `APP_URL` env → evenscribe.app (`canonicalAppUrl()` masks it for now).

### Candidate next builds (not started)
- STT Lab: add a **local AI4Bharat IndicConformer** engine (1 adapter + 1 row) once Mac Mini capacity allows.
- Diarization v2.1 tail: live speaker pills + tap-to-relabel; OSD tuning on short clips; "Conversation with:" email toggle UI; EER threshold tuning after ~50 pilot encounters.
- Post-v2.0 KB ingestion (nutrition / rehab / surgical KBs).

---

## 9. FIRST MOVES IN THE NEW THREAD

1. Confirm you can reach the repo + live build:
   ```bash
   curl -s https://www.evenscribe.app/api/health   # expect ok:true, sha d815c20 (or newer), 6 services ok
   ```
2. Clone per §1's deploy loop (HEAD should be `d815c20`).
3. Ask me what we're working on next (likely: device-test results, gold labeling, the physiotherapist pilot, or a new STT engine). Then plan the sprint, build with the safety loop, and keep `ETA-OPEN-ITEMS.md` + memory updated.

**You are now fully booted on ETA / Evenscribe. Pick up where we left off.**
