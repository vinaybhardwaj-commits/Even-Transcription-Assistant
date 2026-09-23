# ETA — low_signal, the quiet-mic confabulation marker. REFUTER VERDICT. 23 Sep 2026

`vinay/low-signal-marker` **@ `c8c05dc`** (builder fleet), one commit on `8d7618f`: `lib/bench-levels.ts`, the `turnsAnswer` attachment in `lib/mcp/tools/bench.ts`, and two test files. Own detached worktree `/tmp/refute-ls`, HEAD asserted. Nothing pushed, no route invoked. Mutations ran locally (558 ms baseline, 19 tests); production reads were **read-only and returned counts and percentiles only** — no transcript text, no room labels.

## PASS-WITH-FIXES — the design is careful and the null discipline is right. The floor is wrong by about 2×, in the direction that makes the marker fire on three-quarters of real recording

### What is right, and pinned

- **`low_signal` is `boolean | null`, never coerced to `false`.** The comment says why — *"null = no level-log samples over this span, so low_signal cannot be judged either way — never coerced to false, which would read as 'checked, and it was fine'"*. **X2 dies.** That is the same discipline as the encounter clock's `unjudged`, and it is the difference between "no evidence" and "evidence of nothing".
- **`percentile` returns `null` on empty input, never 0** — *"never 0, which would read as a real (very quiet) measurement rather than no data at all"*. **X5 dies.**
- **The floor's value is pinned** (X1) and the comparison is strictly below (X3).
- **Read-side only**, as the header claims: nothing here alters or drops a transcript, a turn or a cue.

### FINDING — the floor marks 74% of actively-recording production samples

`QUIET_FLOOR_RMS = 0.016` is documented as provisional, with the intended derivation (`deriveQuietFloor`: the Nth percentile of `peak` over `tape_advancing = true` spans) unrun because *"this sandbox has no live database"*. **I ran it**, read-only:

| `bench_level_sample`, `tape_advancing = true`, n = 51,074 | |
|---|---|
| p01 | 0.0077 |
| p05 | **0.0080** |
| p25 | 0.0091 |
| **p50 (median)** | **0.0107** |
| p90 | 0.1362 |

**The shipped floor of 0.016 sits *above* the median.** It marks **74.1%** of actively-recording samples as `low_signal`. Across the whole table it is 53.6% of 70,593 samples, and **0** rows fall below `SILENCE_RMS`, so nothing here is dead-mic territory — this is ordinary recording being flagged.

A confabulation marker that fires on three-quarters of real audio is not a marker; it is a constant. Its value to a reader is that it distinguishes cases, and at 0.016 it barely does.

**The reference datum was right; the doubling is what broke it.** The comment derives 0.016 as 2× a 25 Aug median of 0.0079 from `bench_chunk.peak_level`. That reference is almost exactly today's **p05 (0.0080)** on the real metric — an excellent estimate of the quiet end. Using it directly would mark **3.6%** of samples, which is a plausible marker rate. Doubling a median guarantees the result sits above the median, which is what a floor must not do.

**Fix, with the number supplied:** set `QUIET_FLOOR_RMS` to the p05 of `peak` over `tape_advancing = true`, currently **0.0080** (p01 gives 0.0077 and marks 0.4%). Note the distribution is extremely tight at the bottom — p01 0.0077 to p25 0.0091 is a 1.2× spread — then explodes to p90 0.1362, so the choice of percentile between 1 and 5 barely moves the floor but moves the marked share a lot. Worth stating which share is wanted and picking the percentile to match, rather than the reverse.

### X4 survives, and it is LIVE rather than latent

Replacing `low_signal: peak < floor` with `(avg ?? peak) < floor` leaves the suite green. The module deliberately compares **peak** — *"did anyone speak up at all"; "a quiet room with one loud moment is not low_signal"* — and that choice is untested.

It would have been near-equivalent this morning. **It is not now: `avg` is populated on 72.3% of rows (51,309 of 70,927), where it was 0% earlier today.** `avg ≤ peak` by construction, so switching basis would flag strictly more spans, on most rows. The deliberate choice is load-bearing on three-quarters of the data and nothing protects it. One assertion.

### X6 survives — and it is the function meant to fix the floor

Removing the sort from `percentile` leaves the suite green, so it would return an arbitrary element. `percentile` has no production caller today — its only user is `deriveQuietFloor`, which has never been run. But that is precisely the function intended to derive the replacement constant, so it will be trusted exactly once, on a number nobody can eyeball. One assertion on an unsorted input.

## Cross-finding update — the encounter clock's level basis has silently flipped

Reported because it changes the reading of a finding Fable has already ruled on. My r5 verdict (`ETA-ENCOUNTER-CLOCK-R5-REFUTER-RECHECK-22-SEP-2026.md`) recorded *"Production reports no `avg` (0 of 2,160 rows)"*, and `gate.ts`'s comment still says the same. **That is now false: `avg` is populated on 72.3% of rows.**

Consequences, measured:

- The gate reads `avg` when every usable sample has one, else `peak`. On most probes the basis is now **`avg`**, not `peak`.
- That partly resolves the scale mismatch I reported — `DEFAULT_ROOM_ENERGY_FLOOR = 0.00398` is an RMS floor, and `avg` is an RMS quantity, so the comparison is now the right kind. It resolved by the data changing, not by anyone deciding.
- **Finding 2's conclusion still holds**: **0 of 51,381** rows with `avg` fall below 0.00398, so `active_frac` is still 1 and the pre-selector still never skips. But the margin has narrowed sharply — min `avg` is 0.0066 against a 0.00398 floor, **1.7×**, where I reported 11× on peak this morning.
- The dataset grew from 4,738 samples in one room-day to 70,593 across 8 rooms and 2 days while today's reviews were in flight.

Nothing to change on that branch; the comment in `gate.ts` is now inaccurate, and the "accepted as inert" ruling rests on a margin that is a sixth of what it was.

## Gate

- **Mine:** 6 mutations locally, 0 errors, worktree asserted clean at `c8c05dc`; production queries read-only, counts and percentiles only.
- **The builder's:** as recorded on the branch.

**Jev — not run.** The substance here is a numeric constant measured against production data, which a scalar score on the diff cannot see.

**Verdict: PASS-WITH-FIXES.** The null discipline, the read-side boundary and the honesty of the provisional comment are all right, and the marker is safe to ship in the sense that it changes nothing. But at 0.016 it says "low signal" about three-quarters of ordinary recording, so it would be read once, disbelieved, and ignored. The derivation the comment asks for is in this verdict: **0.0080**.
