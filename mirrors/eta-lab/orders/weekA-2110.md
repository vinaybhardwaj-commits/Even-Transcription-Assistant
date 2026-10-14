# Week A kickoff (Fable, 22 Sep 21:10 IST)

Plan: ETA project doc claude/ETA-BUILD-PLAN-INTEGRATED-22-SEP-2026.md (v2).

Production facts:
- Production = vinay/s1-auto-drain @ 248c2ae, served by dpl_7Re7PRD3t87exhVHpcQvmTM1eTue (production-target).
- `main` is the fleet-board line. NEVER base work on main, and never push to main.
- Next migration number is ≥113; check both branch heads.
- Mini whisper-shim is owned by MiniBot: read it, never edit it.
- No re-drains or force-drains by anyone until Fable announces a drainer agreement.

## scribe — A-ETA-1 + A-ETA-3 in ETA (branch vinay/stt-hygiene off origin/vinay/s1-auto-drain)
- A-ETA-1: lib/whisper.ts sends `max_context=0` on every call. Find every other ETA code path that posts to whisper-server / shim (grep inference, whisper URL) and add it there too.
- A-ETA-3: act on `no_speech_prob`. Drop segments with high no_speech_prob AND low avg_logprob (log thresholds; start with whisper's own defaults: no_speech ≥0.6 with avg_logprob < -1.0). Prefer empty over invented text.
- Read how the existing speech gate (built, flag OFF; search "speech gate" / speech_gate) decides. Integrate so there's ONE gate, and say how.
- Regression tests:
  - the form includes max_context=0;
  - the no_speech drop;
  - a silent clip returns empty;
  - a sticky-loop text fixture is cleaned by the existing phrase-loop guard (47a648e) without deleting the distinct lines.
- Full suite (pgrep -f vitest first; Docker for Postgres). Commit, push the branch. Don't merge or deploy.
- REPORT: at most 8 lines.

## lx — A-ETA-1 + A-ETA-2 in the ROUTER (~/eta-router, branch vinay/router-stt-hygiene off main, which is live at e81b839)
- Every router→whisper call sends max_context=0.
- A-ETA-2: an idempotent post-decode collapse:
  - drop consecutive identical or near-identical segments;
  - collapse within-segment phrases repeated 3 or more times;
  - never drop a distinct line;
  - set `repair_applied` in the job result.
  Collapse must be a no-op on shim output that's already collapsed (the shim returns shim_collapse:true). Test that double application changes nothing.
- The router's English hallucination guard stays, now running after the fix.
- Tests + full suite. Commit, don't deploy. REPORT: at most 8 lines.

## scribe3 — driver fix (worktree ~/dev/Even-Transcription-Assistant-ot, branch vinay/overnight-translate, HEAD a3f25ec)
Per docs/handoff/ETA-OVERNIGHT-FATALS-ROOTCAUSE-22-SEP-2026.md:
- (1) a job cancelled by someone other than this driver is a `window_deferred reason=foreign_cancel`, never a failure, and the window stays re-pickable (like `unverified`);
- (2) its own cancels go only through scribe_job_cancel (audited);
- (3) skip windows night-drain has already joined or processed, or that are in flight. Find the cleanest signal: job list by window_id, active in the last N minutes.
- Tests and mutations. Build a STAGED bundle to ~/dev/_fable/scratch/overnight-translate.staged.mjs using the esbuild command in scripts/overnight-translate.ts. Don't restart the driver.
- REPORT: at most 8 lines.

## split-speaker — E-1 + E-2 prototype (research; read-only on prod; scratch only)
On the Cardiology day (room-day rd_v7kw7x4d, session bs_gkzmch9p, 12 Sep):
- build the probe scheduler (probe 180 s, hop 60 s across OPD hours) with extract checksums that round-trip through scribe_extract_audio;
- compute the E-2 gate per probe (energy_active_frac from the audio; unique chars/s from the stored transcript, counts only).
Also check whether bench_level_sample has rows for today (22 Sep, from ~19:53 IST) and how the level-derived energy compares to audio-derived energy on any overlapping probe. That tells us whether the level log can replace decoding for the gate.
Output ~/dev/_fable/scratch/e12/ (probes.json, gate.json). No PHI text. REPORT: at most 10 lines, including gate pass-rate and timing.

## yoga-drain — E-3 reproduction (read-only; serial; ≤1 diarize request at a time)
Reproduce the Cardiology trial's doctor-presence cosines:
- centroid dibyendu-cardiology-opd-2026-09-10 (find it: tc-corpus/centroids/ or the voice/voiceprint stores via the Scribe MCP);
- clips c1304 (13:04–13:07 IST) and c1409 (14:09–14:12 IST) on bs_gkzmch9p, re-extracted fresh;
- local eta-diarize (localhost:8001), ECAPA best cosine per clip.
Target 0.735 / 0.842 ±0.02. If you can't find the centroid, report where you looked.
REPORT: at most 6 lines.

## fleet — level-log readiness (read-only)
- bench_level_sample: row count today, rows per room, sample interval, and growth rate per room-hour. Project 30-day size.
- Propose a retention rule: keep raw N days, keep 15 s buckets longer.
- Say whether a read-only MCP tool for levels exists (none expected).
- No writes. REPORT: at most 8 lines.

## ETA-Refuter
Stand by. You'll refute scribe's, lx's and scribe3's commits as they land.
