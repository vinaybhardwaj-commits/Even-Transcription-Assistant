import { NextRequest, NextResponse } from 'next/server';
import { computeQtc, type QtcInputs, type QtcSex } from '@/lib/calculators/math/qtc';
import { startTrace, finishTrace } from '@/lib/trace';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = {
  qt_ms?:  number;
  hr_bpm?: number;
  rr_ms?:  number;
  sex?:    QtcSex;
  parent_trace_id?: string;
  idempotency_key?: string;
};

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
  if (typeof body.qt_ms !== 'number' || body.qt_ms < 200 || body.qt_ms > 700) errs.push('qt_ms (200-700)');
  const hasHr = typeof body.hr_bpm === 'number' && body.hr_bpm >= 30 && body.hr_bpm <= 200;
  const hasRr = typeof body.rr_ms  === 'number' && body.rr_ms  >= 200 && body.rr_ms  <= 3000;
  if (!hasHr && !hasRr) errs.push('hr_bpm (30-200) OR rr_ms (200-3000)');
  if (body.sex !== 'M' && body.sex !== 'F') errs.push('sex (M|F)');
  if (errs.length) return NextResponse.json({ error: `invalid: ${errs.join(', ')}` }, { status: 400 });

  const inputs: QtcInputs = {
    qt_ms:  body.qt_ms!,
    hr_bpm: hasHr ? body.hr_bpm : undefined,
    rr_ms:  hasRr ? body.rr_ms  : undefined,
    sex:    body.sex!,
  };
  const det = computeQtc(inputs);

  const traceId = await startTrace('qtc', inputs, 1, {
    bazett_ms: det.bazett_ms, band: det.band, high_tdp_risk: det.high_tdp_risk,
  });
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  const interpretation = `Bazett ${det.bazett_ms} ms — ${det.band_label}. Fridericia ${det.fridericia_ms} ms. Framingham ${det.framingham_ms} ms.` +
    (det.high_tdp_risk ? ' High TdP risk — review QT-prolonging drugs.' : '');

  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'qtc', $2, $3, $4::jsonb, $5)`,
      [1, JSON.stringify(inputs), interpretation,
       JSON.stringify({
         bazett_ms: det.bazett_ms, fridericia_ms: det.fridericia_ms, framingham_ms: det.framingham_ms,
         band: det.band, high_tdp_risk: det.high_tdp_risk,
       }), traceId],
    );
  } catch {}

  await finishTrace(traceId, 'success');

  const result = {
    trace_id: traceId,
    deterministic: {
      rr_sec: det.rr_sec,
      bazett_ms: det.bazett_ms, fridericia_ms: det.fridericia_ms, framingham_ms: det.framingham_ms,
      band: det.band, band_label: det.band_label,
      high_tdp_risk: det.high_tdp_risk,
    },
    sections: [{ section: 'interpretation', text: interpretation, complete: true }],
    computed_at: new Date().toISOString(),
  };
  if (body.idempotency_key) storeIdem(body.idempotency_key, result);
  return NextResponse.json(result, { headers: { 'X-Trace-Id': traceId } });
}
