/**
 * GET /api/governance/document-audits-export
 *
 * Pipe B ingest door. GOV_API_KEY (x-api-key or Bearer), same as doctor-audits.
 *   ot              — ot_note_audits where map_status=mapped and doctor_uid is set
 *   discharge       — ipd_discharge_audits after the fail-closed treating-doctor hop
 *   progress        — only when a progress audit store exists and has doctor_uid
 *
 * Each audit carries audit_id, finding_ref, doctor_uid, note_class, note_date,
 * hospital_uid, findings[], and an optional findings-PDF path. Finding join keys
 * are note_class|doctor_uid|signal_type plus EHRC-AUD refs when a routed thread's
 * window covers the note.
 *
 * OT route mint stays off until TRIAGE_BOT_WRITE_CLASSES includes ot. This route
 * does not set that flag and does not mint opd_gov_signal.
 *
 * Query: window=1..400 (default 120) or from=&to= YYYY-MM-DD, optional doctor_uid,
 * optional note_class=ot|discharge_summary|progress.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { triageClassMintAllowed } from '@/lib/triage/stamp-schema';
import { buildDocumentAuditExport, parseExportQuery } from '@/lib/triage/document-audits-export';
import { loadDocumentAuditSources } from '@/lib/triage/document-audits-export-read';

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const parsed = parseExportQuery(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  const loaded = await loadDocumentAuditSources(parsed.value);
  const body = buildDocumentAuditExport({
    from: parsed.value.from,
    to: parsed.value.to,
    doctorUid: parsed.value.doctorUid,
    noteClass: parsed.value.noteClass,
    otRows: loaded.otRows,
    dischargeRows: loaded.dischargeRows,
    dischargeHop: loaded.dischargeHop,
    progress: loaded.progress,
    signals: loaded.signals,
    otWriteMint: triageClassMintAllowed('ot') ? 'on' : 'off',
  });
  return NextResponse.json(body);
}
