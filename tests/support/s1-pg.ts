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
 */
import { execFileSync } from "node:child_process";

export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

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

/** Offset of the last top-level SELECT, skipping string literals and `--` comments; -1 if none. */
function lastTopLevelSelect(q: string): number {
  let depth = 0, found = -1;
  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i]!;
    if (ch === "'") { i += 1; while (i < q.length && !(q[i] === "'" && q[i + 1] !== "'")) i += q[i] === "'" ? 2 : 1; continue; }
    if (ch === "-" && q[i + 1] === "-") { while (i < q.length && q[i] !== "\n") i += 1; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^select\b/i.test(q.slice(i, i + 7)) && !/\w/.test(q[i - 1] ?? " ")) found = i;
  }
  return found;
}

export function pgContainer(name: string) {
  const docker = (args: string[], input?: string) =>
    execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const psql = (text: string) =>
    docker(["exec", "-i", name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], text);

  function start(): void {
    try { docker(["rm", "-f", name]); } catch { /* not running */ }
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
    try { docker(["rm", "-f", name]); } catch { /* already gone */ }
  }

  /** DDL and seeding. No parameters, no result. */
  function exec(text: string): void { psql(text); }

  /** The app's `sql` tag, with values BOUND as $1..$n and sent as untyped strings. */
  const sql: Sql = async (strings, ...values) => {
    let q = "";
    strings.forEach((s, i) => { q += s + (i < values.length ? `$${i + 1}` : ""); });
    const body = q.trim().replace(/;\s*$/, "");
    const head = body.slice(0, 8).toLowerCase();
    const returns = head.startsWith("select") || head.startsWith("with") || /\breturning\b/i.test(body);
    let prepared: string;
    if (!returns) prepared = body;
    else if (head.startsWith("with")) {
      // A data-modifying CTE must stay at the top level, so the final SELECT becomes one more CTE.
      const at = lastTopLevelSelect(body);
      prepared = `${body.slice(0, at).replace(/\s+$/, "")},\n__q AS (${body.slice(at)}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q`;
    } else prepared = `WITH __q AS (${body}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q`;
    const args = values.length ? `(${values.map(asParam).join(", ")})` : "";
    const out = psql(`PREPARE __s AS ${prepared}\n;\nEXECUTE __s${args};\n`).trim();
    if (!returns || !out) return [];
    return JSON.parse(out) as unknown[];
  };

  return { start, stop, exec, sql };
}
