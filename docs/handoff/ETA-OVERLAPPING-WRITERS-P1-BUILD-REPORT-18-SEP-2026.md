# ETA-OVERLAPPING-WRITERS phase 1 — Build report

**Builder, 18 Sep 2026. Worktree `-ow`, branch `vinay/overlapping-writers-p1`, base `5dac810`.**

## Commit
`bbcdca3` — "ETA-OVERLAPPING-WRITERS phase 1 (C1/C2/C3): the claim gets a holder, the streaming
branch takes it too, and jobPending is finally read"

## Files, exact
- `app/[slug]/api/encounters/[id]/process/route.ts` +274/-71
- `tests/unit/overlapping-writers-claim.test.ts` +355/-0 (new)
- `tests/unit/process-step-claim.test.ts` +24/-7 (existing test, widened — see Deviations)

Nothing outside the contract moved. `docs/handoff/*` in this worktree are the PRD and survey the
kickoff named; both left exactly as delivered, uncommitted.

## What C1 actually touches
`translateIfNeeded`, `guardTranscripts`, `assessAndFlag` and `diarizeStore` are the four helper
closures the step machine AND the streaming branch both call — every write inside them is
reachable from either claim, so each now takes `myClaim: string | null` as its first parameter and
every `UPDATE encounter` inside carries `AND (${myClaim}::timestamptz IS NULL OR
processing_step_at = ${myClaim}::timestamptz)`. `null` (the non-streaming fallthrough, out of
scope for this phase) degrades the predicate to `TRUE` — unchanged behaviour, proven by
VERIFICATION 6.

Every fenced write also carries `RETURNING id`, so "0 rows" is observable and distinguished from a
thrown DB error (which keeps its own existing catch/log line). `logLostClaim(step, myClaim)`
prints `[process:fence] LOST CLAIM enc=… step=… myClaim=… — write skipped, not retried` — the
distinct marker the PRD asks for.

Roughly thirty individual `UPDATE encounter` sites were fenced this way: every translate-path
write (misdetection guard, Whisper refine, the chunked-job submit/poll/done/failed writes — the
one the survey's §4b walks through by name — eta-router, Sarvam, indic-note-assist, fusion),
`guardTranscripts`, `assessAndFlag`, every write inside `diarizeStore` (running/failed/complete,
the tagged-transcript and degraded-code writes, the not-dispatched and failure-write paths), and
every step-body write in the step machine (`translated=true`, native, note, cdms, finalize, the
diarize terminal flip) plus both releases (`releaseAndReset`, the jobPending release). The
streaming branch got its own claim (C2) and fences its native-analysis, note, cdmss, finalize and
abort-path writes the same way, releasing fenced in a `finally` block that runs on every exit.

**Deliberately NOT fenced**: `processing_pct`/`processing_stages` (pure UI progress hints, already
best-effort, no data-integrity stake) and the pre-claim `status='failed'` write for
`no_transcript_no_audio` (runs before either branch's claim exists). Flagged, not silently
dropped.

## C2 — the streaming branch's claim
Same statement shape as the step machine's (byte-identical `status = CASE …` — this is why
`tests/unit/process-step-claim.test.ts` now counts 2, not 1), taken before any write, in the
`if (accept.includes(...))` block before the `ReadableStream` is constructed. On failure it
returns `respondOk({ skipped: "locked", lock, claim_error })` — a plain JSON response, never a
stream — matching the step machine's own "locked" vocabulary. VERIFICATION 5 proves this,
including that `lock.held_s` names the current holder's age.

## C3 — jobPending
Read for the first time in the streaming branch, immediately after `translateIfNeeded`, before
`guardTranscripts`/`assessAndFlag`/note generation. Refuses via `emit({ stage: "error", where:
"job_pending", skipped: "job_pending", lock, message })`, then closes the stream. VERIFICATION 4
proves no `generateNote` call and no `note_json` write occur; the fenced release in `finally` still
runs.

## Deviation: `tests/unit/process-step-claim.test.ts`
Not a new test file, but C1's own required change (`RETURNING id` → `RETURNING id,
processing_step_at`) breaks this file's pinned regex, and C2's own required change (the streaming
branch's claim) breaks its `toHaveLength(1)` assumption about how many `status = CASE …`
assignments exist in the route. Both are direct, necessary consequences of the settled spec, not
scope creep: I widened the regex to the new RETURNING shape and the count to 2, added one new
assertion (`RETURNING id, processing_step_at` appears at least twice — the fencing token, not
re-derived), and left every existing invariant (CASE types off the column; the catch is not
silent; the "locked" response names the holder) intact and still checked. I did not touch any
other pre-existing test file.

## Gate, exact numbers measured
- `npm run typecheck` — clean, exit 0
- `npm run typecheck:tests` — clean, exit 0
- `npx vitest run` (no skip flag; Docker up) — **127 files, 2934 tests, 0 skipped, exit 0** (was
  126/2924/0 per the kickoff's stated baseline; +1 file, +10 tests — the 9 new + the 1 widened
  existing test)
- `npm run build` — clean, exit 0
- `npm run check:silent` — **5 findings, exit 1**. Verified against the base commit directly
  (`git stash` + rerun): the true baseline at `5dac810` is 9, matching the kickoff's stated figure
  exactly. Four of those nine were bare `.catch(() => {})` on statements C1 fences
  (`router_job_id` submit/done/failed, the jobPending release) — replacing them with
  `.catch(() => [] as Array<{ id: string }>)` plus `logLostClaim` closed those four as a side
  effect of the required fencing work, not a deliberate cleanup pass. The remaining 5 are
  unchanged, pre-existing, none introduced by this diff, none in files outside the contract.
- `swift build` (apps/room-recorder, untouched) — clean, exit 0
- `swift test` — 600 tests, 48 suites, all passed, exit 0

## Verifications, how each was proven
Against a real postgres:16 (every migration in `db/migrations`, replayed), through the real
`POST /process`, both branches, `tests/unit/overlapping-writers-claim.test.ts`. Only the outside
world is faked (R2, note-generation, CDMSS, diarize, Deepgram, the voiceprint loader, the
eta-router chunked-job transport, `next/server`'s `after()`). The `sql` mock is a thin wrapper
around the real DB call that can pause ONE matching statement once — the mechanism VERIFICATION 2
and 3 use to make a real race land deterministically instead of hoping two Promises interleave the
right way.

1. Two concurrent `syncStep` calls, `Promise.all`, against the real guarded UPDATE: exactly one
   returns without `skipped:"locked"`; `generateNote` is called exactly once.
2. Holder A is paused mid-note-write (SQL-text match on `note_json = `); while paused, its claim is
   expired and a simulated holder B claims fresh and writes its own note directly. A's release
   fires with A's now-stale token: `progressed:false`, the `LOST CLAIM` marker is in the captured
   console output, and the row still holds B's note afterward.
3. Holder A completes a real "finalize" step write, then is paused immediately before
   `releaseAndReset`'s own statement; while paused, A's claim is expired and holder B claims fresh.
   A's release runs with the stale token and matches 0 rows; the row is still locked (B's claim)
   afterward.
4. A `translated:false`, empty-transcript ("rescue"), `duration_seconds:600` encounter routes into
   the chunked-job path; `pollRouteJob` is mocked to always report `"running"`, so the real 240s
   poll deadline is genuinely exhausted (real timers — fake timers did not reliably drive this
   specific `while (Date.now() < deadline)` loop; this one test runs ~241s real time, and its
   `it(...)` timeout is set to 260s accordingly). `generateNote` is never called; `note_json` stays
   null; the claim is still released.
5. A live claim is seeded directly; the streaming branch's pre-stream claim attempt fails and
   returns the JSON refusal with `lock.held_s >= 25`; no stream, no note call.
6. Two full uncontended runs — one step-mode (self-chained through translate/note/finalize/cdms/
   diarize) and one streaming (note/cdms/diarize in one invocation) — both reach `status:'complete'`
   with the expected note and CDS, and neither ever logs `LOST CLAIM`.

## Unverified
- Production frequency of the two doors this closes (survey §6, Phase 3's own open question,
  unchanged by this build).
- Whether `after()` work is actually bounded by `maxDuration` (survey §3/§4a) — Phase 1 is correct
  either way per the PRD; this fact only decides whether the original TTL timeline is also live.

## Blocked
None.
