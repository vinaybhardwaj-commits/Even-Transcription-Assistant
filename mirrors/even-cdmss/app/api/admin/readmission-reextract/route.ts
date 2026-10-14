/**
 * POST /api/admin/readmission-reextract — the R10-A re-extraction backfill and the gained-text
 * refresh trigger (CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO §3.3/§3.4, R10-D2/R10-D3).
 *
 * TWO ACTIONS ON ONE ROUTE, and the split is the point (see lib/readmission/reextract.ts):
 *
 *   ?action=extract   (default)  Re-read this cohort's discharge documents at the new
 *                                DOC_EXTRACT_VERSION. Cheap, reversible, overwrites no judgement.
 *                                Batched by DOCUMENTS (`limit`, ≤ 20) with a wall budget; walks the
 *                                findings from `offset` in dedup_key order and returns `next_offset`.
 *                                Call it again with that offset until `next_offset >= total_rows`.
 *                                Idempotent by version: a document already at the current version
 *                                costs one SELECT and no model call.
 *
 *   ?action=scan                 READ-ONLY. Which cases have gained operative text and are waiting
 *                                to be refreshed. Pays no model, writes nothing.
 *
 *   ?action=refresh              Re-analyse gained-text cases IN PLACE on Opus 4.6 via the existing
 *                                R4.1 refresh path (`limit`, default 1, max 3 — one case is ~200 s).
 *                                This OVERWRITES an audited reading, so it is gated on the R4.1
 *                                probe and on bedrock reachability, every overwrite is snapshotted
 *                                to readmission_finding_versions by saveAuditResult (R8.1), and the
 *                                response names each snapshot id.
 *
 * Auth: ADMIN_TOKEN (Bearer / ?token=) OR an admin session — the migrate-route pattern.
 * ⚠️ INFERRED SQL underneath (no live Neon / db13 in the build sandbox); every string is listed in
 * the R10 build report. Fail-safe: a db13 or store fault is counted and named in the response body,
 * never a 500 and never a silent "nothing to do".
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { DOC_EXTRACT_VERSION } from '@/lib/discharge-extract-store';
import { READMIT_ENGINE_VERSION } from '@/lib/readmission/store';
import {
  REEXTRACT_DEFAULT_DOCS_PER_REQUEST, REEXTRACT_MAX_DOCS_PER_REQUEST,
  REFRESH_DEFAULT_CASES_PER_REQUEST, REFRESH_MAX_CASES_PER_REQUEST,
  nextHint, resolveLimit, resolveOffset,
  refreshGainedTextCases, runReextractBatch, scanGainedTextPending,
} from '@/lib/readmission/reextract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const p = req.nextUrl.searchParams;
  const action = (p.get('action') ?? 'extract').trim();

  if (action === 'scan') {
    const scan = await scanGainedTextPending();
    return NextResponse.json({
      ok: true, action, engineVersion: READMIT_ENGINE_VERSION, extractionVersion: DOC_EXTRACT_VERSION,
      pending: scan.pending.length, scanned: scan.scanned, cases: scan.pending,
    });
  }

  if (action === 'refresh') {
    const r = await refreshGainedTextCases({
      limit: resolveLimit(p.get('limit'), REFRESH_DEFAULT_CASES_PER_REQUEST, REFRESH_MAX_CASES_PER_REQUEST),
    });
    return NextResponse.json({ action, engineVersion: READMIT_ENGINE_VERSION, ...r }, { status: r.ok ? 200 : 409 });
  }

  if (action !== 'extract') {
    return NextResponse.json({ ok: false, error: `unknown action '${action}' — extract | scan | refresh` }, { status: 400 });
  }

  // Resolved ONCE and reused for both the walk and the hint, so the hint can never advertise a
  // limit the request did not actually spend (R10.1).
  const limit = resolveLimit(p.get('limit'), REEXTRACT_DEFAULT_DOCS_PER_REQUEST, REEXTRACT_MAX_DOCS_PER_REQUEST);
  const batch = await runReextractBatch({ offset: resolveOffset(p.get('offset')), limit });
  return NextResponse.json({
    action,
    ...batch,
    next: nextHint({ totalRows: batch.totalRows, nextOffset: batch.nextOffset, limit }),
  });
}
