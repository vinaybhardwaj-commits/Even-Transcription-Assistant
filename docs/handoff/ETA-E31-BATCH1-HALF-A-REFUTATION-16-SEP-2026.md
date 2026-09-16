# ETA-E31 — Batch 1, half A (A1, A2, A12) · REFUTATION · 16 Sep 2026 · Opus Refuter

Target `-e31a`, branch `vinay/e31-atomicity-a`, HEAD **`de50dd9`** on `64ce357`, tree clean at start and end.
Diff `64ce357..de50dd9` only: 7 files, 922 insertions, 115 deletions — the three production files the order
named plus four test files. Nothing outside the contract moved. I fixed nothing, entered neither `-e31b` nor
`-e31c`, committed nothing, pushed nothing, applied no migration outside an ephemeral container. No Swift.

## VERDICT

| site | verdict |
|---|---|
| **A1** span batch (one multi-row insert) | **PASS** — passes D-5 |
| **A1** `no_segments` CTE | **PASS** — passes D-5 |
| **A1** `fail()` — the fat/narrow pair | **DEFECT. Your acceptance is overturned.** |
| **A2** delete into the finishing statement | **PASS** — passes D-5, earlier state proven |
| **A12** close + enqueue | **FAILS D-5.** Collapsing merged a failure domain something depended on. |

Two findings. The `fail()` one is the serious one: the last-resort bookkeeping write dies, in production
conditions, of a cause the design says it cannot have — reproducing the exact defect it exists to prevent.

---

## 1. ATTACK 1 — THE COUPLING-SCOPE CHECK (D-5), PER COLLAPSED PAIR

**A1 span batch** — many single-row `INSERT`s into `room_span_emotion` become one multi-row insert.
*Other readers:* only two, both inside `lib/emotion/store.ts` — the count in `recordEmotionWindow` (`:289`) and
the count in `finishEmotionWindow` (`:601`). **Both filter by `diarize_run_id`.** There is no reader of
`room_span_emotion` anywhere else in `lib/` or `app/` (`lib/emotion/enqueue.ts:3` states it writes nothing and
the job is the only writer). Every row in a batch belongs to one attempt. **Two halves of one fact → PASSES.**

**A1 `no_segments` CTE** — delete other runs' spans, insert the spans, write the window row.
*Other readers:* the span readers above, plus `room_emotion_window`'s readers (the enqueue scan, admin views).
A window row saying `no_segments, skipped 3` over rows that were never written is precisely the lie the
programme is removing. **PASSES.**

**A2 finishing CTE** — delete other runs' spans + the window row.
*Other readers:* as above. I checked the one thing moving the delete from `prepare` to `finish` actually
changes: between prepare and finish, **both runs' spans now coexist**. Nothing double-counts them, because both
count queries filter by `diarize_run_id` and there is no external reader. **PASSES.**

**A12 close + enqueue — FAILS D-5.**

*Readers of `bench_window.state = 'closed'`, every one of them independent of the queue:*
- `countRoomWaitingWindows` and `drainRoomWaitingWindows` (`lib/stt/room-drain.ts:1434` and the scan above it),
  reached by the admin control `app/api/admin/bench/run-waiting/route.ts`
- `lib/admin/room-reads.ts:55` (`waiting_audio_count`) and `:123`
- the drain's own `drainable` set, and `closed_at` feeding `AUTO_DRAIN_MAX_AGE_HOURS`
- everything downstream of a closed window — diarize, emotion, E18 silence

*Readers of the `stt_subject_job` row:* `drainQueuedRoomWindows` (`state='queued'`), the `NOT EXISTS(job)`
scans, and the **5-minute reclaim** at `lib/stt/fanout.ts:220`. On the reclaim specifically, which the order
named: it matches `state = 'running'` only and is **not** filtered by `subject_type`, so it does reach
bench_window jobs — but A12 inserts `'queued'`, so **A12 does not interact with the reclaim.** The merged
domain is not there. It is the close.

**The close is not the other half of the enqueue — the enqueue is a consequence of the close.** Collapsing
makes the primary fact (the tape advanced) hostage to the derived one (work was queued). Measured:

| the enqueue fails … | window state | `countRoomWaitingWindows` |
|---|---|---|
| **OLD** shape (two statements) | `closed`, unqueued | **1 — visible, and one admin click drains it** |
| **NEW** shape (one CTE) | rolled back, still `open` | **0 — invisible to the recovery path** |

The builder's own test (`e31-atomicity-a.test.ts:208`) asserts "left OPEN rather than closed and unqueued" as
the *desired* outcome, and the code comment justifies it by saying auto-drain would only re-offer the window
"if `ROOM_AUTO_DRAIN_ENABLED` is on — it ships dark". **That overlooks the admin run-waiting control**, which
needs no flag and exists for exactly the closed-and-unqueued state. The state the cure makes unreachable was a
first-class, counted, one-click-recoverable state.

Blast radius, stated plainly: while `stt_subject_job` refuses inserts, **no window in any Transcript-on room
advances past `open`.** A failure in the work queue now halts the recorder's bookkeeping. The window does
self-heal on the next chunk, or via `POST /api/admin/bench/windows` — but during the failure the tape is
frozen and nothing counts it.

## 2. ATTACK 2 — THE `fail()` REASONING: VERIFIED IN PART, THEN **OVERTURNED**

**The column claim is TRUE.** All eight columns the narrow write touches — `window_id`, `room_day_id`, `state`,
`diarize_run_id`, `error`, `scored_at`, `attempts`, `failure_history` — are columns 0089 created
(`0089_room_emotion.sql:17-42`). The only later additions to the table are `segments_unscorable` (0097:69) and
`stale_segments_run_id` (0099:58), and the narrow write touches neither. `diarize_run_id` is a 0089 column; the
comment beside it cites 0090 only as the *source of the value*, not the migration that added it.

**The reasoning is sound as far as it goes.** "A bookkeeping write that shares the primary write's column
surface dies of the primary write's cause" is true.

**The unstated converse the design rests on is false.** *Restricting a write's COLUMN surface does not restrict
its CONSTRAINT surface.* 0099 added, at `0099_room_diarize_segments_run_id.sql:59-61`:

```sql
ALTER TABLE room_emotion_window ADD CONSTRAINT room_emotion_window_stale_segments_chk
  CHECK (stale_segments_run_id IS NULL OR state = 'diarize_stale');
```

That constraint couples a **0099 column** to **`state`** — and the narrow write writes `state`. So on a window
whose stored row is `diarize_stale` (which is exactly where `recordStaleWindow` → E24/E25 R15 puts it, and
which is live), the narrow write sets `state='failed'` while leaving `stale_segments_run_id` at its non-NULL
value, and Postgres refuses it. Measured against postgres:16, verbatim:

```
ERROR:  new row for relation "room_emotion_window" violates check constraint
        "room_emotion_window_stale_segments_chk"
DETAIL:  Failing row contains (bw_1, rd_1, failed, run_1, 2, [], emotion_service_down, …, seg_run_1).
AFTER: state=diarize_stale attempts=1
```

**The attempt is not counted.** `fail()` then throws `emotion_bookkeeping_failed`. That is the production
defect this whole design exists to prevent, reproduced *by the fallback itself*.

And the asymmetry is the wrong way round: **the FAT write SUCCEEDS on the identical row**, because it sets
`stale_segments_run_id = EXCLUDED.stale_segments_run_id` (`store.ts:320`). `finishEmotionWindow` nulls it too
(`store.ts:646`). The narrow write is the only writer of `state` in the module that does not touch that column
— which is precisely why it is the only one that can violate the constraint.

**The bind, so the ruling is informed.** There is no column subset that is safe both under *0099 withheld* and
under *0099 applied*: with 0099 applied, writing `state='failed'` over a `diarize_stale` row **requires**
clearing a 0099 column. The "only 0089 columns" rule and the "always able to record a failure" goal cannot both
hold. Options, named not chosen: (a) clear `stale_segments_run_id` in the narrow write and accept that it now
depends on 0099; (b) have the narrow write leave `state` alone when the stored row is `diarize_stale`, writing
only `attempts`/`error`; (c) relax the constraint to admit `failed`.

## 3. ATTACK 3 — THE THREE SPLITS, RE-SPLIT BY HAND

**S1 RED · S2 RED · S3 RED.** Each patch asserted to match its anchor exactly once before it was applied.

S2's first anchor matched **twice** — the same delete text exists in `writeNoSegmentsWindow` — and my harness
reported it **VOID rather than counting it**, which is the guard working. Re-run with an anchor unique to
`finishEmotionWindow`'s final SELECT: **RED**.

## 4. ATTACK 4 — THE INJECTION READS THE DATABASE BACK

Verified for all three. A1 asserts `spanCount == 0` after the refusal **and** that the same batch minus the bad
row lands whole, so the claim is atomicity and not unwritability. A2 asserts the surviving span runs and the
window row. A12 asserts `r.closed` and every window's state. Each is read back through a separate query after
the refusal; **none asserts only that something threw.**

**A2 specifically, measured by me:** after the finishing statement is refused, both runs' spans survive
(`["run_new","run_old"]`) **and** the window row's `diarize_run_id` is still `run_old` — it reads as the
earlier run, which is the acceptable outcome, not as the new one.

**A gap in the builder's own test, though the property holds:** its `emotionRow()` helper selects
`state, attempts, error, segments_scored` — **not `diarize_run_id`**. So the assertion captioned "the window
still reads as the earlier run" does not actually assert the run. It passes on `{state:'ok', scored:1}`, which
an incorrectly-written new-run row could also satisfy. The property is real; the test does not pin it.

## 5. ATTACK 5 — `DO UPDATE`: FORCED, AND SAFE

**Forced, not chosen.** With the delete moved to finish, a retry of the same diarize run meets its own previous
rows on the identical key; under the old design `prepare` deleted everything first, so no conflict could ever
arise and `DO NOTHING` was harmless. It is now harmful — it would keep the stale answer and count it. My
mutant S8 (back to `DO NOTHING`) is **RED** in 4 tests.

**It cannot overwrite a newer run's rows with an older run's, structurally.** `diarize_run_id` is part of
`PRIMARY KEY (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx)` (`0089_room_emotion.sql:83`,
unchanged by any later migration). Two runs' rows therefore have different keys and can never collide, so
`DO UPDATE` can only ever fire within one run. This is a property of the key, not a convention.

Residual, minor: an *older* run writing late inserts rows rather than overwriting, and they linger until the
next finish deletes them. Under the old design that same late run's `prepare` would have deleted the *newer*
run's rows — strictly worse. A2 improves this; it does not fully close it.

## 6. ATTACK 6 — THE THIRD COPY: THEY AGREE TODAY, AND TWO CAN DRIFT UNSEEN

**They agree on the rule's shape.** All three open identically:
`WHERE …state = 'failed' OR …diarize_run_id <> EXCLUDED.diarize_run_id OR ( … ) IS DISTINCT FROM ( … )`.

**Their comparison tuples deliberately differ**, each comparing what its own statement writes:

| copy | tuple |
|---|---|
| `recordEmotionWindow` | 13 fields, **including `stale_segments_run_id`** |
| `finishEmotionWindow` | 12 fields, without it (it nulls the column unconditionally) |
| `writeNoSegmentsWindow` | 5 fields (state, segments_skipped, segments_unscorable, cap_s, room_day_id) |

That is correct today and is not a defect. But it means **"keep all three in step" has no single definition to
keep**, and I tested whether anything would notice a drift:

| drift mutant | result |
|---|---|
| `finishEmotionWindow`'s tuple loses `segments_unscorable` | **SURVIVED — 128/128 green** |
| `writeNoSegmentsWindow`'s tuple loses `segments_unscorable` | **SURVIVED — 128/128 green** |
| `recordEmotionWindow`'s tuple loses `stale_segments_run_id` | CAUGHT — 11 red |

**Two of the three copies can drift with the entire suite green.** The comment is the only thing holding them
together. The builder named the risk honestly and deferred it to batch 2; this is the measurement of how large
it is.

## 7. MUTATION RUN — MINE, 12 RUN, 10 CAUGHT, 2 SURVIVORS NAMED

Six suites (`e31-atomicity-a`, `e31-a1-bookkeeping-survives`, `s1-emotion-zero-scored`,
`e16-emotion-speech-fraction`, `c3-emotion`, `bench-window`), baseline **128 of 128**, matching the builder.

Caught: **S1** span batch → one per row · **S2** delete out of the finishing statement · **S3** close/enqueue
split · **S4** enqueue not fed by the close · **S5** narrow fallback removed · **S6** narrow write not counting
the attempt · **S8** conflict back to `DO NOTHING` · **S9** finish delete widened to every run · **S10**
`state='open'` guard dropped · **D3** `recordEmotionWindow` tuple loses `stale_segments_run_id`.

Survivors, honestly named, and they are the §6 finding rather than an oversight: **D1** and **D2**, the
conflict-rule tuple drifts in `finishEmotionWindow` and `writeNoSegmentsWindow`.

No equivalents. Every patch asserted to match once; all three production files verified byte-identical after
every restore.

## 8. GATE — RUN MYSELF, DOCKER UP, NO EXCLUSIONS

```
npm run typecheck        exit 0
npm run typecheck:tests  exit 0
npx vitest run           Test Files 116 passed (116) · Tests 2780 passed (2780)
npm run build            exit 0, compiled
npm run check:silent     Found 9 — the accepted 9, byte-identical to half B's list, all outside the contract
```

Reproduces the builder's gate exactly.

## 9. SQL AND EXTERNAL-SCHEMA ASSUMPTIONS — INFERRED, VERBATIM

No live database. Read from migrations and confirmed against an ephemeral postgres:16:

- `room_emotion_window` PK `(window_id)`; `room_emotion_window_stale_segments_chk CHECK (stale_segments_run_id
  IS NULL OR state = 'diarize_stale')` (0099) — **the constraint §2 turns on.** If production's 0099 differs
  from the file, §2's severity changes; worth validating live.
- `room_emotion_window_state_chk CHECK (state IN ('ok','failed','no_segments','diarize_stale'))` (0099).
- `room_span_emotion` PK `(window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx)` (0089:83) — what
  makes §5's cross-run safety structural.
- `stt_subject_job` PK `(subject_type, subject_id, tier)` (0061:38) — A12's `ON CONFLICT` target is valid
  against it. I checked this first because an unmatched `ON CONFLICT` target would make every window close
  throw; it is sound.
- Post-0089 additions to `room_emotion_window`: `segments_unscorable` (0097), `stale_segments_run_id` (0099).
  Nothing else.

## 10. WHAT I DID NOT RUN, AND WHY

- **S7** (widening the narrow write back to the fat surface) — the builder's mutant, not reproduced: §2
  overturns that design on other grounds, and S5/S6 already pin the fallback's existence and its attempt count.
- I did not drive the emotion job end to end through the service; the `fail()` path was exercised at the store
  boundary, which is where the defect lives.
- No Swift (R30/R27). No subagents — every measurement is mine.
- **A container I left alone:** `eta-c2-e2e-ec41e47576` is up. Its worktree tag matches none of `-e31a`
  (`afb6fca265`), `-e31b` (`b4efeb673f`) or the main clone (`2208787767`), so it is another worktree's live
  database — `-e31c`, most likely. Removing it would have broken that session's run.

## 11. WHAT THE ORCHESTRATOR MUST RULE ON

1. **`fail()`'s narrow write dies on a `diarize_stale` row** (§2). Your acceptance is overturned, as you asked
   to be told. The three options are named above; the choice is a design decision.
2. **A12 against D-5** (§1). The close is independent evidence for at least five readers. The PRD's actual
   complaint about A12 was the *silent* swallow; D-3 legibility — separate statements, a loud log, and the
   existing run-waiting recovery — satisfies that without making the tape hostage to the queue.
3. **The conflict rule's three copies** (§6): two can drift with the suite green. A single shared definition,
   or a test that compares the three, would close it.
4. **The A2 test does not assert `diarize_run_id`** (§4) — the property holds but is unpinned.
