import { NextRequest, NextResponse } from 'next/server';
import { computeNihss, type NihssInputs } from '@/lib/calculators/math/nihss';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = Partial<NihssInputs> & { parent_trace_id?: string; idempotency_key?: string };

// Idempotency LRU — matches NEWS2 pattern (5-min TTL, 500-entry cap).
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

// Per-field integer range guards. Every NIHSS item is an integer enum.
const RANGES: Record<keyof NihssInputs, number> = {
  loc: 3, loc_questions: 2, loc_commands: 2,
  gaze: 2, visual_fields: 3, facial_palsy: 3,
  motor_arm_left: 4, motor_arm_right: 4, motor_leg_left: 4, motor_leg_right: 4,
  limb_ataxia: 2, sensory: 2, language: 3, dysarthria: 2, extinction: 2,
};

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  if (body.idempotency_key) {
    const cached = checkIdem(body.idempotency_key);
    if (cached) return NextResponse.json(cached);
  }

  // Validate each item is an integer 0..max.
  const errs: string[] = [];
  for (const key of Object.keys(RANGES) as Array<keyof NihssInputs>) {
    const v = body[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > RANGES[key]) {
      errs.push(`${key} (0-${RANGES[key]})`);
    }
  }
  if (errs.length) return NextResponse.json({ error: `invalid: ${errs.join(', ')}` }, { status: 400 });

  const inputs = body as NihssInputs;
  const det = computeNihss(inputs);

  const traceId = await startTrace('nihss', inputs, 1, {
    score: det.score, band: det.band,
  });
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  const interpretation = `NIHSS = ${det.score}/42 — ${det.band_label}.`;

  // Log to user_queries digest engine.
  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'nihss', $2, $3, $4::jsonb, $5)`,
      [1, JSON.stringify(inputs), interpretation,
       JSON.stringify({ score: det.score, band: det.band }), traceId],
    );
  } catch {}

  await finishTrace(traceId, 'success');

  const result = {
    trace_id: traceId,
    deterministic: { score: det.score, band: det.band, band_label: det.band_label },
    sections: [{ section: 'interpretation', text: det.band_label, complete: true }],
    computed_at: new Date().toISOString(),
  };
  if (body.idempotency_key) storeIdem(body.idempotency_key, result);
  return NextResponse.json(result, { headers: { 'X-Trace-Id': traceId } });
}
