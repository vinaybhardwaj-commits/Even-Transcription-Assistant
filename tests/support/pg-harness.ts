/**
 * tests/support/pg-harness.ts — a REAL Postgres for tests that must not lie.
 *
 * WHY THIS EXISTS. Three times in this slice a core path shipped inert — the lease made diarize
 * unreachable, the join loaded zero turns, the stitch wrote nothing — and every one survived
 * because the tests mocked the database and drove the step machine by hand. A fake that answers
 * whatever the caller hoped for cannot fail the way production fails.
 *
 * HOW, WITHOUT A NEW DEPENDENCY. The repo speaks Neon's HTTP protocol and has no raw-Postgres
 * driver, so this proxies the `sql` tagged template through `psql` inside an ephemeral container.
 * Slower than a driver and entirely honest: the CHECK constraints, the NULL semantics and the
 * jsonb operators are the real ones.
 */
import { execFileSync } from "node:child_process";

export const PG_IMAGE = "postgres:16";
export const PG_NAME = "eta-c2-e2e";

export function dockerAvailable(): boolean {
  try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" }); return true; }
  catch { return false; }
}

const sh = (args: string[], input?: string): string =>
  execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });

export function startPg(): void {
  try { sh(["rm", "-f", PG_NAME]); } catch { /* not running */ }
  sh(["run", "-d", "--rm", "--name", PG_NAME, "-e", "POSTGRES_PASSWORD=x", PG_IMAGE]);
  // READINESS IS A REAL QUERY, TWICE. `pg_isready` answers YES during the image's own bootstrap,
  // moments before initdb shuts the server down and restarts it for real — so a single probe
  // reliably wins a race it then loses. Two consecutive successful SELECTs, a beat apart, do not.
  const deadline = Date.now() + 90_000;
  let consecutive = 0;
  for (;;) {
    try {
      sh(["exec", "-i", PG_NAME, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], "SELECT 1;");
      consecutive += 1;
      if (consecutive >= 2) return;
    } catch { consecutive = 0; }
    if (Date.now() > deadline) throw new Error("postgres did not become ready");
    execFileSync("sleep", ["0.5"]);
  }
}

export function stopPg(): void {
  try { sh(["rm", "-f", PG_NAME]); } catch { /* already gone */ }
}

/** Run SQL with no result shaping — DDL, COPY, whatever. Throws with psql's own message. */
export function exec(sqlText: string): void {
  sh(["exec", "-i", PG_NAME, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], sqlText);
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

/**
 * Offset of the last `SELECT` at parenthesis depth 0 outside string literals, or -1. For a
 * `WITH a AS (...), b AS (...) SELECT ...` statement that is where the final query starts.
 */
function lastTopLevelSelect(q: string): number {
  let depth = 0, found = -1, inStr = false;
  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i]!;
    if (inStr) {
      if (ch === "'") { if (q[i + 1] === "'") i += 1; else inStr = false; }
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^select\b/i.test(q.slice(i, i + 7)) && !/[\w]/.test(q[i - 1] ?? " ")) found = i;
  }
  return found;
}

/**
 * The `sql` tagged template the app uses, backed by the container.
 *
 * Values are inlined as escaped literals rather than bound, because psql has no parameter
 * protocol on stdin. That is acceptable HERE and nowhere else: this file never sees user input.
 */
export function makeSql(onQuery?: (q: string) => void) {
  return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    let q = "";
    strings.forEach((s, i) => { q += s + (i < values.length ? lit(values[i]) : ""); });
    onQuery?.(q);
    const head = q.trim().slice(0, 8).toLowerCase();
    const returns = head.startsWith("select") || head.startsWith("with") || /\breturning\b/i.test(q);
    if (!returns) { exec(q.trim().endsWith(";") ? q : `${q};`); return []; }
    // jsonb_agg, not json_agg, and no COPY. json_agg pretty-prints with newlines and COPY then
    // escapes them, so the text that came back was not the JSON that went in. jsonb prints compact
    // on one line, which is exactly what a line-oriented reader needs.
    const body = q.replace(/;\s*$/, "");
    // A statement that is ITSELF a top-level WITH keeps its WITH at the top level: Postgres refuses a
    // data-modifying CTE nested inside another WITH ("must be at the top level"), and Neon runs the
    // app's statement exactly as written. Its final SELECT becomes one more CTE, aggregated the same way.
    const finalSelect = head.startsWith("with") ? lastTopLevelSelect(body) : -1;
    const wrapped = finalSelect > 0
      ? `${body.slice(0, finalSelect).replace(/\s+$/, "")}, __q AS (${body.slice(finalSelect)}) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q;`
      : `WITH __q AS (${body}) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q;`;
    const out = sh(["exec", "-i", PG_NAME, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], wrapped);
    const text = out.trim();
    if (!text) return [];
    return JSON.parse(text) as unknown[];
  };
}
