import { NextRequest, NextResponse } from 'next/server';
import { computeAbcd2, type Abcd2Inputs, type Abcd2ClinicalFeature, type Abcd2Duration } from '@/lib/calculators/math/abcd2';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = Partial<Abcd2Inputs> & { parent_trace_id?: string; idempotency_key?: string };

const IDEMP = new Map<string, { result: unknown; expires: number }>();
function checkIdem(k: string) {
  const h = IDEMP.get(k); if (!h) return null;
  if (Date.now() > h.expires) { IDEMP.delete(k); return null; }
  return h.result;
}
function storeIdem(k: string, r: unknown) {
  IDEMP.set(k, { result: r, expires: Date.now() + 5 * 60 * 1000 });
  if (IDEMP.size > 500) { const x = IDEMP.keys().next().value; if (x) IDEMP.delete(x); }
}

const CLINICAL_OPTIONS: Abcd2ClinicalFeature[] = ['unilateral_weakness', 'speech_disturbance_no_weakness', 'other'];
const DURATION_OPTIONS: Abcd2Duration[]        = ['ge_60min', '10_to_59min', 'lt_10min'];

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  if (body.idempotency_key) {
    const cached = checkIdem(body.idempotency_key);
    if (cached) return NextResponse.json(cached);
  }

  const errs: string[] = [];
  if (typeof body.age_ge_60 !== 'boolean')   errs.push('age_ge_60');
  if (typeof body.bp_ge_140_90 !== 'boolean')errs.push('bp_ge_140_90');
  if (!body.clinical || !CLINICAL_OPTIONS.includes(body.clinical)) errs.push('clinical');
  if (!body.duration || !DURATION_OPTIONS.includes(body.duration)) errs.push('duration');
  if (typeof body.diabetes !== 'boolean')    errs.push('diabetes');
  if (errs.length) return NextResponse.json({ error: `invalid: ${errs.join(', ')}` }, { status: 400 });

  const inputs = body as Abcd2Inputs;
  const det = computeAbcd2(inputs);

  const traceId = await startTrace('abcd2', inputs, 1, { score: det.score, band: det.band });
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  const interpretation = `ABCD² = ${det.score}/7 — ${det.band_label}.`;

  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'abcd2', $2, $3, $4::jsonb, $5)`,
      [1, JSON.stringify(inputs), interpretation,
       JSON.stringify({ score: det.score, band: det.band, element_points: det.element_points }), traceId],
    );
  } catch {}

  await finishTrace(traceId, 'success');

  const result = {
    trace_id: traceId,
    deterministic: {
      score: det.score, band: det.band, band_label: det.band_label,
      element_points: det.element_points,
    },
    sections: [{ section: 'interpretation', text: det.band_label, complete: true }],
    computed_at: new Date().toISOString(),
  };
  if (body.idempotency_key) storeIdem(body.idempotency_key, result);
  return NextResponse.json(result, { headers: { 'X-Trace-Id': traceId } });
}
