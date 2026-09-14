# ETA — S1 REFUTER VERDICT
**14 Sep 2026 · Refuter (Opus) · pinned `d852127` · read-only**

## Overall: FAIL
Every contract item passes and the gate reproduces. The build fails on N1 and N2, which come from the spec, not from a Builder deviation.

## Gate (my run)
Shallow clone at `d852127f87…`. No lockfile, so I linked the main clone's `node_modules` (`package.json` identical).
- `tsc exit 0`
- ` Test Files  105 passed (105)` · `      Tests  2535 passed (2535)` · `npm test exit 0`
- ` ✓ tests/unit/s1-auto-drain.test.ts (24 tests) 6566ms` (Postgres ran)

## Contract
- **Files.** `git diff --name-status 14a4f38 d852127`: exactly six files, none from the untouched list, no migration. PASS
- **Exports** at `auto-drain.ts:49,52,70`. **Route auth** helpers `diff`-identical to `diarize-windows`. PASS
- **`finish()` only**, one hunk at `emotion-window.ts:177-189`. **Cron** `*/5`. PASS
- **`parseFlag`** at `:77`; **`SYSTEM_ACTOR`/`cron`** at `:103`. **Selector** at `:86-97`. PASS
- **Cap.** `:82` keeps the limit in [1, `AUTO_DRAIN_BATCH_LIMIT`]. `clampedIntEnv` (`:43-45`) turns garbage into the default and 0 or negatives into 1; an enormous value becomes Infinity, then 10. The route's `?limit` only lowers it. PASS
- **Live-job check.** The key matches `room-drain.ts:505`, and the statuses match 0082. If either were wrong, the claim (`room-drain.ts:485`) still removes the window from `closed`: a wasted slot, never a double spend. PASS
- **Emotion `planned = 0`** at `:116`, outside the diff. PASS

## New findings
**N1 — A retried zero-scored window records `ok` with no scores.** S1 marks the window `failed`, so the scan retries it on the same diarize run (`enqueue.ts:61-63`). On retry, `writeScoredOrFailed` collides with attempt 1's `failed` rows and does nothing (`store.ts:41`). `finish()` counts from memory and records `ok`, while every segment row still says `failed`. That is rule 9. Before S1 these windows were never retried.

**N2 — A named refusal holds the one slot.** `flag_off`, `too_long` and `join_failed` return before the claim (`room-drain.ts:457,480,481`). The window stays `closed` and is picked again every tick. A recording room with Transcript off starves the others. In a 6-room, 9 h model, one such room cut the other rooms' drained windows from 144 to 69–82 of 180.

**N3 — The throughput premise is false.** "288/day > 216/day" compares daily totals, but six rooms produce 24 windows an hour and the cron drains 12. With every room on, the model ages 72 of 216 windows out undrained. This is flagged for a ruling, not reopened.

**N4 — Tests that pass against broken code.** Hard-coding `6::int` as the bound max age left 24/24 green. So did misspelling `"AUTO_DRAIN_MAX_AGE_HOURS"`. By reading only, not run:
- The POST admin-cookie door is never exercised positively (`verifyAdminJwt` always throws, test `:38`).
- `seedScrambled` uses raw minutes (rule 10).
- `realSql` inlines literals, so neon's bind-parameter typing goes untested.

## Not checked
- Live data.
- Whether a Transcript-off room records today.
- Whether emotion is on in production.
- `npm run build`, `check:silent`, Swift.
