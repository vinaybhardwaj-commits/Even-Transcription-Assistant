import { NextRequest, NextResponse } from 'next/server';
import {
  computeSofa, type SofaInputs, type SofaResp, type SofaCoag, type SofaLiver,
  type SofaCv, type SofaCns, type SofaRenal,
} from '@/lib/calculators/math/sofa';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = Partial<SofaInputs> & { parent_trace_id?: string; idempotency_key?: string };

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

const RESP:  SofaResp[]  = ['gt_400', '301_400', '201_300', '101_200_mv', 'le_100_mv'];
const COAG:  SofaCoag[]  = ['gt_150', '101_150', '51_100', '21_50', 'le_20'];
const LIVER: SofaLiver[] = ['lt_1_2', '1_2_to_1_9', '2_0_to_5_9', '6_0_to_11_9', 'gt_12'];
const CV:    SofaCv[]    = ['map_ge_70', 'map_lt_70', 'dopamine_le_5_or_dobutamine',
                            'dopamine_gt_5_or_norepi_le_0_1', 'dopamine_gt_15_or_norepi_gt_0_1'];
const CNS:   SofaCns[]   = ['15', '13_14', '10_12', '6_9', 'lt_6'];
const RENAL: SofaRenal[] = ['lt_1_2', '1_2_to_1_9', '2_0_to_3_4',
                            '3_5_to_4_9_or_uo_lt_500', 'gt_5_or_uo_lt_200'];

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
  if (!body.respiration    || !RESP.includes(body.respiration))         errs.push('respiration');
  if (!body.coagulation    || !COAG.includes(body.coagulation))         errs.push('coagulation');
  if (!body.liver          || !LIVER.includes(body.liver))              errs.push('liver');
  if (!body.cardiovascular || !CV.includes(body.cardiovascular))        errs.push('cardiovascular');
  if (!body.cns            || !CNS.includes(body.cns))                  errs.push('cns');
  if (!body.renal          || !RENAL.includes(body.renal))              errs.push('renal');
  if (typeof body.qsofa_rr_ge_22       !== 'boolean') errs.push('qsofa_rr_ge_22');
  if (typeof body.qsofa_altered_mental !== 'boolean') errs.push('qsofa_altered_mental');
  if (typeof body.qsofa_sbp_le_100     !== 'boolean') errs.push('qsofa_sbp_le_100');
  if (errs.length) return NextResponse.json({ error: `invalid: ${errs.join(', ')}` }, { status: 400 });

  const inputs = body as SofaInputs;
  const det = computeSofa(inputs);

  const traceId = await startTrace('sofa', inputs, 1, {
    score: det.score, band: det.band, qsofa_positive: det.qsofa_positive,
  });
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  const interpretation = `SOFA = ${det.score}/24 — ${det.band_label}.` +
    (det.qsofa_positive ? ` qSOFA POSITIVE (${det.qsofa_score}/3) — bedside high-risk-for-mortality flag.` : '');

  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'sofa', $2, $3, $4::jsonb, $5)`,
      [1, JSON.stringify(inputs), interpretation,
       JSON.stringify({
         score: det.score, band: det.band, element_points: det.element_points,
         qsofa_score: det.qsofa_score, qsofa_positive: det.qsofa_positive,
       }), traceId],
    );
  } catch {}

  await finishTrace(traceId, 'success');

  const result = {
    trace_id: traceId,
    deterministic: {
      score: det.score, band: det.band, band_label: det.band_label,
      element_points: det.element_points,
      qsofa_score: det.qsofa_score, qsofa_positive: det.qsofa_positive,
    },
    sections: [{ section: 'interpretation', text: interpretation, complete: true }],
    computed_at: new Date().toISOString(),
  };
  if (body.idempotency_key) storeIdem(body.idempotency_key, result);
  return NextResponse.json(result, { headers: { 'X-Trace-Id': traceId } });
}
