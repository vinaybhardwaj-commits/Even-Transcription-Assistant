import { NextRequest, NextResponse } from 'next/server';
import { analyzeCase } from '@/lib/doc-audit';
import { normDocType, parseStatusList, normAdminFacts, parseAftercare, type DocType, type ExtractedCase } from '@/lib/doc-audit-core';
import { makeNdjsonStream, ndjsonHeaders, type Stage } from '@/lib/stream';
import { rightCareStateEnabled, rightCareGroundingEnabled, patientPictureBlock } from '@/lib/right-care-state';
import { extractedCaseToState } from '@/lib/clinical-state/to-audit-family';
import { clinicalStateResultField } from '@/lib/clinical-state/ui-view';
import { stateCounts, type ClinicalState } from '@/lib/clinical-state/schema';
import { logEvent } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 800;

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function strOrNull(v: unknown): string | null { const s = str(v); return s ? s : null; }
function strArr(v: unknown, cap = 30): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap);
}

// POST /api/doc-audit/analyze — runs the audit on a (possibly clinician-edited) extracted case.
// Body: { extracted: ExtractedCase }
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const e = (body.extracted ?? {}) as Record<string, unknown>;
  const docType: DocType = normDocType(e.docType);
  const p = (e.patient && typeof e.patient === 'object') ? e.patient as Record<string, unknown> : {};
  const ageN = Number(p.age);
  const sex = str(p.sex).toLowerCase();

  const courseSummary = str(e.courseSummary);
  const hasContent = courseSummary || str(e.diagnosis) || str(e.procedure) || strArr(e.medications).length || strArr(e.investigations).length;
  if (!hasContent) {
    return NextResponse.json({ ok: false, error: 'nothing to analyze — the extracted case is empty' }, { status: 400 });
  }

  const extracted: ExtractedCase = {
    docType,
    detectedDocType: normDocType(e.detectedDocType ?? e.docType),
    confidence: Number.isFinite(Number(e.confidence)) ? Math.max(0, Math.min(1, Number(e.confidence))) : 0.5,
    patient: {
      age: Number.isFinite(ageN) && ageN > 0 && ageN < 130 ? Math.round(ageN) : undefined,
      sex: sex ? (sex.startsWith('m') ? 'male' : sex.startsWith('f') ? 'female' : sex) : undefined,
    },
    diagnosis: strOrNull(e.diagnosis),
    indication: strOrNull(e.indication),
    procedure: strOrNull(e.procedure),
    investigations: strArr(e.investigations),
    treatments: strArr(e.treatments),
    medications: strArr(e.medications),
    courseSummary,
    disposition: strOrNull(e.disposition),
    followUp: strOrNull(e.followUp),
    rawNotes: str(e.rawNotes).slice(0, 1000),
    // Document-grounded completeness + non-identifying stay facts: produced by the extract
    // pass (which saw the file) and posted back here so "Re-analyze with edits" — which
    // deliberately skips re-reading the document — keeps them instead of regressing to all-missing.
    completeness: parseStatusList(e.completeness),
    adminFacts: normAdminFacts(e.adminFacts),
    // PX (PRD v1.0 §6.3): carry the two additive extract fields through the rebuild —
    // without these the prognosis pass would silently see an empty plan (found in G0 review).
    riskFactors: strArr(e.riskFactors, 12),
    aftercare: parseAftercare(e.aftercare),
  };

  // Stream NDJSON progress (live pipeline bar), then a single {type:'result'} with the
  // audit report, then {type:'done'}. PHI posture unchanged: analyzeCase keeps its
  // untraced LLM path + redacted server trace; the stream only carries progress + report.
  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();

  (async () => {
    try {
      // Slice 2 (RIGHT_CARE_CLINICAL_STATE_GROUND): adapt the case to a state BEFORE the
      // analyze pass and inject the PATIENT PICTURE into its prompt. Near-redundant here —
      // the analyze pass already reasons over the structured ExtractedCase the state is
      // derived from — wired for cross-mode consistency; the A/B expects ≈ zero delta.
      // Flag off (the shipped default) → inert: build order and prompt exactly Slice 1.
      let state: ClinicalState | null = null;
      if (rightCareGroundingEnabled()) {
        try { state = extractedCaseToState(extracted); } catch { state = null; }
      }

      const { report, traceId } = await analyzeCase(extracted, {}, {
        forceOllama: body.providerOverride === 'ollama',   // lab probe: analyze + prognosis on the free mini
        onProgress: (stage, msg) => emit({ type: 'progress', stage: stage as Stage, msg, ms: Date.now() - t0 }),
        ...(state ? { clinicalStateText: patientPictureBlock(state) } : {}),
      });

      // Right Care × ClinicalState Slice 1: adapt the ALREADY-EXTRACTED, de-identified case to
      // a ClinicalState (no new extraction pass). Fail-open + inert with the flag off. Trace
      // carries COUNTS ONLY — the doc-audit trace's cardinal redaction rule (never the extracted
      // case) outranks the DDx pattern of logging the full state; the state itself persists in
      // appropriateness_runs.clinical_state instead (Part C).
      if (rightCareStateEnabled()) {
        try {
          const grounded = !!state;   // Slice 2 pre-built it before the analyze pass
          if (!state) state = extractedCaseToState(extracted);
          if (traceId) {
            await logEvent(traceId, 'clinical_state_extracted', null, { ok: true, grounded, counts: stateCounts(state) }).catch(() => {});
          }
        } catch { state = null; }
      }

      if (!report) {
        emit({ type: 'result', data: { ok: false, error: 'analysis could not be completed — please retry', traceId } });
      } else {
        emit({ type: 'result', data: {
          ok: true, report, traceId,
          ...clinicalStateResultField(state, 0, process.env.CLINICAL_STATE_UI === '1'),
        } });
      }
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (err) {
      emit({ type: 'error', message: String((err as Error).message) });
    } finally {
      close();
    }
  })();

  return new Response(stream, { headers: ndjsonHeaders() });
}
