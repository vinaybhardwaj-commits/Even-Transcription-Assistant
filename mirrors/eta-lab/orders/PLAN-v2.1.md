# ETA — integrated build plan v2.1 (22 Sep 2026, ~21:40 IST) — pane copy

## 0. Ground truth
- Production = `vinay/s1-auto-drain` @ 248c2ae, deployment dpl_7Re7PRD3t87exhVHpcQvmTM1eTue (production-target). Never alias a preview build to www; build target production then promote (Fable only).
- Vercel Production Branch = `vinay/s1-auto-drain` (set 21:20 IST). `main` = fleet-board line; V does not want it live. Never push/merge to main.
- Migrations: prod at 112. 113 reserved for voice_centroid. Check numbers against BOTH branch heads (run-migrations silently skips clashes).

## 1. Ownership
- Mini whisper-shim + whisper units: MiniBot — never edit.
- Yoga local Whisper: Yoga Encounter STT bot.
- ETA lib/whisper.ts, eta-router, overnight driver, encounter pipeline: us.
- Bench UI (cards, EQ, fleet board): EvenScribe Designer (Cursor).
- Re-drain / bench admin: shared — ONE DRAINER AT A TIME, announced; cancels only via the audited MCP tool.

## 2. Level log (bench_level_sample, from 22 Sep 19:53 IST)
peak/avg/zero_ratio/session_open/tape_advancing every ~2 s; GET /api/admin/bench/levels (15 s buckets). Uses: E-2 energy half + E-1 probe pre-selector; dead mic (zero_ratio ≥ 0.98); quiet-mic evidence. ~850 KB/room-hour. Retention target: raw 7 d. Needs an MCP read tool.

## 3. Workstreams
A. Transcript hygiene: A-ETA-1 max_context=0 everywhere (ETA + router); A-ETA-2 idempotent post-decode collapse with repair_applied; A-ETA-3 no_speech_prob + silence merged into the existing speech gate (one gate); English guard stays as backstop; regression pack; A-OPS-1 re-drain loops HELD until drainer agreement. Cut-line 15:32 IST 22 Sep.
B. Backlog driver: cancelled-by-other ≠ failure, window re-pickable; dedupe vs night-drain; restart only after agreement.
C. Encounter clocks: E-1 probe scheduler + extract contract (checksum round-trip); E-2 gate = level energy + post-STT unique chars/s ≥ 0.15; E-3 diarize + ECAPA, source-conditioned centroids {clinician_id, match_source, centroid_id}, soft 0.70, raw cosine logged, provider pluggable (local / pyannote.ai); reproduce Cardiology rd_v7kw7x4d / bs_gkzmch9p 0.735 / 0.842 ±0.02; E-4 hysteresis smoother (±2–3 min); E-5 hypothesis store + MCP read; E-6 Jev soft feature; E-7 day-grid eval vs V's labels. Heuristic role labels are never identity.
D. Voiceprints: voice_centroid (clinician_id, domain room_primary|phone|meet, generation), migration 113. Phone domain needs speaker timings without text (DB segments route).
