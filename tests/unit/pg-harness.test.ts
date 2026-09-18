/**
 * tests/unit/pg-harness.test.ts — the harness's own tests.
 *
 * WHY THIS FILE EXISTS. `tests/support/pg-harness.ts` decides, for every statement a suite runs through it,
 * which of two wrappings psql is given. One of those wrappings is ILLEGAL for a statement containing a
 * data-modifying CTE — Postgres answers "WITH clause containing a data-modifying statement must be at the
 * top level" — so choosing wrongly is not a slow path, it is a hard failure. The chooser scanned for string
 * literals but knew nothing about comments, so an apostrophe in `-- the row's own note` put it inside a
 * string for the rest of the statement and it chose wrongly every time.
 *
 * That matters beyond one suite: every cure in the E31 atomicity programme is a data-modifying CTE with
 * comments in it, and every one of them runs through here.
 *
 * WHAT IS TESTED HOW. The chooser is a pure function, so the four defects are tested directly on its
 * output — a test that only ran a clean statement through a database would not have found any of them. Then
 * the statements it produces are EXECUTED against a real postgres:16 and their effects read back, because a
 * wrapping that parses is not the same as a wrapping that does what the caller asked.
 *
 * Its own container, never `PG_NAME`. vitest runs files in parallel and `startPg()` opens with `docker rm -f`,
 * so borrowing the c2-e2e suite's container would destroy that suite's database mid-run
 * (tests/support/container-name.ts: one suite at a time per worktree, per name).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { statementForPsql } from "../support/pg-harness";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-pg-harness");

describe("REQUIRED PROOF — the harness's own statements run against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/pg-harness.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`CREATE TABLE t (id int PRIMARY KEY, n int NOT NULL DEFAULT 0);
           INSERT INTO t (id, n) VALUES (1, 0), (2, 0);`);
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

/** Run exactly what the harness would hand psql, and give back what psql printed. */
const run = (text: string): string =>
  execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

/** The illegal wrapping: the whole body nested inside a NEW WITH. Postgres refuses it for a data-modifying CTE. */
const isNested = (text: string) => text.startsWith("WITH __q AS (");
const nOf = (id: number) =>
  Number(run(`SELECT n FROM t WHERE id = ${id};`));

describe.runIf(HAVE_DOCKER)("the chooser skips comments, and what it produces runs", () => {
  it("DEFECT 1 — an apostrophe in a `--` comment: the CTE stays at the top level, runs, and its effect is visible", () => {
    const q = `WITH moved AS (
  -- the row's own note, and the apostrophe in it used to swallow the rest of this statement
  UPDATE t SET n = n + 1 WHERE id = 1 RETURNING id
)
SELECT id FROM moved`;
    const plan = statementForPsql(q);
    expect(plan.kind).toBe("query");
    expect(isNested(plan.text), "a data-modifying CTE must NOT be nested in another WITH").toBe(false);

    const before = nOf(1);
    expect(JSON.parse(run(plan.text)), "the statement runs and returns its row").toEqual([{ id: 1 }]);
    expect(nOf(1), "AND THE UPDATE HAPPENED — a wrapping that parses is not the same as one that works").toBe(before + 1);
  }, 300_000);

  it("DEFECT 2 — a semicolon inside a comment no longer swallows the statement's terminator", () => {
    // `CREATE TABLE … -- make it; done` ends, AS TEXT, with no semicolon, so a `;` was appended INSIDE the
    // trailing comment. psql was handed a statement it never saw terminated and silently ran nothing.
    const q = `CREATE TABLE semi_check (id int)  -- make it; done`;
    const plan = statementForPsql(q);
    expect(plan.kind, "no rows to return, so this is the exec path").toBe("exec");
    expect(plan.text, "the terminator is carried out of the trailing comment by a newline").toMatch(/\n;\s*$/);

    run(plan.text);
    expect(run(`SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'semi_check';`),
      "the table exists, so the statement actually ran").toBe("1");
  }, 300_000);

  it("DEFECT 3 — a block comment, nested, with an apostrophe and an unbalanced paren inside it", () => {
    const q = `WITH moved AS (
  /* the row's note /* nested */ with an unbalanced ( inside */
  UPDATE t SET n = n + 1 WHERE id = 2 RETURNING id
)
SELECT id FROM moved`;
    const plan = statementForPsql(q);
    expect(isNested(plan.text), "the block comment must not decide where the parens are").toBe(false);

    const before = nOf(2);
    expect(JSON.parse(run(plan.text))).toEqual([{ id: 2 }]);
    expect(nOf(2)).toBe(before + 1);
  }, 300_000);

  it("DEFECT 4 — a data-modifying CTE whose LAST line is a comment: the closing paren is not commented out", () => {
    // The wrapping appends `) SELECT jsonb_agg(...)`. Without a newline first it landed on the trailing
    // comment's line and was commented out, leaving psql an unbalanced statement.
    const q = `WITH moved AS (UPDATE t SET n = n + 1 WHERE id = 1 RETURNING id)
SELECT id FROM moved  -- the ids we moved`;
    const plan = statementForPsql(q);
    const before = nOf(1);
    expect(JSON.parse(run(plan.text))).toEqual([{ id: 1 }]);
    expect(nOf(1)).toBe(before + 1);
  }, 300_000);

  it("a comment BEFORE the WITH does not hide it: the statement head is read off the code", () => {
    const q = `-- what this does, and why
WITH moved AS (UPDATE t SET n = n + 1 WHERE id = 2 RETURNING id)
SELECT id FROM moved`;
    const plan = statementForPsql(q);
    expect(isNested(plan.text), "the leading comment used to make this look like a non-WITH statement").toBe(false);
    const before = nOf(2);
    expect(JSON.parse(run(plan.text))).toEqual([{ id: 2 }]);
    expect(nOf(2)).toBe(before + 1);
  }, 300_000);

  it("what already worked still works: a plain SELECT is nested, and a real trailing semicolon is still dropped", () => {
    const plain = statementForPsql(`SELECT id, n FROM t WHERE id = 1`);
    expect(isNested(plain.text), "a statement with no CTE of its own is nested, exactly as before").toBe(true);
    expect(JSON.parse(run(plain.text))).toEqual([{ id: 1, n: nOf(1) }]);

    const semi = statementForPsql(`SELECT id FROM t WHERE id = 2;`);
    expect(semi.text, "the statement's own terminator does not end up inside the wrapping").not.toMatch(/;\s*\n\)/);
    expect(JSON.parse(run(semi.text))).toEqual([{ id: 2 }]);

    // An apostrophe in a real string literal is still a string, not a comment.
    const lit = statementForPsql(`SELECT 'it''s fine' AS s`);
    expect(JSON.parse(run(lit.text))).toEqual([{ s: "it's fine" }]);
  }, 300_000);

  it("a REAL terminator followed by a trailing comment: the semicolon is dropped, not carried into the wrapping", () => {
    // `SELECT … ; -- note` ends, as text, with the note — so a terminator search over the raw text finds
    // nothing, keeps the `;`, and the wrapping becomes `WITH __q AS (SELECT 1 AS a; -- note …` — a statement
    // psql sees terminated in the middle of a CTE. Searching the CODE sees the semicolon the comment hides.
    const q = `SELECT 1 AS a; -- a note after the terminator`;
    const plan = statementForPsql(q);
    expect(plan.text, "no semicolon survives inside the wrapped body").not.toMatch(/;[\s\S]*\n\) SELECT COALESCE/);
    expect(JSON.parse(run(plan.text))).toEqual([{ a: 1 }]);
  }, 300_000);

  it("a statement that only mentions `returning` in a comment returns nothing, and still runs", () => {
    const q = `UPDATE t SET n = n WHERE id = 1  -- not returning anything`;
    const plan = statementForPsql(q);
    expect(plan.kind, "the word is in a comment, so there is nothing to aggregate").toBe("exec");
    run(plan.text);
  }, 300_000);
});
