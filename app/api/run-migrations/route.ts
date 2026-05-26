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
 * schema_migrations to find unapplied ones, runs each in a single
 * statement chunk against Neon. Each migration file is responsible
 * for its own transaction (BEGIN/COMMIT) and for inserting its row
 * into schema_migrations on success.
 *
 * Returns { applied: [...], skipped: [...], errored: ... }.
 *
 * Idempotent: safe to re-hit. Migrations that already ran are skipped.
 *
 * Per OPD lesson: splitSqlStatements doesn't handle quoted strings
 * containing semicolons. Feed each migration as ONE chunk to the
 * sql template tag (with .query() for non-parameterised) and let
 * Postgres' own lexer parse.
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

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.MIGRATION_SECRET ?? ""}`;
  if (!process.env.MIGRATION_SECRET || auth !== expected) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Invalid migration secret" } },
      { status: 403 }
    );
  }

  // Ensure schema_migrations exists (bootstrap for 0001 which itself creates it).
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

  // Get applied versions
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

  for (const m of all) {
    if (appliedVersions.includes(m.version)) {
      skipped.push(m.name);
      continue;
    }
    const body = fs.readFileSync(m.path, "utf8");
    try {
      // Neon HTTP driver supports .query() for raw multi-statement SQL.
      // Cast through unknown to access the lower-level method.
      const sqlAny = sql as unknown as {
        query: (q: string, params?: unknown[]) => Promise<unknown>;
      };
      await sqlAny.query(body);
      applied.push(m.name);
    } catch (e) {
      return NextResponse.json(
        {
          applied,
          skipped,
          errored: { migration: m.name, error: String(e) },
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ applied, skipped, errored: null });
}

// Also support GET for status check (no secret needed; just lists applied)
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
