# ETA / Evenscribe — Build History

A milestone chronology of how the app was built (May–June 2026). Per-bug detail is in
[`../content/ETA-BUG-LOG.md`](../content/ETA-BUG-LOG.md); the scoped reliability backlog is in
[`ETA-BACKLOG-SCOPED.md`](ETA-BACKLOG-SCOPED.md); session-by-session handoffs are the
`ETA-CARRYOVER-*` docs. Commit shas referenced throughout are in repo history.

## v1 — core record → note → email (late May 2026)
PIN auth (clinician slug + 4-digit PIN, JWT, lockout) · `MediaRecorder` capture with IndexedDB +
in-memory failsafe · presigned R2 upload · streamed `/process` pipeline (cleanup → qwen note →
llama CDS with pgvector KB retrieval + citation-critique) · inline note edit · Resend send with
svix delivery webhooks · admin console (clinicians, recipients, encounters, LLM traces, health,
launch-readiness) · service-worker PWA with killswitch. Migrations 0001–0005.

## Multilingual transcription (30 May)
Sarvam Saaras v3 for Indic languages: live code-mixed rolling transcript + submit-time batch
STT-translate to English; English path (Deepgram) unchanged; `transcription_run` + detected-language
storage; leading-hallucination/ad guard. Migration 0006.

## Speaker diarization v2.1 (30–31 May)
Mac-Mini pyannote `/diarize` + `/enroll`; voice enrollment wizard; submit-time diarization +
voiceprint naming; speaker-tagged transcript; admin Speakers timeline + diarization EER harness.
Migrations 0007–0009.

## v2.0 — note types × clinician types (31 May)
5 note types (clinic, general medical, operative, dietetic, physiotherapy) × 3 clinician types
(physician, dietitian, physiotherapist), each with its own schema/prompt/viewer/editor/email.
`clinician` became the sole identity table and the legacy `doctor` table was dropped. CDS gated by
note type. Migrations 0010–0016.

## Voiceprint retention A/B (31 May)
Retain every voice sample (audio + embedding) in `voice_sample`; accumulate + retrain centroids;
passive capture of matched-clinician samples above a confidence gate. Migration 0017.

## STT Engine Lab L0–L7 (31 May – 1 Jun)
Engine registry + adapter interface (new engine = 1 file + 1 row); offline fan-out queue; reference-
free scoring (inter-engine agreement + blinded LLM judge); gold WER + medical-term fidelity;
composite leaderboard; stage×language routing; ASR engines Deepgram/Whisper/Sarvam/ElevenLabs +
a Scribe tier (audio→note vs the `even_pipeline` reference). Migrations 0018–0023.

## Reliability hardening + testing harness (2 Jun)
Proactive 3-reviewer audit (logged as B19) → fixed data-loss + a 20-item reliability backlog across
5 tiers (crypto PINs, Sarvam/Whisper/Deepgram robustness, atomic fan-out claim, dup-email guard,
Resend webhook hardening, stuck-`processing` reaper on an hourly cron, Tier-4 live-path flags).
Test harness: `smoke.mjs` canary, `check:silent` gate, vitest unit suite, Playwright e2e (incl. the
B18 IndexedDB-blocked regression). New admin surfaces: published `/buglog`, encounter audio
play/download, self-serve Admins management, System Map. Migrations 0024–0025.

## Field fixes + scribe swap + CI repair (6 Jun)
- Activated Tier-4 flag #17 (live-buffer trim).
- **Discovered CI had never actually run** (no lockfile → failed at Setup Node on every run); fixed so typecheck + vitest + silent-gate genuinely execute (B21).
- Retired EkaScribe (too costly; row disabled, code kept) and added **`elevenlabs_scribe`** as the showcased scribe competitor (ElevenLabs ASR → Even note-gen). Migration 0026.
- **Dr-Ankit field bugs (B22):** live Sarvam `http_413` payload wedge → byte-capped the live window (`lib/live-window.ts`); service-worker "FetchEvent.respondWith … Load failed" → SW returns a real network error on cache-miss+offline and **no longer proxies non-GET** (so the long `/process` stream isn't SW-wrapped); client auto-recovers a dropped `/process` stream (idempotent route). Added vitest regressions for both (live-window byte cap + SW non-GET bypass).

## Current state
Migrations 0001–0026 applied; all backend services green; `npm run smoke` 9/9; CI green
(typecheck + vitest + silent-gate); Playwright e2e green. See `ETA-OPEN-ITEMS.md` for pending-V
items and `../content/ETA-BUG-LOG.md` for the parked security P0s (B19).
