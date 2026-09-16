# ETA-E20 — RULING: recompute in the app, but measure the shadow · 14 Sep 2026, 21:55

`scribe3` found that E20's premise does not hold: `server.py:209-216` emits `clinician_id` and
`confidence` **only at or above the threshold**, so losing candidates are discarded before the app ever
sees them. Stopping to ask was right — building on a false premise is what E16 avoided three hours ago
and it is becoming this programme's most valuable habit.

## 1. Ruled: option 1 — the app recomputes — with the guard MANDATORY

This is the second time tonight a round has needed a number only a Mini service computes. **The answer
is different this time, and the difference matters:**

- **In E16 the two signals answered different questions.** The service's amplitude gate asked *"is
  there enough energy to bother?"*; the diarizer asked *"how much did this person speak?"* The second
  was the better answer, so the service change became unnecessary.
- **Here there is only one question** — *what did the matcher score this speaker against this centroid?*
  — and only one correct answer: the service's. Any app-side computation is a **second implementation
  of the match**, which is testing rule 3, the defect that has bitten this codebase repeatedly.

So the shadow is only acceptable if it is **measured rather than trusted**, and `scribe3`'s proposed
guard is exactly the right instrument:

> **Recompute the MATCHED speakers too, and count disagreements against the service's 3-dp confidence.**

That is fork W option A's pattern from `ETA-E1-RULINGS-14-SEP-2026.md`, and ruling it the same way here
keeps the programme consistent.

**The guard is not optional and its result is a number, not a claim.** Report the disagreement count and
the distribution of the differences.

> **If the disagreement count on matched speakers is anything but zero, the losing scores are not fit to
> set a threshold from, and we go to option 2.** Say so in the report; do not quietly proceed.

## 2. Mirror the service faithfully, including the part that is easy to miss

`scribe3` already spotted it: the service does greedy assignment and **skips clinicians already used**
(`used_clinician_ids`). The shadow must mirror that exclusion, or it will report a losing score against
a clinician who was in fact taken by a louder speaker in the same window — a number that looks like a
near-miss and is nothing of the sort.

Mirror it, and **test that specific case**: two speakers, one centroid that both would match, the louder
one taking it.

## 3. Record where the number came from — the E16 lesson, applied

Add a basis column alongside the score, exactly as E16 did with `speech_basis`:
`score_basis` ∈ `{'app_recomputed', 'service_reported'}`, defaulting to `'app_recomputed'` for what this
round writes.

When option 2 lands, rows from before and after are then distinguishable by a query rather than by a
date someone has to remember. **Reserve `'service_reported'` in the CHECK now with a comment saying it
is for the option-2 round and currently unwritten** — same as 0097 did.

## 4. Option 2 is the end state, and it is NOT tonight

`server.py` returning `best_clinician_id` / `best_score` for unmatched speakers is the correct design —
exact numbers, no shadow, no drift. It is out of scope tonight for the reasons that already stand: it
edits and restarts a Mini service outside this repo, on an unversioned file, while the live pipeline
depends on it. **Its own round, with a version on the contract**, alongside the emotion service's
option D. Two services now owe us the same thing, which is itself an argument for doing them together.

## 5. Scope unchanged otherwise

Migration **0096**. `role` stays NULL. No threshold changes — not 0.65, not 0.70, not 0.78; the
distribution this round produces is what sets them later, and setting one now from the 151 rows we have
would be fitting a number to centroids built from a single voice sample for five of seven doctors.

Branch `vinay/e20-losing-score` in its own worktree. Commit on green; no push, no merge, no deploy, no
service restart.

## 6. And the finding stands on its own

Even if the shadow turns out to be unusable, **record in the report that the diarize service discards
the losing candidate before responding** (`server.py:188-216`), that the raw ECAPA embedding is
available in the response, and that `used_clinician_ids` governs the exclusion. That is the fact which
makes option 2 necessary, and it should survive whatever happens to this round.

Orchestrator.
