/**
 * app/api/admin/migrate-lvc-merge/route.ts — the runner for migration 0041.
 * LVC RULEBOOK REPAIR PRD v1.1 §3.1 (D-13, D-18), 25 Aug 2026.
 *
 * Applies migrations/0041_lvc_rule_merge.sql: the `merged_into` column, its comment and its index.
 * SCHEMA ONLY — under D-18 the ratification surface writes the rule content, so there is no data
 * migration to run here and this route can never change a clinical statement.
 *
 * ⚠️ WHY THE STATEMENTS ARE INLINED RATHER THAN READ FROM migrations/*.sql — the house reason,
 * unchanged since migrate-lvc-wording: `migrations/` is not bundled into the Vercel serverless
 * function. Only code reachable through an import is. lib/lvc-rule-merge.ts holds the statements,
 * the .sql file is the version-controlled record, and a unit test asserts the two agree.
 *
 * IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step: the orchestrator POSTs it once,
 * after the deploy is READY, and BEFORE the sitting opens (Verification plan, Gate A).
 *
 *   POST /api/admin/migrate-lvc-merge?dry=1   → plan + probe, ZERO writes
 *   POST /api/admin/migrate-lvc-merge         → apply, then confirm merged_into is visible
 *
 * IDEMPOTENT: every statement is IF NOT EXISTS, so the second POST is a no-op.
 *
 * FAIL-SAFE: a failure is reported per statement in a JSON body with the probe result — never a
 * bare 500, never a success that hides a column that did not appear.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { applyMergeDdl, MERGE_DDL_STATEMENTS, type SqlRunner } from '@/lib/lvc-rule-merge';

export const runtime = 'nodejs';
export const maxDuration = 60;

const run = sql as unknown as SqlRunner;

export async function POST(req: NextRequest) {
  // Admin cookie (browser, same-origin) OR ?token=/Bearer ADMIN_TOKEN — the house gate.
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  try {
    const result = await applyMergeDdl(run, { dryRun });
    return NextResponse.json({
      migration: '0041_lvc_rule_merge',
      note: 'SCHEMA ONLY — no rule content. The ratification surface at /admin/lvc-ratify is the write (D-18).',
      planned: MERGE_DDL_STATEMENTS,
      ...result,
    }, { status: result.ok ? 200 : 500 });
  } catch (e) {
    // Belt and braces: applyMergeDdl already catches per statement, so this is unreachable in
    // practice. It exists so a surprise (a dead pool, an import fault) is still JSON, not a 500 page.
    return NextResponse.json({
      migration: '0041_lvc_rule_merge', ok: false, dryRun,
      error: `migration failed, see detail: ${String((e as Error).message).slice(0, 300)}`,
    }, { status: 500 });
  }
}
