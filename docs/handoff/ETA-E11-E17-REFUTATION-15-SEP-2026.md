# ETA-E11-E17 — Refutation of e925901 (E17) and 3aa75c9 (E11 e/f) · 15 Sep 2026 · Refuter (Builder pane)

Range `e925901^..3aa75c9` on `vinay/s1-auto-drain`, main worktree, HEAD `3aa75c9060b722c1b6caf62cb3fb973c1443d33b`.
Nothing was fixed, committed, pushed or migrated. I did not enter the -e16 or -e20 worktrees. I ran the mutations
in a `git archive` copy under the session scratchpad, never in the live tree. The live tree is unchanged: only
`CLAUDE.md` is modified (it was before I started) and `docs/` holds untracked files.

## 1. Verdicts

| Commit | Verdict |
|---|---|
| e925901 — E17 drain fairness | **MERGE-READY, with two flags (F1, F2).** Fairness comes from the new order itself, not from kiosk churn. The SQL ran green against a real postgres:16. F1 is a new way to starve a room. No live refusal source reaches it today, so it is latent. |
| 3aa75c9 — E11 (e)(f), test files only | **MERGE-READY.** Its claims hold on rerun: the real `writeWindowCues` runs, both failure shapes are covered, the sweep catches new top-level directories, `ADAPTERS` and `.swift` files, and the named survivor is equivalent. E11 as a whole is **not complete on every path** (F3). That gap is outside this diff, and dormant under the room routing the migrations point to. |

## 2. Gate — rerun by me

- `npm run typecheck` — exit 0.
- `npm test`, first run, Docker down: `Test Files 4 failed | 106 passed (110)`, `Tests 4 failed | 2554 passed | 97 skipped (2655)`. The 4 failures are the REQUIRED PROOF guards: c2-e2e-runner, s1-auto-drain, s1-emotion-zero-scored, s1-fix2-migrations.
- **Docker came up during this session. I did not start it.** `npm test`, second run, Docker up, no skip variable: `Test Files 110 passed (110)`, `Tests 2655 passed (2655)`. That includes `s1-auto-drain.test.ts (52 tests)`, so E17's rewritten selector SQL has now run against a real postgres:16. No suite is left UNRUN on the TypeScript side, and no waiver was used.
- `npm run build` — exit 0.
- `npm run check:silent` — exit 1, 9 findings. They are the accepted pre-existing 9 (finalize-text, finalize-upload, process route ×5, NoteComposerClient ×2). None is in this diff.
- `swift build` (apps/room-recorder) — exit 0.
- `swift test` — **UNRUN.** Compilation stopped with `external macro implementation type 'TestingMacros.SuiteDeclarationMacro' could not be found … plugin for module 'TestingMacros' not found`. `xcode-select -p` is `/Library/Developer/CommandLineTools`. This is the toolchain, not the diff: neither commit touches Swift. It is not a `needsEnrolment` case either.
- Concurrency: `pgrep vitest` was empty before the Docker-up run. Mutants E17-8 onward used the Docker suites while Docker was up. Whether another session ran a Docker suite at the same moment cannot be proven either way from here.

## 3. Priority 1 — is "no speech" separated from "service unavailable" on every path?

I built this list myself from every `transcribeWithWhisper`, `adapterFor`, `/inference`, `EMPTY_TRANSCRIPT` and `empty_transcript` site outside tests/ and docs/.

| # | Path | No-speech outcome | Status |
|---|---|---|---|
| 1 | `lib/stt/room-drain.ts:736` room_window segment, full window | Silence: stt_silence and a complete marker, no attempt, engine skipped | Correct (6e68462) |
| 2 | `room-drain.ts:663` prepare, language probe | Ignored; probe language null; no attempt | Correct |
| 3 | `lib/jobs/kinds/transcribe-range.ts:217` | Silence | Correct |
| 4 | `lib/mcp/tools/bench.ts:1814` sync tool, whisper | Silence | Correct |
| 5 | `bench.ts:1689` sync tool, any other engine | An empty answer from the engine becomes `EMPTY_TRANSCRIPT`, then silence | Correct |
| 6 | **`room-drain.ts:1232` room_window engine step, synchronous engine** | `asr.error = "empty_transcript"` (`lib/sarvam.ts:83`, `lib/stt/adapters/gemini.ts:234`, whisper adapter) becomes **`engine_failed`**, which **spends an attempt**. After 3 the window is parked `failed`, and a paid engine has been billed three times for 900 s. | **F3 — gap** |
| 7 | `room-drain.ts:1280` room_window poll, route (async) | `toSttResult` returns an empty transcript with `error: null`, written as a run | Not a failure |
| 8 | `app/[slug]/api/transcribe/whisper-chunk/route.ts:149` live rolling | Empty becomes `UPSTREAM_UNAVAILABLE whisper_failed: empty_transcript`; the client keeps its watermark and retries with more audio | F5 — pre-existing, encounter path |
| 9 | `app/[slug]/api/encounters/[id]/process/route.ts:355` | Progress text reads "Whisper long-file unavailable (empty_transcript)" | Cosmetic |
| 10 | `lib/transcribe-compare.ts:111` | "Whisper failed: empty_transcript" | Lab tool, cosmetic |
| 11 | `lib/stt/measure-job.ts:389` tuning fork | Known-speech clip, so empty really is an anomaly | Correct |
| 12 | `lib/health/whisper-probe.ts` | Requires a parseable 200 object and does not read the text | Not affected |

**The reverse direction was checked and refuted.** Could a real Whisper error arrive as a 200 with no text and now be
recorded as silence? I read the local whisper.cpp source (`~/whisper.cpp`, commit `e0fd1f67`,
`examples/server/server.cpp:825-1002`). Every error body there sets `res.status` to 400, 499 or 500. On this build,
a 200 with an error body cannot become `EMPTY_TRANSCRIPT`.

**F3, stated plainly.** The sync tool (#5) and the room_window job (#6) disagree about an engine's empty answer.
That is the same two-paths shape E11 exists to remove, and `room-window.ts`'s header claims "a case handled anywhere
is handled everywhere". It fires only when stage `room` routes to a synchronous engine (sarvam, gemini, whisper). The
routing migrations say room goes to `route` (async, #7), so under that routing it is dormant. The trigger is
realistic: Whisper hears a few words (or hallucinates them) and the paid engine hears none. INFERRED: live
`stt_routing` for stage `room` is `route` for both buckets (0084). Please check it live.

## 4. Priority 2 — does E17 deliver fairness through its own ordering?

I drove the real `orderAutoDrainOffers`, extracted from HEAD with esbuild, with a harness of my own. Six rooms, 36
windows each, each kiosk's phase fixed (20–25 s, so no restarts), a tick every 300 s, cap 1, 6 h horizon, 60 min
cooldown.

- **S1, every room stable, every offer enqueues:** slots per room 19/19/19/20/20/20. The room that is always
  "newest" gets no extra slots. Fairness comes from `last_served_ms`, not from churn. Mutants E17-1, -2, -6 and -8
  (served order removed or broken) are each caught.
- **S2, one room's every offer refused before the claim (F1):** the refusing room holds **98–100 of 117 slots**.
  The other five get 3–4 each, whatever that room's phase. The reason: "served" means a `room_window` job exists, and
  a refusal creates none. The room therefore stays `null`, ranks first on every tick, and moves to its next window
  while the refused one cools down. Rooms have 24 windows in the horizon against 12 ticks of cooldown, so it never
  runs out. For comparison, under the old `closed_at DESC` order the same room held slots only when its window was
  newest (3 of 117 at the oldest phase). **E17 turns a refused room into the top-priority room.**
- **Is F1 reachable today?** After the SQL filters, the pre-claim refusals left in `drainRoomWindow` are
  `too_long` (a window over 30 min; grid windows are 15), `wrong_state/claim_lost` (a race), `flag_off` (a
  switch cache of at most 5 s; `isTranscriptEnabled` reads the same `room.transcript_enabled` column), a thrown
  `engine_failed`, and `join_service_not_configured` (global, so every room is refused equally). None is a
  persistent per-room refusal, so F1 is latent. The E4 model in `e17-drain-fairness.test.ts:72` marks a room served
  on every pick and never models a refusal. That is why no test sees F1.
- **F2 — test gap, confirmed against real postgres.** Mutant E17-10 (the `served` CTE counts only `status IN
  ('done')`) **SURVIVED with Docker up**. No test pins that a queued or running job counts as served. Yet that is
  exactly the state right after the drain submits, and a route job takes about 1.3× realtime (~20 min for a 900 s
  window) across four cron ticks. The code is correct; nothing protects it.
- Other checks, all correct: ties on `-Infinity − -Infinity = NaN` fall through `||` to the window order. Late
  verification cannot jump the queue inside a room (`end_ms`, V3). Capacity is unchanged.

## 5. Priority 3 — attempt accounting

- **E11 silence:** no attempt, and the result is final (`transcribed`, engine skipped, never offered again without
  `force`). A silence whose cues are refused spends one attempt, and both brain failure shapes are covered by (e).
  **Is that what we want? It needs a ruling (F4).** It is right for a true silence. But the live whisper-server runs
  `--vad` (Silero v6.2.0) with `--no-speech-thold` and `--suppress-nst`, and E15 marks their calibration on room
  audio UNVERIFIED. E13 says a dead mic cannot be told from a quiet room. Before E11, a false silence burned 3
  attempts and parked visibly as `failed`. Now it is recorded as a quiet room, once, and nobody retries it.
- **F3 (engine step):** an empty engine answer spends an attempt, up to 3 paid calls. That is not what we want,
  and it is inconsistent with #5.
- **E17 refusal:** no attempt (pre-claim), a 60 min cooldown on that window, and **the room is not marked served**
  (F1). An enqueued job that then fails spends an attempt through `recordFailure` and does count as served. That is
  correct.

## 6. Mutation check — 24 caught of 29 run

All 17 room/drain test files ran per mutant with `ETA_ALLOW_SKIP_E2E=1`. Docker was down for the earliest E17
mutants and up from E17-8 on; every mutant that ran before Docker came up was caught regardless. Each mutation was
applied by an exact string matched once and restored under a sha256 check.

- **E17, 12 of 13 caught:** served order inverted (19 failed) · never-served last (19) · no one-per-room (2) ·
  oldest slot in room (6) · closed_ms in place of end_ms (4) · served key dropped (13) · cap ignored (8) · scan seam
  drops last_served (2) · scan seam end_ms←closed_ms (2) · served horizon removed (1) · served joined per window (1)
  · cooldown filter removed (22). **SURVIVED: E17-10, served counts only `done` (F2), rerun alone with Docker up.**
- **E11 production branch, 9 of 11 caught:** silent guard removed (2) · `!window_recorded` (1) · `failed > 1` (2) ·
  silence spends an attempt (3) · prefix match (3) · `silent_window:true` dropped (6) · speech `silent_window:false`
  dropped (1) · kind always goes to engine (6) · silence turns dropped (3). **SURVIVED: E11-4 `turn_write_error`** —
  equivalent, as claimed: every `complete:false` return of `writeWindowCues` sets it. The one hole is a brain
  refusal with an empty error string, which is theoretical. **SURVIVED: E11-11, the SPEECH-path guard changed to
  `!counts.window_recorded`** (F6). The batch-refused, marker-accepted shape that (e) proves on the silent branch is
  unproven on the speech branch. There, the mutant marks a window `transcribed` whose turns were rolled back. The
  gap is not new in 3aa75c9; the fix just stops one branch short.
- **E11(f) sweep, 3 of 5 caught:** new top-level `workers/` reader (1) · `ADAPTERS` reader in `lib/` (1) ·
  `.swift` POST to `/inference` (1). **SURVIVED, both blind spots the header declares for E19:** a
  `routeTranscribe` reader and a string-built URL.
- Leaving out the one equivalent mutant and the two declared blind spots: **24 of 26**. The two real survivors are
  F2 and F6.

## 7. Findings

- **F1 (E17, latent):** a room whose offers are refused is never marked served and takes ~84% of slots. `auto-drain.ts` CTE `served` plus the refusal branch.
- **F2 (E17, test gap):** mutant E17-10 survives on real postgres; no test pins that queued or running jobs count as served.
- **F3 (E11 path, dormant under `route`):** `room-drain.ts:1232` turns a synchronous engine's `empty_transcript` into `engine_failed` and spends an attempt; `bench.ts:1689` calls the same answer silence.
- **F4 (E11, ruling):** silence is final with no attempt spent, while VAD calibration (E15) and dead mic versus quiet room (E13) remain unresolved.
- **F5 (pre-existing, encounter live path):** `whisper-chunk/route.ts:149` reports a silent delta as `UPSTREAM_UNAVAILABLE`.
- **F6 (E11, test gap):** mutant E11-11 survives; the speech-path cue guard has no test on the brain's real failure shapes.

## 8. SQL and external-schema assumptions reviewed (the E17 SQL, verbatim at HEAD)

```sql
WITH served AS (
  SELECT ss.room_id, MAX(j.created_at) AS last_served_at
    FROM scribe_job j
    JOIN bench_window sw ON sw.id = j.args->>'window_id'
    JOIN bench_session ss ON ss.id = sw.session_id
   WHERE j.kind = ${ROOM_WINDOW_KIND}
     AND j.status IN ('queued', 'running', 'done', 'failed', 'cancelled')
     AND j.created_at >= NOW() - (${AUTO_DRAIN_MAX_AGE_HOURS}::int * INTERVAL '1 hour')
   GROUP BY ss.room_id
)
SELECT w.id, s.room_id, w.start_ms, w.end_ms,
       (EXTRACT(EPOCH FROM w.closed_at) * 1000)::float8 AS closed_ms,
       (EXTRACT(EPOCH FROM served.last_served_at) * 1000)::float8 AS last_served_ms
  FROM bench_window w
  JOIN bench_session s ON s.id = w.session_id
  JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
  LEFT JOIN served ON served.room_id = s.room_id
 WHERE w.state = 'closed' AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
   -- … the unchanged age, cooldown and queued/running-job filters …
```

It executed against the migrated postgres:16 in `s1-auto-drain.test.ts` (Docker run). It is still INFERRED against
production data. Please check live: (a) `scribe_job.args->>'window_id'` is set on every `room_window` job; (b) an
index lets the CTE's `(kind, status, created_at)` scan stay bounded; (c) `stt_routing` for stage `room` (F3).

## 9. Scratch evidence (session scratchpad, not committed)
`mutate.mjs`, `mutation-results.json`, `mut-e17-10.log`, `sim.mjs` / `sim-old.mjs` (the fairness runs), gate logs
`typecheck.log`, `test-noskip.log`, `test-docker.log`, `silent.log`, `build.log`, `swift-build.log`, `swift-test.log`.

## 10. Subagents
None. Every read, run and mutant above is mine.
