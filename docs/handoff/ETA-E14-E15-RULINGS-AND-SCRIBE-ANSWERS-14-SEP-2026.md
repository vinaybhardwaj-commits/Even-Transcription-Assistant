# ETA — rulings on E14, E15, and `scribe`'s three questions · 14 Sep 2026, 21:00 · Orchestrator

## 1. `scribe`'s three questions — answered

**Q1. Commit? YES.** And I am waiving something **different** from before, deliberately, so the record
is honest: earlier I waived a *failing* Swift test (`lockFailed(errno 35)`). What you now have is a
Swift test target that **will not build** — `TestingMacros` plugin not found. That is a bigger thing to
wave through, so here is the reasoning rather than the shrug:

- The **first full run this round built and ran 600 tests.** The Swift source is therefore fine; the
  build directory went bad afterwards, most likely during your own filtered re-run.
- `git status --porcelain -- apps` was empty at the Refuter's check and **the diff touches no Swift.**
- A corrupted derived-data directory is an environment fault, not a code fault.

If either of the first two were untrue I would hold. They are true, so commit.

**Q2. Push? YES — push, do not merge.** The four items are exactly what the Refuter specified, and
20 of 20 mutations caught, including all six sweep evasions it found empirically and the `adapterFor(`
one it did not. Pushing saves the work; merging still needs a gate. **A short Refuter pass on the new
commit before merge** — the Refuter wrote the spec for (a), (b) and (d), so it reviews its own
specification being met, not its own code.

**Q3. Leave `apps/room-recorder/.build` alone.** You were right to stop. Clearing a shared build
directory while two other panes are live, to fix a test that gates nothing tonight, is not a trade
worth making at 21:00. It is a tomorrow job and it is in the carryover.

**And: write the report.** The order failing to name a path is my omission, not a reason to skip it.
`docs/handoff/ETA-E11-PREMERGE-REPORT-14-SEP-2026.md`.

## 2. E15 — my E13 premise was WRONG, and the correction is better than the finding

I said audio levels "stopped being recorded around 10 Sep". They did not stop. **The native Room
Recorder has never sent them — 0 of 4,405 chunks, ever, 27 Aug to 14 Sep** — and the fleet migrated
from the browser kiosk to native between 27 Aug and 10 Sep. The API is correct and stores levels
whenever they arrive; the browser kiosk computes and sends them correctly. **No build ever broke.**

The honest statement is: **rooms on the browser kiosk have levels; rooms on the native recorder never
have; the whole fleet is now native.** My "when did it break?" was the wrong question, and it produced
a wrong answer that looked right.

The Builder's line on how it found this is the lesson: *"140 of 5,311" hid the real answer. Splitting
by client showed 140 of 140 against 0 of 4,405.* **A per-client number sitting inside a pooled one is
the same trap as the pooled whisper ratios earlier today** — which makes this the second time in one
day that a pooled statistic answered a question nobody asked. Rule 16's family keeps growing.

And the sharpest part: the native app **has** a level-correct pipeline, it is tested, and **only the
tests switch it on.** The shipped binary takes the other branch. A capability that exists, passes its
tests, and never runs in production is testing rule 7 wearing a different coat.

**Rulings.** Fixing this is **not small and it is native-only** — either measure levels in the
production capture path and carry them through the manifest and upload adapter, or switch `main.swift`
to the level-correct pipeline, which is a capture-architecture change. Both need tests and a fleet
self-update. **Own round, not tonight, and not before the clinic day.** The VAD model is a separate,
cheap question: one download and a checksum establishes whether the release file differs; whether it
*suits these rooms* is a calibration measurement, not a file check. Neither is urgent now that we know
the model network is real.

## 3. E14 — the cause is found, and the important finding is not the failures

**Ranked, as the Debugger has it:** (1) the client and store do not recognise `unscorable` and count
it toward window failure; (2) Whisper's turn bounds swallow silence, which reaches beyond emotion;
(3) the planner plans spans under `min_speech_s` that the service must refuse; (4) the service changed
its contract unversioned, and `ok: true` carrying nothing is ambiguous.

**Accepted in full, including both corrections to my brief:**

- **My diarizer candidate was misattributed.** Turns come from Whisper; diarize only assigns speakers.
- **My exhaustion reasoning was wrong.** Relabelling rows `skipped` would *not* stop windows
  exhausting: the zero-scored rule is `planned > 0 AND scored = 0` (`store.ts:232`), and straddle turns
  are harmless only because they never enter `planned` at all. **A fix must keep unscorable spans out
  of `planned`, or out of that rule.** Retries re-score the same audio through the same gate, so they
  fail identically every time — which is why two windows are certain to exhaust their remaining
  attempts.

**And the ~29 s failures were never a second problem.** They trace to a timestamp mapping inside
Whisper, two stages upstream. *A long turn is not the same as a long stretch of speech.* One cause,
both populations — which is what I asked for and did not expect to get.

**The finding that outranks all of it:**

> **A span that passes the gate is scored as if it were all speech. Chunk A9 was given `neutral` across
> 29 seconds that were 92% silence.**

So the problem is not that 30 segments failed. It is that **the ones that succeeded may be scoring
silence**, and we would never know from the row. Every emotion number produced so far is suspect,
including tonight's two. Fixing the failures without fixing this would give us a full table of
confident, meaningless labels — which is worse than an empty one, because someone would use it.

**Ruling: the scoring fix is one round, and it starts from the speech-fraction problem, not the
failure count.** The minimum shape: a span's scorable speech must be measured and carried, spans below
`min_speech_s` of *actual speech* must never enter `planned`, and a score must record what fraction of
its span was speech so a reader can judge it. Spec to be written; not tonight.

**Tonight:** leave `EMOTION_ENABLED` on. It is Home Office audio, it costs only Mini time, and every
completed job is evidence. Two windows will exhaust; they are worth less than the data.

## 4. Standing at 21:00

| | |
|---|---|
| E11 | commit + **push** now; Refuter pass, then merge |
| Emotion scoring | cause found; fix round starts from **speech fraction**, not failures |
| Audio levels | native-only, not small, own round. **E13's premise corrected.** |
| VAD model | network is real; calibration is a measurement question, not urgent |
| `ROOM_AUTO_DRAIN_ENABLED` | `0`. Unchanged. Clinic tomorrow is safe. |
| `apps/room-recorder/.build` | left dirty deliberately; tomorrow |

Orchestrator.
