# ETA-E22 — Rulings on the E11/E17 refutation · 15 Sep 2026 · Fable

Source: docs/handoff/ETA-E11-E17-REFUTATION-15-SEP-2026.md (Refuter, 18:28).
Both commits came back MERGE-READY. Neither merges tonight. Reasons below.

## 0. Container contamination — RULED OUT, with its premise named

The Refuter wrote: "Mutants from E17-8 on also used the Docker suites. I can't rule out
another session using the same container at that moment." I can rule it out.

c041ea8 names each container `<base>-<sha256(worktree root)[0:10]>`. At the time of the
Refuter's rerun: -e20 was at c041ea8 (unique names), -e16 had the cherry-pick as a05d750
(unique names) and scribe3 explicitly did not run its suites, and -slice-e (fee5822) was
untouched all evening. Main, lacking c041ea8, was therefore the ONLY user of fixed-name
containers. Nothing else could have taken them.

This rests on one premise: that no process ran a Docker suite in -slice-e tonight. That is
my judgement from the session record, not a measurement. If anyone finds evidence of a
-slice-e run after 17:00, the E17-8-onward mutants must be rerun.

RULING R0: main gets c041ea8 in the next build round. It is the last worktree using fixed
names, and "the only one left" is not a safety property, it is a countdown.

## 1. F4 — silence is final and nobody retries it. MY RULING.

E11 made a silent window cost no attempt and never be offered again. Against E13 (a dead
mic cannot be told from a quiet room) and E15 (VAD calibration on room audio UNVERIFIED),
that makes a FALSE silence permanent and invisible. Before E11 it burned three attempts
and parked visibly as `failed`.

RULING R1. E11's direction is correct and E11 does not change. A quiet room must not burn
attempts and must not be called an outage. What is wrong is not the attempt accounting, it
is that a silence verdict is currently unevidenced and unrevisitable. Three requirements,
and they land in E18, whose spec is already written and unbuilt:

  R1.1 A window called silent is recorded in its own named state, never folded into
       `transcribed` alongside windows that actually contained speech. "We heard nothing"
       and "we heard something" are different claims and must not share a state.
  R1.2 The silence verdict carries the evidence that produced it: the VAD decision, the
       audio level if the recorder sent one, the engine that answered, and the whisper
       parameters in force at the time (--vad, --no-speech-thold, --suppress-nst, and the
       Silero version). A verdict we cannot re-derive is a verdict we cannot overturn.
  R1.3 The silent population is queryable as a set and re-adjudicable in BULK. When E15
       calibrates VAD and E13 lands a dead-mic detector, we re-run the whole backlog
       against the better detector. Requiring `force` per window is not a mechanism, it is
       a wish.

Attempt accounting stays as built: no attempt for silence. Do not revert that.

Rationale, stated plainly: E11 traded a noisy false alarm (a quiet room reported as an
outage, 21 of 25 windows) for a silent false negative (a dead mic reported as a quiet
room). That is the right trade ONLY if the false negative is recoverable. R1 is what makes
it recoverable. Until R1 is built, every silence verdict we write is a claim we cannot
audit — and audio we cannot re-examine is audio we have effectively thrown away.

## 2. F1 — E17 turns a refused room into the top-priority room. BLOCKS MERGE.

Measured by the Refuter against the real `orderAutoDrainOffers`: a room whose offers are
refused before the claim holds 98-100 of 117 slots. The other five rooms get 3-4 each.
Cause: "served" means a `room_window` job exists; a refusal creates none; the room stays
`null` and ranks first forever.

RULING R2. This is not a flag, it is the same defect E17 was built to remove, pointing the
other way, and it is worse than what we measured live (one room took 25 of 25 drain slots;
this takes 84% structurally). E17 does not merge until it is fixed.

RULING R3. The fix is to mark the room served WHEN THE SLOT IS OFFERED, not when a job is
created. A room got its turn; whether it used the turn is its own business. Rejected
alternative: per-room refusal backoff — more machinery, more state, and it re-derives at
runtime what the served mark already knows. Take R3 unless building it exposes something
neither of us has seen, in which case stop and report rather than switching approaches.

Note for whoever builds it: `flag_off` and `join_service_not_configured` both become
"served" under R3. That is correct. A room with transcription switched off should wait its
turn like everyone else, and a global misconfiguration refuses every room equally.

RULING R4. F1 is latent today only because no refusal is persistently per-room. "Latent"
here means one new refusal reason away from live, and it would arrive as a silent 84%
starvation, not as an error. It is fixed now, not tracked.

## 3. F1's real lesson — the MODEL enumerated

No test saw F1 because the E4 model at `e17-drain-fairness.test.ts:72` marks a room served
on every pick and never models a refusal. The code was exercised; the scenario was never
imagined.

TESTING RULE 21 (new): a simulation is a guard, and a guard that enumerates cannot see what
it was not told about. When a model stands in for the world, the refusal, the timeout and
the partial failure must be in the model, or the model is only testing the happy path in a
costume.

This is rule 19 applied to a fake instead of a switch statement, and it is the second time
tonight a survivor was visible only with realistic inputs (the Refuter's own closing note:
"a test is only as strong as how realistic its fake is"). Rules 18, 19 and 21 are one
family. Treat them as one check.

## 4. F2, F6 — two test gaps, both confirmed by surviving mutants

RULING R5. Both are built in the same round as R3.
  - F2: mutant E17-10 (the `served` CTE counting only `status IN ('done')`) survives on real
    postgres. Pin that a QUEUED or RUNNING job counts as served. This is the state right
    after the drain submits, and a route job runs ~1.3x realtime — about 20 min for a 900 s
    window, four cron ticks during which the room must not be re-offered.
  - F6: mutant E11-11 survives; the speech-path cue guard has no test on the brain's real
    failure shapes. Item (e) covered only the silent path.

## 5. F3, F5 — not this round, but F5 is live

RULING R6. F3 (`room-drain.ts:1232` turns a synchronous engine's `empty_transcript` into
`engine_failed` and spends up to 3 paid calls; `bench.ts:1689` calls the same answer
silence) folds into E19, the whisper result classifier. It is the same defect class E11
fixed, on the engine step, and two paths disagreeing about one answer is exactly what E19
exists to end.

RULING R7. F5 is the one with production impact right now. `whisper-chunk/route.ts:149`
reports a silent delta as `UPSTREAM_UNAVAILABLE` on the LIVE encounter path — the doctor-
facing path, not the batch one. E11 fixed this class for room windows and left the live
path untouched. It gets its own spec (E23) and it is not "pre-existing, therefore later":
pre-existing means it has been wrong for longer.

## 6. What merges, and when

Nothing merges tonight. Order:
  1. R3 + R5 + R0 on vinay/s1-auto-drain (F1 fix, F2 and F6 tests, c041ea8 into main).
  2. Refuter on that, by an agent that did not build it.
  3. E16 (a05d750) refuted — still the oldest unreviewed commit, now unblocked because
     Docker is up (server 29.7.2) and c041ea8 is in -e16.
  4. Then E18 (carrying R1.1-R1.3), then E19 (carrying R6), then E23 (R7).

## 7. Standing rules confirmed tonight

- Every spec names its branch AND its worktree. Held this round.
- A waiver is granted against a specific diff and does not transfer (rule 20). The E11
  Docker waiver was correctly refused carriage into E16.
- Mutation count is reported as caught-of-run with equivalents named. The Refuter reported
  24 of 29, then 24 of 26 after naming one equivalent mutant and two declared blind spots.
  That is the right shape: the raw number first, the adjustment shown, not folded in.
