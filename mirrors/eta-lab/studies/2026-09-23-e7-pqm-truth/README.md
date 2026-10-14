# E-7 PQM-truth prep (e7-pqm-truth)

**Question:** ground-truth E-7 (encounter-clock hypotheses) against PQM consult times. This study is the *prep* step only: room->doctor mapping for 20-23 Sep, and a first look at the PQM event table.

**Owner:** Builder (Fable, Mini)
**Date:** 2026-09-23
**Status:** blocked on Metabase db 13 / Pulse monorepo access (see `findings.md` §1) — voiceprint side done (§2-4, `voiceprint-attribution.json`)

**Files:**
- `findings.md` — what was checked, what's blocked, and why; the Scribe-side clustering outage found along the way; the voiceprint-attribution results and which room-days are voiceprint-confirmed vs unmapped (§4).
- `e7-truth-summary.md`, `e7-score-acoustic.md` — the PQM ground-truth build and the acoustic-hypothesis scoring against it.
- `PQM-SOURCE.md`, `e7_score.py`, `hyp-acoustic.json` — source notes and the scoring script/input.

**Not produced:** the `queue_token_steps`/`queue_token_events` query results and the `opdRoomByDoctor` display-board config — no Metabase MCP or Pulse monorepo checkout on this Mac. See `findings.md` §1 for exactly what was tried.

**Doctor identity:** `pqm-consults.csv`, `e7-truth.csv`, `voiceprint-attribution.json`, and `build_truth.py` carry real doctor names (PQM query output / a name-keyed lookup) and live at `/Volumes/Air Drive/eta-data/2026-09-23-e7-pqm-truth/` instead of here — never in git, same rule as patient identity. The markdown above refers to clinicians by room instead of by name.
