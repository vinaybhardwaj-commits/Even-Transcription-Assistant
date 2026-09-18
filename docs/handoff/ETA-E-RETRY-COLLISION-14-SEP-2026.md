# ETA — emotion retry collision · 14 Sep 2026 · Builder
**Unattended path: the claimed lock-out does NOT fire. Retries on the cron path (`/api/admin/emotion-windows` */5 → `/api/jobs/run`) recover (P1, P1b). A narrower collision does sit on that same unattended runner (P3). It fires only when an invocation dies after a score step's rows are written. It costs one of the three attempts and never locks a window.** No code changed. No commit.

## 1. The premise — confirmed from source at `fe021a3`
`finish()` does not count from memory. `emotion-window.ts:191-194` says so, and `finishEmotionWindow` (`lib/emotion/store.ts:222-287`) counts `room_span_emotion` for this window and diarize run in the CTE `seg` (`:224-230`). It decides `zero_scored` there (`:232`) and writes the window row in the same statement (`:233-281`). The pre-S1 N1 paragraph no longer describes the code.

## 2. The hypothesis "a retry can never succeed" — DISPROVED by probe
`writeScoredOrFailed` does end `ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO NOTHING` (`store.ts:51`). A retry does reuse the diarize run id. But every retry is a new job that starts at `prepare`, and `prepare` runs `clearWindowSegments(w.id)` (`emotion-window.ts:125` → `store.ts:28-30`: `DELETE FROM room_span_emotion WHERE window_id = …`) before any write. It runs after the health check and the plan, so attempt 2 finds no rows to collide with.

Probe: `docs/handoff/scratch/E-RETRY-COLLISION-probe.test.mts`, output `…-probe-out-14-SEP-2026.log`. **5 passed (5).** The kind's own `run()` drives every step against real Postgres with migrations 0057/0074/0085/0088/0089/0090. Only the service and R2 are faked, as in the existing suite.

| Case | Sequence | Result |
|---|---|---|
| P1 | job all-fail → job all-ok | a1 `failed/emotion_zero_scored`, spans `[failed,failed]`; a2 **`done`, spans `[scored,scored]`, window `ok`, attempts 2, scored 2** |
| P1b | fail → fail → ok | **`ok`, attempts 3, scored 2** — the last attempt the scan allows (`enqueue.ts:63`) still recovers |
| P2 discriminator | P1's sequence ×3 with `clearWindowSegments` mocked to a no-op | spans stay `[failed,failed]`; window `failed/emotion_zero_scored`, **attempts 3 = exhausted**. This is exactly the lock-out you predicted. The probe can tell the two sides apart, and the delete is the only thing preventing it |
| P3 residual | one job: prepare → warm → score (all fail) → **the same score step re-run with the same saved progress** (service recovered) → finish | replay's scored rows discarded; spans `[failed,failed]`; window `failed/emotion_zero_scored`, attempts 1. **The next job: `ok`, attempts 2, scored 2** |
| P4 | candidate fix SQL (§3) on one row: failed → scored → failed | `[scored]` then `[scored]` — a scored row replaces a failed one, and a failed row never replaces a scored one |

**Why P3 is reachable.** The runner saves progress only after a step returns (`lib/jobs/runner.ts:117`, `saveStep`). `claimJobs` reclaims a `running` row whose lease has expired (`lib/jobs/store.ts:90-91`) and re-runs `job.step` with `job.progress` (`runner.ts:71`). The score step's own work is bounded: one call with a 90 s timeout (`lib/emotion/client.ts:39`) against a 240 s lease. So a replay needs the function to die, or `saveStep` to fail, after the segment writes and before the save. Rare, but on the unattended runner. First write wins in both directions: a failed row blocks a later scored one, and a scored row blocks a later failed one.

## 3. Minimum correct fix — only if the Orchestrator rules the residual worth a round
- **Attempt in the conflict key: no.** (a) `room_span_emotion` has no attempt column; its PK is the five columns (`0089:83`), so this needs a migration and a PK change. (b) `clearWindowSegments` already keeps attempts apart. (c) A replay is the same attempt, so it would not fix P3. (d) If the delete were ever dropped, rows from several attempts would sit under one diarize run id, and `finishEmotionWindow`'s count filters only by window and run (`store.ts:229`). It would add them up.
- **The upsert: yes, and it must overwrite the whole scored payload.** P4 first failed twice on `room_span_emotion_reason_chk` (`0089:94`) and `room_span_emotion_scored_chk` (`0089:87-93`): an upsert that sets only `state` violates both. Shape (probed on PGlite for the columns shown; the rest are INFERRED to follow the same rule):
  `ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, anger = EXCLUDED.anger, disgust = EXCLUDED.disgust, enthusiasm = EXCLUDED.enthusiasm, fear = EXCLUDED.fear, happiness = EXCLUDED.happiness, neutral = EXCLUDED.neutral, sadness = EXCLUDED.sadness, labels_json = EXCLUDED.labels_json, top_label = EXCLUDED.top_label, top_score = EXCLUDED.top_score WHERE room_span_emotion.state = 'failed' AND EXCLUDED.state = 'scored'`
  A real fix would also carry `model, model_key, subfolder, device, inference_s, duration_s, scored_at`. That is my inference, not probed. `writeSkipped` (`store.ts:64`) keeps `DO NOTHING`.

## 4. Which tests
- **Your hypothesis:** `tests/unit/s1-emotion-zero-scored.test.ts:181` ("N1 — a retry that scores everything REPLACES the failed rows") runs P1's sequence. P2 shows that sequence fails when the delete is missing, so the test does catch the lock-out, and it is green because the lock-out is not there. **I did not run that suite:** Docker is not running on the Mini.
- **The residual:** no test catches it. That suite's `runKind` (`:124-145`) always passes a step's returned progress to the next step, so no case re-runs a step with stale progress. `c3-emotion.test.ts` never exercises `writeScoredOrFailed`'s conflict. The `store.ts:32` comment "idempotent WITHIN one attempt" was never tested against a replay whose result differs.

## 5. Deviations and flags
- **F1. PGlite, not Docker.** Docker Desktop is down, and scribe3 holds the Mini for measurement, so I did not start it. I installed `@electric-sql/pglite@0.3` (PostgreSQL 17.5 WASM) in the session scratchpad, outside the repo. Values are bound as untyped strings like the Neon driver, but the probe does not use `tests/support/s1-pg.ts`, and 17.5 is not Neon's version. `ON CONFLICT` and CHECK behaviour do not differ between them for these statements; that is inferred, not tested on Neon.
- **F2.** Three files are on the bus scratch, untracked: the probe `.test.mts`, its `.vitest.config.mts`, and the log. Rerun: `E_PGLITE_PATH=<dir>/node_modules/@electric-sql/pglite/dist/index.js npx vitest run -c docs/handoff/scratch/E-RETRY-COLLISION-probe.vitest.config.mts`.
- **F3.** `lib/` and the six migrations used are identical between `fe021a3` and the working tree (`git diff --quiet`).
- **F4. Not probed:** a partial-batch death, where some of a batch's 16 writes land before the replay. `DO NOTHING` keeps the first write for those segments, the same shape as P3.

Subagents: none.
