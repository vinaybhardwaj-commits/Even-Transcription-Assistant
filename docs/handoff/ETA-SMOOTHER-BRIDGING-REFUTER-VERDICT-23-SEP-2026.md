# ETA — E-4 smoother, the bridging ruling. REFUTER VERDICT. 23 Sep 2026

`lib/encounter-clock/smooth.ts` as merged at **`2203873`** (the merge of `5e1b5e2`, builder split-speaker), reviewed on Fable's order of 23 Sep: refute the smoother **before its flag is ever turned on**. Contract = Fable's bridging ruling: bridge unjudged only up to the merge window; tape-off and dead mic always close; unjudged alone never opens an encounter. Own detached worktree `/tmp/refute-sm`; builder's worktree never written to, nothing pushed. Note `2203873` is already on `origin/vinay/s1-auto-drain`, the branch production deploys from — **with `ENCOUNTER_CLOCK` off and no caller**, which is why the timing of this review is right.

## FAIL — the ruling is enforced in the `open` state and absent in the `pending` state. Not a regression; a gap the ruling did not reach. Blocker for flag-on.

All three of the ruling's closes are written as guards on `state === "open"`:

```
lib/encounter-clock/smooth.ts:117-123
if (state === "open") { if (tapeOffBetween(ps[lastSpeech].t, p.t)) close("tape_off"); }
if (state === "open" && p.reason === "dead_mic") { close("dead_mic"); continue; }
if (state === "open" && lastJudged >= 0 && p.t - ps[lastJudged].t > bridge) close("unjudged_gap");
if (v === "unjudged") continue;                 // never counts, never resets, never closes by itself
```

The machine has three states, not two: `idle` → `pending` (a speech run that has not yet reached `ENTER_SPEECH_PROBES`) → `open`. In `pending`, none of the three guards fires, and line 123 then skips every unjudged probe before the `pending` branch is reached. **A run that has not yet opened bridges without limit, across anything.**

### Measured, not argued — probes run through the Yoga runner against `2203873`

| probe | input | result |
|---|---|---|
| P1/P2 | `S` + 20×`U` + `S` (1,200 s unjudged) | **one encounter spanning all 21 hops**, start at the first `S` |
| P6 | `S` + 1000×`U` + `S` | **one encounter, 16.7 hours** |
| P7 | two speech probes 600 hops apart, **no probes at all between** | **one encounter, 10 hours** |
| P3/P8 | `S` `D` `S` (dead mic between) | opens across it; the interval even reports `dead_mic_ms = 1 hop` |
| P4 | `S` `S` with a tape-off between them | opens across it |
| P5 | `SS` + 20×`U` + `SS` (**control**, already open) | **2 encounters — the ruling works in `open`** |

P5 is the control that makes this precise: the ordered fix is correctly implemented. What is missing is one state earlier. **This is the 352-minute-encounter failure the ruling was written to stop, surviving in `pending`** — and P6 reaches 16.7 hours, longer than the case that prompted the ruling.

P7 matters most: it needs **no unjudged probes at all**. A hole in the probe series does it, so a scheduler that simply does not run overnight produces the same result.

### Why it is reachable in production, not a synthetic edge

`pending` is reset only by a `non_speech` probe (`smooth.ts:130`). On production data the gate can never return one overnight:

```
lib/encounter-clock/gate.ts:240-241
if (energy.state === "quiet") return transcript.state === "text" ? out("unjudged", "halves_disagree") : out("non_speech", "quiet_room");
if (transcript.state === "missing") return out("unjudged", "no_transcript_evidence");
```

`non_speech`/`quiet_room` requires `energy.state === "quiet"`. My r5 Finding 2 measured that this never happens on real data — the quietest peak ever recorded is **0.0428 against a 0.00398 floor**, an empty night room included, so `active_frac` is 1 and the state is always `active`. An empty room with no transcript therefore returns **`unjudged`/`no_transcript_evidence`**, not `non_speech`. **The pending run cannot be reset overnight.**

So the concrete failure is ordinary: **one stray speech probe at the end of a clinic day, plus the first speech probe the next morning, is a single encounter spanning the night.** Two probes, no exotic input.

This also re-prices an accepted decision. Fable accepted Finding 2 as **inert** on 22 Sep on the grounds that the level half only costs a skipped fetch. That reasoning is sound for the pre-selector and does not carry here: the same fact — every probe reads `active` — is what removes the only reset the `pending` state has. **Inert for cost, not inert for the smoother.** Flagging, not reopening: the ruling stands, the second consequence was not costed.

### Fix

Hoist the three closes above the state test, or apply them to `pending` as a reset rather than a close (a `pending` run has no encounter to close — it should simply return to `idle`, discarding `first`). Jev's `changeability` lead names the shape of it: the rule is scattered across three separate `state === "open"` guards instead of living in one place. A single "evidence ended here" step evaluated before the state switch would make the ruling structurally true in every state, which is what the contract asks for.

## The ordered mutation set — 14 mutations, **11 killed, 0 runner errors**

The `open`-state contract is genuinely well covered: the bridge close, the dead-mic close, the tape-off close, the bridge constant, ending at the last speech probe rather than the last judged probe, the forced-close merge guard, the `overBridge` clause, both hysteresis constants, `unjudged` not resetting the bridge clock, and tape-off-after-last-speech closing as `tape_off` — **all die.** The tests are good. They are good about one state.

**Three survivors, all real, none a blocker:**

- **M12 — a hole in the probe series counting as unjudged time is untested** (`HOLE_HOPS`). Setting it to `1e9` leaves the suite green, so nothing pins that holes are counted. The accounting is *correct* as written — but it is the accounting for exactly the interval in the finding above, so the 10-hour encounter in P7 would be the only signal that anything was wrong. Worth a test on that ground alone.
- **M13 — `exitCount = 0` on speech in the open state is untested.** Removing it lets a non-consecutive `N S N N` close an encounter, violating the documented "with no speech between them". Reachable in an ordinary consult with pauses.
- **M14 — `dead_mic_ms` attribution is untested.** Reporting only.

### Rejected leads — stated so they are not re-raised

- **The gap-merge undoing a bridge-forced split.** I suspected `overBridge` could let a split within one hop of the bridge limit be merged back. Probed (P9: `SS` + 4×`U` + `SS`, a 240 s gap against a 180 s bridge): **2 encounters.** Does not reproduce; the lead is dead.
- `tapeOffBetween` missing a stretch that began before the last speech probe: unreachable, since the recorder being off produces no speech probe to begin with.

## Jev (V's standing rule) — after my read, probes and mutations; neutral context

Task, source diff and neutral context (the ruling's three rules and the constants); **none of my findings**, no mention of `pending`. Scores **4.8–6.4**, one `medium`.

- **testQuality 4.8, `medium`, its top priority** ("important changed behaviour lacks meaningful regression coverage") → **CONFIRMED and it is the finding**: 24 passing tests, every one of them in `idle`/`open`. Jev named no specifics; the `pending` state and the six probes are mine.
- **changeability 5.9** ("a domain rule or decision is scattered across multiple locations") → **CONFIRMED, and it is the right frame for the fix**: the ruling is three separate `state === "open"` guards rather than one rule, which is precisely how a state got missed.
- **correctness 5.2** ("an important edge case or invalid state appears insufficiently handled") → **CONFIRMED in substance.**
- **cognitiveComplexity 5.7** ("state transitions or side effects are difficult to reason about") → **CONFIRMED, and it is causal here**, not cosmetic: `close()` mutates five variables and the guards read `ps[lastSpeech]` before the state is known to be valid.
- **duplication 5.8 / maintainability 5.3** → same root.

## Gate

Probes and mutations ran on the Yoga fast runner as ordered — 23 runs in all (5 + 4 probes, 14 mutations), 0 runner errors, worktree verified clean at `2203873` after each. I did not re-run the full suite: this is a read plus targeted runs on a pure module, and the builder's own full-suite result is not in dispute.

**Verdict: FAIL for flag-on, PASS for merge-as-is.** The code is already merged and the flag is off, so nothing is broken today and nothing needs reverting. But `ENCOUNTER_CLOCK` must not be turned on until the three closes apply in `pending`: as it stands the first day the clock runs, a night with one stray speech probe either side of it is billed as one encounter.
