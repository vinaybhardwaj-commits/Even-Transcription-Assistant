# ETA-E16 — RULING: build option A, and my amendment is partly withdrawn · 14 Sep 2026, 21:15

Rules on `ETA-E16-REPORT-14-SEP-2026.md`. **Stopping was right.** The spec's §7 said a round that
improves the failure rate and says nothing about speech fraction has built the wrong thing; you noticed
that P2/P5 without P1/P3/P4 *is* that round, and you stopped instead of shipping it. That is the brief
working as intended.

## 1. The finding underneath the blocker — three systems disagree about what speech is

| span | diarizer | Whisper VAD | outcome |
|---|---|---|---|
| Run A chunk 9 (A9) | 2.28 s / 29.07 s = **7.8%** | ~92% silence | scored `neutral` |
| Run A chunk 5 | **3.73 s** | ≤ 0.38 s | failed |
| Run B chunk 1 | **4.53 s** | 1.76 s | failed |
| Run B chunk 2 | **4.99 s** | ~0.04 s | **scored** |

Run B chunk 2 is diarizer-against-VAD by a factor of **125**. That is not noise between two estimators
of one quantity; it is two systems measuring **different quantities** and a third — the service's
amplitude gate — measuring a third.

> **Nobody in this system agrees on what counts as speech, and every stage downstream of that
> disagreement inherits it.** That is bigger than emotion and it is now its own named item (§5).

## 2. RULED: option A — the diarizer's per-speaker intervals

Not as a compromise. **As the better answer to the question P3 actually asks.**

A reader of an emotion label needs to know *how much of this span was this person speaking*. Compare
what each signal answers:

- **The service's `speech_s_est`** is peak amplitude ≥ 0.02 over 20 ms frames. That counts a door, a
  chair, a keyboard. It answers *"was there enough energy to bother running the model?"* — an
  **operational gate**, not a semantic measure.
- **The diarizer's segments** are speech intervals **attributed to a speaker** — and the emotion score
  is for one speaker. That answers the reader's question almost exactly.

So the diarizer is not second-best here. It is the right basis, and it needs no audio decode, no new
dependency, and no service change.

**My amendment A2 is therefore partly withdrawn.** I reversed §5 an hour ago and put the service change
in scope, reasoning that only the service could cheaply compute this. That reasoning was sound and its
conclusion is wrong: you found a signal already in the repo that answers a *better* question. The
service change stays ruled as the end state (§4 option D) and moves back to its own round.

**What survives from the amendment, unchanged:** A1 — **no cutoff this round.** Your data confirms it.
n = 26 scored rows, p10 0.295, p50 0.755, and the two known-bad spans at 0.078 and 0.181. A 0.25 floor
would separate exactly those two, which is fitting a threshold to two points from one room's Home Office
audio. **Emit the fraction; set the floor when there is a clinic week behind it.**

## 3. Your §5 questions, answered

**P2 — both, not one.** Pre-filter spans whose *diarized* speech is under `/health`'s `min_speech_s`,
**and** exclude the service's `unscorable` answers from `planned > 0 AND scored = 0` (`store.ts:232`).
Run B proves the planner and the gate disagree **in both directions**, so a fix in one place leaves the
other open. Note that `min_speech_s` is exposed and read — rule 11 is satisfied without hard-coding
`speech_abs`, which is exactly why option A escapes the problem that blocked you.

**Migration 0097 — approved as you designed it**, with one addition: put `'service_speech_est'` in the
`speech_basis` CHECK now, with a comment saying it is reserved for the option-D round and currently
unwritten. A CHECK widened later is a second migration; a documented reserved value is not.

**Branch — yes.** Cut `vinay/e16-emotion-speech-fraction` from `ccd12b0`. Do not push. `vinay/s1-auto-drain`
is carrying E11 under Refuter review and must not move.

## 4. One thing to add that your report implies but does not state

Record **both** numbers where both exist. They answer different questions and we now know they diverge:

- `speech_ms` + `speech_basis = 'diarize_segments'` — the semantic measure, for judging a score (P3).
- the service's `speech_s_est`, where it returns one — the operational explanation of a refusal (P5).

Keeping only one would throw away the evidence of the divergence in §1, and that divergence is the most
interesting thing found tonight.

## 5. Named, not built — and now a priority

**Three-way speech disagreement.** Diarizer vs Whisper VAD vs the service's amplitude gate, differing
by up to 125×. This sits upstream of emotion, upstream of the silent-window rule E11 just shipped, and
upstream of any dead-microphone alarm. Own round, its own evidence pass first.

Also still named and untouched: Whisper's VAD time-mapping (E14 cause 2), and the service contract
(option D).

## 6. Build it

P1–P5 under option A, migration 0097, on `vinay/e16-emotion-speech-fraction`, no cutoff, both numbers
recorded, mutation check mandatory, commit on green, no push. Report as specified.

Orchestrator.
