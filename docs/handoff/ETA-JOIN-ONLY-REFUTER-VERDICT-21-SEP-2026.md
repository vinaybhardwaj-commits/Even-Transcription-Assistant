# ETA — join-only clips. REFUTER VERDICT. 21 Sep 2026

`vinay/join-only-clips` @ **`3ca19d5`** (base `45eedda`), 4 files, +522/−5, no migration. Own detached worktrees `/tmp/refute-joc` and `/tmp/refute-joc-mut`; builder's worktree never written to, nothing pushed, no clip created, no write of any kind.

## FAIL — the branch does not pass its own gate

**F1 (blocker) — a real, branch-caused test failure, reported as green.**

The report states `Tests 3271 passed | 1 skipped (3272)`. My clean run: **`Test Files 1 failed | 144 passed (145)`, `Tests 1 failed | 3270 passed | 1 skipped (3272)`**.

```
FAIL tests/unit/room-switches.test.ts > all nine call sites read the room
     > every guard calls the room reader, and there are exactly nine
AssertionError: expected { …(6) } to deeply equal { 'lib/stt/room-drain.ts': 3, …(4) }
+   "lib/stt/join-only.ts": 1,
```

`room-switches.test.ts:182` is a deliberate census tripwire: it enumerates every `isTranscriptEnabled` call site and asserts the exact map. `lib/stt/join-only.ts:107` adds a tenth, so the test fires — **working exactly as designed**. It is saying: a new place now reads the Transcript switch; record it and think about whether that is wanted. Given this branch's whole argument is "joining is not transcribing, so the switch may be asked differently here", that tripwire is asking precisely the right question, and the answer belongs in the census map with a comment.

This is not a flake — it reproduces deterministically, and the cause is in the diff. Repo rule is no commit on a red gate. **Fix: add `"lib/stt/join-only.ts": 1` to the census with a line saying why a non-transcribing path reads the switch.**

**F2 — the extracted seam is mocked out, so none of it is tested.**

`tests/unit/join-only.test.ts:29` does `vi.mock("@/lib/stt/room-drain", …)` and supplies its own `joinClipForWindow`. The real function — which this branch created, which now carries **production's phase 1**, and which contains the new `UPDATE`, the new try/catch and the new R2 compensation — is never executed by any test on this branch. Three of my mutations survive for that reason:

| mutation | survives | consequence |
|---|---|---|
| **K15** `joinClipForWindow` returns `ok:true` when the clip-key UPDATE failed | GREEN | the caller is told a clip exists while `clip_r2_key` stays NULL: the window is re-picked for ever and a fresh R2 object is orphaned on every pass |
| **K14** drop the compensation `deleteObject` | GREEN | the orphan cleanup the builder added to close their *own* check:silent finding has no test |
| **K12** listing `ORDER BY w.start_ms ASC` → `DESC` | GREEN | "oldest first", stated in the docstring and the report's SQL, is unverified — an operator asking for a handful would get the newest |

**Mutations: 12 of 15 killed.** Everything in `joinOnlyWindow` itself is well defended — idempotence, the state guard, the `closed` value, the transcript switch and its default, D15 both ways (`known:false` holds, `rooms.length > 0` refuses), `too_long`, `join_service_not_configured`, the listing's include flag and limit clamp, and the `joined:false` flag all die. The gap is entirely the seam and the listing's ORDER BY.

**F3 — "the drain's own behaviour is unchanged" is not accurate.**

The report says: *"same request, same UPDATE, same failure step, in the same order."* True for the success path and the service-failure path. **Not true for the UPDATE-failure path.** At `45eedda` the `UPDATE` sat bare in `roomWindowPrepare` with no try/catch anywhere in the function, so a write failure **threw** out of phase 1. Now it is caught, the orphan object is deleted, and `{ok:false, error:"clip_key_write_failed: …"}` is returned, which phase 1 records as `join_failed` **and counts as an attempt** via `recordFailure` toward `DRAIN_MAX_ATTEMPTS`.

The change is an improvement — bounded instead of thrown, and no orphaned object. It is the *claim* that is wrong, and the difference is visible in production: a window whose clip-key write keeps failing now burns its attempt budget into a terminal `failed` state instead of throwing for the job runner to handle.

## The SQL — validated live, which the report could not do

The report says *"Assumes … Unvalidated live."* I have read-only access, so I validated all of it (`BEGIN READ ONLY`; a no-op `UPDATE` was refused with `cannot execute UPDATE in a read-only transaction`; ids and counts only).

**Every assumed column exists, with a usable type:** `bench_window.{id, session_id, clip_r2_key (nullable), state, room_day_id (nullable), start_ms, end_ms, grid_aligned}`, `bench_session.{id, room_id}`, `room.{id, transcript_enabled NOT NULL}`. `transcript_enabled` being NOT NULL matters — `r.transcript_enabled = TRUE` carries no three-valued-logic trap. Primary keys are `bench_window.id`, `bench_session.id`, `room.id`, so `UPDATE … WHERE id = $2` touches exactly one row.

**`state = 'closed'` is real and is the right filter.** Live distribution: `closed` 2704, `open` 319, `silent` 254, `transcribed` 242, `failed` 8, `transcribing` 1. Clipless windows by state: `closed` **2698**, `open` 319, `failed` 1, `transcribing` 1 — and **every one of the 254 `silent` and 242 `transcribed` windows already has a clip**, so excluding those states loses nothing.

**The listing query, run verbatim:** `include=false` → **2,488**; `include=true` → **2,699**, of which **211** are in Transcript-off rooms. The 211 matches the report's "The 211" and the ledger exactly, and 2,488 + 211 = 2,699.

**The join cannot duplicate a window.** In a single statement, plain count = joined rows = joined distinct = **2,698** (`bench_session` 328/328 distinct ids, `room` 18/18). An earlier pair of readings gave 2,698 and 2,699; taken a minute apart on a live system, that was **time skew** — a window closing between two queries — not a duplicating join. I record it because a Refuter reporting a one-row discrepancy as a defect would have been wrong.

## Flag, unproven and cheap to close

`joinClipForWindow` puts `clip_key_write_failed: ${String(e).slice(0, 120)}` into `recordFailure`, which persists it to `stt_subject_job.last_error` (300 chars). That is a raw database-driver error message reaching a stored column. The sibling branch `vinay/overnight-translate` deliberately logs only `(e as Error).name` for exactly this reason — its comment says *"the message can carry SQL or connection detail"*. I did **not** verify whether Neon's client puts a connection string in a message, so this is not a proven leak; close it with `e.name` or a code rather than the message.

## Gate, my run

`typecheck` exit 0. `build` `✓ Compiled successfully in 7.7s`. `npm test`: **1 failed**, as above. `join-only.test.ts` on its own is 20/20, matching the report's "Tests. 20, all green" — the report's error is the *suite* line, not that one.

**Verdict: FAIL**, on F1 alone: the gate is red, the failure is caused by this diff, and the report states it green. F2 and F3 are why I would not wave it through even once F1 is fixed — the seam that now runs in production's phase 1 is stubbed out in the only test that exists for it. Nothing here questions the design: the seam extraction is right, the two-decisions split is right, D15 is asked correctly, and the SQL is sound against the live schema.
