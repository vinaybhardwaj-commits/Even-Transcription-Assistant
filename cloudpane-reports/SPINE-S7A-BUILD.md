# SPINE-S7A-BUILD — transcript_final, live for CONFIRMED encounters only (spine/s7a-transcript-final, off a01b3e69)
**NO MIGRATION.** The event is a `spine_tick` row (kind `transcript_final_event`), the ref is a `spine_artefact` row. No 0178, no "waits on fable" commit. Migration 0173–0177 are on main; nothing taken or added.
## What changed
- `lib/spine/config.ts` KNOWN_STAGES += transcript_final (NOT PAID); new SERVER_STAGES. `app/api/spine/claim/route.ts` never hands a SERVER stage to the box.
- `lib/spine/enqueue.ts` P2 plans transcript_final for status `confirmed` ONLY (not candidate / single_proxy / merged / rejected / frozen), after the 15-min grace; cut_version r<boundary_rev>; supersede/revive as R4.
- `lib/spine/transcript-final.ts` (pure): window outcomes, ready/wait/fail decision, assembly (sha256 over run id + native + English, in window order), event builder. No clock, no text kept.
- `lib/room-access/readers/spine-transcript.ts`: covering windows (grid-aligned, room-day overlap, blind windows dropped and counted, no room_day => not returned), route runs only, `markWindowOffered`.
- `lib/spine/transcript-final-store.ts`: server executor `runTranscriptFinal(now, origin)`; `app/api/cron/spine/route.ts` runs it as step 4 (only after a clean enqueue). Reader `transcript-final-read.ts` + `GET /api/spine/transcript-final?after=&limit=&shadow=1` (SPINE_BEARER_TOKEN) for feed-orch.
- Event fields: encounter_id, cut_version, room_id, ist_date, engine route, stamps {t_close, enqueued_at, windows_ready_at, final_at}, windows {covering, transcribed, silent, refused, pending, blind_excluded}, window_ids, run_ids, text {native_chars, english_chars, sha256, ref}. Reader adds consult_uid / consult_key (active links) and `current`. A newer cut_version = a new event.
- Tests: `tests/unit/spine-s7a.test.ts` (17, pure + O4 import scan), `tests/unit/spine-s7a-pg.test.ts` (25, postgres:16, 0173+0176 plus stub room tables for the reader SQL). Updated 5 existing files for the 6th confirmed stage: spine-p2, spine-p2-pg, spine-p2-oref-r3-pg, spine-p2-oref-r4-pg (counts 5->6, 10->12 etc.), spine-signals-route (4th cron step).
## Behaviour
- live (jobs + mode.transcript_final live): claim -> re-check (confirmed, same cut, not frozen, not blind room-day, closed) -> read covering windows -> pending closed windows are OFFERED to the existing drain (enqueueSubject + drainRoomWindow, max 2 per pass, none already in a room_window job, none refused inside the cooldown, only if ROOM_AUTO_DRAIN_ENABLED) -> job `release`d (next_attempt +3 min, attempt given back) -> when all windows are transcribed/silent/refused: artefact + event in ONE statement, job done.
- Fail: no terminal windows by t_close + 15 min + 6 h => permanent `windows_not_ready`; none exist => `no_covering_windows`; not confirmed / stale cut / frozen / blind room-day => permanent with that code. Errors => transient (backoff, MAX_ATTEMPTS 6, breaker).
- shadow (or jobs=shadow): nothing offered, leased, or emitted live; a job that WOULD emit writes one `transcript_final_shadow` tick (same shape). Off/missing/malformed/killed => `{skipped:"off"}`, no read, no write.
- O4: no Sarvam/paid import in any S7a file (test scans imports); only transcription entry is drainRoomWindow; the reader takes `engine = 'route'` runs and assembly throws on any other engine.
## Gate (own .bc/gate.log, 24 Oct 12:50 IST run)
- typecheck, typecheck:tests: clean. `vitest run --maxWorkers=4`: **Test Files 531 passed | 1 skipped (532); Tests 10541 passed | 7 skipped (10548)** — 0 failed (first run had 13 failures, all mine, fixed: room-access allowlist, adopted R3/R4 counts, cron-route mock).
- `npm run build`: OK. `check:silent`: 9 findings, the pre-existing accepted set, none in my files. `swift build/test`: N/A on Linux.
## Mutants (17 tried, 16 killed by the two S7a files)
Killed: candidate/sp get the stage; box can claim server stage; not_confirmed check; pending counts ready; no max wait; blind room-day not refused; shadow offers; O4 non-route allowed; event not deduped; cut_version fixed; offer cap; offer ignores drainOn; kill/off ignored; silent as pending; offer ignores open job; shadow writes live kind. **M16 survived but was an invalid mutant** (an extra constant column, no behaviour change); the one-statement atomicity of artefact+event is NOT mutation-tested.
## Assumptions
1. No migration: events in spine_tick; the "assembled text pointer" is run ids (`transcription_run:<ids>`) + sha256; the text is re-derivable from the runs, never stored. feed-orch's answer file (.bc/feed-orch-answer.md) did not exist, so the fallback shape was used.
2. `windows_ready_at` is derived (max of run created_at / refusal / closed_at, clamped to now), not observed.
3. Terminal outcomes: transcribed = state transcribed + a route run; silent = state silent; refused = state failed OR a permanent drain refusal (too_long, no_room_day, not_found). Two mics on one span: primary wins.
4. Offers also write the drain's own `auto_drain_refused_*` marks on bench_window (same as the auto-drain loop), and enqueueSubject/drain write their usual rows. Offers need ROOM_AUTO_DRAIN_ENABLED; otherwise the job waits and fails at max wait.
5. Wait is bounded by time (6 h) not attempt count (a `release` gives the attempt back).
## Open risks / UNVERIFIED
- Reader SQL proven only against hand-made stub tables, not the real room schema. The tail window being cut after the grace is assumed (no tail-coverage check); a recording that stops early looks complete.
- A rerun after a window was re-transcribed keeps the first event/artefact for that cut (create-only); a changed text needs a new cut_version.
- The live drain (one window/room/tick) may not clear a backlog inside 6 h; then the job fails `windows_not_ready` and is not revived (no event).
- Never run against Neon or the real drain. vercel.json unchanged (the spine cron already runs every 5 min; maxDuration 60 s with <=3 jobs and <=2 offers per pass is unmeasured).
