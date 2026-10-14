import { NextRequest, NextResponse } from 'next/server';
import { computeBundle, type SepsisBundleInputs } from '@/lib/calculators/math/sepsis-bundle';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Main bundle compute. No LLM on the main path (locked decision #13: sidebar is opt-in).
// Returns immediately with deterministic state. Frontend polls / re-submits as the clock ticks.
export async function POST(req: NextRequest) {
  let body: SepsisBundleInputs & { parent_trace_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  // Validate
  if (!body.recognition_time) return NextResponse.json({ error: 'recognition_time required (ISO datetime)' }, { status: 400 });
  if (Number.isNaN(new Date(body.recognition_time).getTime())) {
    return NextResponse.json({ error: 'recognition_time must be a valid ISO datetime' }, { status: 400 });
  }
  for (const k of ['lactate_done', 'cultures_done', 'abx_given', 'hypotension_or_lactate_high', 'fluids_done', 'vasopressors_started'] as const) {
    if (typeof body[k] !== 'boolean') return NextResponse.json({ error: `${k} must be boolean` }, { status: 400 });
  }

  const result = computeBundle(body);

  const traceId = await startTrace('sepsis_bundle', body, 1, {
    elapsed_min: result.elapsed_min,
    compliance_pct: result.compliance_pct,
    elements_complete: result.complete_required_count,
    elements_required: result.required_count,
    banner_tone: result.banner?.tone ?? null,
    qsofa: body.qsofa ?? null,
    sofa: body.sofa ?? null,
  });

  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  // Log to user_queries (digest)
  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'sepsis_bundle', $2, $3, $4::jsonb, $5)`,
      [
        1,
        JSON.stringify(body),
        `bundle ${result.compliance_pct}% at ${result.elapsed_min}min`,
        JSON.stringify({
          elapsed_min: result.elapsed_min,
          compliance_pct: result.compliance_pct,
          elements_complete: result.complete_required_count,
          elements_required: result.required_count,
          bundle_complete: result.bundle_complete,
          banner_tone: result.banner?.tone ?? null,
          educational_sidebar_opened: false,
        }),
        traceId,
      ],
    );
  } catch {}

  await finishTrace(traceId, 'success');

  return NextResponse.json({ trace_id: traceId, deterministic: result }, {
    headers: { 'X-Trace-Id': traceId },
  });
}
