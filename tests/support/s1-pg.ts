/**
 * tests/support/s1-pg.ts — a REAL Postgres per suite, with BOUND parameters. S1 FIX2.
 *
 * WHY NOT pg-harness.ts. Two reasons, both found on S1:
 *   1. It hard-codes one container name, and vitest runs files in parallel — a second suite starting
 *      it removes the first suite's database mid-run. Here every suite names its own container.
 *   2. It inlines values as literals, so Postgres never infers a parameter's type the way it does for
 *      the app's driver. A query that only works because `6` arrived as an integer literal passes there
 *      and fails in production. Here the statement is PREPAREd with $1..$n and EXECUTEd with every value
 *      as an untyped string, which is how the Neon HTTP driver sends them: the server infers each type
 *      from context, and "could not determine data type of parameter" fails the test as it would fail
 *      the app.
 *
 * psql, not a driver, because the repo has no raw-Postgres dependency. Each call is its own session, so
 * a prepared statement never outlives the call that made it.
 *
 * ─── KNOWN DIVERGENCES FROM NEON, NOT FIXED (S1 FIX3b C12) ─────────────────────────────────
 * Rows come back through jsonb_agg, which changes two things. Do not trust this harness past them:
 *   1. A `bigint` (and any int8, e.g. count(*) without a cast) comes back as a JSON NUMBER. The Neon
 *      driver returns it as a STRING. Code that works here because a count is a number can break there.
 *   2. Row ORDER is not guaranteed unless the query itself says ORDER BY. Do not assert an order the
 *      statement does not ask for.
 * One divergence IS fixed: a statement this harness cannot classify (a leading comment or `(`, or a first
 * word it does not know) THROWS UnrecognisedStatementError. It used to run and return [] — a wrong answer
 * wearing the shape of "no rows".
 */
import { execFileSync } from "node:child_process";
import { containerName } from "./container-name";

export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** A statement the harness cannot classify. Thrown, never read as "no rows". */
export class UnrecognisedStatementError extends Error {
  constructor(head: string) {
    super(`s1-pg: cannot classify a statement starting ${JSON.stringify(head)} — it must begin with SELECT, WITH, INSERT, UPDATE or DELETE (no leading comment or parenthesis)`);
    this.name = "UnrecognisedStatementError";
  }
}

const KNOWN_FIRST_WORDS = new Set(["select", "with", "insert", "update", "delete"]);

export function dockerAvailable(): boolean {
  try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" }); return true; }
  catch { return false; }
}

/** A JS array as the Postgres array literal the driver sends: {"a","b"}, NULL unquoted, nested arrays nested. */
function pgArray(a: unknown[]): string {
  return `{${a.map((e) => {
    if (e === null || e === undefined) return "NULL";
    if (Array.isArray(e)) return pgArray(e);
    const s = e instanceof Date ? e.toISOString() : typeof e === "object" ? JSON.stringify(e) : String(e);
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join(",")}}`;
}

/** How the Neon driver serialises a value before sending it: a string (arrays as array literals), or NULL. */
function asParam(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (Array.isArray(v)) s = pgArray(v);
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Offset of the MAIN statement: the first SELECT / INSERT / UPDATE / DELETE at parenthesis depth 0, skipping
 * string literals and comments; -1 if none. For `WITH a AS (...), b AS (...) <main>` that is <main> — which
 * may itself be an INSERT ... SELECT, so it is the FIRST top-level keyword, not the last SELECT.
 */
function mainStatementAt(q: string): number {
  let depth = 0;
  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i]!;
    if (ch === "'") { i += 1; while (i < q.length && !(q[i] === "'" && q[i + 1] !== "'")) i += q[i] === "'" ? 2 : 1; continue; }
    if (ch === "-" && q[i + 1] === "-") { while (i < q.length && q[i] !== "\n") i += 1; continue; }
    if (ch === "/" && q[i + 1] === "*") { const end = q.indexOf("*/", i + 2); i = end < 0 ? q.length : end + 1; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^(select|insert|update|delete)\b/i.test(q.slice(i, i + 7)) && !/\w/.test(q[i - 1] ?? " ")) return i;
  }
  return -1;
}

/**
 * `base` is the suite's stem (`eta-s1-emotion`, …); the container is `<base>-<worktree tag>`, so a suite in one
 * worktree can never `rm -f` another worktree's database (tests/support/container-name.ts). `name` is returned.
 */
export function pgContainer(base: string) {
  const name = containerName(base);
  const docker = (args: string[], input?: string) =>
    execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const psql = (text: string) =>
    docker(["exec", "-i", name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], text);

  function start(): void {
    try { docker(["rm", "-fv", name]); } catch { /* not running */ }
    docker(["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "postgres:16"]);
    // Two consecutive real SELECTs: pg_isready answers during initdb's restart and then loses the race.
    const deadline = Date.now() + 90_000;
    for (let ok = 0; ok < 2;) {
      try { psql("SELECT 1;"); ok += 1; } catch { ok = 0; }
      if (Date.now() > deadline) throw new Error(`postgres ${name} did not become ready`);
      execFileSync("sleep", ["0.5"]);
    }
  }

  function stop(): void {
    try { docker(["rm", "-fv", name]); } catch { /* already gone */ }
  }

  /** DDL and seeding. No parameters, no result. */
  function exec(text: string): void { psql(text); }

  /** The app's `sql` tag, with values BOUND as $1..$n and sent as untyped strings. */
  const sql: Sql = async (strings, ...values) => {
    let q = "";
    strings.forEach((s, i) => { q += s + (i < values.length ? `$${i + 1}` : ""); });
    const body = q.trim().replace(/;\s*$/, "");
    const firstWord = /^[A-Za-z]+/.exec(body)?.[0]?.toLowerCase() ?? "";
    if (!KNOWN_FIRST_WORDS.has(firstWord)) throw new UnrecognisedStatementError(body.slice(0, 12));
    const at = mainStatementAt(body);
    if (at < 0) throw new UnrecognisedStatementError(body.slice(0, 12));
    const main = body.slice(at);
    // Rows come back from a SELECT, or from a data-modifying main statement that says RETURNING. A
    // `WITH ... INSERT ... SELECT` with no RETURNING returns nothing, whatever its CTEs contain.
    const returns = /^select\b/i.test(main) || /\breturning\b/i.test(main);
    let prepared: string;
    if (!returns) prepared = body;
    else if (at > 0) {
      // A data-modifying CTE must stay at the top level, so the main statement becomes one more CTE.
      prepared = `${body.slice(0, at).replace(/\s+$/, "")},\n__q AS (${main}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q`;
    } else prepared = `WITH __q AS (${body}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q`;
    const args = values.length ? `(${values.map(asParam).join(", ")})` : "";
    const out = psql(`PREPARE __s AS ${prepared}\n;\nEXECUTE __s${args};\n`).trim();
    if (!returns || !out) return [];
    return JSON.parse(out) as unknown[];
  };

  return { name, start, stop, exec, sql };
}
