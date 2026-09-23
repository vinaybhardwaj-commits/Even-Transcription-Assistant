# ETA — scribe_room_levels, IST range and caps. REFUTER VERDICT. 23 Sep 2026

`vinay/levels-mcp-read` **@ `69bc7fe`** (builder split-speaker), one commit on `5ee078c`: `lib/mcp/tools/levels.ts` and its test. Own detached worktree `/tmp/refute-lvl69`; nothing pushed, no database touched. Mini kept out — every run on the Yoga fast runner. `c23f056` (deployed) is upstream of it.

## PASS-WITH-FIXES — the caps and the range are solid; one bound format does not honour the module's own rule

**Mutations: 9 run, 0 runner errors, 8 killed.** Everything the order asked for is pinned: the 24 h cap, the cap being a **ceiling not a fencepost** (exactly 24 h allowed), empty/inverted-range refusal, `to` being exclusive, `sample_count` covering the returned buckets rather than the whole day, truncation being reported, a bare date refused as a bound, and a range crossing midnight reading **both** IST days. That is a strong suite for a first pass.

Reusing `readRoomLevelDay` per day rather than writing a second aggregator is the right structural choice, and the header says why — one query shape, shared with the admin card, so the two can never drift.

### FINDING — a naive ISO bound is read in the server's timezone, not IST

`parseIstBound` handles two formats. The clock branch is exact: `HH:MM[:SS]` is composed onto `day` with a literal `+05:30`, and IST has no DST so that is right. The ISO branch is not:

```
lib/mcp/tools/levels.ts
  if (!/[T ]/.test(value)) return null;   // a bare date is a day, not a bound
  const t = Date.parse(value.trim());     // ← no offset required, and none supplied
```

A timestamp without an offset — `2026-09-23T10:00:00` — is parsed by `Date.parse` in the **runtime's local zone**. Measured, not argued:

```
this Mini (Asia/Calcutta):  2026-09-23T10:00:00  ->  2026-09-23T04:30:00Z   matches IST intent
a UTC runtime (Vercel):     2026-09-23T10:00:00  ->  2026-09-23T10:00:00Z   5.5 hours adrift
```

**The bug is invisible exactly where it would be caught.** Development and every local test run on this machine sit in Asia/Kolkata, where a naive stamp happens to mean what the caller intends; production runs in UTC, where it does not. A watcher asking for 10:00–11:00 gets 04:30–05:30 IST — a plausible-looking window of the wrong hour, with no error.

This is also the one place the module departs from the principle it states twice in its own header — *"a malformed bound is refused, never quietly taken as midnight"*, *"both refusing rather than guessing"*. The clock branch refuses. The ISO branch guesses, using a zone the header never mentions.

**My L1 probe confirms the behaviour is unspecified rather than chosen:** changing the ISO branch to apply `+05:30` when no offset is present leaves the whole suite green. So no test says what a naive stamp means — and, usefully, the fix passes unchanged.

**Fix, consistent with the module's own rule:** require an explicit offset or `Z` in the ISO branch and return `null` otherwise, so an ambiguous bound is refused like every other malformed one. Applying `+05:30` when absent is the friendlier alternative and my probe shows it is safe, but refusing matches what the header promises and cannot surprise a caller who really did mean UTC.

### Two smaller notes

- **The `to`-omitted default is inclusive-shaped.** With `from` given and `to` absent, `toMs` becomes `23:59:59.999` IST rather than the next midnight, while `to` is documented and tested as exclusive. No bucket is lost — 15 s buckets make the last one 23:59:45 — so this is a consistency wrinkle, not a defect. `T00:00:00` of the next day would make the default say the same thing as the parameter.
- **`istDaysSpanned` can read one wasted day.** For a range ending exactly at IST midnight, `istDate(Math.min(t, toMs))` yields the following day, which is queried and then filtered away entirely because `to` is exclusive. One redundant query on an exact-midnight boundary; harmless, and worth a `<` rather than `<=` in the loop's last step if anyone is tidying.

### The NOT-DONE disclosure is correct, and correctly reasoned

The order also asked for the tool to be placed in the MCP selector. The builder did not do it, and the reason is right: `mcp-surface-aliases.test.ts` checks grouped members against **captured live `tools/list` answers** from the deployed door, `scribe_room_levels` post-dates those captures, and the scopes fixture is not derivable from a `tools/list` answer. Grouping it now would mean editing evidence of what production actually served, or relaxing a guard against scope drift. **Declining to alter captured evidence to make a guard pass is the correct call**, and flagging it rather than doing it quietly is what makes it reviewable.

## Jev (V's standing rule) — after my read and mutations; neutral context

Task, diff and neutral context, including that the runtime is UTC and the dev machine is Asia/Kolkata; **none of my findings**. Scores **4.3–6.4**, one `medium`.

- **testQuality 4.3, `medium`, its top priority** ("important changed behaviour lacks meaningful regression coverage") → **partly REJECTED, partly CONFIRMED.** 8 of 9 mutations died, so the *caps and range* are well covered; what is uncovered is precisely the one thing L1 found — the ISO branch's timezone. Jev's severity is too high for the file as a whole and exactly right for the gap that exists.
- **consistency 5.4** ("related parts of the change follow inconsistent conventions") → **CONFIRMED, and it is the sharpest statement of the finding**: two accepted bound formats, one zone-exact and one zone-dependent, in the same function.
- **correctness 5.3** ("an important edge case insufficiently handled") → **CONFIRMED in substance.**
- **compatibility 5.2** ("appears to break an existing contract") → **REJECTED**: with neither bound given the tool reads the whole day exactly as before, and the added response fields are additive.
- **performance 6.4** → **minor, and it is the wasted-day note above.**

## Gate

- **Mine:** 9 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `69bc7fe` afterwards.
- **The builder's, quoted as theirs:** 23 tests in `mcp-room-levels`; seven mutations of their own verified to fail.

**Integrity note on my own run.** My first launch went against a **stale worktree at `6dd1b79`**, left over from the level-log-ops review — `git worktree add` failed with "already exists" and the harness ran anyway. I caught it by printing the worktree's HEAD before trusting the output, killed the run, confirmed no mutation had been left applied, and re-ran against a verified checkout. The numbers above are from the verified run only. Recording it because a wrong-sha run produces a table that looks ordinary.

**Verdict: PASS-WITH-FIXES.** The range, both caps and the truncation contract are correct and well pinned, and the aggregator was reused rather than duplicated. One bound format needs to obey the rule the rest of the file follows: refuse what is ambiguous instead of resolving it in whatever zone the server happens to run in.
