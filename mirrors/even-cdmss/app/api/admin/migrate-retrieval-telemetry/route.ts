import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { retrievalTelemetryDdl, RETRIEVAL_ROLE_NOT_NULL_SQL } from '@/lib/retrieval-telemetry-core';

export const runtime = 'nodejs';

/**
 * Applies the Stage 0a rerank-telemetry schema. Idempotent. Mirrors
 * migrations/0035_opd_audit_retrieval_telemetry.sql, which is DOCUMENTATION — a parity test holds
 * the two together, and this route is the thing that actually runs.
 *
 * ⚠️ THERE IS NO MIGRATION RUNNER IN THIS REPOSITORY. `migrations/*.sql` files are read by nothing;
 * schema changes are applied by idempotent admin routes like this one, of which there are 38
 * directories and 29 with a POST. Migration 0035 has therefore never been applied and cannot be.
 *
 * ⚠️ RETENTION, ACCESS AND DELETION are declared in the three `COMMENT ON TABLE` statements, one
 * per table, with the correct anchor column named in each. The purge is OWED AND UNIMPLEMENTED: a
 * scheduled delete against a table that may hold the only evidence of an unreconciled incident is
 * a decision, not a default. Access is the admin gate below — the same control `opd_note_audits`
 * carries, which is the standard §4.2 sets. `lib/sql-guard-core.ts` is deliberately NOT edited.
 *
 * Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie — so the migration can
 * be run one-click from the dashboard, like every other migrate-* route.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const steps: Record<string, string> = {};
  try {
    // ── THE STOP RULE (D1) ──────────────────────────────────────────────────────────────────────
    // If the table already exists WITH ROWS, this route changes nothing and reports what is there.
    // Legacy telemetry needs a signed policy before its state vocabulary is replaced underneath it:
    // the persistence-state CHECK below goes from eight values to fourteen and drops `not_eligible`,
    // so a pre-existing row carrying that state would make the ADD CONSTRAINT fail — and the honest
    // response to that is a decision by V, not a migration that quietly deletes or rewrites history.
    const reg = (await sql`SELECT to_regclass('public.opd_audit_retrieval_telemetry') IS NOT NULL AS present`) as Array<{ present: boolean }>;
    const tablePresent = Boolean(reg[0]?.present);
    if (tablePresent) {
      const counted = (await sql`SELECT count(*)::int AS n FROM opd_audit_retrieval_telemetry`) as Array<{ n: number }>;
      const existingRows = counted[0]?.n ?? 0;
      if (existingRows > 0) {
        const hist = (await sql`
          SELECT persistence_state AS state, count(*)::int AS n
            FROM opd_audit_retrieval_telemetry
           GROUP BY persistence_state
           ORDER BY n DESC`) as Array<{ state: string; n: number }>;
        steps.stop_rule = `halted: table exists with ${existingRows} rows — nothing was changed`;
        return NextResponse.json({
          ok: false,
          halted: 'table_not_empty',
          reason: 'Legacy telemetry rows exist. The persistence-state vocabulary changes in this migration; '
            + 'replacing a constraint under existing rows is a policy decision, not a schema step. '
            + 'Decide the legacy-data policy first, then re-run.',
          existing_rows: existingRows,
          state_histogram: Object.fromEntries(hist.map((r) => [r.state ?? 'null', r.n])),
          steps,
        }, { status: 409 });
      }
      steps.stop_rule = 'table exists and is empty — proceeding';
    } else {
      steps.stop_rule = 'table absent — proceeding';
    }

    // ── THE SCHEMA ──────────────────────────────────────────────────────────────────────────────
    // Every CHECK value list is GENERATED from the exported constants (D2). Nothing here is
    // hand-typed, which is the whole reason the statements live in lib/retrieval-telemetry-core.ts
    // rather than being spelled out inline.
    for (const stmt of retrievalTelemetryDdl()) {
      await sql(stmt.sql, []);
      steps[stmt.key] = 'ok';
    }

    // ── THE CONDITIONAL NOT NULL (D2) ───────────────────────────────────────────────────────────
    // An existing row's role cannot be reconstructed, so this is applied only to an empty table.
    // Explicit step, not a DO block, so the decision appears in this response and an operator can
    // see which of the two happened without reading the server log.
    const rowsNow = (await sql`SELECT count(*)::int AS n FROM opd_audit_retrieval_telemetry`) as Array<{ n: number }>;
    if ((rowsNow[0]?.n ?? 0) === 0) {
      await sql(RETRIEVAL_ROLE_NOT_NULL_SQL, []);
      steps.retrieval_role_not_null = 'applied, table empty';
    } else {
      steps.retrieval_role_not_null = 'skipped, table not empty';
    }

    const cols = (await sql`
      SELECT table_name, count(*)::int AS n
        FROM information_schema.columns
       WHERE table_name IN ('opd_audit_retrieval_telemetry', 'opd_retrieval_invocations', 'opd_retrieval_telemetry_failures')
       GROUP BY table_name`) as Array<{ table_name: string; n: number }>;
    for (const c of cols) steps[`columns_${c.table_name}`] = String(c.n);

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
