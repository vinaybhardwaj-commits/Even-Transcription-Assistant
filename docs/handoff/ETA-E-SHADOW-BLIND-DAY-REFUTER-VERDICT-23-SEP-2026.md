# ETA — E-shadow: no-energy days go provisional. REFUTER VERDICT. 23 Sep 2026

`vinay/e-shadow-runner` **@ `40b0d6a`** (builder split-speaker), pushed, gate green. Follow-on to the partial-day guard, forced by the first real-data runs. Own detached worktree `/tmp/refute-es3`, HEAD asserted. Nothing pushed.

## PASS-WITH-ONE-FIX — the rule is right and the hole it closes is real. The widening to all five triggers is not free, and the justification for it does not hold at the threshold chosen

### The hole is real, and the first real runs found it

My partial-day guard keyed `provisional` on **day completeness**. The 22 Sep fragment showed that is not enough: 742 of 742 probes returned `no_energy_evidence`, because the level log began at 19:53 and that room's tape had already stopped — the samples and the recording never overlap. Zero encounters. And because 22 Sep is a **complete** day, both provisional-eligible triggers reported **FIRM**: a roll-back signal for a day that simply predates the level log.

That is the same shape as my finding one level up, and split-speaker's diagnosis of it is exactly right: *"provisional keyed on day completeness; it needed to key on evidence coverage too."* A run that saw nothing has no number worth stopping for.

The implementation is careful — `NO_ENERGY_PROVISIONAL_SHARE = 0.5` exported, the threshold **exclusive** and tested both sides, `no_energy_share` carried in the summary so a reader sees why, `triggers_tripped` still honest while `triggers_tripped_firm` excludes. Three mutations dead on their side.

## FIX — the widening to all five triggers suppresses a real stop, and I measured it

split-speaker asked me to weigh this rather than take it from them, and gave the reasoning: *"with no energy there are no speech probes and so no encounters, which means `encounter_over_2h` and `median_over_60min` cannot trip on such a day anyway — so the widening costs nothing today."*

**That is true at ~100% blind and false at the 50% threshold actually chosen.** I probed it:

```
a COMPLETE day, no_energy_share = 0.6, one encounter, longest_minutes = 180
  -> encounter_over_2h  tripped: true   provisional: TRUE
  -> excluded from triggers_tripped_firm  ->  NO FIRM STOP
```

At 51% blind, **49% of probes still see energy**, so speech probes form and encounters form. A genuine three-hour encounter in that sighted remainder is marked provisional and suppressed from the firm stop — the one trigger that most needs to fire, silenced by a rule about a different kind of blindness.

**And the motivating scenario makes it likely, not exotic.** A level log that starts partway through a day produces **contiguous** blind probes — the 22 Sep shape exactly. The sighted remainder is then a continuous stretch at the end of the day, which is precisely where a long encounter can form intact. The situation that prompted this fix is the situation that exposes its widening.

**The argument against is the one split-speaker already accepted from me on the partial-day guard, and it transfers unchanged:** a prefix can *manufacture* a high unjudged share or a zero-encounter count, but it cannot manufacture a three-hour encounter. **Being half-blind cannot manufacture one either.** If 40% of the day saw energy and produced a three-hour encounter, that encounter is real and the bridging rule has a hole regardless of what the other 60% could not see.

**Fix, and it is the one line they offered:** keep `provisional` narrow — `blind` should mark the same two triggers `partial` does (`unjudged_over_90pct`, `no_encounters_on_a_day_with_transcripts`), not all five. Those two are the ones a lack of evidence can falsely trip. `encounter_over_2h`, `median_over_60min` and `encounters_over_15` all require encounters to exist, and an encounter that exists is evidence in itself.

Worth noting the 22 Sep case is still handled by the narrow version: at 100% blind there are no encounters, so those three carry `value: null` and `tripped: false` anyway — they never reach the firm count. **The narrow rule fixes 22 Sep and keeps the three-hour stop. The wide rule fixes 22 Sep and loses it.**

## The next item they ledgered, and I agree it is the one that matters

`bench_level_sample.avg` is now on **81.2%** of today's rows (0% on 22 Sep), so the gate's *avg-when-every-usable-sample-has-one* rule means **the level basis now varies probe to probe inside a single day**, and the run does not record `level_basis` per probe — so no reader can tell which basis produced a verdict.

That is the same drift I reported this morning (72.3% then, 81.2% now) moving faster than the work on it. `energyHalf` already returns `level_basis`; recording it per probe is cheap, and without it E-7 will be comparing acoustic verdicts whose basis silently differed.

## Gate

- **Mine:** one targeted probe, worktree asserted clean at `40b0d6a`.
- **The builder's, quoted as theirs:** 35 tests; three mutations dead; Yoga 174 files / 3,920 passed, typecheck + build, rc=0; `check:silent` the accepted 9, none in the changed files.

**Their first real-data runs, recorded:** 23 Sep, eight rooms, mid-clinic — 1–7 encounters per room, median 5.5–12 min, longest 12, unjudged 71–90% of which 91–96% is `no_transcript_evidence`. Exactly one trigger tripped across all eight, and the partial-day flag marked it provisional. No firm stop anywhere.

**Verdict: PASS-WITH-ONE-FIX.** The rule closes a real hole that real data found, and the honest/firm split is intact. The widening to all five is the one thing to change, because its justification holds only at total blindness while the threshold sits at half — and the day-shape that motivated the fix is the one that puts a real long encounter in the sighted remainder.
