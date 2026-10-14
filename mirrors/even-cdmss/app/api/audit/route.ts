import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { auditAccessAllowed } from '@/lib/pharmacist-cookie';
import type { AuditPayload } from '@/lib/med-audit';
import { startTrace, logEvent, finishTrace, setTraceQuestionPreview } from '@/lib/trace';

export const runtime = 'nodejs';

// GET: recent audits (history list for the pharmacist).
export async function GET() {
  if (!(await auditAccessAllowed())) {
    return NextResponse.json({ error: 'pharmacist auth required' }, { status: 401 });
  }
  const rows = (await sql`
    SELECT s.id, s.uhid, s.auditor, s.audit_date, s.location, s.created_at,
           COUNT(DISTINCT d.id)::int AS drug_count,
           COUNT(f.id) FILTER (WHERE f.status = 'error')::int AS error_count
    FROM med_audit_session s
    LEFT JOIN med_audit_drug d ON d.session_id = s.id
    LEFT JOIN med_audit_finding f ON f.drug_id = d.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
    LIMIT 100`) as unknown[];
  return NextResponse.json({ audits: rows });
}

// POST: save a finished audit (session + drugs + findings).
export async function POST(req: NextRequest) {
  if (!(await auditAccessAllowed())) {
    return NextResponse.json({ error: 'pharmacist auth required' }, { status: 401 });
  }
  let p: AuditPayload;
  try { p = (await req.json()) as AuditPayload; } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!p || !Array.isArray(p.drugs)) return NextResponse.json({ error: 'invalid payload' }, { status: 400 });

  const m = p.meta || ({} as AuditPayload['meta']);
  const drugCount = p.drugs.length;
  const errorCount = p.drugs.reduce((s, d) => s + (d.findings || []).filter((f) => f.status === 'error').length, 0);
  const naCount = p.drugs.reduce((s, d) => s + (d.findings || []).filter((f) => f.status === 'na').length, 0);
  // Observability: capture this completed audit as a run. Non-identifying summary only —
  // the full PHI record (UHID, drugs, findings) lives in med_audit_session/drug/finding and
  // is referenced here by sessionId. Tracing is best-effort and never blocks the save.
  const traceId = await startTrace('med_audit',
    { location: m.location || null, allergies_documented: p.allergies_documented || null, drug_count: drugCount },
    1, { surface: 'medaudit' }).catch(() => undefined as string | undefined);

  try {
    const sess = (await sql`
      INSERT INTO med_audit_session
        (uhid, auditor, audit_date, location, admission_date, consultant,
         allergies_documented, known_allergies, status, app_source, created_by)
      VALUES (${m.uhid || null}, ${m.auditor || null}, ${m.audit_date || null}, ${m.location || null},
              ${m.admission_date || null}, ${m.consultant || null}, ${p.allergies_documented || null},
              ${JSON.stringify(p.known_allergies || [])}::jsonb, 'final', 'medaudit', ${m.auditor || null})
      RETURNING id`) as { id: number }[];
    const sessionId = sess[0].id;

    for (let i = 0; i < p.drugs.length; i++) {
      const d = p.drugs[i];
      const dr = (await sql`
        INSERT INTO med_audit_drug
          (session_id, position, name, category, dose, frequency, route, reserve, high_alert, formulary_id)
        VALUES (${sessionId}, ${i}, ${d.name}, ${d.category || null}, ${d.dose || null},
                ${d.frequency || null}, ${d.route || null}, ${!!d.reserve}, ${!!d.high_alert}, ${d.formulary_id || null})
        RETURNING id`) as { id: number }[];
      const drugId = dr[0].id;
      const findings = (d.findings || []).filter((f) => f.status === 'error' || f.status === 'na');
      for (const f of findings) {
        await sql`
          INSERT INTO med_audit_finding (drug_id, param_no, param_label, status, ncc_merp, note)
          VALUES (${drugId}, ${f.param}, ${null}, ${f.status}, ${f.status === 'error' ? (f.ncc_merp || null) : null}, ${f.note || null})`;
      }
    }
    if (traceId) {
      await logEvent(traceId, 'med_audit_saved', null, { sessionId, drug_count: drugCount, error_count: errorCount, na_count: naCount, allergies_documented: p.allergies_documented || null }).catch(() => {});
      await setTraceQuestionPreview(traceId, `Medication chart audit · ${drugCount} drug(s), ${errorCount} error(s)`).catch(() => {});
      await finishTrace(traceId, 'success').catch(() => {});
    }
    return NextResponse.json({ ok: true, id: sessionId });
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
