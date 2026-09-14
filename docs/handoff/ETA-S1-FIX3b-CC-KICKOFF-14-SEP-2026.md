# ETA — S1 FIX3b — CC KICKOFF (re-issue; FIX3 was correctly halted)
**14 September 2026 · Session: `scribe` · Same branch `vinay/s1-auto-drain`, NEW COMMIT on `8ac9e24`.**

Read `docs/handoff/ETA-S1-ROUND4-RULINGS-14-SEP-2026.md` first. Your C9 stop is answered there as option
(b); your C8 and C10 findings are accepted as you stated them. Everything below is settled.

## 0. Machine, repo, branch, push policy

Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · branch `vinay/s1-auto-drain` at
`8ac9e24`. **Commit on the branch. DO NOT push. DO NOT touch `main`. Never amend `8ac9e24`.**

## 1. Pre-flight
```
git rev-parse --abbrev-ref HEAD    # vinay/s1-auto-drain
git rev-parse HEAD                 # 8ac9e24
git status --porcelain | grep -v '^??'   # empty
```

## 2. The changes

**C8 — the selector filters on Transcript, as you proposed.** A SQL join on `room.transcript_enabled` —
the same column `lib/room-switches` reads — applied **before** the LIMIT, so a Transcript-off window can
never take the slot. `drainRoomWindow` keeps its own `isTranscriptEnabled` check on entry; that stays the
authority. Report the SQL verbatim and say plainly that the selector reads the column directly.

**C9 — RULED (b): write the window row IF AND ONLY IF it would change.** Compare the state derived from
the current segment rows against the state already stored; write only on a difference. Keep the existing
guard's intent — do not remove `c2-e2e-runner.test.ts:1351-1359` (IDEMPOTENT) and **do not edit that
file**. A re-run reproducing the same result writes nothing; a re-run whose rows say something different
rewrites. **The same rule covers `fail()`**: on a settled `ok` window a partway failure changes the derived
state, so it writes. No special case.

**C10 — as you scoped it.** `fail()` at `:96` and `:111` run before this attempt's delete, so any rows
present belong to an earlier attempt — those record **null**, never counts. `:139`–`:163` may use counts
derived from the rows. The catch paths at `:221` and `:232` record null.

**C11 — H1, the id guard.** Two parts:
1. The guard runs against the **staged** tree, so a bus document committed after the gate cannot escape it.
   A guard that exempts untracked files must run at the moment staging decides what is tracked.
2. In the committed `ETA-S1-FIX2-REPORT-14-SEP-2026.md`, replace the id-shaped placeholder on line ~278
   with `doc_<id>`, which cannot match the banned shape. Locate it by running the guard; change nothing
   else in that report. **Never reproduce the banned shape in your own report or commit message** — refer
   to it by description, as this kickoff does.

**C12 — H3, the harness.** `tests/support/s1-pg.ts`: a query whose first non-whitespace character makes it
unrecognisable to the harness — a leading comment or `(` — must **throw** with a named error, never return
zero rows. Silently returning no rows is a wrong answer wearing a success shape. Add a comment at the top
of the file naming the two divergences we are **not** fixing: `bigint` returns as a number where Neon
returns a string, and row order is not guaranteed.

**C13 — H5.** The zero-scored retry tests each seed their own state and pass in any order. Prove it by
running that file with the order reversed and reporting the result.

**C14 — H4.** The "admin cookie succeeds" test must mint a real token through the repo's own signing path
and let `verifyAdminJwt` verify it, instead of mocking both the cookie read and the JWT check. The test may
set whatever env var the signing path needs. Keep the existing negative cases.

## 3. Tests

Every change above carries a test, each refusal paired with a control that proves the refusal is not
universal (rule 7). For C9 specifically: a re-run reproducing the same result leaves `scored_at` untouched
AND a re-run whose rows differ rewrites the window — both asserted in the same file.
Continue the mutation check **including env reads**; report the count.

## 4. File contract

**Edit:** `lib/stt/auto-drain.ts` · `lib/emotion/store.ts` · `lib/jobs/kinds/emotion-window.ts` ·
`tests/support/s1-pg.ts` · the S1 test files · the id-guard script (name it in your report) ·
`docs/handoff/ETA-S1-FIX2-REPORT-14-SEP-2026.md` (the one placeholder only).
**UNTOUCHED — and this one is load-bearing:** `tests/.../c2-e2e-runner.test.ts` · `lib/stt/room-drain.ts` ·
`lib/bench-window.ts` · `lib/stt/fanout.ts` · `lib/emotion/enqueue.ts` · `lib/emotion/client.ts` ·
`lib/mcp/**` · `lib/stt/adapters/**` · `lib/jobs/{runner,store,submit}.ts` · `db/migrations/**` (0091 and
0092 stand as written) · `vercel.json` · `apps/**` · `package.json`.

## 5. Gate and report

`npx tsc --noEmit` and the full suite, both green, quoted. **Stage the bus documents BEFORE you run the
gate** (that is C11's whole point), then commit. Swift out of scope.
Report to `docs/handoff/ETA-S1-FIX3b-REPORT-14-SEP-2026.md`: new sha · gate output · `git diff --stat
8ac9e24..HEAD` · every inferred SQL verbatim · the C13 reversed-order result · mutation-check count ·
flags. Commit this kickoff, the round-4 rulings, your FIX3 stop report, the FIX2 Refuter verdict and your
own FIX3b report by exact filename; **do not `git add .`**. Env var NAMES only.


---

## ADDENDUM — 14 Sep ~10:15, answering your "Guard vs docs" question

You were right to ask, and the answer is partly an apology: **I wrote the banned shape into three of my own
documents**, including the very ruling that says a placeholder must not wear the shape of the thing it
stands for. A mechanical token swap would have mangled that sentence, so **I have already corrected all
three on disk myself** — `ETA-S1-ROUND4-RULINGS-14-SEP-2026.md`, this kickoff, and
`ETA-S1-FIX2-REFUTER-VERDICT-14-SEP-2026.md` (that last one with a bracketed editor's note, since it is the
Refuter's record, not mine).

**Re-read those three. They now contain zero shape-matches.** Your contract does not change on their
account, and no contract extension is needed for them.

### But your question uncovered something neither of us was looking for

`docs/handoff/scratch/C2-REFUTER-NOTES.md` is **TRACKED** — committed back in the C2 round — and carries
**two** id-shaped tokens. It is not on this round's list and you would have hit a fourth stop on it.

This is the real lesson of C11: **changing the guard's scope from "untracked is exempt" to "the staged tree"
does not only close the escape hatch, it retroactively applies the rule to everything already committed.**

I inspected both tokens without printing them. **Neither is one of the seven enrolled clinician ids.** Both
sit in probe fixtures — one in a segment-match note, one inside a `"clinician_id"` JSON example. But I
cannot confirm from here that they are absent from the whole `clinician` table, and the repo is public.

**Ruling: do not allowlist them. Replace them.** An allowlist entry nobody can verify is worse in a public
repo than a two-token edit to a scratch note.

### C15 — contract extension, additions only

1. In `docs/handoff/scratch/C2-REFUTER-NOTES.md`, replace both id-shaped tokens with ids **already on**
   `SYNTHETIC_CLINICIAN_IDS` — prefer an existing `doc_fakeNNNN` entry. If no suitable entry exists, add
   the minimum number of new `doc_fakeNNNN` entries to that allowlist with a dated comment naming this
   round. **Change nothing else in that file**; it is another round's record.
2. Added to the **edit list**: `docs/handoff/scratch/C2-REFUTER-NOTES.md` and
   `tests/unit/no-real-clinician-ids.test.ts` (allowlist entries only — do not touch
   `CLINICIAN_ID_SHAPE`, `unlistedIds`, or the three existing test cases).
3. After C11 lands, **stage everything this round commits, then run the guard over that staged set**, and
   report its offender list. Expected: empty.
4. **Never reproduce the shape in your report, your commit message, or any new document.** The guard's own
   line 68 already states the rule — *name the file and the count, never the id* — and I failed to follow
   it. Refer to it by description, as this addendum does.

Everything else in this kickoff stands unchanged. Proceed.
