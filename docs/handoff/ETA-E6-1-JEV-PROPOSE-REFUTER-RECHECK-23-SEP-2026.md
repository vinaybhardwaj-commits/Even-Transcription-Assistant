# ETA — E-6.1, zero-speech fix. REFUTER RE-CHECK. 23 Sep 2026

`vinay/e6-1-jev-propose` **@ `81cec3a`** (builder lx), one commit on `b05ac71`. Worktree `/tmp/refute-e61b`, HEAD asserted, clean after every run. Baseline green pristine: 53/53.

## PASS — my finding is closed, and the guard is pinned in both directions

**My original probe, re-run unchanged against this sha:** three probes, every one acoustically `unjudged`, textbook Jev consultation on top →

```
proposed = 0    no_speech = 1    encounters = 0
```

The case that produced a phantom encounter at `b05ac71` now produces none, and the rejection is **counted** rather than silently dropped — so E-7 can see how many candidates fell to this rule.

| mutation | result |
|---|---|
| **V1** guard neutered (`heard` always true) | **killed, 2** |
| **V2** an acoustically-`unjudged` probe counts as heard | **killed, 2** |
| **V3 VACUITY CONTROL** guard inverted, so only unheard runs propose | **killed, 10** |

V2 is the one that matters: it pins the exact distinction rather than the general shape — `unjudged` is kept, is not trimmed, and does **not** count as heard, three different treatments of one verdict. V3 dying in the other direction means a run that *was* heard still proposes, so the guard is a boundary and not a blanket refusal.

**The comment is better than the code.** lx wrote the principle into the header rather than leaving it to the diff:

> *"No evidence is not silence, but no evidence is not a consultation either: a run with no speech-judged probe rests on transcript text alone, and whether text was invented from silence is the one question Jev cannot answer (PLAN-v3 §1.1, J-A). Jev may propose without an acoustic BOUNDARY, never without acoustic evidence of SOUND."*

They also documented the **two meanings of "unjudged"** — Jev's (no answer, breaks the run) against the acoustic gate's (no energy evidence, does not break it, is not trimmed, does not count as heard) — which I had raised as a readability point and expected to be ignored. It is the ambiguity most likely to cause the next bug in this file.

## Verdict: PASS
Closed at the level I asked for, counted rather than silent, and pinned by a control in both directions. No follow-up from me.
