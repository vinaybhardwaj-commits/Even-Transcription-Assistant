# ETA · New Thread Boot Prompt (30 May 2026)

> Paste this entire document as the first message of a new Cowork thread. You'll boot to current state instantly with no loss of context. Supersedes all earlier boot prompts.

---

I'm V (Vinay Bhardwaj), Hospital Product Manager at Even Hospital and General Manager for Even Hospital on Race Course Road, Bangalore. Neurologist by training, now in an operations-heavy role designing HIS / EHR / MIS tools.

We're continuing **ETA — the Even Transcription Assistant**, user-facing **evenscribe** (`evenscribe.app`), also called the **OPD Encounter App**, **Even Assistant**, or **EvenScribe**. It's a **Next.js 15.5 PWA on Vercel** for clinicians at Even Hospital to voice-record patient encounters; an LLM produces structured notes; CDMSS adds clinical decision support against an MKSAP knowledge base; emails go via Resend. Since v1 we've added **multilingual transcription, speaker diarization, real-time streaming, and English translation** (all live).

## One-paragraph state of play

**v1 shipped + hardened.** On top of it we shipped, this session (29–30 May 2026), a large **multilingual + diarization + streaming** body of work, all live on `evenscribe.app`. Main HEAD is **`fa41130`** on `vinaybhardwaj-commits/Even-Transcription-Assistant`. The Mac Mini now runs **three** services (diarization, voice enrollment, and a Sarvam streaming-STT relay), all auto-starting and tunnel-exposed. The big remaining roadmap is **`ETA-V2-PRD.md`** (5 note types × 3 clinician types, sprints V2.S0–V2.S8, pilot dietitian Afshan Kamar) plus a backlog of diarization polish + bugs (below). Everything builds green; deploys are automatic on push to `main`.

## Read these files first (in `Daily Dash EHRC/ETA/`)

1. **`ETA-NEXT-THREAD-BOOT-PROMPT.md`** — this file (start here).
2. **`ETA-CARRYOVER.md`** — master carryover (infra IDs, v1 history, trap memories).
3. **`ETA-OPEN-ITEMS.md`** — living backlog + bugs (the to-do list for this thread).
4. **`ETA-V2-PRD.md`** — the big roadmap (note types × clinician types; §20 = v2.1 diarization design).
5. **`ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md`** — the multilingual/Sarvam testbed PRD.
6. **`ETA-BUG-LOG.md`** — B1–B13 (B12 = Sarvam MIME, B13 = iOS pause/resume).
7. Mac Mini runbooks: **`ETA-STT-RELAY-MAC-MINI-TASK.md`**, **`ETA-DIARIZE-SERVICE-HANDOVER.md`** (+ `ETA-MINI-ENROLL-TASK.md`).

## Repo + deploy

- **Repo:** `vinaybhardwaj-commits/Even-Transcription-Assistant` (GitHub, private).
- **Main HEAD:** `fa41130` (live-language-lock-fix). Live at `https://www.evenscribe.app`.
- **Sandbox is ephemeral** — re-clone each thread:
  ```bash
  cd /tmp && git clone "https://vinaybhardwaj-commits:${GITHUB_PAT}@github.com/vinaybhardwaj-commits/Even-Transcription-Assistant.git" eta-build
  cd eta-build && git config user.email "vinay.bhardwaj@even.in" && git config user.name "Vinay Bhardwaj (Cowork)"
  ```
- **Build/deploy loop:** edit the clone → `git push origin main` → Vercel auto-builds → poll `https://www.evenscribe.app/api/health` for the new `sha` (~60–90s) → tag the commit. Vercel's build runs `tsc`/lint and **catches type errors**; on a failed build prod safely holds on the last good deploy. When a deploy doesn't go live, read the build error via the **Vercel MCP** `get_deployment_build_logs` (don't guess).
- **DB migrations:** `POST https://www.evenscribe.app/api/run-migrations` with `Authorization: Bearer ${MIGRATION_SECRET}`. Use the **www** host (apex redirects `/api` → 308 and drops the body). Migrations applied through `0009` (0006 multilingual, 0007 diarization, 0008 identification_label/EER, 0009 tagged_transcript).
- **Admin login (for curl/testing):** `POST /api/admin/login` `{email,password}` → cookie. Creds below.

## Critical infrastructure, keys & env (use without re-asking)

| Resource | Value |
|---|---|
| GitHub repo | `vinaybhardwaj-commits/Even-Transcription-Assistant` |
| GitHub PAT | `<REDACTED>` |
| Vercel team | `team_yu1wWpsKdjsf90haai1ETJDG` (Hospital Product) |
| Vercel project | `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z` |
| Vercel region | `bom1` (Mumbai) |
| Primary domain | `evenscribe.app` (+ `www`, + legacy `eta.llmvinayminihome.uk`) |
| Admin login | `vinay.bhardwaj@even.in` / `<REDACTED>` |
| Test doctor slug | `dr-vinay-bhardwaj-cjzs` (doctor id `doc_gkldkeu8`) |
| Sarvam API key | `<REDACTED>` |
| STT relay shared secret | `STT_RELAY_SECRET = <REDACTED>` (same on Mac relay + Vercel) |
| Neon project | `calm-resonance-28753525` / branch `br-wild-snow-aoowura2` |
| R2 bucket | `eta-audio` |
| Resend FROM | `transcripts@eta.llmvinayminihome.uk` |

**Full env-var set** (all in Vercel Prod+Preview AND mirrored in `_sprint0-secrets/eta-vercel-env-vars.env`):
`APP_DATABASE_URL`, `KB_DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ADMIN_*`, `JWT_SECRET_ADMIN`, `JWT_SECRET_DOCTOR`, `ADMIN_BASE_PATH`, `ADMIN_PASSWORD_CURRENT`, `ADMIN_TOKEN`, `MIGRATION_SECRET`, `DEEPGRAM_API_KEY`, `SARVAM_API_KEY`, `DIARIZE_BASE_URL=https://diarize.llmvinayminihome.uk`, `DIARIZE_TIMEOUT_MS=90000`, `NEXT_PUBLIC_STT_RELAY_URL=wss://stt.llmvinayminihome.uk`, `STT_RELAY_SECRET`. (Secret VALUES live in that file — read it for MIGRATION_SECRET, DB URLs, etc.)

## Mac Mini services (home box `llmvinayminihome`, Cloudflare tunnel `llm-tunnel` UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`)

All three run under launchd (`RunAtLoad`+`KeepAlive`, survive reboot) and share the one tunnel (`/etc/cloudflared/config.yml`). **The sandbox can reach the public HTTPS/WSS URLs but NOT the home LAN** — Mac-Mini-side changes need a paste-ready runbook for V to run on the box.

| Service | Public URL | launchd label | Port | Notes |
|---|---|---|---|---|
| Diarization + enrollment | `https://diarize.llmvinayminihome.uk` (`/health`, `/diarize`, `/enroll`) | `uk.llmvinayminihome.eta-diarize` | 8001 | FastAPI; pyannote.audio 3.3.2 + SpeechBrain ECAPA on MPS. **Pinned venv — never `pip -U`.** `~/eta-diarize/`. HF token `~/.huggingface/token`. |
| Sarvam STT relay | `wss://stt.llmvinayminihome.uk/ws` | `uk.llmvinayminihome.eta-stt-relay` | 8787 | Standalone Node (`ws`), node v22.20.0 via nvm. `~/eta-stt-relay/`. HMAC-token auth; secrets `~/.eta-sarvam-key` + `~/.eta-stt-relay-secret` (600). Source also in `Daily Dash EHRC/ETA/stt-relay/`. |

## MCPs to spin up in the new thread

- **Vercel MCP** — essential for reading build/runtime logs. Use `list_deployments`, `get_deployment_build_logs`, `get_runtime_logs` with `projectId prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z`, `teamId team_yu1wWpsKdjsf90haai1ETJDG`. (This session it diagnosed both a failed build and the `no_token` 401.)
- **Workspace bash** (built-in) — for the clone/build/curl loop.
- Chrome MCP only if you need to click through the Vercel dashboard (env vars were set this way once); normally not needed.

## What was built this session (29–30 May 2026) — newest first

| Tag / sha | What |
|---|---|
| `live-language-lock-fix` `fa41130` | Live language flipping fix: connect on `unknown`, then **lock** to the dominant Indian language (reconnect WS pinned, transcript preserved). Stops Marathi↔Hindi↔Kannada per-window flip. |
| `stt-token-cookiepath-fix` `44e3b85` | Fixed live `no_token` (doctor cookie is path-scoped to `/{slug}` → token route moved under `/{slug}/api/voice/stt-token`) + **streaming→REST fallback** + **refresh-on-stream-close** so diarization/translation show without a manual reload. |
| `doctor-diarization-surfaced` `6dbb0b8` | Doctor encounter view: "N speakers detected" summary + expandable color-coded "Conversation by speaker"; live pill upgraded to **You / "Another voice in the room" / Listening** (per-window identify, non-latched). |
| `diarization-polish-shipped` `8394cd2` | **English** speaker-tagging via Deepgram diarized batch (`transcribeDiarized`) reconciled to pyannote; **first-person → Patient** role override (`applyRoleOverrides`). |
| `english-translation-box-shipped` `05f5bab` | Surfaced the existing full-audio English translation + vernacular as labelled expandable boxes (doctor + admin). No new infra — Sarvam batch translate already runs at submit. |
| `b-streaming-appside-shipped` `8fcb1f8` | **Real-time streaming (B):** `useSarvamStreaming` (mic→`public/pcm16-worklet.js` 16k PCM→relay→Sarvam codemix WS, VAD), `/{slug}/api/voice/stt-token`, Mac Mini relay + runbook. Flag: `NEXT_PUBLIC_STT_RELAY_URL`. |
| `live-latency-refine-shipped` `7f1fe94` | **Latency (A):** growing-window refine+commit (~10s → ~2–3s) on the REST trace. |
| `v2sd-enroll-evidence-admin-kiosk-shipped` `ae632fa` (+`8921f44`) | Enrollment wizard recording-evidence (meter+timer+dot+live text) + **admin kiosk enrollment** (`/admin/doctors/[id]/voice`, row→enroll, detail "🎙 Record voice"). |
| `v2sd-note-tagging-shipped` `fc8af8e` | Note speaker-tagging (Sarvam batch `with_diarization` → `reconcileTagged` → `tagged_transcript`; migration 0009). |
| `v2sd6-eer-harness-shipped` `5c2bfb7` | Admin **Diarization** page `/admin/diarization` + `/api/admin/diarization-eer` (label correct/wrong, EER once ≥3 each; migration 0008). |
| `v2sd2-live-pill` `6afa8ca` | Live clinician-identify pill (`/api/voice/identify`, cosine vs `voice_print` centroid, 0.78). |
| `mt-multilingual-v2` `69bbc07` / `mt3-engines-view` | Sarvam multilingual: single codemix live box + submit-time batch translate; admin Engines comparison tab. |

## Architecture quick-map (where things live)

- **Live transcription:** `components/recording/RecordingScreen.tsx` chooses `useSarvamStreaming` (relay set) else `useSarvamRolling` (REST refine); both feed `SarvamTranscript` + the submit pipeline. Clinician pill = `useSpeakerIdentify`. Recorder = `lib/use-media-recorder.ts` (has `onStream` for the PCM worklet + level meter).
- **Submit pipeline:** `app/[slug]/api/encounters/[id]/process/route.ts` → `translateIfNeeded` (Sarvam batch translate; sets `transcript_raw`=English + `transcript_original`=vernacular + captures `sarvamEntries`) → note → CDMSS → **then** `diarizeStore` (Mac Mini `/diarize`; stores `speakers`/`transcript_segments`/`tagged_transcript`; English path uses `transcribeDiarized`; `applyRoleOverrides`). **Diarization runs AFTER the "final" stream event** — the doctor client refreshes on stream-close to show it.
- **Sarvam client:** `lib/sarvam.ts` (`sarvamCodemix`, `sarvamBatchTranslate` with `withDiarization`, MIME-param stripping). **Streaming:** `lib/use-sarvam-streaming.ts` + relay.
- **Diarize reconcile/roles:** `lib/diarize.ts` (`reconcileTagged`, `applyRoleOverrides`). **Deepgram:** `lib/transcribe.ts` (`transcribeAudio`, `transcribeDiarized`). **Enroll:** `lib/enroll.ts`.
- **Admin encounter detail:** `components/admin/EncounterDetailAdminClient.tsx` (tabs note/transcript/engines/speakers/cdmss/send/audit). **Doctor view:** `components/encounter/EncounterDetailClient.tsx`.

## Load-bearing patterns & gotchas (don't relearn the hard way)

- **Doctor cookie `rounds_session` is path-scoped to `/{slug}`** (lib/cookie.ts). Every doctor-authed API MUST live under `/{slug}/api/...` or it 401s (this caused the streaming `no_token` bug). Admin cookie is path `/`.
- **`respondError` codes are a fixed union** (PIN_*, AUTH_REQUIRED, AUTH_EXPIRED, NOT_FOUND, FORBIDDEN, VALIDATION_FAILED, PIPELINE_FAILED, SEND_FAILED, UPSTREAM_UNAVAILABLE, RATE_LIMITED). Inventing a code = build break. `respondOk(data)` returns the object directly (no `{data}` wrapper).
- **Neon HTTP driver** (`neon()` from `@neondatabase/serverless`), not a pool.
- **Sarvam:** codemix mode = native script + inline English; sync REST caps at 30s (window it); per-message `encoding` must be `"audio/wav"` even for raw PCM; the WS auth is an `Api-Subscription-Key` **header** → browser can't connect → **relay required**; `language-code=unknown` re-detects per utterance and flips → **lock after detect** (current behavior).
- **Mac Mini diarize venv is pinned** (torch 2.2.2, numpy<2, pyannote 3.3.2, `PYTORCH_ENABLE_MPS_FALLBACK=1`). Never upgrade.
- **No new npm deps** in the app unless necessary; the relay uses only `ws` (on the Mac Mini, not the app).

## Open backlog & bugs to tackle next (see `ETA-OPEN-ITEMS.md` for the living list)

**Bugs / polish**
- **Doctor-enrollment live text** uses `/api/voice/transcribe-window` (no slug) — same cookie-path issue, so live text 401s for doctor self-serve (the level meter still works; admin kiosk works because admin cookie is global). Fix: add a `/{slug}/api/voice/transcribe-window` (or move it) and point the doctor wizard at it.
- **Language lock** can pick a close neighbor (Hindi vs Marathi) if the first few utterances misdetect — acceptable + stable; could improve with a confidence-weighted vote.
- **Streaming** has no auto-reconnect if the WS drops mid-encounter (only the lock-swap + error→REST fallback). Consider reconnect-with-backoff for pilot robustness.
- **65s clip → 1 speaker** under-segmentation (OSD/diar tuning, data-gated).

**Data-gated (need ~50 pilot encounters)**
- EER threshold tuning (0.70 batch / 0.78 live) — harness live at `/admin/diarization`, label matches there.
- OSD hyperparameter tuning (V2.SD.6).

**Roadmap**
- **ETA-V2-PRD** — the big build: 5 note types × 3 clinician types, sprints V2.S0–V2.S8, pilot dietitian Afshan Kamar.
- v2.1 diarization remaining polish; pilot readiness (accumulate real encounters); streaming hardening for clinic use.

**Pending V (device tests)**
- Re-test a 5-min Marathi conversation: language should settle after ~10–15s and **hold**; speaker summary auto-appears after submit.
- Full kiosk enrollment of another doctor; relay `127.0.0.1` bind hardening (optional).

---

**First action in the new thread:** read `ETA-OPEN-ITEMS.md`, confirm HEAD is `fa41130` (re-clone), then ask me what to pick up — most likely either kicking off **ETA-V2-PRD** or clearing the bug/polish list above.
