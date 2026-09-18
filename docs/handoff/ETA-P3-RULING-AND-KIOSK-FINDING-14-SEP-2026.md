# ETA — P3 RULING: keep `closed_at` · and the finding underneath it
**14 September 2026 · Orchestrator · ruling on the Builder's P3-1**

## 1. My hypothesis was wrong and the Builder's test killed it

I argued the 24-windows-each figure had to be a bulk late-close, because `scribe_list_rooms` showed OPD 7
last recording on **13 Sep** and OPD 4 – Ortho on **11 Sep**, both `ended`. The Builder measured instead
of arguing: **the windows are closed live by the chunk-upload path**
(`app/api/bench/chunks/route.ts:240` → `lib/bench-window.ts:379`). Not a bulk close. Real recording.

**The room list misled me, and here is why it did** — this is the finding, not the ruling:

> **Both rooms are uploading chunks into `bench_session` rows that have been marked `ended` for days.**

A session marked ended is still accepting audio. So `last_session_at` and `last_session_status` say
nothing about whether a room is recording *right now*, and any query that treats them as a liveness signal
— including mine — is unsound.

## 2. What is actually happening in those two rooms

The pieces fit together: the day-rollover reaper ends a still-recording session at IST midnight, the kiosk
never stops, and every subsequent chunk creates and closes a window under a session the database believes
finished. **OPD 7 has been recording since roughly 13 September; OPD 4 – Ortho since roughly 11 September.**
Only 24 windows each fall inside the six-hour age limit; the rest are older and therefore invisible to
that query.

That means **two OPD kiosks have been recording empty rooms for one to three days, including today, a
holiday.** Storage cost is already spent. Transcription cost is not — and only because **Transcript is OFF
for both rooms**, which is the single reason they show 0 in the Transcript-filtered column. That was luck,
not design.

## 3. THE RULING — the age limit keeps `closed_at`

The Builder asked whether the limit should gate on `start_ms` instead. **No. Keep `closed_at`.**

- `closed_at` is the **readiness** signal. A window cannot be drained before it closes. Gating on
  `start_ms` would make any window that closed late **permanently ineligible** — never drained, never
  refused, never counted. That is a silent orphan, and it is the same failure class as N2's starvation and
  testing rule 12: a decision that changes nothing and is never seen again.
- The problem `start_ms` would solve — ancient audio arriving through a bulk close — **is refuted**. It is
  not happening. Designing around it now would be designing around an unmeasured constant.
- In normal operation the two are ~15 minutes apart, because the chunk-upload path closes windows live.
  They diverge only in the abnormal case, and in that case `closed_at` is the safer of the two.

**One addition, not a change of gate:** when the drain claims a window, record the gap between its audio
start and its `closed_at`. A window drained long after the speech it contains should be *visible*, not
silent. This is the make-the-decision-into-data principle that C6 already applies to refusals. Cheap, and
it turns the abnormal case into an observation instead of a surprise.

## 4. Queued, separately, and not in any current round

**K1 — a session marked `ended` accepts new chunks.** Either the reaper's end is wrong, or the ingest path
does not check session state before creating a window. Both readings are defects; which one it is decides
the fix. This corrupts every liveness query in the system and it is why §1 happened. Needs its own
investigation round — **not** folded into S1, and not started while M7 holds the Mini.

**K2 — an operational decision for V**, stated in §5 of my message to him: whether the OPD 7 and OPD 4
kiosks should be stopped. They are recording empty rooms today.

## 5. What this does not change

`fe021a3` is live, health is green on all six checks, seven crons are registered including
`/api/jobs/run`. The C23 counts stand — neither `AUTO_DRAIN_MAX_AGE_HOURS` nor
`AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` is set in Vercel, so the code defaults of 6 h and 60 min are what
production runs. `ROOM_AUTO_DRAIN_ENABLED` stays **off**.

**And a note on the loop:** this is the third time today a Builder or Refuter has corrected the
Orchestrator against the code — F2 on the retry counter, D8 on `model_key`, and now P3-1. Each time the
correction came from measuring the thing rather than reasoning about it. The briefs should keep saying
so: a premise in a kickoff is a claim to be tested, not a fact to be built on.
