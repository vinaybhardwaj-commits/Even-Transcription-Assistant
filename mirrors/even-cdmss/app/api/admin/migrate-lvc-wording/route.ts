/**
 * app/api/admin/migrate-lvc-wording/route.ts — the runner for the ratified LVC wording pass.
 * LVC JUDGE PINNING PRD v1.0 §3 (D-5, D-5a, D-5b, D-5c), 10 Aug 2026.
 *
 * Applies migrations/0034_lvc_ratified_wording.sql: seven `lvc_recommendations.precondition` texts
 * replaced with V's ratified wording, two records retired, every touched row stamped
 * `ratified_by = 'V (Dr Vinay Bhardwaj)'` / `ratified_at = 2026-08-10`.
 *
 * ⚠️ WHY THE STATEMENTS ARE INLINED RATHER THAN READ FROM migrations/*.sql — the house reason,
 * unchanged since migrate-scoring-policy: `migrations/` is not bundled into the Vercel serverless
 * function. Only code reachable through an import is. lib/lvc-ratified-wording.ts holds the texts
 * and the SQL, the .sql file is the version-controlled record, and a unit test asserts the two
 * agree byte-for-byte — so the pair cannot drift silently.
 *
 * IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step: the orchestrator POSTs it once,
 * after the deploy is READY (PRD §5.1).
 *
 *   POST /api/admin/migrate-lvc-wording?dry=1   → read + plan, ZERO writes
 *   POST /api/admin/migrate-lvc-wording         → apply, then read the nine rows back
 *
 * IDEMPOTENT: the second POST reports `changed: 0`. Every UPDATE carries an IS DISTINCT FROM
 * guard, so a row already holding the ratified value is not rewritten.
 *
 * FAIL-SAFE: the readback runs FIRST, so a missing column (migrations/0024 unapplied), a missing
 * table or a dead connection aborts with nothing written and a JSON error body — never a 500 and
 * never a half-applied set. Every SQL string is INFERRED (no live DB in the builder's sandbox) and
 * is reproduced verbatim in the build report for validation before this route is called.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import {
  applyRatifiedWording,
  RATIFIED_IDS,
  type SqlRunner,
} from '@/lib/lvc-ratified-wording';

export const runtime = 'nodejs';
export const maxDuration = 60;   // nine single-row UPDATEs plus two readbacks

const run = sql as unknown as SqlRunner;

export async function POST(req: NextRequest) {
  // Admin cookie (browser, same-origin) OR ?token=/Bearer ADMIN_TOKEN — the seed-loader's gate,
  // so V can run this from an already-signed-in browser without handling the token.
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const result = await applyRatifiedWording(run, { dryRun });
  return NextResponse.json({
    migration: '0034_lvc_ratified_wording',
    ids: RATIFIED_IDS,
    ...result,   // carries ratifiedBy / ratifiedAt from the module's own constants
  }, { status: result.ok ? 200 : 500 });
}
