# ETA-E16 — items (i), (ii), (iii) · REPORT · 15 Sep 2026 · Builder (`scribe`)
Order: `ETA-E16-NOT-MERGE-READY-RULING-AND-THE-WAIVER-14-SEP-2026.md` §7, from `ETA-E16-REFUTER-VERDICT-14-SEP-2026.md` §3.
(No report path was named; this follows the E11-EF naming.)

## 1. Commits
- **E11, committed first as ordered: `3aa75c9060b722c1b6caf62cb3fb973c1443d33b`** on `vinay/s1-auto-drain`, main
  worktree, on top of `e925901`. Exactly the two test files, whose sha256 matched the E11-EF report before staging. Not pushed.
- **E16: NO COMMIT.** Work is in `-e16` on `vinay/e16-emotion-speech-fraction`, on top of `f4f51c6`, uncommitted.
  - Item (ii) is not finished. Its rerun needs Docker, and the order holds every Docker suite until `scribe3` reports
    unique container names.
  - `c2-e2e-runner` is the end-to-end proof of exactly the path this round changes. Per §2 of the ruling, no waiver
    carries over to it.

## 2. Gate (`-e16` worktree)
- `npm run typecheck` → exit 0. `npm run typecheck:tests` → exit 0.
- **Vitest, with the four Docker suites excluded by name**: `Test Files 106 passed (106)`, `Tests 2526 passed (2526)`.
  - The excluded files: `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`, `s1-fix2-migrations`, and the 4
    REQUIRED PROOF guards inside them. **UNRUN.**
  - Why excluded rather than `npm test`: the Docker socket answered, with the daemon returning 500. A daemon that came up
    mid-run would have started the forbidden suites. A plain `npm test` was not run.
- `npm run build` → exit 0. `npm run check:silent` → the accepted 9, none in changed files.
- `swift build` → `Build complete!`. **`swift test` → `error: Build failed`: `plugin for module 'TestingMacros' not found`**
  in this worktree's `.build`. It is the main clone's earlier environment fault. The same worktree passed 600 tests
  earlier tonight, and this diff has no Swift (`git diff --stat -- apps` empty).

## 3. Files (`git diff --numstat`, `-e16`) — nothing outside these moved
- `db/migrations/0097_room_span_emotion_speech.sql` +18/−1 · `lib/emotion/client.ts` +14/−4
- `lib/emotion/segments.ts` +36 · `lib/emotion/store.ts` +20/−3 · `lib/jobs/errors.ts` +2
- `lib/jobs/kinds/emotion-window.ts` +14/−5 · `tests/fixtures/e16-a9-window.json` +5/−3
- `tests/unit/c2-e2e-runner.test.ts` +69/−15 · `tests/unit/e16-emotion-speech-fraction.test.ts` +57/−9
- `tests/unit/s1-emotion-zero-scored.test.ts` +37/−5

**(i) The stale-segments guard: a NAMED failure.**
- **Where:** `staleSegmentTurns` (`segments.ts`) runs in `prepare`, after the turns load and before any planning, write or call.
- **How:**
  - Each stored `room_turn_speaker` binding for the run is bound again, by **the diarize writer's own
    `bindTurnsExclusive`**, over the stored intervals.
  - Speaker, `overlap_ms` and exclusivity (straddle) are compared.
  - Any disagreement fails **`diarize_segments_stale`**, a new published code in `lib/jobs/errors.ts`, through `fail(…, "none")`.
  - That writes a failed window row, so the attempt bound applies. No span row is written and no audio is sent.
- **Stricter than the Refuter's detector.** "A turn's speaker has no interval over it" misses a two-speaker rank swap
  where each speaker still overlaps the other's turns. A different run's timings or a lost straddle are caught too.
  `'[]'` beside attributed turns is caught on every turn.
- **No false positive on real data.** The A9 fixture now carries the stored `overlap_ms` (6009, 9837), read-only
  from the database. The stored intervals reproduce both bindings exactly, and the guard returns 0.

**(ii) `c2-e2e-runner` — written, NOT RUN.**
- **Harness:** applies 0097, and its `/health` fake carries `min_speech_s` (1.5).
- **`seedEmotionWindow` intervals cover the turns, as one run would bind them:**
  - speaker 0's turns: 4000 ms each;
  - the straddle: 2000 ms to speaker 0 and 1000 ms to speaker 1, stored as speaker 0, overlap 2000, not exclusive;
  - speaker 1's turns: 5000 and 2500 ms.
  - `room_turn_speaker.overlap_ms` is that binding, no longer a fixed 1000.
- **HAPPY PATH now asserts E16 on Postgres:** `segments_unscorable` 0; every row `diarize_segments`; speaker 0's
  chunks sum to 56 000 ms; speaker 1's run 7 500 ms; the straddle row 2 000 ms.
- **New cases:** `/health` without `min_speech_s` → `health_min_speech_unreadable`, no audio, a failed row. Stored
  intervals with speakers swapped → `diarize_segments_stale: 17 of 17`, steps `["(first)"]`, no audio, no span row,
  window `failed`.
- **`s1-emotion-zero-scored` (also unrun):**
  - its seed computes `overlap_ms` from the seeded intervals;
  - the never-sent case now gives speaker 1 900 ms of real speech (with none at all, it is stale);
  - new cases: a swapped-speaker seed → `diarize_segments_stale` with a window row; 0097 refuses a `diarize_segments`
    row with NULL `speech_ms`.
- **To finish (ii), once scribe3 reports unique names, one suite at a time:**
  `npx vitest run tests/unit/c2-e2e-runner.test.ts`, then `npx vitest run tests/unit/s1-emotion-zero-scored.test.ts`.

**(iii)**
- **The basis follows the measure.** `speechFields(speech_ms)` writes `diarize_segments` only beside a finite
  `speech_ms`, otherwise `pre_speech_fraction` with NULL. That closes the deploy-straddle job. 0097 adds
  `room_span_emotion_basis_measure_chk CHECK (speech_basis <> 'diarize_segments' OR speech_ms IS NOT NULL)`.
- **Unflagged empty labels are a model fault.** `ok:true, labels:{}` without `unscorable:true` is written `failed`
  with reason `empty_labels_without_unscorable_flag`, and counts. Only the flag means unscorable.
- **The rollback hazard is in 0097's header, in bold.** All five `app.py.bak-*` lack `min_speech_s`. Restoring one
  after E16 deploys fails every window and spends attempts. A restart is safe. Roll the app back first.

## 4. Mutation check — 22 of 22 caught
Each mutation was applied by exact string (matched once), run against the E16 unit file and `c3-emotion`, and
restored with a sha256 match. The two behaviours each separates:
- **G1** guard removed (stale named failure vs quiet wrong measure) — 2 failed
- **G2** overlap comparison removed (another run's timings: stale vs trusted) — 1
- **G3** exclusivity comparison removed (straddle shown vs not) — 1
- **G4** speaker comparison removed (renumbered: stale vs trusted) — 1
- **G5** unbound turn not counted (`'[]'`: stale vs `no_segments`) — 1
- **B1** basis stamped beside a missing measure (pre-fix vs post-fix) — 1
- **U1** unflagged empty labels read as unscorable again (model fault vs silence) — 1
- **Regression, re-pointed where this round changed the text:** E1 6 · E2 1 · E3 1 · E4 2 · E6 2 · E7 2 · E8 1 · E9 1
  · E10 1 · E11 2 · E12 1 · E13 1 · E14 1 · E15 1 · E16 1. The old E5 (the empty-labels arm) no longer exists; U1
  replaces it.
- **E15/E16 and the new pg cases are caught here only by text and unit checks.** Their behavioural proof is the unrun pg suites.

## 5. SQL and schema assumptions
- **0097 additions:** the CHECK above, and the header text. Still not executed anywhere. **INFERRED.**
- **The `prepare` turn SELECT** now also reads `t.overlap_ms`, a 0074 column the diarize writer fills (`diarize-window.ts:175-179`).
- The guard assumes stored `overlap_ms` is the writer's `bindTurnsExclusive` overlap, rounded into an integer column.
  **Confirmed on A9's two real turns.**

## 6. Deviations and flags
- **F1 — a stale window cannot be cured by re-running diarize.** `recordDiarizeWindow` keeps `segments_json` on an
  `ok` row, which is the hazard itself. A stale window therefore fails its three attempts and parks, **named**. The
  cure is the run-identity design the ruling keeps as the end state. Visible and parked, instead of a wrong number.
- **F2 — `lib/jobs/errors.ts` (+2) is shared** with other rounds' branches: a one-line merge point.
- **F3 — the detector goes beyond the Refuter's minimum** (§3 (i)), with the reasons stated. The Refuter should rule
  on whether it over-reaches.
- **F4 — still latent, not ordered:** `unscorable:true` beside seven valid labels still discards the scores as unscorable.
- **F5 — an unrelated process was running beside my gate:** scribe3's container-name harness. My vitest run excluded
  every Docker suite, so no container was touched.

## 7. Manual steps
- **scribe3:** unique container names. **Then** the two suite runs in §3 (ii), one at a time, then the commit on
  green, then a Refuter pass on the sha.

## 8. Subagents
None.
