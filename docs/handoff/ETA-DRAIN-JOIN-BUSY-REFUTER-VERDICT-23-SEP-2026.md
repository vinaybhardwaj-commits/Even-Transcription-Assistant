# ETA — drain: join_already_running waits, not fails. REFUTER VERDICT. 23 Sep 2026

`vinay/drain-join-busy` **@ `1fa844c`** (builder yoga-drain), one commit on production `d519d7b`. Order `orders/DRAIN-JOIN-BUSY.md`. Worktree `/tmp/refute-djb`, HEAD asserted, clean after every run. Gate per Fable's ruling: typecheck + touched suites + my mutations.

- `npx tsc --noEmit` → **rc=0**
- `c1b-room-window-job.test.ts` + `room-drain.test.ts` → **76/76**
- Mutations: **7 applied, 5 killed, 2 survived (one finding, confirmed twice), 1 void and redone**

## PASS-WITH-FIXES — the order's own prescribed control passes, and it is the half that could not fail

### The design is right, including the part that is easy to get wrong

Two caps on two different clocks, and the distinction matters:

- **Per-claim**: `JOIN_BUSY_STEP_BUDGET_MS` = 2.5 min. When the next backoff would cross it, the step **yields** — `return { step: "join_busy", next_progress: {...} }` — and the job kind requeues on the **same** step. No invocation ever blocks for fifteen minutes, which a `while` loop in a serverless function otherwise would.
- **Total**: `JOIN_BUSY_MAX_WAIT_MS` = 15 min, measured through `join_busy_first_at_ms` **persisted in progress**, plus a defensive ceiling of 30 attempts (exactly 900 s ÷ the 30 s minimum backoff — the two agree). A naive implementation would restart the elapsed clock on each re-claim and never reach the cap at all; this one carries it across claims.

**The cooldown claim checks out.** `runAutoDrain` sets `auto_drain_refused_at` only when `drainRoomWindow`'s step is not `"enqueued"` — a refusal to *enqueue*. `join_busy` is returned by `roomWindowPrepare` **inside** an already-enqueued job, so auto-drain never sees it. Not defended by a guard; unreachable by structure.

| mutation | result |
|---|---|
| **D1 — the order's own control**: busy is an ordinary failure again | **killed, 3** |
| **D3** elapsed cap removed (waits forever) | **killed** |
| **D4** step budget removed (blocks past the claim) | **killed, 2** |
| **D5** the busy yield records a failure — i.e. counts against `DRAIN_MAX_ATTEMPTS` | **killed** |
| **D2** the match loosened to `String(join.error).includes("already_running")` | **survives** |
| **D6** `join_timeout` added to the busy classification | **survives** |

D5 matters: the order's requirement that a busy retry *"must not count against the per-window 3-attempt failure bound"* is genuinely pinned, not merely intended.

### FINDING — "and only it" is implemented and untested, and the order's prescribed control cannot catch it

The order says: classify `join_already_running` **(and only it)** as retryable-busy. The code does exactly that — `join.error === "join_already_running"`, strict equality, with a comment naming the errors that must fall through (`join_timeout`, `join_unreachable`, a real `join_http_5xx`). **Nothing tests the "only" half.**

Confirmed from both directions: **D2** loosens the comparison to a substring and **D6** adds `join_timeout` to the busy set outright. Both leave **76/76 green**.

**The part worth carrying beyond this branch:** the order itself prescribed the mutation control — *"flip the classification back → test fails"* — and that control **passes** (D1, 3 tests). It tests that busy **is** retried. Nothing tests that non-busy is **not**. A control written into the order still only covered one half of the binary, which is the sixth appearance of that pattern today and the first time it was specified rather than merely overlooked.

**Why it is worth a test rather than a shrug.** Broadening this match is a natural "be more tolerant" refactor. If `join_timeout` or `join_unreachable` were ever swept in, a genuinely broken join would retry for **15 minutes per window** before failing — and with five windows per tick that is a throughput collapse in precisely the system this branch exists to speed up. The failure direction is the fix's own goal, inverted.

One test closes it: a fake join returning `join_timeout` fails immediately, with no retry and no busy bookkeeping in progress.

### Smaller note, no action

`joinBusyFirstAtMs` is read once before the loop, and inside it `const firstAtMs = joinBusyFirstAtMs ?? Date.now()` recomputes on every iteration while the stored value is null. So during the **first** claim the elapsed clock effectively restarts each iteration, and the value persisted on yield is the last iteration's timestamp rather than the first busy answer. The total cap is therefore up to one step budget (2.5 min) more generous than the comment's "since the FIRST busy answer". The attempt ceiling still bounds it and the direction is patience, not premature failure — worth knowing, not worth changing.

## Verdict: PASS-WITH-FIXES
The throughput fix is sound and the hard parts — yielding rather than blocking, carrying the elapsed clock across claims, and keeping the busy path clear of both `DRAIN_MAX_ATTEMPTS` and the refusal cooldown — are all correct and pinned. The gap is that the exclusion the order asked for twice is the one property no test asserts, and the control the order supplied could not have found it.
