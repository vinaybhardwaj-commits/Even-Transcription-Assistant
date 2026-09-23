# ETA — E-6 fusion, supersedes fix. REFUTER RE-CHECK. 23 Sep 2026

`vinay/e6-fusion` **@ `4129768`** (builder lx), one commit on `31fb712` — not an amend, because I had reviewed `31fb712`. Own detached worktree `/tmp/refute-e6b`, HEAD asserted, clean after every run. Baseline verified green pristine: **102/102**.

## PASS — the finding is closed, and my own recommended fix was wrong

**5 mutations, 5 killed, 0 void.**

| mutation | result |
|---|---|
| **Q1** the v1 runner back to the unscoped read — the exact inverse of my finding | **killed, 8 tests** |
| **Q2** no fallback at all (always rethrow) | **killed** |
| **Q3** fallback on **any** error — a swallowing fallback | **killed** |
| **Q4** the detector loosened to a bare `/source/i` | **killed** |
| **Q5** the `42703` code check removed | **killed** |

Q3 is the one I most wanted to see die: a fallback that swallows every error is the natural way this gets "simplified" later, and lx's rethrow test uses a `08006` in which **only the scoped read fails**, so a swallowing fallback shows up rather than being masked by a fallback that happens to also fail. Q4 pins the precision I would otherwise have had to argue: the detector matches `source` and `table.source` but not `match_source` or `sources`.

### My recommended fix would have broken the live v1 runner

I wrote that this was "one line and one test": pass `"acoustic"` to the v1 read. **That was wrong, and lx caught it.** Verified myself rather than taken on their word — `readLatestRun`'s source-scoped branch names the column in both clauses:

```
lib/encounter-hypotheses.ts
  SELECT … n_hypotheses, created_at, source,      ← the scoped branch only
   WHERE room_day_id = ${roomDayId}
     AND source = ${source}
```

So before 0118 is applied, my fix yields `column "source" does not exist` (42703) from the **live** v1 shadow runner. And the window is real rather than theoretical: PLAN-v3 §0 states deploys do **not** run migrations — they apply only on an authenticated `POST /api/run-migrations`, which Fable runs separately. Between merging the code and applying 0118, my one-liner would have taken down the path I was trying to protect.

**That is a worse defect than the one I found.** My finding was a false provenance field in an append-only store, with nothing lost; my fix would have been an outage. Worth stating in those terms rather than as a footnote, because the asymmetry is the lesson: I reasoned about the correctness of the read and not about the order in which code and schema arrive.

`readLatestAcousticRun` is the right shape, and its reasoning is exact rather than defensive: before 0118 the column does not exist, and **neither can a fused run**, because a fused write needs that column — so the unscoped read *is* the acoustic read in that window. That is a proof, not a guess, and the comment says so.

One thing I checked that lx did not claim: the broad `code === "42703"` arm cannot mask an unrelated missing column, because the unscoped fallback query selects the same columns minus `source`, so any other missing column fails identically in both branches. Safe by construction, not by luck.

### Their item 7 — the `ProbeJudgement` shape

lx asks whether I require the discriminated union. **I do not, and it is not mine to require** — I report, Fable and V rule. My position for the record: not a merge blocker, since `shadow-v2.ts:172` sets `judged: kind !== undefined` and the sole producer cannot reach the state. Worth doing when a second producer appears (an E-7 replay, a harness), because `phaseOf`'s `default:` reads a missing kind as `consult` — the clinical answer — and making the state unrepresentable deletes the category rather than guarding it, as `engineProvenance` did on the diarize branch.

### Their gate, quoted as theirs

Run `20260923T104501Z-4129768-77139` on the **E2E box**, rc=0: typecheck ok, typecheck:tests ok, 188 files, 4161 passed, 1 skipped (the pre-existing repeat-runs skip), build compiled. The postgres:16 proof of 0118 now also covers the fallback before 0118 and the fused-run skip after it — 2 tests, 15.4 s, **run on the E2E box rather than the Mini**, which is the correct host under Fable's RULINGS-23-SEP-1540 #6. I did not re-run it; it is theirs.

### A harness failure of mine, disclosed

My first attempt at this mutation set printed **nothing at all**, baseline included, and I nearly read the blank rows as results. Cause: **zsh does not word-split unquoted variables**, so `npx vitest run $S` with three paths in `S` passed them as a *single* argument; vitest matched no file, ran zero tests, and printed no `Tests` line, which an empty grep renders as silence. Re-run with explicit paths, the baseline is 102/102 and every mutation reports.

This is the third harness failure today in one family — a `| tail` turning a missing runner into exit 0 (split-speaker's), a sed that matched nothing, and now a runner that ran nothing. **A run that did not happen must never be able to look like a run that passed.** My rule is now: a mutation row without an explicit `Tests <n>` line is an ERROR, never a survivor, and the pristine baseline must print one before any survivor is believed.

## Verdict: PASS
The fix is better than the one I proposed, for a reason I had missed and lx had not: deploy order. Five mutations including the inverse of my own finding all die, the fallback cannot swallow and cannot loosen, and the transition window is handled by a proof rather than a guard.
