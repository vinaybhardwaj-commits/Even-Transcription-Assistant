# ETA — S1 + D1 VERDICT AND RULINGS
**14 September 2026 · Orchestrator · Rules on every flag raised by `scribe` (S1) and `ETA-Refuter` (D1).**

## 1. S1 — ACCEPTED AT `d852127`, PENDING REFUTATION AND FIX1

Gate green: `tsc --noEmit` exit 0 · 2535/2535 tests, **none skipped**, both real-Postgres suites ran ·
build compiled with `/api/admin/drain-windows` in the route list · `check:silent` exit 1 only on the
nine findings already accepted at `1193083`, none in a touched file · file contract honoured, no
migration, nothing on the untouched list changed.

**Commended, and adopted as a standing practice:** the Builder removed each new rule from the source
in turn and reran its test — all 8 removals failed a test. That is testing rule 1 and rule 6 applied
without being asked. Do this on every slice from now on and say so in the report.

## 2. RULINGS ON S1's FLAGS

**F1 — the retry storm. FIX, and it gates the flag.** A window that closed while Transcript was OFF
never got its legacy `stt_subject_job` row, so `recordFailure` returns 0 attempts, the window goes
back to `closed`, and the cron retries it every 5 minutes for 6 hours — up to 72 jobs.

Ruling: **before calling `drainRoomWindow`, the auto-drain ensures the legacy row exists**, using the
same helper `lib/bench-window.ts` uses on close (`enqueueSubject("bench_window", <id>, "asr")`, which
is ON CONFLICT DO NOTHING). Rationale: it makes the cron behave exactly like the admin doors, the
3-attempt ceiling starts working, and no window is silently skipped. Rejected alternative: requiring
the legacy row in the selector — that strands every window that closed while the switch was off, and
a silent gap is worse than a bounded retry. When the legacy table is retired under S19, the attempts
counter moves with it; record that in the S19 notes.

**F2 — `emotion_zero_scored` not a job error code. RATIFIED AS BUILT.** The window row carries the
precise reason and the job uses the existing `emotion_window_failed` code with the reason in the
detail. Adding a code would have changed a file outside the contract for no gain.

**F3 — the manual POST records a person as the cron. FIX. My spec gap, not the Builder's.** My
kickoff gave `enqueueAutoDrain` no actor parameter. `actorProblem`'s own comment says why this
matters: "an unattended actor arriving through an attended door… would attribute a person's spend to
the cron." The POST handler must pass the resolved admin id with `via: "admin_route"`; the GET keeps
`SYSTEM_ACTOR` / `"cron"`. `app/api/admin/diarize-windows/route.ts` already resolves an actor for its
POST — copy that.

**F4 — step-to-status mapping. ACCEPT, with one change.** Per-window outcomes staying 200 with the
step named is right. `join_service_not_configured` is not a per-window outcome — it is a
misconfiguration that will fail every window forever, and a cron returning 200 while transcribing
nothing is the always-green signal we spent this cycle killing. **`join_failed` with
`join_service_not_configured` returns 500.** Every other step keeps its current status.

**F6 — the seventh Vercel cron. ACCEPTED AS AN OPEN WATCH.** Only the preview deploy can answer it.
The account already runs six, so the limit is not expected to bite. If the preview build refuses it,
STOP and report — do not delete another cron to make room.

**F8 — the kickoff and report were not committed. MY ERROR; the repo's `CLAUDE.md` wins.** My
"untouched" list meant "do not edit other people's bus documents", not "do not commit your own".
**FIX1 commits the S1 kickoff, the S1 report, this verdict, the FIX1 kickoff, and the D1 brief and
report** in the same branch.

## 3. D1 — ROOT CAUSE ACCEPTED. Excellent work, and it overturns the handoff.

Cause: the Mini's FastAPI services do blocking model work inside `async def` handlers, so the single
event loop is stalled for the whole call and even a trivial `/health` cannot answer. Proven by
measurement — `/health` 5154 ms during a 36 s diarize and `/healthz` 2174 ms during an 18 s route
call, against ≤170 ms when idle. **The reds are intermittent, not permanent**, which is why fresh
production calls at 08:00 passed.

This supersedes handoff §13 and open item 1 entirely. It also explains the abort at exactly 5002 ms:
a blocked loop accepts the connection and never replies, which is indistinguishable from an
unroutable host at the caller. Recorded in project memory as `eta-health-probes-measured-14-sep`.

**Order M1 issued** (session `scribe3`): move the blocking work off the event loop on the Mini,
diarize first and proved before the router is touched. Design is specified in that kickoff — keep the
handlers `async def` and wrap the blocking call in `asyncio.to_thread` behind a semaphore of 1, so
the current one-job-at-a-time behaviour is preserved and only the loop is freed. Do **not** convert
the handlers to plain `def`: that hands the model to FastAPI's 40-thread pool and invites concurrent
model calls on a service that has never had them.

**The third red — the `gemini` engine row. My ruling: disable the row.** `lib/mcp/tools/health.ts:116`
counts every enabled engine, and `gemini` is enabled in the database while `GEMINI_STT` gates it off,
so `scribe_health` can never be true however healthy the Mini is. The defect is two sources of truth
disagreeing about whether an engine is on — the same family as "a label must be DERIVED, never
typed". Fixing `health.ts` to special-case a gate would preserve the disagreement and add a second
rule to keep in sync. **Migration 0091 sets `enabled = false` on the `gemini` stt_engine row**, with a
comment naming the env gate and the one UPDATE that reverses it. When the Sarvam-vs-Gemini bake-off
needs it (PRD v1.2 S24), the row and the flag go on together.

## 4. WHAT STILL GATES `ROOM_AUTO_DRAIN_ENABLED`

1. FIX1 merged (F1 above — without it the first stale window becomes a 72-job retry storm).
2. The Refuter's PASS on the branch.
3. **`route`'s realtime factor measured on a genuine clinic-length window.** D1's 18 s clip took
   2682 ms; extrapolating that to 900 s is exactly the §16.1 mistake. The orchestrator owns this
   measurement and it is the last gate before the flag.
