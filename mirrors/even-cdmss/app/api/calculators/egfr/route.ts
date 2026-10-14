import { NextRequest, NextResponse } from 'next/server';
import { computeEgfr, umolLtoMgDl, type EgfrInputs, type Sex } from '@/lib/calculators/math/egfr';
import { startTrace, logEvent, finishTrace, tracedChat } from '@/lib/trace';
import { sql } from '@/lib/db';
import { INTERPRETATION_FALLBACKS } from '@/lib/calculators/static-fallbacks';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = {
  age?: number;
  sex?: Sex;
  scr?: number;
  scr_unit?: 'mg/dL' | 'umol/L';
  weight_kg?: number;
  displayed_equation?: 'ckd-epi-2021' | 'cockcroft-gault';   // UI default; both compute server-side
  parent_trace_id?: string;
  idempotency_key?: string;
};

// Simple in-process LRU for idempotency dedup (PRD §15.2). 5-min TTL.
// Cleared on every cold start, which is fine — double-click protection only.
const IDEMPOTENCY_CACHE = new Map<string, { result: unknown; expires: number }>();
function checkIdempotency(key: string): unknown | null {
  const hit = IDEMPOTENCY_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { IDEMPOTENCY_CACHE.delete(key); return null; }
  return hit.result;
}
function storeIdempotency(key: string, result: unknown) {
  IDEMPOTENCY_CACHE.set(key, { result, expires: Date.now() + 5 * 60 * 1000 });
  // Cheap cleanup: cap size at 500.
  if (IDEMPOTENCY_CACHE.size > 500) {
    const oldest = IDEMPOTENCY_CACHE.keys().next().value;
    if (oldest) IDEMPOTENCY_CACHE.delete(oldest);
  }
}

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  // Idempotency check (PRD §15.2)
  if (body.idempotency_key) {
    const cached = checkIdempotency(body.idempotency_key);
    if (cached) return NextResponse.json(cached);
  }

  // Validate
  const { age, sex, scr, scr_unit = 'mg/dL', weight_kg } = body;
  if (typeof age !== 'number' || age < 18 || age > 110) {
    return NextResponse.json({ error: 'age must be 18-110' }, { status: 400 });
  }
  if (sex !== 'F' && sex !== 'M') {
    return NextResponse.json({ error: 'sex must be F or M' }, { status: 400 });
  }
  if (typeof scr !== 'number' || scr <= 0) {
    return NextResponse.json({ error: 'scr required' }, { status: 400 });
  }
  const scr_mg_dl = scr_unit === 'umol/L' ? umolLtoMgDl(scr) : scr;
  if (scr_mg_dl < 0.1 || scr_mg_dl > 25) {
    return NextResponse.json({ error: 'scr out of physiological range' }, { status: 400 });
  }

  // Deterministic compute — never an LLM call.
  const inputs: EgfrInputs = { age, sex, scr_mg_dl, weight_kg };
  const det = computeEgfr(inputs);

  // Start trace.
  const traceId = await startTrace('egfr', {
    age, sex, scr_mg_dl, weight_kg, scr_unit,
    displayed_equation: body.displayed_equation ?? 'ckd-epi-2021',
  }, /* userId */ 1, {
    // PRD §5.5 meta
    equation: body.displayed_equation ?? 'ckd-epi-2021',
    ckdepi_egfr: det.ckdepi_2021,
    cg_crcl: det.cockcroft_gault,
    stage: det.stage,
    pushed_to_drugs_ctx: true,
  });

  // Parent trace linking (PRD §15.3)
  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  // LLM interpretation (llama 8b, target <2.5s per PRD §4.1)
  // Falls back to static interpretation on bridge error.
  let interpretation = '';
  let llmFailed = false;
  try {
    const sys = `You are Even-CDMSS, an educational clinical companion. The user computed eGFR for a patient. Write a tight clinical interpretation: one paragraph naming the CKD stage and what it clinically means (no drug doses, no fluid rates), then 3 short management bullets (one line each — what to change/avoid/refer). Be terse and specific. No first person. No apologies.`;
    const user = `Patient: ${age} y/o ${sex === 'F' ? 'female' : 'male'}, SCr ${scr_mg_dl} mg/dL${weight_kg ? `, ${weight_kg} kg` : ''}.
Computed: CKD-EPI 2021 = ${det.ckdepi_2021} mL/min/1.73 m² (stage ${det.stage}).${det.cockcroft_gault !== null ? ` Cockcroft-Gault = ${det.cockcroft_gault} mL/min.` : ''}
Write the interpretation paragraph then the 3 bullets. Use "- " bullets.`;

    const resp = await tracedChat(traceId, 'interpretation', {
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 400,
      options: { num_ctx: 4096 },
    });
    interpretation = resp.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (e) {
    await logEvent(traceId, 'llm_error', 'interpretation', { error: String((e as Error).message) });
    llmFailed = true;
  }

  if (!interpretation) {
    interpretation = INTERPRETATION_FALLBACKS.egfr({
      ckdepi_2021_ml_min_173: det.ckdepi_2021,
      stage: det.stage,
    });
  }

  // Pushed-to-context payload (sessionStorage on the client; per PRD §8.1)
  const pushed_to_context = {
    target: 'drugs',
    renal_ctx: {
      ckdepi_2021_ml_min_173: det.ckdepi_2021,
      cg_crcl_ml_min: det.cockcroft_gault,
      stage: det.stage,
      conservative_for_nti: det.conservative_for_nti,
      displayed_equation: body.displayed_equation ?? 'ckd-epi-2021',
      computed_at: new Date().toISOString(),
      source_trace_id: traceId,
    },
  };

  // Log to user_queries (digest engine; PRD §5.7 + §17.2)
  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, pushed_to_context, session_id)
       VALUES ($1, 'egfr', $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        1,
        JSON.stringify({ age, sex, scr_mg_dl, weight_kg }),
        interpretation,
        JSON.stringify({
          equation: body.displayed_equation ?? 'ckd-epi-2021',
          ckdepi_egfr: det.ckdepi_2021,
          cg_crcl: det.cockcroft_gault,
          stage: det.stage,
          conservative_for_nti: det.conservative_for_nti,
        }),
        JSON.stringify(pushed_to_context),
        traceId,
      ],
    );
  } catch {}

  await finishTrace(traceId, llmFailed ? 'partial' : 'success');

  const result = {
    trace_id: traceId,
    deterministic: {
      ckdepi_2021_ml_min_173: det.ckdepi_2021,
      cg_crcl_ml_min: det.cockcroft_gault,
      stage: det.stage,
      conservative_for_nti: det.conservative_for_nti,
      displayed_equation: body.displayed_equation ?? 'ckd-epi-2021',
    },
    sections: [
      {
        section: 'interpretation',
        text: interpretation,
        complete: true,
      },
    ],
    pushed_to_context,
    llm_failed: llmFailed,
    computed_at: new Date().toISOString(),
  };

  if (body.idempotency_key) storeIdempotency(body.idempotency_key, result);

  return NextResponse.json(result, {
    headers: { 'X-Trace-Id': traceId },
  });
}
