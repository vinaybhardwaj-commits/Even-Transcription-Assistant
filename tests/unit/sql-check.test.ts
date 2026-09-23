/**
 * sql-check.test.ts — the shared drift-guard parser (tests/support/sql-check.ts).
 *
 * It exists so a SQL CHECK and the TypeScript list it mirrors can be compared by VALUE, and its one
 * real weakness is being answered by a comment instead of by the constraint. F1 was that hole in `--`
 * form; G2 is the same hole in `/* *\/` form (ETA-Refuter, 23 Sep). Both are pinned here, in the
 * shape the mutation actually takes: a comment quoting the wide clause above a narrowed real one.
 *
 * All SQL here is synthetic.
 */
import { describe, expect, it } from "vitest";
import { checkValues, stripSqlComments } from "../support/sql-check";

const WIDE = "'non_speech', 'unjudged_gap', 'tape_off', 'dead_mic', 'end_of_input'";
const NARROW = "'non_speech', 'end_of_input'";
const real = (values: string) => `CREATE TABLE t (\n  CONSTRAINT c_chk CHECK (\n    closed_by IN (${values}))\n);`;

describe("a comment cannot answer for a constraint", () => {
  it("G2: a block comment quoting the wide clause does not hide a narrowed one", () => {
    const sql = `/* CONSTRAINT c_chk CHECK (closed_by IN (${WIDE})) */\n${real(NARROW)}`;
    expect(checkValues(sql, "c_chk", "closed_by")).toEqual(new Set(["non_speech", "end_of_input"]));
  });

  it("F1: a line comment quoting the wide clause does not hide a narrowed one", () => {
    const sql = `-- CONSTRAINT c_chk CHECK (closed_by IN (${WIDE}))\n${real(NARROW)}`;
    expect(checkValues(sql, "c_chk", "closed_by")).toEqual(new Set(["non_speech", "end_of_input"]));
  });

  it("a constraint that exists ONLY in a comment is not found, in either syntax", () => {
    for (const sql of [
      `/* CONSTRAINT ghost_chk CHECK (x IN ('a')) */\nCREATE TABLE t (z text);`,
      `/**\n * CONSTRAINT ghost_chk CHECK (x IN ('a'))\n */\nCREATE TABLE t (z text);`,
      `CREATE TABLE t (\n  z text /* CONSTRAINT ghost_chk CHECK (x IN ('a')) */\n);`,
      `-- CONSTRAINT ghost_chk CHECK (x IN ('a'))\nCREATE TABLE t (z text);`,
    ]) expect(() => checkValues(sql, "ghost_chk", "x")).toThrow(/no CONSTRAINT ghost_chk/);
  });

  it("nested blocks close once, as Postgres reads them", () => {
    const sql = `/* outer /* inner CONSTRAINT c_chk CHECK (x IN ('a')) */ still a comment */\n${real(NARROW)}`;
    expect(checkValues(sql, "c_chk", "closed_by")).toEqual(new Set(["non_speech", "end_of_input"]));
    expect(stripSqlComments("/* a /* b */ c */x")).toBe("x");
  });

  it("the repo's own doc-comment form is stripped", () => {
    // 0074 writes /** … */ over columns; a CHECK quoted in one must not answer for the real clause.
    const sql = `CREATE TABLE t (\n  /** CONSTRAINT c_chk CHECK (closed_by IN (${WIDE})) */\n  CONSTRAINT c_chk CHECK (closed_by IN (${NARROW}))\n);`;
    expect(checkValues(sql, "c_chk", "closed_by")).toEqual(new Set(["non_speech", "end_of_input"]));
  });
});

describe("a comment marker inside a string is not a comment", () => {
  it("keeps -- and /* inside single-quoted values", () => {
    expect(stripSqlComments("SELECT 'a -- b' -- gone\n")).toBe("SELECT 'a -- b' \n");
    expect(stripSqlComments("SELECT 'a /* b' /* gone */ , 'c'")).toBe("SELECT 'a /* b'  , 'c'");
    expect(stripSqlComments("SELECT 'it''s -- fine' -- gone")).toBe("SELECT 'it''s -- fine' \n");
  });

  it("a value containing a comment marker still parses as that value", () => {
    expect(checkValues("CONSTRAINT c CHECK (x IN ('a--b', 'c/*d', 'e'))", "c", "x"))
      .toEqual(new Set(["a--b", "c/*d", "e"]));
  });

  it("an unterminated block comment swallows the rest, and the guard says so rather than guessing", () => {
    expect(() => checkValues(`/* CONSTRAINT c_chk CHECK (x IN ('a'))\n${real(NARROW)}`, "c_chk", "closed_by"))
      .toThrow(/no CONSTRAINT c_chk/);
  });

  it("line structure survives, so a stripped file still lines up", () => {
    expect(stripSqlComments("a\n/* two\nlines */\nb")).toBe("a\n\n\nb");
  });
});
