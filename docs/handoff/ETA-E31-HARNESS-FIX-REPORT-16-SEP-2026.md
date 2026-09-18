# ETA-E31 — test harness fix · Builder report · 16 Sep 2026 · worktree `-e31c`

`tests/support/pg-harness.ts`. Infrastructure; it unblocks every remaining cure in the atomicity programme.

## 1. Commit

`b29d9af` on `vinay/e31-harness`, parent `64ce357`. Not pushed. `main` untouched. Tree clean, no containers
left. No production code, no migration. `-e31a` and `-e31b` were not entered.

## 2. What the wrapping is actually for

Read before deciding anything, as the order asked. `psql -qAt` prints rows as text lines and has no result
protocol on stdin; the repo has no raw-Postgres driver. So `makeSql` wraps every row-returning statement to
make psql print **one line of compact JSON**:

```
… __q AS (<the statement>) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q;
```

That is the whole purpose — turning line-oriented output into rows the tagged template can return.
`jsonb_agg` and not `json_agg` because json_agg pretty-prints with newlines, and a line-oriented reader would
not get back the JSON that went in.

**It has two forms, and one of them is illegal for some statements.** A statement that is itself a top-level
`WITH` keeps its own WITH at the top level and gains `__q` as one more CTE. Anything else is nested whole
inside a new `WITH __q AS (…)`. **Postgres refuses the nested form when the body contains a data-modifying
CTE** — *"WITH clause containing a data-modifying statement must be at the top level"* — so choosing the
branch wrongly is a hard failure, not a slow path.

**The wrapping serves a purpose for every statement, so it is kept for all of them.** Nothing was exempted.
The defect was never the wrapping; it was the chooser picking the illegal branch because it could not read
SQL. Only the chooser changed.

## 3. The defect, and the one idea that fixes it

The chooser tracked single-quoted strings and knew nothing about comments. `-- the row's own note` put it
inside a string literal **for the rest of the statement**; it then found no top-level SELECT, took the nested
branch, and Postgres refused the result.

`maskNonCode` blanks every line comment, block comment and string literal into spaces of the **same length**,
so offsets into the mask are offsets into the original. The paren counter, the `SELECT` finder, the statement
head, the `returning` probe and the terminator check all read the mask. Block comments are counted as
**nesting**, which is Postgres's rule and not C's.

## 4. Five shapes were broken — the four ordered, plus two found on the way

| shape | what happened before |
|---|---|
| apostrophe in a `--` comment | nested a data-modifying CTE → refused outright |
| block comment with an apostrophe or an unbalanced paren | the same |
| semicolon inside a comment | `CREATE TABLE t (…) -- make it; done` ends, as text, with no semicolon, so a `;` was appended **inside** the trailing comment. psql, handed a statement it never saw terminated, **silently ran nothing at all** |
| data-modifying CTE executing, effects visible | blocked by all of the above |
| *(found)* comment **before** the `WITH` | the head was read off the raw text, so it did not look like a WITH and was nested |
| *(found)* trailing `--` after the final SELECT | the appended `) SELECT jsonb_agg(…)` landed on that comment's line and was commented out, leaving psql an unbalanced statement |

## 5. Test results — 9 cases, all green, all against a real postgres:16

Each case **executes the statement the chooser produces** and reads the effect back, because a wrapping that
parses is not the same as a wrapping that does what the caller asked.

```
✓ DEFECT 1 — apostrophe in a `--` comment: top level, runs, and n went 0 → 1
✓ DEFECT 2 — semicolon inside a comment: the table exists afterwards, so it actually ran
✓ DEFECT 3 — nested block comment holding an apostrophe AND an unbalanced paren
✓ DEFECT 4 — a data-modifying CTE whose last line is a comment: the closing paren survives
✓ a comment BEFORE the WITH does not hide it
✓ a REAL terminator behind a trailing comment (`SELECT 1; -- note`) is seen and dropped
✓ what already worked still works: a plain SELECT is still nested; `'it''s fine'` is still a string
✓ a statement mentioning `returning` only in a comment returns nothing, and still runs
✓ REQUIRED PROOF — ran against Docker, or was skipped deliberately
```

## 6. Mutation check — each fix reverted individually

**7 caught of 7. No survivors. No equivalents.** Each revert is caught by **its own** case, not by
"something failed":

| revert | the case that goes RED |
|---|---|
| F1 line-comment masking | DEFECT 1 |
| F2 block-comment masking | DEFECT 3 |
| F3 statement head off the raw text | the leading-comment case |
| F4 the newline before the closing paren | DEFECT 4 |
| F5 terminator off the raw text | DEFECT 2 |
| F6 `returning` off the raw text | the comment-only-mention case |
| F7 trailing semicolon off the raw text | the real-terminator case |

**F7 survived the first pass and is worth the record.** I checked whether it was a true equivalent rather
than assuming it: it is not. `SELECT 1 AS a; -- a note after the terminator` separates the two — searching
the raw text finds no terminator, keeps the `;`, and the wrapping becomes
`WITH __q AS (SELECT 1 AS a; -- note …`, a statement psql sees terminated in the middle of a CTE. It got the
case it was missing rather than an excuse.

Rule 22 observed: each revert an exact string matched once, sha256 before and after, every file verified
restored, no container left.

## 7. Gate

```
npm run typecheck    tsc --noEmit                       exit 0
npm test             Test Files 115 passed (115)
                     Tests     2778 passed (2778)       exit 0
npm run build        next build                         exit 0
npm run check:silent Found 9 silent-failure handler(s)  exit 0   — the accepted 9, unchanged
```

The baseline at `64ce357` was **measured, not assumed**: 114 files / 2769 tests. Plus the 9 here = 2778.
Docker up, no exclusions. Per R30/R27 no Swift ran and none is cited.

## 8. Anything touched beyond the harness

**One structural change, additive:** the pure chooser is extracted and exported as `statementForPsql`.
`makeSql` is its only caller and behaves exactly as before for every statement that already worked. It is
exported because all five defects live in the wrapping, and a test that only ran a clean statement through a
database would not have found one of them. **Nothing about what the harness asserts, or how any suite uses
it, changed.**

**One file imported, none modified:** the new test imports `pgContainer` from `tests/support/s1-pg.ts` for
container lifecycle. It does **not** use `startPg()`/`PG_NAME`, because vitest runs files in parallel and
`startPg()` opens with `docker rm -f` — borrowing the c2-e2e suite's container would destroy that suite's
database mid-run, which is exactly the hazard `tests/support/container-name.ts` documents. `s1-pg.ts` was
read and imported, never edited.

**Nothing else.** No production code, no other support file, no migration.

## 9. Named rather than left to be discovered

Dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`) are **not** masked. Nothing reaches this function with one:
`lit()` never emits a dollar quote, and the migrations and `DO` blocks that use them go through `exec()`,
which parses nothing. A comment in the file says so and says where to teach it if that changes. Adding
untested scanner surface would have been a redesign, which this round is not.

## 10. Subagents

None.
