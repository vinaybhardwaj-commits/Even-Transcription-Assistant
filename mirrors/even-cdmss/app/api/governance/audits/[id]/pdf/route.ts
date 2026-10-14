/**
 * GET /api/governance/audits/:id/pdf
 *
 * Audit-findings PDF for an ot_note_audits / ipd_discharge_audits id, or for an
 * EHRC-AUD reference whose window contains a matching document audit. GOV_API_KEY,
 * same as doctor-audits. The clinical source PDF is not attached.
 *
 * OT route mint stays off. This route does not set TRIAGE_BOT_WRITE_CLASSES.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { buildFindingsPdf } from '@/lib/triage/document-audits-pdf';
import { loadFindingsPdf } from '@/lib/triage/document-audits-export-read';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const { id: raw } = await params;
  const loaded = await loadFindingsPdf(raw || '');
  if (loaded === 'bad-id') {
    return NextResponse.json({ ok: false, error: 'id must be an audit uuid or EHRC-AUD reference' }, { status: 400 });
  }
  if (!loaded) return NextResponse.json({ ok: false, error: 'audit not found' }, { status: 404 });

  const bytes = await buildFindingsPdf(loaded);
  const filename = `audit-findings-${loaded.audit_id.replace(/[^a-zA-Z0-9.-]/g, '')}.pdf`;
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
