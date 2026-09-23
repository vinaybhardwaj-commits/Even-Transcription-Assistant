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
import { containerName } from "./container-name";

export const PG_IMAGE = "postgres:16";
/** Unique per worktree: a fixed name let a suite in one worktree `rm -f` another worktree's database mid-run. */
export const PG_NAME = containerName("eta-c2-e2e");

/** eta-refuter-2 D1 (23 Sep): no timeout meant a hung docker socket stalled the gate until the
 * 1800s hard-timeout watchdog killed the whole run. 15s is enough for a real daemon to answer;
 * a genuinely down/hung one now fails fast and loud instead. */
export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (err.code === "ENOENT") console.error("dockerAvailable: docker CLI not found");
    else if ((err as { signal?: string }).signal === "SIGTERM") console.error("dockerAvailable: docker daemon did not answer within 15s (server unreachable)");
    else console.error(`dockerAvailable: server unreachable: ${String(err.stderr ?? err.message).slice(0, 200)}`);
    return false;
  }
}

const sh = (args: string[], input?: string): string =>
  execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });

export function startPg(): void {
  try { sh(["rm", "-fv", PG_NAME]); } catch { /* not running */ }
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
  try { sh(["rm", "-fv", PG_NAME]); } catch { /* already gone */ }
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
 * ─── E31 — EVERY SCAN BELOW READS CODE, NEVER COMMENTS ──────────────────────────────────────────────
 *
 * THE DEFECT THIS FIXES. The scanner tracked single-quoted strings but knew nothing about comments, so
 * `-- the row's own note` put it inside a string literal for the REST OF THE STATEMENT. It then found no
 * top-level SELECT, fell into the nesting branch below, and Postgres refused the result outright:
 * "WITH clause containing a data-modifying statement must be at the top level". Every one-statement cure in
 * the E31 atomicity programme is a data-modifying CTE with comments in it, so every one of them hit this.
 *
 * THE FIX IS ONE IDEA: blank out everything that is not code — line comments, block comments and string
 * literals — into spaces of the SAME LENGTH, so offsets into the mask are offsets into the original. Then
 * the paren counter, the `SELECT` finder, the statement head and the terminator check all read the mask and
 * none of them can be fooled by prose.
 *
 * NOT HANDLED, and named rather than left to be discovered: dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`).
 * Nothing reaches this function with one — `lit()` never emits a dollar quote, and the migrations and DO
 * blocks that use them go through `exec()`, which parses nothing. If that ever changes, this is the function
 * to teach.
 */
function maskNonCode(q: string): string {
  const out = q.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  for (let i = 0; i < q.length; i += 1) {
    // A line comment runs to the end of the line. The newline stays, so line structure survives masking.
    if (q[i] === "-" && q[i + 1] === "-") {
      const end = q.indexOf("\n", i);
      const stop = end === -1 ? q.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Block comments NEST in Postgres, unlike C. `/* /* */ */` is one comment, not one and a half.
    if (q[i] === "/" && q[i + 1] === "*") {
      let depth = 1, j = i + 2;
      while (j < q.length && depth > 0) {
        if (q[j] === "/" && q[j + 1] === "*") { depth += 1; j += 2; continue; }
        if (q[j] === "*" && q[j + 1] === "/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      blank(i, j);
      i = j - 1;
      continue;
    }
    // A single-quoted literal, with '' as the escape for a quote inside one.
    if (q[i] === "'") {
      let j = i + 1;
      while (j < q.length) {
        if (q[j] === "'") { if (q[j + 1] === "'") { j += 2; continue; } j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j - 1;
      continue;
    }
  }
  return out.join("");
}

/**
 * Offset of the last `SELECT` at parenthesis depth 0, or -1. For a `WITH a AS (...), b AS (...) SELECT ...`
 * statement that is where the final query starts. Read off the MASK, so a paren, a quote or the word
 * `select` inside a comment counts for nothing.
 */
function lastTopLevelSelect(code: string): number {
  let depth = 0, found = -1;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^select\b/i.test(code.slice(i, i + 7)) && !/[\w]/.test(code[i - 1] ?? " ")) found = i;
  }
  return found;
}

/**
 * WHAT PSQL IS ACTUALLY GIVEN for one tagged-template call, as a pure function of the statement text.
 *
 * Exported so the defects above can be tested without a container: the wrapping is where they lived, and a
 * test that only ran the happy path through a database would not have found any of them. `makeSql` is the
 * only caller and behaves exactly as before for every statement that already worked.
 *
 * `kind: "exec"` — nothing to return; psql runs it for its effect.
 * `kind: "query"` — the statement wrapped so psql prints ONE line of compact JSON. THAT is what the wrapping
 * is for, and it is the only reason it exists: psql has no result protocol on stdin, the repo has no raw
 * Postgres driver, and the caller expects rows. `jsonb_agg`, not `json_agg`, because json_agg pretty-prints
 * with newlines and a line-oriented reader would not get back the JSON that went in.
 *
 * TWO WRAPPINGS, because one of them is illegal for some statements. A statement that is itself a top-level
 * WITH keeps its own WITH at the top level and gains `__q` as one more CTE; anything else is nested whole
 * inside a new `WITH __q AS (...)`. Nesting is refused by Postgres when the body contains a data-modifying
 * CTE, which is why picking the right branch matters and why picking it wrongly was silent breakage.
 */
export function statementForPsql(q: string): { kind: "exec" | "query"; text: string } {
  const code = maskNonCode(q);
  const at = code.search(/\S/);
  const head = at === -1 ? "" : code.slice(at, at + 8).toLowerCase();
  // `returning` is looked for in the CODE: a statement that only mentions it in a comment returns nothing.
  const returns = head.startsWith("select") || head.startsWith("with") || /\breturning\b/i.test(code);

  if (!returns) {
    // TERMINATE ON THE CODE, NOT ON THE TEXT. `CREATE TABLE t (…) -- make it; done` ends, as text, with no
    // semicolon, so a `;` used to be appended INSIDE the trailing comment — and psql, handed a statement it
    // never sees terminated, silently ran nothing at all. The newline is what carries the terminator out of
    // any trailing line comment.
    return { kind: "exec", text: /;\s*$/.test(code) ? q : `${q}\n;` };
  }

  // A trailing `;` belongs to the statement, not to the wrapping, and is dropped from both — but only when
  // it is real code and not the one inside `-- ended it; here`.
  const semi = /;\s*$/.exec(code);
  const body = semi ? q.slice(0, semi.index) : q;
  const bodyCode = semi ? code.slice(0, semi.index) : code;
  const finalSelect = head.startsWith("with") ? lastTopLevelSelect(bodyCode) : -1;

  // THE NEWLINES BEFORE EACH `)` ARE LOAD-BEARING. The body may end in a line comment; without them the
  // closing paren and everything after it would land on that comment's line and be commented out, leaving
  // psql an unbalanced statement.
  const tail = `\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q;`;
  const text = finalSelect > 0
    ? `${body.slice(0, finalSelect).replace(/\s+$/, "")}, __q AS (${body.slice(finalSelect)}${tail}`
    : `WITH __q AS (${body}${tail}`;
  return { kind: "query", text };
}

export function makeSql(onQuery?: (q: string) => void) {
  return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    let q = "";
    strings.forEach((s, i) => { q += s + (i < values.length ? lit(values[i]) : ""); });
    onQuery?.(q);
    const plan = statementForPsql(q);
    if (plan.kind === "exec") { exec(plan.text); return []; }
    const out = sh(["exec", "-i", PG_NAME, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], plan.text);
    const text = out.trim();
    if (!text) return [];
    return JSON.parse(text) as unknown[];
  };
}
