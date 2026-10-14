/**
 * /api/admin/ipd-stay-audit-now — run the STAY-level audit for one document
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P3 / §5, O11).
 *
 * ⚠️ NOT IN THE §7 P3 FILE CONTRACT — flagged in the P3 report, and the same gap P2's build route
 * filled: §7 names the engine, the assembly and the store, but no trigger, so a stay audit would
 * exist and be unrunnable. Deliberately a NEW route rather than a flag on
 * /api/admin/ipd-audit-now: that route is the single-doc primitive the parked surface depends on,
 * and the one thing this slice must not do is change how the discharge-only audit behaves.
 *
 * WHAT IT DOES. One document id in; `runIpdStayAudit` builds the P2 library for the stay, composes
 * the STAY PICTURE, runs ONE analyze pass on the same engine with wider material, and APPENDS a row
 * under `ipd-stay-audit/0.1`. The `ipd-discharge-audit/0.2` row for the same document is not read,
 * not written and not deleted — the composite PK (document_id, engine_version) makes that structural
 * rather than a promise.
 *
 * WHAT IT CANNOT DO. It is admin-gated and takes a document id; there is no path from a chat turn to
 * here (P1's Ask routes import nothing from lib/ipd-audit and hold no run path — asserted by test).
 * It writes no score onto any existing row, and a document class the library could not read reaches
 * the report as `stayCoverage`, never as a clean result.
 *
 * The box matches /api/admin/ipd-audit-now exactly: this route does the same one-document work
 * (doc_read 180,000 + audit_ipd 200,000 × 3 legs = 780,000 ms) inside an 800,000 ms box.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchIpdDoc } from '@/lib/ipd-audit/db13';
import { runIpdStayAudit } from '@/lib/ipd-audit/run';
import { getIpdAuditByVersion, IPD_STAY_ENGINE_VERSION } from '@/lib/ipd-audit/store';
import { stayCoverageLine } from '@/lib/ipd-audit/stay-material';

export const runtime = 'nodejs';
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
  if (!documentId) return NextResponse.json({ ok: false, error: 'documentId required' }, { status: 400 });

  try {
    const doc = await fetchIpdDoc(documentId);
    if (!doc) return NextResponse.json({ ok: false, error: 'document not found' }, { status: 404 });

    const result = await runIpdStayAudit({
      documentId: doc.documentId, ipUid: doc.ipUid, memberId: doc.memberId, pdfUrl: doc.pdfUrl ?? '',
    });
    if (result.error) return NextResponse.json({ ok: false, error: result.error, ...result }, { status: 200 });
    if (result.skip) return NextResponse.json({ ok: false, error: `document skipped: ${result.skip}`, ...result }, { status: 200 });

    const saved = await getIpdAuditByVersion(doc.documentId, IPD_STAY_ENGINE_VERSION);
    return NextResponse.json({
      ok: true,
      engineVersion: IPD_STAY_ENGINE_VERSION,
      status: result.status,
      id: saved?.id ?? null,
      careValueIndex: result.cvi, band: result.band,
      nFindings: result.nFindings, nLowValue: result.nLowValue,
      coverage: result.coverage,
      coverageLine: result.coverage ? stayCoverageLine(result.coverage) : null,
      extractedFromPdf: result.extractedFromPdf === true,
      notes: result.notes ?? [],
      extractTraceId: result.extractTraceId ?? null,
      analyzeTraceId: result.analyzeTraceId ?? null,
      latencyMs: result.latencyMs,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
