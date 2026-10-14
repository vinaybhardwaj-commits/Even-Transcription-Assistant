export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/scoring-policy/lab-packages/export
 *   → the CURRENT LIVE package set as CSV (§7.3).
 *
 * "Exports the current live set, not a blank template" — a clinician edits what exists rather than
 * starting from nothing. That is also what makes the round-trip guarantee meaningful: download,
 * change nothing, re-upload ⇒ zero-row diff, no new version.
 *
 * Source of truth is `scoring_policy_versions` with note_type='lab_packages' (the Phase A tables,
 * reused wholesale — no parallel versioning path). Before anything is published there, it falls
 * back to data/lab-packages.json, which is what the judge actually reads.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authedAdminRequest } from '@/lib/scoring-policy/store';
import { serialiseLabPackagesCsv } from '@/lib/scoring-policy/lab-packages-csv';
import { activeLabPackages } from '@/lib/scoring-policy/lab-packages';

export async function GET(req: NextRequest) {
  if (!(await authedAdminRequest(req))) return NextResponse.json({ error: 'admin required' }, { status: 401 });

  const { packages } = await activeLabPackages();
  const csv = serialiseLabPackagesCsv(packages);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="lab-packages.csv"',
      // Never cached: the point of the export is that it reflects the live set at this moment.
      'cache-control': 'no-store',
    },
  });
}
