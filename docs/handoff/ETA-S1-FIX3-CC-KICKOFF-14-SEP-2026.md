# ETA — S1 FIX3 — CC KICKOFF
**14 September 2026 · Session: `scribe` · Same branch `vinay/s1-auto-drain`, NEW COMMIT on `8ac9e24`.**

Read `docs/handoff/ETA-S1-ROUND3-RULINGS-AND-M2-VERDICT-14-SEP-2026.md` first. Three changes, all ruled.
G4, G5, G6, G7, G8 and G10 are accepted as built — do not touch them.

## 0. Machine, repo, branch, push policy

Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · branch `vinay/s1-auto-drain` at
`8ac9e24`. **Commit on the branch. DO NOT push. DO NOT touch `main`. Never amend `8ac9e24`.**

## 1. Pre-flight
```
git rev-parse --abbrev-ref HEAD    # vinay/s1-auto-drain
git rev-parse HEAD                 # 8ac9e24
git status --porcelain | grep -v '^??'   # empty
```

## 2. The three changes

**C8 — G1: the selector filters on the room's Transcript switch.** Windows whose room has Transcript off
are never selected, so they never get a legacy `queued` row and never leave the operator's "N waiting"
count. `drainRoomWindow` keeps its own `isTranscriptEnabled` check on entry — that one stays the
authority and must not be removed; the selector's filter is an optimisation on top. Use the same source
of truth the drain uses (`lib/room-switches`), not a copied SQL predicate, if the shape allows it inside
the file contract; if it does not, say so in the report rather than duplicating the rule silently.

**C9 — G2: no path leaves the window row stale.** Every attempt that writes an emotion window's segment
rows must also write the window row, derived from those same rows — including an attempt on a window that
is already settled (`ok` or `failed`). Today the automatic path does this (C5) and a manual re-submit does
not. Find where the window-row write is skipped or conflict-ignored for a settled window and make it
unconditional. The `planned = 0` ⇒ `no_segments` path stays as it is.

**C10 — G3: `fail()` stops counting from memory.** Its counts come from the persisted rows, exactly as
`finish()` now does. If a failure path cannot read the rows — because the failure is that the write
itself failed — record **null** for the counts rather than the remembered numbers. A number that cannot
be trusted is worse than no number.

## 3. Tests

- **C8:** a window in a Transcript-off room is not selected, paired with an otherwise identical window in
  a Transcript-on room that is (rule 7). Prove no legacy `queued` row is created for the excluded one.
- **C9:** a manual re-run of a settled `ok` window that scores nothing leaves the window row `failed` and
  the segment rows `failed` — never `ok` over `failed` rows. Paired with a re-run that scores
  successfully, which leaves both `ok`.
- **C10:** a `fail()` path records either row-derived counts or nulls — never a remembered number that
  disagrees with the rows. Construct the disagreement explicitly.
- Continue the mutation check, **including env reads**, and report the count as you did on FIX2.
- Keep using the real bind-parameter harness (`tests/support/s1-pg.ts`).

## 4. File contract

**Edit:** `lib/stt/auto-drain.ts` · `lib/emotion/store.ts` · `lib/jobs/kinds/emotion-window.ts` ·
the S1 test files · `tests/support/s1-pg.ts` if a helper is genuinely needed.
**Create:** a new test file if you need one. **No migration this round** — 0091 and 0092 stand as written.
**Untouched:** `lib/stt/room-drain.ts` · `lib/bench-window.ts` · `lib/stt/fanout.ts` ·
`lib/emotion/enqueue.ts` · `lib/emotion/client.ts` · `lib/mcp/**` · `lib/stt/adapters/**` ·
`lib/jobs/runner.ts` · `lib/jobs/store.ts` · `lib/jobs/submit.ts` · `app/api/admin/drain-windows/route.ts`
· `db/migrations/**` · `vercel.json` · `apps/**` · `package.json`.

## 5. Gate and report

`npx tsc --noEmit` and the full suite, both green, quoted. Swift out of scope.
Report to `docs/handoff/ETA-S1-FIX3-REPORT-14-SEP-2026.md`: new sha · gate output ·
`git diff --stat 8ac9e24..HEAD` · every inferred SQL string verbatim · mutation-check count including env
mutations · flags. Commit this kickoff, the round-3 rulings, the M2 report and your own FIX3 report by
exact filename; **do not `git add .`**. Env var NAMES only.
