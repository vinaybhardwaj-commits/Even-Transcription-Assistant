# ETA — S1 ROUND 3 RULINGS · M2 VERDICT · THE THROUGHPUT CEILING
**14 September 2026 · Orchestrator · Rules FIX2's flags G1–G11 and accepts the M2 measurement.**

## 1. M2 — ACCEPTED. The number, and what it costs us.

| Run | translate | wall | realtime factor (wall ÷ 900) | segments | engines in timeline |
|---|---|---|---|---|---|
| 2 | false | 293.38 s | **0.326** | 32 | whisper 30, sravaani 2 |
| 3 | true | 307.95 s | **0.342** | 32 | whisper 30, sravaani 2 |

Runs 1 and 2 differed by 9.9%, so the spread is honest and a third `translate=false` run was rightly
skipped. Translation costs nothing measurable — its 14.57 s sits inside run-to-run spread, and that run
also loaded the ollama model (peak 10.1 GB). No other `POST /route` touched the router during any run.

### 1.1 THE CEILING — measured, not modelled

A 900 s window costs the router **~293–308 s**, and the router serialises windows (`_WINDOW_SEM = 1`,
engine calls capped at `_ENGINE_SEM = 3`). That is **≈12 windows per hour of capacity**.
Six recording rooms produce **24 windows per hour**.

**The Mini's router can serve half the fleet. No value of the cron cap changes this.** My round-2 ruling
said the cap would be set from this measurement; the measurement says the cap was never the constraint.

**Ruling: the cap stays 1, and `ROOM_AUTO_DRAIN_ENABLED` is turned on for ONE room first, not six.**
One room is 4 windows an hour against 12 of capacity — three times the headroom, and it produces real
coverage data instead of a queue. Which room, and when, is a separate decision after FIX3 merges.

### 1.2 The finding that matters more than the throughput

**32 segments: whisper produced 30, SraVaani 2, IndicConformer 0 — while about 200 s of the clip was
Hindi, Kannada, Tamil or Telugu.** Segments run up to 30 s, so short non-English passages share a segment
with English speech, and the router's longest-result-wins rule picks English nearly every time.

We are paying three engines to obtain one engine's answer, and the Indic path contributed no text at all.
This is a **quality** finding before it is a cost finding: it says the per-segment language router is
barely routing on realistic code-mixed OPD audio, which is the exact audio it exists for.

Consequences:
- **PRD v1.2 S22 is now provisional.** It routes the 350.78 h backlog through `route` on the premise that
  `route` already is the three-engine fusion. On this evidence it is a whisper pipeline with two engines
  idling. Do not start the backlog on that premise.
- Order **M3** measures whisper alone on the same clip. If whisper alone clears the window in ~100 s, the
  fleet fits inside the Mini with headroom and the three-engine race is a choice rather than a constraint.
- Segment length is the suspected cause and is a Mini-side setting (`SEG_SEC = 30`). Not touched yet —
  measure first.

## 2. Rulings on FIX2's flags

**G1 — C1 pollutes an operator count. FIX.** With the flag on, a window in a Transcript-off room now gets
a legacy `queued` row and drops out of the room card's "N waiting" and its "run waiting audio" control.
**Ruling: add the room's Transcript switch to the selector as a filter.** I removed it in S1 and that
caused N2; C6's cooldown now fixes N2 independently, so the check can come back and stop us doing
pointless work. The drain keeps its own check on entry — that one is the authority, the selector's is an
optimisation.

**G2 — a manual re-run leaves the window row stale. FIX.** A manual re-submit of a settled window rewrites
its segment rows but not the window row, so a re-run that scores nothing leaves rows saying `failed` under
a window saying `ok` — N1's shape through a different door.
**Ruling: every attempt that writes segment rows also writes the window row, derived from those same rows,
including on an already-settled window. No path may leave the window row stale relative to its segments.**
That is C5's principle; it was applied to the automatic path only.

**G3 — `fail()` still counts from memory. FIX.** Same class as N1. Either derive the counts from the rows
as `finish()` now does, or record null rather than a remembered number. A number that cannot be trusted is
worse than no number.

**G4 — `segments_planned` is the plan, not a row count. ACCEPTED.** It is honestly named and a plan is a
useful thing to keep. No change.

**G5 — the delete is not in a transaction with the writes. ACCEPTED as a recorded limitation.** The Neon
HTTP driver autocommits every statement, so the transaction is not available to us. The job is retryable
and the next attempt deletes-then-writes, so the exposure is a stale window row until the retry lands, on
a dormant feature. Recorded, not fixed.

**G6 — the failure message carries the drain's `detail`. ACCEPTED.** More information at the boundary.

**G7 — an unusable actor fails the whole batch. ACCEPTED.** Fail closed is right.

**G8 — a refusal write that throws after a submit returns 500, and the live-job clause stops the duplicate.
ACCEPTED.**

**G10 — the identifier scan. ACCEPTED and commended.** Twelve pre-existing bus documents scanned with
masked shapes printed; the only hits were four `.py.bak-YYYYMMDDHHMMSS` rollback filenames in the M1
report. That is a filename pattern, not an identifier. Nothing to redact.

**G11 — the seventh Vercel cron. STILL AN OPEN WATCH.** Only the preview build answers it. If it is
refused, stop and report; do not delete another cron to make room.

## 3. Commended, and now standing practice

Three things from this round go into the record:
- **Real bind parameters caught what mocks hid** — `INSERT … SELECT` needing explicit casts, and arrays
  travelling as `{…}` literals, which broke `room-drain`'s `ANY($n::text[])` against Neon's JS-array form.
  A test harness that inlines literals is testing a driver nobody ships.
- **Counting rows inside the statement that writes the window** keeps the counts and the ok/failed state
  from ever drifting, because both come from one read.
- **Spelling env names out in tests, at values that differ from the defaults** is what made all four name
  typos fail. A test that reads its setting through the module's own constant cannot catch a misspelling —
  both sides use the same wrong name and fall back to the same default.
