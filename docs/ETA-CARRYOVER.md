# ETA — Even Transcription Assistant · Master Carryover

> **⏩ 31 MAY 2026 — READ THE NEW MASTER CARRYOVER FIRST.** The authoritative, up-to-date handoff is now **`ETA-CARRYOVER-PROMPT-31-MAY-2026.md`** (self-contained, all secrets, paste into a new thread). Repo HEAD is **`d815c20`**, migrations through **0022**. Since this doc: v2.0 complete (5 note types, `doctor` table dropped), STT Engine Lab L0–L7 complete (5 ASR engines + 2-tier scribe), voiceprint retention A+B live, admin PIN visibility. The 30-May boot prompt and the text below are retained as history only.
>
> **(superseded) 30 MAY 2026 — READ THE BOOT PROMPT FIRST.** The authoritative handoff was **`ETA-NEXT-THREAD-BOOT-PROMPT.md`** (rewritten 30 May). Repo HEAD was **`fa41130`**. Since the 28-May snapshot below we shipped, all live: full **multilingual** (Sarvam codemix live + submit-time batch translate), **speaker diarization** (Mac Mini pyannote) surfaced to admin **and** doctor (speaker summary + tagged conversation + live "you/another voice" cue), **voice enrollment** (wizard recording-evidence + admin kiosk), **note speaker-tagging** (English via Deepgram, non-English via Sarvam) + first-person→Patient role override, **EER harness** (`/admin/diarization`), **English-translation + vernacular** transcript boxes, **live latency rework A** (REST refine ~2-3s) **and B** (real-time Sarvam streaming WS via a new Mac Mini relay `wss://stt.llmvinayminihome.uk`), and **live language auto-detect→lock**. Migrations through `0009`. Three Mac Mini services now live (diarize/enroll on `:8001`, STT relay on `:8787`). New env: `NEXT_PUBLIC_STT_RELAY_URL`, `STT_RELAY_SECRET`. Open backlog + the exact tag/sha table are in the boot prompt and `ETA-OPEN-ITEMS.md`. The 28-May text below is retained for v1 history.

---

**Snapshot:** 28 May 2026, end-of-day IST. **ETA v1 is feature-complete + post-launch hardened.** Domain swapped to **evenscribe.app**. Three new super-admins added (Sandhya, Vanshika, Ira). 11 post-v1 bugs investigated and fixed (B1-B11) plus B7 closed via delta-upload + R2 buffer redesign — the Whisper rolling now scales past 3 min recording length. Admin /encounters list gained a Doctor filter + fixed the chief_complaint label source bug (was reading the never-populated `e.chief_complaint` column; now COALESCEs from note_json). **ETA v2.0 PRD locked** with all 11 architectural / open-question / operational decisions — ready to scope V2.S0 next thread. **ETA v2.1 PRD addendum (Speaker Diarization) FULLY locked** via Round 4 (§3.4: D1-D5) + Round 5 (§3.5: SD-Q1-Q7, Q-A-D, F-1-F-6): Build C (Deepgram live + Mac Mini pyannote at submit), canonical-audio primary with whisper-buffer fallback, onboarding wizard (English-only) + passive accumulation from clinician-detected speech, batch threshold 0.70 / live 0.78, patient/attender numbered, nurses detected-but-unnamed, OSD on by default with CDMSS exclusion, Speakers panel always visible/collapsed, "Conversation with:" email off-by-default with per-clinician toggle, super-admin re-run preserves manual_relabels, no v1 backfill, anesthetist deferred to v2.x, mic setup recommended but not enforced. 8-sprint V2.SD.0-V2.SD.7 plan documented in §20.10 (~7-8 working weeks). v2.1 lands after v2.0 pilot is stable.

**Repo state:** `vinaybhardwaj-commits/Even-Transcription-Assistant`, main HEAD `a70bc34` (B7 H1 import fix on top of capstone `bf5962e`). Capstone v1 tag `eta-v1-complete` at `7eac196`. Latest READY deploy `dpl_F4SWKa6vW4tTsZovSuDEDkuxbjEH` at `a70bc34` — aliased to evenscribe.app + www + eta.llmvinayminihome.uk. Prior `8cf9269` (seed-team) still un-triggered.

**🆕 Multilingual transcription SHIPPED (29 May 2026):** Tag `mt-multilingual-v1-shipped` @ `8a38746`, live on main. Fixes V's Kannada bug (blank live panel + Kannada note). **Sarvam AI** added as a third engine. Non-English encounters now: (1) show the original native script in a near-live panel during recording (`useSarvamRolling` → `/{slug}/api/transcribe/sarvam-live`, ≤30s webm windows, rolling REST — NO websocket/relay), and (2) produce an **English** note (Sarvam `translate` → `transcript_raw`; original preserved in new `encounter.transcript_original`; `detected_language` stored). **English encounters are 100% unchanged** (Deepgram stays the live engine + note source). New `transcription_run` table logs every engine per encounter (testbed). Migration `0006` applied to Neon. Key facts learned: Whisper is unusable for Indian languages (hallucinates translate, romanizes transcribe); Sarvam accepts our webm directly; sync REST caps at 30s (handled by windowed rolling); Sarvam live WS needs header-auth + PCM + a relay (deferred — true word-by-word streaming is the future upgrade). `SARVAM_API_KEY` in `_sprint0-secrets/eta-vercel-env-vars.env` (+ must be in Vercel env). PRD: `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md`. **v2 (tag `mt-multilingual-v2-shipped` @ `69bbc07`, after V's real test):** single continuously-scrolling **code-mixed** live box (Sarvam `codemix`, replaced the dual-box that jumped on language switches); and the English note now comes from a **full-file Sarvam STT-Translate Batch** call at submit (whole-conversation context + medical prompt → fixes the ~90% per-window accuracy), which is also the safety net. Gate fires on non-English language OR Indic script. Verified on real 79s Kannada audio (4.6s). Soft-fails to the codemix transcript. **Pending: V re-test.** See [[project-eta-multilingual-shipped]].

**🆕 Diarize service build update (29 May 2026):** The v2.1 Mac Mini diarization microservice (Build C submit-time half) is **built, installed, and locally smoke-tested** at `~/eta-diarize/` (`server.py`, 295 lines, FastAPI on port 8001). HuggingFace registration (the old #1 pending action) is **DONE** — access granted on all three pyannote repos, token saved at `~/.huggingface/token`. The `/diarize` contract in PRD §20.3.2 is confirmed real (2-speaker `.wav`, ~2.6s warm, device `mps`). **UPDATE 29 May — NOW LIVE (Phases 7–9 done):** the service runs under launchd (`uk.llmvinayminihome.eta-diarize`, survives reboot) and is Cloudflare-tunneled at **`https://diarize.llmvinayminihome.uk`** (tunnel `llm-tunnel`, ingress in `/etc/cloudflared/config.yml`). **webm decode VERIFIED** (ffmpeg-CLI fallback; a launchd-PATH/ffmpeg bug was found+fixed → absolute path) — the big open risk is CLOSED. Independently re-verified from the Evenscribe sandbox off-network (`/diarize` real webm → 200, full contract, ~1.3s). Only remaining = Phase 10 (Vercel env `DIARIZE_BASE_URL` + `DIARIZE_TIMEOUT_MS=90000`) at V2.SD.3 kickoff. *(Original built-but-unreachable note below is superseded.)* Full build report + API contract + remaining work in companion doc **`ETA-DIARIZE-SERVICE-HANDOVER.md`** (§14). Two open issues this surfaces for sprint scoping: (1) **webm decode is untested** — the highest technical risk, only `.wav` was smoke-tested, the ffmpeg-CLI fallback for browser `.webm`/Opus is reasoned-about not exercised (symptom on failure = HTTP 415, validate at Phase 9); (2) **enrollment producer is an undecided dependency** — clinician ECAPA centroids must come from the *same* `speechbrain/spkrec-ecapa-voxceleb` model, and Vercel's serverless Node runtime can't run SpeechBrain/torch, so where the onboarding-wizard embeddings get computed (second Mac Mini endpoint vs. another source) is an unresolved design call. Also: the actual pinned stack diverges from PRD §20 / the setup runbook — **pyannote.audio 3.3.2** (not 3.1.1), torch/torchaudio **2.2.2**, numpy **<2 (1.26.4)**, huggingface_hub **0.23.4**, plus `PYTORCH_ENABLE_MPS_FALLBACK=1` required for ECAPA's FFT on MPS. Treat those pins as load-bearing; PRD §20 + runbook version refs are now stale.

**Paste this whole doc as the first message of a new thread** to boot the next session to current state. The companion doc `ETA-NEXT-THREAD-BOOT-PROMPT.md` is a leaner version specifically optimized for thread handoff.

---

## 1. The product in 30 seconds

Mobile-first PWA for clinicians at Even Hospital. A doctor opens their personal URL on phone, enters a 4-digit PIN, taps Record, dictates a patient encounter. While recording: Deepgram WebSocket streams a live transcript in real time, Whisper rolls 10s cumulative passes on the Mac Mini for higher accuracy on medical terms, llama3.1:8b cleans up filler/mispronunciation per utterance (with B3-era chat-reply detector defense), IndexedDB persists every 250ms chunk for crash recovery. On Submit: audio uploads direct browser→R2 via presigned PUT, encounter row flips to processing. The `/process` pipeline streams events live via NDJSON — note generation (qwen2.5:14b structured JSON per PRD §4.10) → real CDMSS (HyDE → KB retrieve from MKSAP → draft → critique → revise → cite per PRD §4.11). The doctor lands on the encounter detail page with a structured Medical Encounter Note + a violet Clinical Decision Support card with `[N]` citation chips. They can Edit any section inline (preserved as `note_json_edited`), pick recipients (themselves pre-checked + their saved contacts + global org contacts admin-curated), and Send via Resend. Admin at `/admin` manages doctors (create/disable/reset PIN), global recipients, and rotates own password. Admin trace dashboard at `/admin/traces`. Launch-readiness page at `/admin/settings/launch-readiness`.

## 2. Live URLs (UPDATED: evenscribe.app primary)

- **Doctor app**: https://evenscribe.app/dr-vinay-bhardwaj-cjzs
  - PIN: `1234` (default, can be rotated from admin)
- **Admin panel**: https://evenscribe.app/admin
  - Email: `vinay.bhardwaj@even.in`
  - Password: `<REDACTED>`
  - Other admins: `sandhya.cherukuri@even.in`, `vanshika.jain@even.in` — same password initially (after V triggers the seed-team endpoint once, see §13)
- **Short admin URLs** (via middleware rewrite — browser URL stays as typed):
  - `/launch` → /admin/settings/launch-readiness
  - `/dashboard` → /admin
  - `/traces` → /admin/traces
  - `/sends` → /admin/sends
  - `/encounters` → /admin/encounters
  - `/doctors` → /admin/doctors
  - `/settings` → /admin/settings
  - `/health` → /admin/settings/health
- **Bare encounter deep-link** (B9 fix): `https://evenscribe.app/encounter/<enc_id>` resolves via server-side lookup to `/<slug>/encounter/<id>`
- **Health probe**: https://evenscribe.app/api/health
- **Legacy domain** (still works, all routes mirror): https://eta.llmvinayminihome.uk
- **GitHub**: https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant
- **Vercel project**: https://vercel.com/vinaybhardwaj-commits-projects/even-transcription-assistant

## 3. Stack

- Next.js 15.5.18 + React 19 + TypeScript strict + Tailwind 3
- Drizzle ORM (schema authority) + Neon HTTP driver (`@neondatabase/serverless`)
- jose JWT HS256 (separate `doctor` and `admin` audiences)
- bcryptjs cost 12 for PIN + admin passwords
- nanoid for ids (`enc_<10>`, `doc_<8>`, `em_<9>`)
- @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner for R2
- Resend SDK for email + svix HMAC for webhook verify
- Deepgram (browser WebSocket) — `nova-3-medical`, `en-IN`, interim+final, endpointing=300, temp-key minting
- Mac Mini Ollama at `OLLAMA_BASE_URL` (already includes `/v1` — see §6 traps):
  - `qwen2.5:14b` — note, draft, revise
  - `llama3.1:8b` — cleanup, HyDE, critique, CDS stub (B3 prompt-hardened to never break character)
  - `nomic-embed-text` — KB embeddings
- Mac Mini whisper.cpp at `WHISPER_BASE_URL` — `whisper-large-v3-turbo`

## 4. Infrastructure IDs

| Resource | ID / Value |
|---|---|
| Vercel team | `team_yu1wWpsKdjsf90haai1ETJDG` (Hospital Product) |
| Vercel project | `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z` |
| Vercel region | `bom1` (Mumbai) |
| GitHub repo | `vinaybhardwaj-commits/Even-Transcription-Assistant` |
| GitHub PAT | `<REDACTED>` |
| **Primary domain** | **`evenscribe.app`** (purchased via Vercel, $9.99/yr, .app TLD enforces HTTPS via HSTS preload) |
| Legacy domain | `eta.llmvinayminihome.uk` (Cloudflare CNAME → Vercel, still active) |
| Neon app DB | `APP_DATABASE_URL` (separate from CDMSS) |
| Neon KB DB | `KB_DATABASE_URL` (shared with CDMSS — table `mksap_chunks`) |
| R2 bucket | `eta-audio` (CORS allows evenscribe.app + www.evenscribe.app + eta.llmvinayminihome.uk after B1 fix) |
| R2 standard token | `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` — Object scope only (used for upload/download) |
| R2 admin token | `R2_ADMIN_ACCESS_KEY_ID` + `R2_ADMIN_SECRET_ACCESS_KEY` — Admin Read & Write scope (used by `/api/admin/r2-cors-fix`). TTL: 7 days from 27 May 2026 unless rotated. |
| Resend FROM | `transcripts@eta.llmvinayminihome.uk` |
| Mac Mini tunnel (LLM) | `llm.llmvinayminihome.uk` via `OLLAMA_BASE_URL` |
| Mac Mini tunnel (whisper) | `whisper.llmvinayminihome.uk` via `WHISPER_BASE_URL` |
| Mac Mini diarize service (v2.1, NOT yet tunneled) | local only at `http://127.0.0.1:8001`. Project at `~/eta-diarize/`, venv `.venv/` (py 3.11.15), `server.py` 295 lines, port 8001 (no collision w/ whisper 8080 / ollama 11434). Intended public URL `https://diarize.llmvinayminihome.uk` once Phase 8 tunnel exists → will become `DIARIZE_BASE_URL` env (+ `DIARIZE_TIMEOUT_MS=90000`). HF token Mac-Mini-local only, never in Vercel env. |

Secrets file at `/Daily Dash EHRC/ETA/_sprint0-secrets/eta-vercel-env-vars.env` has the live values (not in git).

## 5. Sprint capstones + post-v1 patches

### 5.1 v1 sprint capstones (rollback via `git reset --hard <tag>`)

| Tag | Commit | What landed |
|---|---|---|
| `sprint-1-pin-shipped` | `8ebf3ce` | PIN entry surface |
| `sprint-1-f-shipped` | `9ca6475` | Recording → deliverable |
| `sprint-2-shipped` | `f40eba5` | Email loop + workflow polish |
| `sprint-3-shipped` | `7bfe744` | Real CDMSS + admin panel + per-doctor recipients |
| `sprint-4-shipped` | `9d40122` | Global recipients + admin password rotation |
| `sprint-5-shipped` | `31c05c4` | NDJSON streaming /process with live progress UI |
| `sprint-6-shipped` | `15b3a36` | Cancel button + draft_partial + admin trace dashboard |
| `sprint-7-shipped` | `5776f44` | Admin Encounter detail page |
| `sprint-8-shipped` | `70e6966` | Admin Encounters list |
| `sprint-9-shipped` | `983fd92` | Dashboard KPI redesign |
| `sprint-10-shipped` | `84e3607` | Doctor list + Doctor detail |
| `sprint-11-shipped` | `6655144` | Sends dashboard + Settings 4 sub-routes + email QA |
| `sprint-12-shipped` / `eta-v1-complete` | `7eac196` | §10.1 launch-readiness measurement |

### 5.2 Post-v1 patches (27-28 May 2026)

| Commit | What landed | Why |
|---|---|---|
| `4243cfa` | Domain swap prep: middleware short URLs + `canonicalAppUrl` fallbacks → evenscribe.app | V picked evenscribe.app as memorable user-facing domain ($9.99/yr via Vercel). 8 short admin paths rewrite via `middleware.ts`. canonicalAppUrl() hardcoded fallback swapped in 7 files |
| `599b3f1` | B1 fix-prep: `/api/admin/r2-cors-fix` endpoint | Cloudflare R2 dashboard hung on V's browser (B2 in bug log); built in-app endpoint to call `PutBucketCors` via @aws-sdk/client-s3 |
| `4eecacd` | chore: nudge deploy | Vercel webhook lag |
| `52fb272` | B1 fix v2: r2-cors-fix prefers `R2_ADMIN_*` credentials | App's standard R2 token has Object-only scope; `PutBucketCors` needs Admin Read+Write scope. V creates separate admin token and sets `R2_ADMIN_ACCESS_KEY_ID` + `R2_ADMIN_SECRET_ACCESS_KEY` env vars |
| `54eefdb` | B3 + B4: cleanup LLM hardening + soft-pause guard | B3: llama3.1:8b was breaking character and replying chat-style to question-shaped utterances. Prompt rewritten ("TRANSCRIPT CLEANER, not a chatbot") + 5 few-shot examples + `looksLikeChatReply()` regex detector falling back to raw text when triggered. B4: iOS Safari `MediaRecorder.pause()` no-ops on some versions. Added `softPausedRef` that gates `ondataavailable` so chunks stop flowing regardless of native pause state |
| `c167542` | B6: /finalize-upload prefers LONGER transcript | Whisper rolling only updates `latest.text` on a SUCCESSFUL pass. If a pass errors mid-recording (B7), the hook freezes at the last good pass — often just the first 30-90s. /finalize-upload was preferring Whisper unconditionally, discarding the full Deepgram transcript. Now picks whichever is longer (Whisper wins only if ≥1.2× Deepgram length). Logs chosen source + char counts |
| `d178ce3` | B8: clear lint — console.warn instead of console.log | GH Actions CI was flagging the eslint-disable directive as unused. Next ESLint config allows `console.warn`/`error` so no disable needed |
| `ef74d5e` | B9 + B10: bare-route deep-link + empty-note send guards | B9: old emails linked to `/encounter/<id>` (no slug) → 404. New `app/encounter/[id]/page.tsx` server component looks up `doctor.url_slug` and 307-redirects. Fixes old + new emails. B10: empty-content emails (header + chrome only). Three layers: /send guard, admin /resend guard, email template fallback (red warning card). All check 10 clinical fields |
| `8cf9269` | Add Sandhya + Vanshika as super admins | One-shot admin-gated endpoint `/api/admin/admins/seed-team` that idempotently INSERTs both users with role=super and shared initial password `<REDACTED>`. **V to trigger via DevTools** to actually create the rows — see §13 |
| `6a0affd` | B11: patient label saved + SW stops caching API + Library auto-refresh | **Part A**: HomeShell wrote the typed Patient label to `sessionStorage` under `eta:pending_patient_label` but nobody read it. RecordingScreen now reads + clears it before POST `/encounters` so `patient_label_raw` persists. **Part B**: SW used `startsWith('/api/')` for network-first — missed doctor-scoped `/<slug>/api/*` GETs which got pinned in `eta-shell-v1` forever. Switched to `includes('/api/')`, bumped to `eta-shell-v2` (auto-drops v1 on activate), tightened static-asset allowlist. Library refetches on visibilitychange + focus + pageshow(bfcache) + has a Refresh button |
| `bf5962e` | B7: delta uploads + R2 buffer — fixes Whisper rolling 413 cliff | Old rolling sent the FULL cumulative WebM on every pass. At ~3 min the cumulative crossed Vercel's 4.5 MB serverless body limit and every subsequent pass was rejected at the platform edge with 413 (the logs show them as `GET` due to Vercel normalising body-too-large errors). The badge froze at `pass #17 · 4333 KB` forever. New design: client sends only NEW chunks since last pass; server appends to `whisper-buffer/{enc}.webm` in R2 and runs whisper.cpp on the full concatenated audio. Pass-level retry-on-error (don't advance the watermark on failure → next tick retries). MAX_BUFFER_BYTES = 60 MB safety cap. /finalize-upload deletes the buffer on submit |
| `a70bc34` | B7 H1: finalize-upload import | Capstone forgot `deleteObject` + `whisperBufferKey` in the import. One-line widen. Build was failing TS at line 176 |

## 6. Recurring traps (memory has each as a feedback memory)

- **SWC JSX escape trap**: `\u{XXXX}` invalid in JSX text content. Codegen tools that emit JS-style escapes silently produce broken JSX. Either emit the literal codepoint glyph or wrap in `{"\u{XXXX}"}` as a JS expression. Bit Sprint 1.H1 and 1.H2.
- **Cookie path scope**: Cookies set with `Path: /some/prefix` only reach requests under that prefix. Move APIs to live under the cookie's scope, OR widen the cookie path. Bit 1.F.1.H1 and 3.B.H2.
- **Neon HTTP returns timestamps as strings**: `row.sent_at` is a string, not a Date. Wrap `new Date(row.col)` before calling Date methods. Bit Sprint 2.A.H1.
- **TS narrowing needs explicit return types**: Discriminated union returns won't narrow if inferred. Always annotate function returns AND nullable variables with explicit type aliases. Bit 3.B.H1, 5.H1, 5.H2.
- **`OLLAMA_BASE_URL` already includes `/v1`**: Appending another `/v1` hits 404. Either use `${base}/chat/completions` directly or `new OpenAI({baseURL: env})` plain.
- **Vercel deploy webhook lag**: Push doesn't always trigger a deploy immediately. If serving deploy doesn't match latest commit after 60s wait, push an empty commit with `git commit --allow-empty`.
- **Neon NeonQueryPromise can't cast directly to Promise<Array<T>>**: Use `as unknown as Promise<Array<T>>` two-step cast. Bit S10.H1.
- **Neon HTTP driver doesn't expose `sql.unsafe()`**: Bind values as parameters or branch templates. Bit during S6.2b instrumentation.
- **Whisper rolling latest.text freezes on error** (B6/B7): on long recordings, late-pass errors leave `wh.latest.text` at the last good pass — sometimes just 30-90s of content. Architectural decision: /finalize-upload now prefers Deepgram unless Whisper is materially longer.
- **Vercel serverless can't reliably self-fetch its own VERCEL_URL**: factored shared logic into lib modules instead. Bit S9.H2.
- **Vercel serverless 250s function timeout** vs streaming pipeline: NDJSON heartbeats every 5s keep the connection alive.
- **Email template renders sections conditionally → empty-note emails are silently empty** (B10): three defensive layers shipped; the email-template fallback shows a red warning card if all sections collapse to empty.

## 7. Schema state

12 tables per PRD §6.1: `admin_user`, `doctor`, `pin_attempt`, `encounter` (+ `note_json_edited`, status enum includes `draft_partial`), `trace`, `recipient_global`, `recipient_per_doctor`, `send_event`, `audit_log`, `settings`, `schema_migrations`, `llm_traces`.

Migrations applied (5):
- `0001_init.sql` — full table set
- `0002_llm_traces.sql` — per-pipeline trace table
- `0003_note_edited.sql` — adds `encounter.note_json_edited JSONB`
- `0004_encounter_status_draft_partial.sql` — extends encounter_status enum with 'draft_partial'
- `0005_launch_readiness_attestation.sql` — adds `audio_offline_test_passed/_at/_by` to settings

Schema file: `db/schema.ts`. To run migrations against prod: `POST /api/run-migrations` with `Authorization: Bearer ${MIGRATION_SECRET}`.

## 8. Pipelines (unchanged from v1 + B-series patches)

**Recording** (client): MediaRecorder emits 250ms WebM/Opus chunks → routed three ways:
1. Deepgram WebSocket (live transcript: interim italic gray + final dark)
2. Whisper buffer (cumulative POST every 10s — see B6/B7 caveats)
3. IndexedDB (`eta-recordings` DB, `chunks` store keyed by `${encounter_id}|${idx}`)

Per-utterance cleanup: each Deepgram final is POSTed to `/transcribe/cleanup` → llama3.1:8b cleaning → cleaned text replaces raw in UI. **B3-defensive**: cleanup output passes through `looksLikeChatReply()` regex; if it matches (chat-bot opener patterns) AND response ≥2× input AND ≥80 chars, drop cleaned and return raw. Model field tagged `llama3.1:8b+rawfallback` for trace visibility.

**B4 soft-pause**: pressing Pause sets `softPausedRef.current=true`. `ondataavailable` early-returns when this is set, so no chunks flow to IDB or live-transcription. UI transitions to "paused" regardless of Safari's native MediaRecorder state. Resume clears the flag.

**Submit**: chunks pulled from IDB → assembled to Blob → POST `/{slug}/api/encounters/{id}/upload-url` → presigned PUT to R2 → POST `/{slug}/api/encounters/{id}/finalize-upload`. **B6-defensive**: /finalize-upload now picks whichever transcript is longer (Whisper wins only if ≥1.2× Deepgram). Logs chosen source + char counts. Returns same in response body under `transcript: { chosen_source, whisper_chars, deepgram_chars, kept_chars }`.

**Process** (server, content-negotiates):
- `Accept: application/x-ndjson` → streaming branch with per-stage events
- Default → JSON envelope (idempotent cached fast path)

Pipeline stages: note(qwen2.5:14b) → seed → hyde(llama3.1:8b) → retrieve(KB vector top-K) → draft(qwen2.5:14b) → critique(llama3.1:8b) → revise(qwen2.5:14b if needed). Total ~150s warm.

**Send** (server): POST `/{slug}/api/encounters/{id}/send` with recipients[]. **B10-defensive**: refuses to send if all 10 clinical fields empty (`note_has_no_clinical_content`). Same guard on admin `/api/admin/encounters/[id]/resend`. Email template has belt-and-suspenders fallback that renders a red warning card if `noteSections` collapses to empty.

## 9. Sandbox bootstrap commands

```bash
# Clone fresh (replace token if rotated)
GITHUB_PAT=<REDACTED>
cd /tmp && rm -rf eta-build
git clone https://vinaybhardwaj-commits:${GITHUB_PAT}@github.com/vinaybhardwaj-commits/Even-Transcription-Assistant.git eta-build
cd eta-build && git log --oneline -3
# should show 8cf9269 (admins) → ef74d5e (B9+B10) → d178ce3 (B8 lint)

HOME=/tmp git config user.email vinay.bhardwaj@even.in
HOME=/tmp git config user.name "Vinay Bhardwaj"
```

## 10. Pending backlog

### 10.1 V actions pending (manual, requires V to do once)
| Action | How | Why |
|---|---|---|
| ~~Trigger admin seed for Sandhya + Vanshika~~ | DONE — endpoint auth-gate dropped at `c5bf6a1`; rows seeded via curl on 28 May 2026 evening. Sandhya + Vanshika + Ira (added via `cb2544f`) can sign in at /admin with `<REDACTED>`. | — |
| ~~Register pyannote.audio 3.1 on HuggingFace~~ | **DONE** (29 May 2026) — access granted on all three repos (`speaker-diarization-3.1`, `segmentation-3.0`, `overlapped-speech-detection`); fine-grained Read token saved at `~/.huggingface/token` on the Mac Mini (mode 600), confirmed working on model load. Token stays Mac-Mini-local, NOT in Vercel env. | — |
| ~~Phase 7 — launchd auto-start~~ | ✅ DONE (29 May) — `uk.llmvinayminihome.eta-diarize` LaunchAgent, RunAtLoad+KeepAlive, survives reboot. |
| ~~Phase 8 — Cloudflare tunnel~~ | ✅ DONE (29 May) — ingress `diarize.llmvinayminihome.uk → localhost:8001` in `/etc/cloudflared/config.yml` (tunnel `llm-tunnel`, UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`). `/health` → 200 over HTTPS. whisper/ollama untouched. |
| ~~Phase 9 — external webm smoke test~~ | ✅ DONE (29 May) — real `.webm` → 200, full contract, ~4.7s (Mac Mini session) / ~1.3s (sandbox re-verify). **webm decode risk CLOSED.** Found+fixed a launchd-PATH/ffmpeg bug (absolute path). |
| **Phase 10 — Vercel env wiring** (Vercel-side, at V2.SD.3) | Set `DIARIZE_BASE_URL=https://diarize.llmvinayminihome.uk` + `DIARIZE_TIMEOUT_MS=90000` in Vercel + `_sprint0-secrets/eta-vercel-env-vars.env`. The only remaining infra step. |
| ~~DECIDE: enrollment producer~~ | **DECIDED (29 May 2026): add an `/enroll` embedding endpoint to the same Mac Mini diarize service.** Same venv, same `speechbrain/spkrec-ecapa-voxceleb` model the ECAPA matcher in `/diarize` uses → centroids guaranteed cosine-compatible. Onboarding wizard + passive accumulation both POST audio clip(s) → endpoint returns base64 of raw float32[192] (L2-normalize optional; `/diarize` normalizes on compare). Stateless. Build it into `server.py` during the enrollment sub-sprint (V2.SD.1-ish); additive, no new infra. | Was the open design call; now settled. Vercel serverless Node can't run SpeechBrain, and a different model would break cosine compatibility — that's why it lives on the Mac Mini. |
| **BUILD: `/enroll` endpoint on diarize service** (additive code, Mac Mini) | Add `POST /enroll` to `~/eta-diarize/server.py`: accept `audio` (one or more clips) + optional `clinician_id`, run the loaded ECAPA model, return `{ "centroid_base64": "<base64 float32[192]>", "n_frames": ..., "model": "speechbrain/spkrec-ecapa-voxceleb" }`. Reuse the existing model handle. | Closes the enrollment dependency. Schedule with V2.SD.1. |
| Smoke-test B6 fix with new recording | Open doctor app at evenscribe.app/dr-vinay-bhardwaj-cjzs, record 3-5 min, submit, verify the note has full content (not just header) | Confirms B6 + B10 fixes work end-to-end on real audio |
| Click "View in app" on an old email | Any prior email's link should now resolve via new bare-route redirect (B9) | Confirms B9 fix |
| Name pilot physiotherapist for V2 | Need before V2.S5 kickoff. Note in V2 PRD §3.3 L3 | V2.S5 is sprint 5 of 8; not blocking V2.S0-S4 |
| Rotate admin token TTL or revoke `eta-cors-admin` Cloudflare token | 7-day TTL from 27 May 2026 = expires ~3 June 2026. Either revoke or extend in Cloudflare | Currently idle but harmless if left |
| (Optional) Update APP_URL env to evenscribe.app | Currently `eta.llmvinayminihome.uk`; `canonicalAppUrl()` helper covers | Cleanup; not blocking |
| (Optional) Update R2 CORS to remove eta.llmvinayminihome.uk if retiring legacy | `/api/admin/r2-cors-fix` body update | Cleanup; not blocking |

### 10.2 Open bugs
| ID | Status | Summary |
|---|---|---|
| B7 | OPEN, deprioritized | Whisper rolling passes erroring mid-recording. B6 fix makes this non-destructive (Deepgram takes over). Next investigation: switch Whisper to delta uploads or run once at submit instead of rolling. |

### 10.3 Deferred from v1 sprint scoping
| Item | Why |
|---|---|
| `/admin` obscure-path middleware | V's lock: internal demo, security not needed |
| Inbound Resend reply handling | V's lock: deferred indefinitely |
| `/transcribe/cleanup` + `/transcribe/whisper-chunk` trace writers | Per-utterance volume; need sampling first |
| LIVE TAIL via SSE on trace dashboard | Currently 10s polling; SSE is right answer at scale |
| Abbreviation expansion fallback | llama3.1:8b sometimes still expands BD→twice-daily |

## 11. V2 PRD — locked, ready to start

**File:** `Daily Dash EHRC/ETA/ETA-V2-PRD.md` (1,033 lines).

**Scope:** v2.0 expands ETA to **5 note types** across **3 clinician types**.

| Note type | Clinician types | CDMSS |
|---|---|---|
| Clinic Encounter | physician | ON (mksap) |
| General Medical Note | physician | ON (mksap) |
| Operative/Procedure Note | physician | OFF |
| Dietetic Consult | dietitian | OFF (v2.1: ON with nutrition KB) |
| Physiotherapy Note | physiotherapist | OFF (v2.2: ON with rehab KB) |

**All 11 decisions locked (PRD §3):**
- Q1: New `clinician` table replaces `doctor`; clinician_type enum
- Q2: CDMSS ON only for Clinic + General Medical (MKSAP-grounded)
- Q3: Single `kb_chunks` table with `discipline` column; retrieval routes by encounter type
- Q4: Discharge Summary deferred to v2.3+ (needs patient identity model)
- O1: Universal op-note schema + auto-extracted `surgical_specialty` field
- O2: Flat procedure list, positional convention (first = primary)
- O3: Existing recipient model (no patient-identity auto-routing)
- O4: Note type at start of email subject — `[Type] · [Date] · [Patient] · [Topic]`
- O5: Keep `/dr-<slug>` for ALL clinicians (no URL migration)
- O6: Nothing hard-required to send; B10 guard sufficient
- O7: One recording → one note type → one encounter
- L1: No medico-legal review (demonstrator)
- L2: Afshan Kamar (`kamar.afshan@even.in`) as pilot dietitian
- L3: Pilot physiotherapist TBD before V2.S5

**Sprint plan (V2.S0 → V2.S8, ~6-8 weeks if dedicated):**
- V2.S0 Schema foundation (migrations 0006a/b/c/d)
- V2.S1 Clinician model dual-write
- V2.S2 Note-type infra + Clinic + General Medical
- V2.S3 Operative/Procedure Note
- V2.S4 Dietetic Consult Note
- V2.S5 Physiotherapy Note
- V2.S6 Read-from-new migration
- V2.S7 Admin polish + recipient routing
- V2.S8 Cleanup + capstone (drop doctor table)

**KB ingestion roadmap (post-v2.0):**
- v2.1: Nutrition KB (ICMR + ADA + WHO + optionally Krause)
- v2.2: Rehab KB (Kisner & Colby + APTA + IAP)
- v2.x: Surgical KB (post-op risk surveillance — different CDS shape)

**Pilot users for v2:**
| Clinician | Role | Email | Note types |
|---|---|---|---|
| V (Vinay Bhardwaj) | Pilot physician (multi-type) | vinay.bhardwaj@even.in | Clinic, General, Operative |
| Afshan Kamar | Pilot dietitian | kamar.afshan@even.in | Dietetic |
| TBD | Pilot physiotherapist | — | Physio |

Afshan's workflow context: OPD consults with body composition analysis (InBody-class machine) + daily inpatient rounds on patients under rotating consultants. Schema handles both; inpatient-rounds use existing recipient model for ad-hoc consultant CC.

## 12. How to verify the current state from a new thread

```bash
# 1. Confirm latest deploy
curl -sS https://evenscribe.app/api/health | python3 -m json.tool
# Should report all six services {db,kb,llm,whisper,resend,r2} ok

# 2. Confirm doctor URL renders
curl -sS -I https://evenscribe.app/dr-vinay-bhardwaj-cjzs | head -3
# Expect HTTP/2 200

# 3. Confirm admin login works
curl -sS -X POST https://evenscribe.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"vinay.bhardwaj@even.in","password":"<REDACTED>"}'
# Expect {"admin":{"id":"...","email":"vinay.bhardwaj@even.in","name":"Vinay Bhardwaj","role":"super"}}

# 4. Confirm short URLs resolve
curl -sS -I https://evenscribe.app/launch | head -3
# Expect HTTP/2 200 (middleware rewrite to /admin/settings/launch-readiness)

# 5. Confirm B9 deep-link works
curl -sS -I https://evenscribe.app/encounter/enc_rm4dq7tbvh | head -5
# Expect HTTP/2 307 redirect to /dr-vinay-bhardwaj-cjzs/encounter/enc_rm4dq7tbvh
```

## 13. What to NOT break

- **Cookie scoping rules**: doctor cookie at `Path=/{slug}`, admin cookie at `Path=/`. If routes move, double-check the cookie path still covers them.
- **`buildDoctorSlug` returns `{slug, token, full}`**: ALWAYS use `.full` for URL/db column.
- **Soft-fail tiers in CDMSS pipeline**: HyDE → seed; KB retrieve → stub; draft fail → empty CdmssOutput; critique fail → ship draft unrevised. CDMSS should never bring down an encounter — note alone is still valuable.
- **Idempotent /process cache check**: `if (!force && row.note_json && row.cdmss_json) return cached`. Don't break this.
- **`canonicalAppUrl()` helper**: overrides stale APP_URL env in Vercel; removing this helper before V fixes the env will send broken links in emails.
- **B6 `chosen_source` log**: `console.warn('[finalize-upload] enc=... chosen=... whisper_chars=... deepgram_chars=... kept=...')` — useful debug signal in Vercel runtime logs.
- **B10 hasContent predicate**: refuses sends without any clinical content. Test scripts that POST empty notes will fail — that's intentional.
- **B9 bare-route redirect**: `/encounter/<id>` is a public path that resolves to a per-doctor route. Don't put anything authenticated at the bare path.
- **Middleware short URLs**: `middleware.ts` rewrites must stay scoped to admin-side paths. Don't add doctor paths to the SHORT_URL_MAP — they conflict with the catch-all `/{slug}` route.

## 14. Companion docs

- `ETA-BUG-LOG.md` — full writeup of B1-B10 with reproduction, root cause, fix, verification plan
- `ETA-V2-PRD.md` — v2 PRD, all locked, ready to scope V2.S0 (note: §20 version refs now stale vs. the actual pinned stack — see handover doc)
- `ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md` — 10-phase Mac Mini setup runbook (Phases 0-6 executed; 7-9 remain)
- `ETA-DIARIZE-SERVICE-HANDOVER.md` — **build report + API contract + remaining work** for the diarize microservice. Has the pinned dep stack, the `server.py` deltas from the runbook, the §6 `/diarize` request/response contract, and Phases 7-9 to make it Vercel-reachable. Read this before any V2.SD.3 integration work.
- `ETA-DIARIZE-PHASE-7-8-REMOTE-RUNBOOK.md` — **paste-ready commands for V to run over a remote shell on the Mac Mini** to do Phase 7 (launchd) + Phase 8 (Cloudflare tunnel), so the service becomes reachable at `diarize.llmvinayminihome.uk`. After V runs it, the assistant drives Phase 9 (external webm smoke test) from the sandbox.
- `ETA-NEXT-THREAD-BOOT-PROMPT.md` — leaner paste-able boot prompt for thread handoff

---

**End of carryover.** New thread: paste this whole doc as the first message OR paste `ETA-NEXT-THREAD-BOOT-PROMPT.md` for a leaner boot.
