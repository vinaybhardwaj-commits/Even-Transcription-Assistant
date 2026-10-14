import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { sql } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations";
import { auditWrite } from "@/lib/audit";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Split a migration SQL block into discrete statements.
 *
 * 1. Strip line comments (`-- …`) before splitting.
 * 2. Walk the SQL char-by-char and split on `;` EXCEPT when inside a
 *    dollar-quoted block (`$$ … $$` or `$tag$ … $tag$`). This lets
 *    migration SQL contain DO blocks like:
 *      DO $$ BEGIN ... ; ... END $$;
 *    without the inner semicolons fragmenting the statement.
 */
function splitStatements(sqlText: string): string[] {
  const stripped = sqlText
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.substring(0, idx);
    })
    .join("\n");

  const out: string[] = [];
  let buf = "";
  let dollarTag: string | null = null; // null => not in $$, else holds the closing tag including dollars
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (dollarTag) {
      buf += ch;
      if (ch === "$" && stripped.startsWith(dollarTag, i)) {
        buf += stripped.substring(i + 1, i + dollarTag.length);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i++;
      continue;
    }
    // Detect entering a dollar-quoted block: `$$` or `$tag$`
    if (ch === "$") {
      const m = stripped.substring(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (m) {
        dollarTag = m[0];
        buf += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * POST /api/admin/migrate
 *
 * Applies pending migrations idempotently. Uses a `_migrations` marker table.
 *
 * AUTH (Round 2 / F3): a signed-in super_admin session, or `Authorization: Bearer ${ADMIN_OPS_TOKEN}`.
 * Neither = 401, and an unset token disables the bearer path (fail closed). The URL is no longer the gate.
 *
 * Returns: { ok, executed, skipped, errors, applied: [{ id, durationMs }] }
 */
export async function POST(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not set on this deployment" },
      { status: 500 },
    );
  }
  const rawSql = neon(url);

  try {
    // Bootstrap the marker table (always idempotent).
    await rawSql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        description text
      )
    `;

    const appliedRows = await rawSql`SELECT id FROM _migrations`;
    const alreadyApplied = new Set<string>(
      (appliedRows as Array<{ id: string }>).map((r) => r.id),
    );

    const applied: Array<{ id: string; statementCount: number; durationMs: number; description: string }> = [];
    const skipped: string[] = [];
    const errors: Array<{ id: string; statement?: string; error: string }> = [];

    for (const m of MIGRATIONS) {
      if (alreadyApplied.has(m.id)) {
        skipped.push(m.id);
        continue;
      }
      const statements = splitStatements(m.sql);
      const start = Date.now();
      let lastStatement = "";
      try {
        for (const stmt of statements) {
          lastStatement = stmt;
          await rawSql(stmt);
        }
        await rawSql`INSERT INTO _migrations (id, description) VALUES (${m.id}, ${m.description})`;
        applied.push({
          id: m.id,
          statementCount: statements.length,
          durationMs: Date.now() - start,
          description: m.description,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ id: m.id, statement: lastStatement.slice(0, 200), error: msg });
        // Stop on first failure — migrations must apply in order.
        break;
      }
    }

    if (applied.length > 0 || errors.length > 0) {
      try {
        await auditWrite({
          actor_position: "Committee Admin",
          action: "migrate",
          entity_type: "system",
          entity_id: "_migrations",
          after: { applied: applied.map((a) => a.id), errors },
        });
      } catch {
        // Audit table may not exist on the very first migration run — non-fatal.
      }
    }

    return NextResponse.json({
      ok: errors.length === 0,
      executed: applied.length,
      skipped: skipped.length,
      errors: errors.length,
      applied,
      skipped_ids: skipped,
      error_details: errors,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * GET /api/admin/migrate — read current marker state without applying. Same auth as POST.
 */
export async function GET(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        description text
      )
    `;
    const rows = await sql`SELECT id, applied_at, description FROM _migrations ORDER BY applied_at`;
    return NextResponse.json({
      ok: true,
      applied: rows,
      pending: MIGRATIONS.filter(
        (m) => !(rows as Array<{ id: string }>).some((r) => r.id === m.id),
      ).map((m) => ({ id: m.id, description: m.description })),
      total: MIGRATIONS.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
