import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { buildNoteAuditPdf, type AuditPageData, type OriginalDoc } from '@/lib/opd-audit-pdf';
import { getVertexAccessToken } from '@/lib/gcp-auth';
import { fetchIpdDoc } from '@/lib/ipd-audit/db13';
import { CASE_AUDIT_DISCLAIMER, type AuditFinding } from '@/lib/doc-audit-core';

export const runtime = 'nodejs';
export const maxDuration = 60;

// GET /api/admin/ipd-audit-export?id=<audit uuid>&mode=report|combined — the download path
// (S3.4). Reuses the OPD combined-PDF builder (buildNoteAuditPdf is audit-generic: pure layout
// over finished-audit data, no engine dependency). mode=combined prepends the real discharge
// PDF fetched from GCS; mode=report emits the audit pages alone. De-identified: the PDF pages
// carry the ip_uid envelope, never a name/UHID (the discharge PDF itself is the identified
// artifact, exactly as it is in the iframe).
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const id = req.nextUrl.searchParams.get('id') ?? '';
  const mode = req.nextUrl.searchParams.get('mode') === 'combined' ? 'combined' : 'report';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 });

  try {
    const rows = (await sql(`SELECT * FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`, [id])) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return NextResponse.json({ ok: false, error: 'audit not found' }, { status: 404 });

    const findings = ((typeof r.findings === 'string' ? JSON.parse(String(r.findings)) : r.findings) ?? []) as AuditFinding[];
    const suggestions = ((typeof r.suggestions === 'string' ? JSON.parse(String(r.suggestions)) : r.suggestions) ?? []) as Array<{ text?: string }>;

    let original: OriginalDoc = null;
    let originalStatus: string | null = 'Discharge PDF not attached — audit only.';
    if (mode === 'combined') {
      const doc = await fetchIpdDoc(String(r.document_id)).catch(() => null);
      if (doc?.pdfUrl) {
        let res = await fetch(doc.pdfUrl).catch(() => null);
        if (!res?.ok) {
          const token = await getVertexAccessToken().catch(() => null);
          if (token) res = await fetch(doc.pdfUrl, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
        }
        if (res?.ok) {
          original = { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
          originalStatus = null;
        } else {
          originalStatus = 'Discharge PDF could not be fetched — audit only.';
        }
      }
    }

    const data: AuditPageData = {
      uid: String(r.ip_uid ?? r.document_id),
      doctor: String(r.speciality ?? '—'),
      specialty: r.discharge_type ? String(r.discharge_type) : null,
      noteDate: r.discharged_at ? String(r.discharged_at).slice(0, 10) : String(r.audited_at).slice(0, 10),
      engineVersion: String(r.engine_version),
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      originalStatus,
      band: String(r.band),
      index: Number(r.care_value_index),
      domains: [
        { label: 'Appropriateness', score: r.score_appropriateness == null ? null : Number(r.score_appropriateness) },
        { label: 'Efficiency', score: r.score_efficiency == null ? null : Number(r.score_efficiency) },
        { label: 'Safety', score: r.score_safety == null ? null : Number(r.score_safety) },
        { label: 'Cost', score: r.score_cost == null ? null : Number(r.score_cost) },
        { label: 'Documentation', score: r.score_documentation == null ? null : Number(r.score_documentation) },
        { label: 'Patient-centred', score: r.score_patient_centred == null ? null : Number(r.score_patient_centred) },
      ],
      findings: findings.map((f) => ({
        subject: f.subject, verdict: f.verdict, domain: f.domain ?? 'appropriateness',
        rationale: f.rationale, ground: (f.citation_ids?.length ? 'grounded' : 'reasoning') as 'grounded' | 'reasoning',
      })),
      suggestions: suggestions.map((s) => String(s.text ?? '')).filter(Boolean),
      footer: CASE_AUDIT_DISCLAIMER,
    };

    const bytes = await buildNoteAuditPdf(data, original);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="ipd-audit-${String(r.ip_uid ?? id).replace(/[^A-Za-z0-9-]/g, '_')}-${mode}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
