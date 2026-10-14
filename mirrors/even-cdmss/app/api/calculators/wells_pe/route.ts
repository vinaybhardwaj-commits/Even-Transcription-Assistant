import { NextRequest, NextResponse } from 'next/server';
import { computeWellsPe, type WellsPeInputs } from '@/lib/calculators/math/wells_pe';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = Partial<WellsPeInputs> & { parent_trace_id?: string; idempotency_key?: string };

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

const KEYS: (keyof WellsPeInputs)[] = [
  'dvt_signs', 'pe_most_likely_dx', 'hr_gt_100',
  'immob_or_surgery', 'prior_dvt_or_pe', 'hemoptysis', 'malignancy',
];

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
  for (const k of KEYS) if (typeof body[k] !== 'boolean') errs.push(k);
  if (errs.length) return NextResponse.json({ error: `invalid: ${errs.join(', ')}` }, { status: 400 });

  const inputs = body as WellsPeInputs;
  const det = computeWellsPe(inputs);

  const traceId = await startTrace('wells_pe', inputs, 1, {
    score: det.score, three_tier: det.three_tier, two_tier: det.two_tier,
  });
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  // Show both bands in the headline interpretation per spec.
  const interpretation = `Wells PE = ${det.score} — ${det.three_tier_label}. Two-tier rule: ${det.two_tier_label}.`;

  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'wells_pe', $2, $3, $4::jsonb, $5)`,
      [1, JSON.stringify(inputs), interpretation,
       JSON.stringify({
         score: det.score, three_tier: det.three_tier, two_tier: det.two_tier,
       }), traceId],
    );
  } catch {}

  await finishTrace(traceId, 'success');

  const result = {
    trace_id: traceId,
    deterministic: {
      score: det.score,
      three_tier: det.three_tier, three_tier_label: det.three_tier_label,
      two_tier: det.two_tier, two_tier_label: det.two_tier_label,
    },
    sections: [{ section: 'interpretation', text: interpretation, complete: true }],
    computed_at: new Date().toISOString(),
  };
  if (body.idempotency_key) storeIdem(body.idempotency_key, result);
  return NextResponse.json(result, { headers: { 'X-Trace-Id': traceId } });
}
