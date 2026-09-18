# ETA-E — retry collision: VERDICT · 14 Sep 2026 · Orchestrator

Rules on `ETA-E-RETRY-COLLISION-14-SEP-2026.md`.

## 1. My hypothesis is WITHDRAWN

I claimed that `ON CONFLICT … DO NOTHING` in `writeScoredOrFailed` (`lib/emotion/store.ts:51`), with a
retry reusing the same diarize run id, means **a retry can never succeed** — attempt 2's scored rows
would hit attempt 1's failed rows and be discarded, leaving the window permanently
`failed/emotion_zero_scored`.

Wrong. Every retry is a new job that starts at `prepare`, and `prepare` calls
`clearWindowSegments(w.id)` (`emotion-window.ts:125` → `store.ts:28-30`) before any write. Attempt 2
finds nothing to collide with. P1 and P1b show recovery at attempt 2 and at attempt 3 — the last the
enqueue scan allows. The conflict key's missing attempt column is **deliberate and correct**: with
the delete in place an attempt column would be dead weight, and without it rows from several
attempts would pile up under one run id where `finishEmotionWindow` (`store.ts:229`) would sum them.
That is a worse bug than the one I was chasing.

**P2 is why I believe this.** Mocking `clearWindowSegments` to a no-op reproduces my predicted
lock-out exactly — spans stuck `[failed,failed]`, attempts exhausted at 3. The probe can separate
the two worlds and it put the delete on the causal path. That is rule 14 satisfied properly, and it
is the reason this verdict is a withdrawal rather than a shrug.

## 2. P3 — accepted as real, deferred, not dismissed

One job dies after a score step writes its rows and before `runner.ts:117` saves progress; the lease
expires, `claimJobs` re-runs the same step with stale progress, the replay's scored rows meet the
first pass's failed rows, and `DO NOTHING` throws the good ones away. Window goes
`failed/emotion_zero_scored` with attempts 1. **Cost: one of three attempts. The next job recovers.**
No window is ever locked.

I am not ordering a fix round for it today, for the reason in
`ETA-E4-RULING-STARVATION-CAP-AND-THROUGHPUT-14-SEP-2026.md` §1.3: **`room_emotion_window` has zero
rows, all time.** This writer has never written in production. Refining the collision semantics of a
path with no measured throughput is the same mistake as reordering a queue whose consumer's rate we
have not measured — and I ruled against that one this afternoon (R2). It would be inconsistent to
exempt my own finding from it.

**Conditions attached to the deferral, so this does not rot:**

- **D1.** The fix lands in the same round as whatever `ETA-E5` turns up, not in a round of its own.
  E5 drives 40 real windows through this exact path; if P3 or F4 occurs naturally it will show there,
  and a natural instance is worth more than the probe.
- **D2. When it is built, the `DO UPDATE SET` enumerates every scored column AND the provenance
  columns** — `model`, `model_key`, `subfolder`, `cap_s`, `device`, `inference_s`, `duration_s`,
  `scored_at`. This is testing rule 15 and it applies here verbatim: any column left out is a place
  the row goes stale with nobody noticing. The Builder flagged the extra columns as inferred; treat
  the enumeration as mandatory, not optional.
- **D3. F4 is probed in that round.** A partial-batch death — some of 16 writes land, then the replay
  — is **more likely than P3**, has the same shape, and was not tested. It should have been in the
  brief; that is my omission.
- **D4. The P4 upsert is re-probed on Neon, not PGlite.** F1 is honest that 17.5-on-WASM is not
  Neon's engine and that `tests/support/s1-pg.ts` was bypassed. `ON CONFLICT … DO UPDATE` against
  two CHECK constraints is precisely where an engine difference would bite.
- **D5.** The comment at `store.ts:32` — *"Idempotent per (…) WITHIN one attempt"* — is true but
  misleading, because it leaves the reader to discover that cross-attempt retry works at all. It
  should name `clearWindowSegments` as the thing that makes retries safe. One line, same round.

## 3. Standing

- N1's pre-S1 paragraph no longer describes the code; `finish()` counts rows, not memory
  (`emotion-window.ts:191-194`, `store.ts:222-287`). **Closed.**
- "A retry can never succeed." **Closed, disproved, mine.**
- P3 / F4 replay collision. **Open, deferred under D1–D5.**
- `tests/unit/s1-emotion-zero-scored.test.ts:181` does catch the lock-out (P2 proves the test
  discriminates) but **was not run** — Docker is down on the Mini. Not a blocker for E5, which uses
  the live services, but the suite is unrun and should not be described as green until it is.

Orchestrator. No subagents.
