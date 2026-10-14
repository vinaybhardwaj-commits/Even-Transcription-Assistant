import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { extractCase, analyzeCase } from '@/lib/doc-audit';
import { ipdAnalyzeBudget, servedCallFor } from '@/lib/ipd-audit/run';
import { getVertexAccessToken } from '@/lib/gcp-auth';
import { fetchIpdDoc, fetchIpdAdmissionHeader } from '@/lib/ipd-audit/db13';
import { fetchBilledTotal, fetchBillingEnvelope } from '@/lib/ipd-audit/billing';
import { buildIpdAuditRow } from '@/lib/ipd-audit/assemble';
import { saveIpdAudit, IPD_ENGINE_VERSION } from '@/lib/ipd-audit/store';
import { persistEpisodeState } from '@/lib/ipd-audit/episode-adapter';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
// 300 → 800 (Unit D, DEC-B5, 3 Aug 2026). THIS ROUTE DOES IDENTICAL WORK TO ONE IPD WORKER
// DOCUMENT, so it needs an identical box — and under the corrected per-leg budget it needs
// 780,000 ms, which never fitted 300,000:
//
//   doc_read             180,000 × 1        =  180,000
//   audit_ipd × 3 legs   200,000 × 1 × 3    =  600,000
//                                              -------
//   one document                                780,000 ms   in an 800,000 ms box   margin 2.5%
//
// The three legs are doc_audit_analyze, doc_audit_critique_llm (on by default) and
// doc_audit_revise — see IPD_ANALYZE_LEGS in lib/doc-audit.ts. Budgeting one leg here, as the
// first cut of this unit did, understates the requirement by 3×.
export const maxDuration = 800;

// POST /api/admin/ipd-audit-now — the SINGLE-DOC audit primitive (S3.5; S4 scales this).
// Body: { documentId } (db13 miscellaneous_documents _doc_id).
// Flow: db13 envelope → GCS fetch → shipped doc-audit extract+analyze (+ value-score-core,
// computed inside analyzeCase) → persist de-identified via lib/ipd-audit/store.
// The LLM sees ONLY the document bytes + the de-identified extract — never the db13 header.
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
    if (!doc?.pdfUrl) return NextResponse.json({ ok: false, error: 'document not found or has no PDF' }, { status: 404 });
    const header = doc.ipUid ? await fetchIpdAdmissionHeader(doc.ipUid) : null;
    // S7: the billed ₹ scalar, best-effort — no linked bill (~8%) is a normal null, not a failure.
    const billedTotal = doc.ipUid ? await fetchBilledTotal(doc.ipUid).catch(() => null) : null;

    // GCS fetch: plain URL first (bucket is publicly readable today — flagged to infra),
    // service-account Bearer as the durable path.
    let res = await fetch(doc.pdfUrl).catch(() => null);
    if (!res?.ok) {
      const token = await getVertexAccessToken();
      res = await fetch(doc.pdfUrl, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) return NextResponse.json({ ok: false, error: `GCS fetch ${res.status}` }, { status: 502 });
    const buf = Buffer.from(await res.arrayBuffer());

    const { extracted, traceId: extractTraceId } = await extractCase({
      base64: buf.toString('base64'), mime: 'application/pdf',
      docTypeHint: 'discharge_summary', bytes: buf.length,
    });
    if (!extracted) return NextResponse.json({ ok: false, error: 'could not read the document', extractTraceId }, { status: 200 });

    // The same per-leg budget the worker uses, read from PROVIDER_BUDGETS. This route is always
    // the cloud path — it has no mini mode.
    const { report, traceId: analyzeTraceId } = await analyzeCase(extracted, {}, ipdAnalyzeBudget(false));
    if (!report) return NextResponse.json({ ok: false, error: 'analysis could not be completed', extractTraceId, analyzeTraceId }, { status: 200 });

    // T-5 / Unit B, applied HERE at last (3 Aug 2026): this route recorded `model: GEMINI_MODEL`,
    // a CONSTANT, and never set `provider` at all. So its rows claimed Gemini whether or not Gemini
    // answered — the exact D-D defect Unit B fixed on the worker and missed on this path, which is
    // the *other* writer into ipd_discharge_audits. Both fields now come from the SAME row of the
    // SAME trace query the worker uses, so a fallback to the local model is visible rather than
    // laundered into a Pro label.
    //
    // ⚠️ DISCRIMINATOR FOR THE EXISTING ROWS: any ipd_discharge_audits row with
    // `provider IS NULL` AND `model = 'gemini-2.5-pro'` was written by THIS route before this fix.
    // A row from old worker code has provider NULL too, but its model came from the trace.
    const served = await servedCallFor(analyzeTraceId);

    const row = buildIpdAuditRow({
      documentId: doc.documentId,
      ipUid: doc.ipUid,
      memberId: doc.memberId,
      speciality: header?.speciality ?? null,
      dischargeType: header?.dischargeType ?? null,
      losDays: header?.losDays ?? null,
      dischargedAt: header?.dischargeDate ? `${header.dischargeDate}T00:00:00+05:30` : null,
      billedTotal,
      engineVersion: IPD_ENGINE_VERSION,
      model: served.model,
      traceId: analyzeTraceId ?? null,
    }, extracted, report);
    // `provider` is set on the ROW rather than threaded through buildIpdAuditRow's meta:
    // lib/ipd-audit/assemble.ts builds the row field-by-field and is outside this unit's file
    // contract, so a meta field would be silently dropped there. Identical to lib/ipd-audit/run.ts.
    row.provider = served.provider;
    const saved = await saveIpdAudit(row);

    // EpisodeState (#4 SL2) — additive + best-effort; never throws, never affects the audit above.
    const billing = doc.ipUid ? await fetchBillingEnvelope(doc.ipUid).catch(() => null) : null;
    const episode = await persistEpisodeState(doc.documentId, extracted, header, billing);

    const idRows = (await sql(
      `SELECT id FROM ipd_discharge_audits WHERE document_id = $1 AND engine_version = $2 LIMIT 1`,
      [doc.documentId, IPD_ENGINE_VERSION],
    )) as Array<{ id: string }>;

    return NextResponse.json({
      ok: true, saved, id: idRows[0]?.id ?? null,
      careValueIndex: row.careValueIndex, band: row.band,
      nFindings: row.nFindings, nLowValue: row.nLowValue,
      episodeState: episode ? { status: episode.status, episodeRef: episode.episodeRef } : null,
      extractTraceId, analyzeTraceId,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
