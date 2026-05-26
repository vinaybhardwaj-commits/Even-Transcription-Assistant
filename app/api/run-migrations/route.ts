import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import fs from "fs";
import path from "path";

/**
 * POST /api/run-migrations
 *
 * Auth: Authorization: Bearer ${MIGRATION_SECRET}
 *
 * Reads every .sql file in /db/migrations/ in version order, checks
 * schema_migrations to find unapplied ones, runs each migration as one
 * Neon HTTP transaction so partial failures roll back.
 *
 * Each migration's SQL is split by the dollar-quote-aware splitter below
 * (Neon HTTP does not accept multi-statement strings directly), then
 * passed to sql.transaction([...]) as an array of prepared queries.
 *
 * GET returns the applied list (no auth) for status checks.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type MigrationFile = { version: number; name: string; path: string };

function discoverMigrations(): MigrationFile[] {
  const dir = path.join(process.cwd(), "db", "migrations");
  if (!fs.existsSync(dir)) return [];
  const out: MigrationFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d{4})_(.+)\.sql$/.exec(f);
    if (!m) continue;
    out.push({
      version: parseInt(m[1]!, 10),
      name: f.replace(/\.sql$/, ""),
      path: path.join(dir, f),
    });
  }
  return out.sort((a, b) => a.version - b.version);
}

/**
 * Split a SQL script into individual statements, respecting:
 *   - `$$` dollar-quoted blocks (used by DO and CREATE FUNCTION bodies)
 *   - line comments (-- ...)
 *   - block comments (/* ... *\/)
 *   - single-quoted strings (incl. doubled-up '' escapes)
 *
 * Drops BEGIN; and COMMIT; (we wrap the whole thing in sql.transaction()
 * which gives us atomicity; doubled-up BEGINs would error).
 */
function splitSql(body: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inDollar = false;
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < body.length) {
    const c = body[i]!;
    const next = body[i + 1] ?? "";
    if (inLineComment) {
      buf += c;
      if (c === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === "*" && next === "/") {
        buf += next;
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inSingleQuote) {
      buf += c;
      if (c === "'") {
        if (next === "'") { buf += next; i += 2; continue; } // doubled-up escape
        inSingleQuote = false;
      }
      i++;
      continue;
    }
    if (inDollar) {
      buf += c;
      if (c === "$" && next === "$") {
        buf += next;
        inDollar = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // not inside anything
    if (c === "-" && next === "-") { inLineComment = true; buf += c; i++; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; buf += c; i++; continue; }
    if (c === "'") { inSingleQuote = true; buf += c; i++; continue; }
    if (c === "$" && next === "$") { inDollar = true; buf += c + next; i += 2; continue; }
    if (c === ";") {
      const s = buf.trim();
      if (s && !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) out.push(s);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail && !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(tail)) out.push(tail);
  return out;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.MIGRATION_SECRET ?? ""}`;
  if (!process.env.MIGRATION_SECRET || auth !== expected) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Invalid migration secret" } },
      { status: 403 }
    );
  }

  // Bootstrap schema_migrations
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  } catch (e) {
    return NextResponse.json(
      { error: { code: "PIPELINE_FAILED", message: "Cannot create schema_migrations: " + String(e) } },
      { status: 500 }
    );
  }

  // List applied
  let appliedVersions: number[] = [];
  try {
    const rows = (await sql`SELECT version FROM schema_migrations`) as Array<{ version: number }>;
    appliedVersions = rows.map((r) => r.version);
  } catch (e) {
    return NextResponse.json(
      { error: { code: "PIPELINE_FAILED", message: "Cannot list applied migrations: " + String(e) } },
      { status: 500 }
    );
  }

  const all = discoverMigrations();
  const applied: string[] = [];
  const skipped: string[] = [];

  // Type-narrow sql to access the transaction() method
  const sqlAny = sql as unknown as {
    transaction: (queries: unknown[]) => Promise<unknown>;
  };

  for (const m of all) {
    if (appliedVersions.includes(m.version)) {
      skipped.push(m.name);
      continue;
    }
    const body = fs.readFileSync(m.path, "utf8");
    const statements = splitSql(body);
    try {
      // Build queries by calling sql as a template tag with each prepared statement
      const queries = statements.map((s) =>
        (sql as unknown as (strs: TemplateStringsArray, ...vals: unknown[]) => unknown)(
          Object.assign([s], { raw: [s] }) as unknown as TemplateStringsArray
        )
      );
      await sqlAny.transaction(queries);
      applied.push(m.name);
    } catch (e) {
      return NextResponse.json(
        {
          applied,
          skipped,
          errored: { migration: m.name, error: String(e), statement_count: statements.length },
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ applied, skipped, errored: null });
}

export async function GET() {
  try {
    const rows = (await sql`
      SELECT version, name, applied_at::text AS applied_at
        FROM schema_migrations
       ORDER BY version
    `) as Array<{ version: number; name: string; applied_at: string }>;
    return NextResponse.json({ applied: rows });
  } catch (e) {
    return NextResponse.json(
      { applied: [], note: "schema_migrations table not yet created: " + String(e) },
      { status: 200 }
    );
  }
}
