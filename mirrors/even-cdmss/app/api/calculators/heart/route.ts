import { NextRequest, NextResponse } from 'next/server';
import { computeHeart, type HeartInputs, type HeartHistory, type HeartEcg, type HeartAge, type HeartRiskFactors, type HeartTroponin } from '@/lib/calculators/math/heart';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = Partial<HeartInputs> & { parent_trace_id?: string; idempotency_key?: string };

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

const HISTORY:      HeartHistory[]     = ['slightly_suspicious', 'moderately_suspicious', 'highly_suspicious'];
const ECG:          HeartEcg[]         = ['normal', 'non_specific_changes', 'significant_st_deviation'];
const AGE:          HeartAge[]         = ['lt_45', '45_to_64', 'ge_65'];
const RISK_FACTORS: HeartRiskFactors[] = ['none', '1_to_2', 'ge_3_or_known_cad'];
const TROPONIN:     HeartTroponin[]    = ['le_normal', '1_to_3x_normal', 'gt_3x_normal'];

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
  if (!body.history      || !HISTORY.includes(body.history))           errs.push('history');
  if (!body.ecg          || !ECG.includes(body.ecg))                   errs.push('ecg');
  if (!body.age          || !AGE.includes(body.age))                   errs.push('age');
  if (!body.risk_factors || !RISK_FACTORS.includes(body.risk_factors)) errs.push('risk_factors');
  if (!body.troponin     || !TROPONIN.includes(body.troponin))         errs.push('troponin');
  if (errs.length) return NextResponse.json({ error: `invalid: ${errs.join(', ')}` }, { status: 400 });

  const inputs = body as HeartInputs;
  const det = computeHeart(inputs);

  const traceId = await startTrace('heart', inputs, 1, { score: det.score, band: det.band });
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  const interpretation = `HEART = ${det.score}/10 — ${det.band_label}.`;

  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'heart', $2, $3, $4::jsonb, $5)`,
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
