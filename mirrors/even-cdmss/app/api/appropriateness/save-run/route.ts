import { NextRequest, NextResponse } from 'next/server';
import { saveRun, type RunMode } from '@/lib/appropriateness-runs';
import { rightCareStateEnabled, stateForRun } from '@/lib/right-care-state';
import { recordAuditLinkEnabled, parseMemberLink, saveMemberLink } from '@/lib/record-audit-link-store';

export const runtime = 'nodejs';

const MODES = new Set<RunMode>(['check', 'pathway', 'audit']);
const MAX_OUTPUT_CHARS = 600_000;

// POST /api/appropriateness/save-run — persist a COMPLETED run for research retention.
// Body: { mode, scenario?, docType?, input?, output }. Counts + summary are derived
// server-side from output. Anonymous; output is expected DE-IDENTIFIED (case-audit
// extractor already strips name/UHID). Soft-fails so it never breaks the UX.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const mode = String(body.mode ?? '') as RunMode;
  if (!MODES.has(mode)) return NextResponse.json({ ok: false, error: 'invalid mode' }, { status: 400 });

  const output = body.output;
  if (!output || typeof output !== 'object') return NextResponse.json({ ok: false, error: 'output required' }, { status: 400 });
  if (JSON.stringify(output).length > MAX_OUTPUT_CHARS) {
    return NextResponse.json({ ok: false, error: 'output too large' }, { status: 413 });
  }

  const o = output as Record<string, unknown>;
  const scenario = typeof body.scenario === 'string' ? body.scenario : null;
  const docType = typeof body.docType === 'string' ? body.docType : null;

  // Derive counts + a short summary from the output shape (per mode).
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const valueAnalysis = o.valueAnalysis as { interventions?: unknown[] } | undefined;
  const enrichment = o.enrichment as { nodes?: unknown[] } | undefined;
  const report = o.report as { findings?: unknown[]; completeness?: { coverage?: number }; sources?: unknown[] } | undefined;

  // "Cited" = the distinct sources the output actually referenced (varies by case),
  // NOT the fixed retrieval pool (always topK=8). Union of citation_ids across the
  // interventions / pathway nodes / audit findings.
  const citedIds = new Set<number>();
  const collectCites = (items: unknown[]) => {
    for (const it of items) {
      const c = (it as { citation_ids?: unknown } | null)?.citation_ids;
      if (Array.isArray(c)) for (const n of c) if (typeof n === 'number') citedIds.add(n);
    }
  };
  collectCites(arr(valueAnalysis?.interventions));
  collectCites(arr(enrichment?.nodes));
  collectCites(arr(report?.findings));
  const nSources = citedIds.size;
  const nFindings = arr(valueAnalysis?.interventions).length || arr(enrichment?.nodes).length || arr(report?.findings).length || 0;

  let summary = '';
  if (mode === 'check') {
    const first = (valueAnalysis?.interventions?.[0] ?? {}) as { intervention?: string; net_value?: string };
    summary = `Appropriateness check — ${nFindings} intervention(s)${first.net_value ? `, lead verdict ${first.net_value}` : ''}`;
  } else if (mode === 'pathway') {
    const sk = o.skeleton as { workingDiagnosis?: string | null; stages?: unknown[] } | undefined;
    summary = `Pathway — ${arr(sk?.stages).length} stages${sk?.workingDiagnosis ? ` for ${sk.workingDiagnosis}` : ''}`;
  } else {
    const cov = report?.completeness?.coverage;
    summary = `Case audit (${docType ?? 'document'}) — coverage ${cov != null ? Math.round(cov * 100) + '%' : '—'}, ${nFindings} finding(s)`;
  }

  // Right Care × ClinicalState Slice 1 (Part C): reconstruct the state SERVER-SIDE from the
  // run's own de-identified input through the same pure builders the mode used — a client-
  // supplied state blob is never trusted. Flag off (or any failure) → null → the pre-0011
  // INSERT runs and the row is byte-identical to today.
  const clinicalState = rightCareStateEnabled() ? stateForRun(mode, body.input ?? null) : null;

  const id = await saveRun({
    mode,
    scenario: scenario ? scenario.slice(0, 2000) : (mode === 'audit' ? summary : null),
    docType,
    summary,
    nSources,
    nFindings,
    input: body.input ?? null,
    output,
    deIdentified: true,
    clinicalState,
  });

  if (!id) return NextResponse.json({ ok: false, error: 'could not save run' }, { status: 200 });

  // Member linkage (audit only, double-gated): the identity key captured by the extract
  // route's dedicated identity-only pass, stored in its own table alongside — never inside —
  // the de-identified run row. Best-effort: a linkage failure never fails the save.
  if (mode === 'audit' && recordAuditLinkEnabled()) {
    const link = parseMemberLink(body.memberLink);
    if (link) await saveMemberLink(id, link);
  }

  return NextResponse.json({ ok: true, runId: id });
}
