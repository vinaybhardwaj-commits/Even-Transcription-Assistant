# ETA — S1 FIX3 — REPORT (STOPPED: C9 CONTRADICTS A TEST OUTSIDE THE CONTRACT)
**14 September 2026 · Builder · branch `vinay/s1-auto-drain` · HEAD still `8ac9e24` · not pushed**

## 1. Commit

**No commit.** C9 as ruled cannot pass the gate without editing a file outside this round's contract. The standing rule is to stop and report. None of C8–C10 is built, and no tracked file differs from `8ac9e24`. The only new file is this report, untracked. The bus documents named in §5 of the kickoff are not committed, because that commit belongs to the halted round.

Pre-flight passed:
- `git rev-parse --abbrev-ref HEAD` returned `vinay/s1-auto-drain`.
- `git rev-parse HEAD` returned `8ac9e248a08d7aaf0cb98561cdaf6f9ceb4efb51`.
- `git status --porcelain | grep -v '^??'` was empty.

## 2. The contradiction, measured

**The ruling (round 3, G2):** *"every attempt that writes segment rows also writes the window row, derived from those same rows, including on an already-settled window."* **The kickoff (C9):** *"Find where the window-row write is skipped or conflict-ignored for a settled window and make it unconditional."*

**Where the write is conflict-ignored.** Both window-row upserts in `lib/emotion/store.ts` end with the same guard:
```sql
WHERE room_emotion_window.state = 'failed' OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
```
- `recordEmotionWindow` carries it; `fail()` and the `no_segments` path use that function.
- `finishEmotionWindow` carries it; `finish()` uses that function.

A settled `ok` row on the same diarize run therefore refuses both writes.

**The test that pins the opposite.** `tests/unit/c2-e2e-runner.test.ts:1351-1359`, written in C3 and outside this round's edit list:
```ts
it("IDEMPOTENT: the same job again for the same diarize attempt duplicates no row and does not rewrite the window", async () => {
  ...
  const after = (await sql`SELECT (SELECT count(*) FROM room_span_emotion WHERE window_id = 'bw_emo')::int AS n, (SELECT scored_at::text FROM room_emotion_window WHERE window_id = 'bw_emo') AS at`) ...
  expect(after[0]).toEqual(before[0]);
```
It asserts that a re-run for the same diarize run leaves the window's `scored_at` unchanged, which means the row was not rewritten.

**Measured, not inferred.**
1. I removed the guard from both upserts, in the working tree only.
2. I ran `npx vitest run tests/unit/c2-e2e-runner.test.ts`: `Tests  1 failed | 47 passed (48)`.
3. The one failure is `IDEMPOTENT: the same job again for the same diarize attempt duplicates no row and does not rewrite the window`.
4. Every other C3 emotion test still passed, including SERVICE DOWN's attempt bound and DIARIZE RE-RAN.
5. I then restored `lib/emotion/store.ts` from a byte-for-byte backup (`cmp` clean), and `git status` shows no tracked change.

So these three cannot all hold:
- the C9 ruling (rewrite on a settled re-run);
- the gate (full suite green);
- the contract (`c2-e2e-runner.test.ts` is not editable this round; the global rule is to leave files I did not create as they are).

The ruling reverses the C3 contract that the test was written to enforce. That is a decision for the Orchestrator, not a test to adjust in silence.

## 3. Options, for a ruling. None is chosen.

- **(a) Rewrite always, and update the C3 test.**
  - Authorise editing `c2-e2e-runner.test.ts:1351-1359`: keep "duplicates no row", and replace "does not rewrite the window" with "the window row is rewritten from the rows".
  - Then both upserts become unconditional. A settled re-run increments `attempts` (same diarize run), and `scored_at` moves.
  - This is C9 exactly as ruled.
- **(b) Rewrite only when the rows disagree with the row.**
  - Keep the guard, and add `OR` the stored state or counts differ from what the rows now derive.
  - A settled re-run that reproduces the same result leaves the row untouched, so IDEMPOTENT passes unedited.
  - A re-run whose rows now say `failed` rewrites the row, which is the G2 case.
  - "No stale row" still holds. The cost: `attempts` and `scored_at` do not move on an identical re-run.
- **(c) Refuse to re-score a settled window.**
  - `prepare` returns `done` with a named no-op before `clearWindowSegments` when the window row is final for the same diarize run.
  - No segment rows are written, so nothing can go stale, and IDEMPOTENT passes unedited.
  - The cost: a settled window can then only be re-scored after a new diarize run, which removes G2's door instead of fixing it.

Whichever is chosen, the ruling should also say whether it covers `fail()`'s upsert. On a settled `ok` window, a manual re-run that fails in `warm` or `score` after the delete meets the same guard, and would leave the rows rewritten under an `ok` row. In my experiment (a) that guard was removed too, and no other test broke.

## 4. C8 and C10: premises checked, no other stop

- **C8 — the Transcript filter.**
  - `lib/room-switches` exports only per-room readers: `readRoomSwitches(roomId)` and `isTranscriptEnabled(roomId)`, both async and cached for `ROOM_SWITCH_CACHE_MS`. It has no set reader.
  - The selector needs the filter *before* its `LIMIT`. Filtering in JS after the scan would let Transcript-off windows take the only slot, which is N2's shape again. Over-fetching has no bound.
  - So the filter has to be a SQL predicate on the column the helper reads: `JOIN bench_session s ON s.id = w.session_id JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE`. `room.transcript_enabled` is from `0065_room_processing_switches.sql`; `bench_session.room_id` is from `0041_room_bench.sql`.
  - It fails closed the way the helper does, because an unknown room drops out of the join.
  - Adding a set reader to `lib/room-switches.ts` would need that file on the edit list.
  - This is the "say so in the report" case §2 C8 allows, not a stop. `drainRoomWindow`'s own check is untouched and stays the authority.
- **C10 — `fail()` counts.**
  - Eight call sites of the `fail()` helper defined at `emotion-window.ts:62`: `:96, 111, 139, 154, 159, 163, 221, 232`.
  - `:96` (health) and `:111` (planning) run before `clearWindowSegments`. Any rows present there belong to an earlier attempt, so those two must record **null** counts, not derived ones. They pass no `segments` today, so they already record null.
  - `:139`–`:163` run after the delete. Rows there are this attempt's, so counts can be derived exactly as `finish()` does.
  - The `run()` catch paths `:221` and `:232` may be catching a failed write, so per the kickoff they record null.
  - All of this is buildable within the contract.

## 5. Gate

Not run on a committed change; nothing is committed. The one measurement is §2's single-file run, reverted.

## 6. SQL

None written. The only SQL touched was the §2 experiment, which removed the existing guard and was reverted.

## 7. Manual steps for V

None. 0091 and 0092 from FIX2 stand as written. Re-issue the order once C9 is ruled.

## 8. Subagents

None used.
