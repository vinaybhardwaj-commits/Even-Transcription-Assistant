# ETA / Evenscribe — Documentation Index

Everything needed to understand, operate, and rebuild the app. Secret **values** have been redacted
from all docs (replaced with `<REDACTED>`); variable **names** and structure are intact — see the
repo-root [`.env.example`](../.env.example).

## Start here (authoritative, current-state)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system shape, auth, the record→note→deliver pipeline, resilience patterns, driver gotchas.
- [`DATA-MODEL.md`](DATA-MODEL.md) — every table + all 25 migrations + the 5 note types.
- [`REBUILD.md`](REBUILD.md) — stand it up from scratch (services, env, DB, deploy, first users).
- [`BUILD-HISTORY.md`](BUILD-HISTORY.md) — milestone chronology, v1 → today.
- [`../content/ETA-BUG-LOG.md`](../content/ETA-BUG-LOG.md) — the canonical bug log (also published in-app at `/buglog`).

> Where a ported design doc below conflicts with the four files above or the code, the above win.
> The PRDs/runbooks reflect their authoring dates and may lag the shipped system.

## Product & build specs (ported)
- `EVEN-TRANSCRIPTION-ASSISTANT-V1-PRD.md` — v1 product spec.
- `ETA-V2-PRD.md`, `ETA-V2-PRD-RESCOPE.md` — note-types × clinician-types.
- `ETA-BUILD-PLAN.md` — per-sprint scope/exit criteria.
- `COWORK-BUILD-BRIEF.md` — working agreements + tech-stack locks.
- `EVEN-TRANSCRIPTION-ASSISTANT-SOURCE-CATALOG.md` — file-by-file lift map from sibling apps.
- `SPRINT-0-EXIT.md`, `SPRINT-6-SCOPE.md` — sprint records.

## Subsystem PRDs (ported)
- `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md` — Sarvam multilingual.
- `ETA-STT-ENGINE-LAB-PRD.md` — the engine comparison test-bed.
- `ETA-VOICEPRINT-RETENTION-PRD.md` — voice sample retention/retrain/passive capture.
- `ETA-AUDIO-FAILSAFE-PRD.md` — capture failsafe design.
- `ETA-TIER4-FLAGS-DEVICE-TEST.md` — the live-path feature flags + device-test checklist.

## Backend / infrastructure runbooks (ported)
- `ETA-MAC-MINI-BACKEND-HANDOVER.md` — Ollama, Whisper, pyannote, Sarvam relay (tunnels, launchd).
- `ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md`, `ETA-DIARIZE-SERVICE-HANDOVER.md`, `ETA-DIARIZE-ENROLL-ENDPOINT-RUNBOOK.md`, `ETA-DIARIZE-PHASE-7-8-REMOTE-RUNBOOK.md` — diarization service.
- `ETA-STT-RELAY-MAC-MINI-TASK.md`, `ETA-VOICEPRINT-PASSIVE-CAPTURE-MAC-MINI-TASK.md`, `ETA-MINI-ENROLL-TASK.md`, `ETA-WHISPER-NOSPEECH-GUARD-MAC-MINI-TASK.md` — Mac-Mini tasks.
- `ETA-V2-S8-DROP-DOCTOR-RUNBOOK.md` — the doctor→clinician cutover.

## Status / handoff (ported; point-in-time, oldest→newest)
- `ETA-OPEN-ITEMS.md` — living open-work tracker.
- `ETA-BACKLOG-SCOPED.md` — the 20-item reliability backlog (all shipped).
- `ETA-CARRYOVER.md`, `ETA-CARRYOVER-PROMPT-31-MAY-2026.md`, `ETA-CARRYOVER-PROMPT-2-JUN-2026.md`, `ETA-NEXT-THREAD-*.md` — session handoffs (the 2-Jun carryover supersedes earlier ones).
- `ETA-CLAUDE-MD-SNIPPET.md` — project working-context snippet.

_Not ported: accidental Finder-duplicate files and the raw secrets `.env` (those only held credentials)._
