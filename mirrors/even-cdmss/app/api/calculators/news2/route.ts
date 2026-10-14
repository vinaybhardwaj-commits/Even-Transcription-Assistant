import { NextRequest, NextResponse } from 'next/server';
import { computeNews2, elementDirectionLabels, type News2Inputs, type Consciousness } from '@/lib/calculators/math/news2';
import { startTrace, logEvent, finishTrace, tracedChat } from '@/lib/trace';
import { sql } from '@/lib/db';
import { INTERPRETATION_FALLBACKS } from '@/lib/calculators/static-fallbacks';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Body = {
  rr?: number;
  spo2_scale?: 1 | 2;
  spo2?: number;
  o2_supp?: boolean;
  temp_c?: number;
  sbp?: number;
  hr?: number;
  consciousness?: Consciousness;
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

  // Validate
  const { rr, spo2_scale, spo2, o2_supp, temp_c, sbp, hr, consciousness } = body;
  const requiredErrs: string[] = [];
  if (typeof rr !== 'number' || rr < 5 || rr > 60) requiredErrs.push('rr (5-60)');
  const spo2_scale_n = Number(spo2_scale); if (spo2_scale_n !== 1 && spo2_scale_n !== 2) requiredErrs.push('spo2_scale (1 or 2)');
  if (typeof spo2 !== 'number' || spo2 < 50 || spo2 > 100) requiredErrs.push('spo2 (50-100)');
  if (typeof o2_supp !== 'boolean') requiredErrs.push('o2_supp (boolean)');
  if (typeof temp_c !== 'number' || temp_c < 30 || temp_c > 43) requiredErrs.push('temp_c (30-43)');
  if (typeof sbp !== 'number' || sbp < 40 || sbp > 280) requiredErrs.push('sbp (40-280)');
  if (typeof hr !== 'number' || hr < 20 || hr > 250) requiredErrs.push('hr (20-250)');
  if (!consciousness || !'AVPUC'.includes(consciousness)) requiredErrs.push('consciousness (A|V|P|U|C)');
  if (requiredErrs.length) return NextResponse.json({ error: `invalid: ${requiredErrs.join(', ')}` }, { status: 400 });

  const inputs: News2Inputs = {
    rr: rr!, spo2_scale: spo2_scale_n as 1 | 2, spo2: spo2!, o2_supp: o2_supp!,
    temp_c: temp_c!, sbp: sbp!, hr: hr!, consciousness: consciousness!,
  };
  const det = computeNews2(inputs);

  // Banner derivation per PRD §4.2
  let banner: { tone: 'amber' | 'red'; text: string; cta?: { label: string; href: string } } | null = null;
  if (det.score >= 7) {
    banner = {
      tone: 'red',
      text: 'High-risk NEWS2 — emergency response. Think sepsis until proven otherwise.',
      cta: { label: 'Open sepsis 1-h bundle', href: '/calculators/sepsis-bundle' },
    };
  } else if (det.score >= 5) {
    banner = {
      tone: 'amber',
      text: 'Medium-risk NEWS2 — urgent review and consider critical-care input.',
      cta: { label: 'Coach me on deterioration recognition', href: '/coach?topic=deterioration%20recognition' },
    };
  }

  const traceId = await startTrace('news2', inputs, 1, {
    score: det.score,
    band: det.band,
    element_points: det.element_points,
    any_single_three: det.any_single_three,
    triggered_coach_banner: banner?.tone ?? null,
  });

  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  // llama 8b interpretation (band-aware, direction-aware)
  // PRD CALC.2 fixup: pre-classify each element by clinical direction so llama
  // can never describe 32°C as 'high temperature' or 35 bpm as 'tachycardia'.
  let interpretation = '';
  let llmFailed = false;
  try {
    const dir = elementDirectionLabels(inputs);
    const sys = `You are Even-CDMSS, an educational clinical companion. The user computed NEWS2 for a patient. Write a tight interpretation: one sentence naming the risk band and what it operationally means (monitoring frequency, escalation), then 2-4 short bullets covering: per-element drivers (which inputs contributed most — name the CLINICAL DIRECTION, e.g. "hypothermia" not "high temperature" for low temps), expected next actions per NICE NEWS2 algorithm, any red flags (single-parameter 3, sepsis pattern). When the patient is hypothermic, mention the differential (sepsis with paradoxical hypothermia, environmental exposure, hypothyroidism, sedative ingestion, hypoglycemia). No drug doses, no fluid rates, no first person, no apologies. NEVER mis-name a clinical direction — temperatures ≤36°C are HYPOTHERMIA, not high; HR ≤50 is BRADYCARDIA, not tachycardia.`;
    const user = `NEWS2 = ${det.score} (${det.band}${det.any_single_three ? ', single parameter scoring 3' : ''}).
Element points (each integer is NEWS2 SCORE contribution, not the underlying value):
  RR=${det.element_points.rr} pts (${dir.rr}, raw RR ${inputs.rr})
  SpO2=${det.element_points.spo2} pts (${dir.spo2}, raw ${inputs.spo2}%${inputs.o2_supp ? ' on O2' : ' on air'}, scale ${inputs.spo2_scale})
  O2 supp=${det.element_points.o2_supp} pts (${inputs.o2_supp ? 'on supplemental O2' : 'room air'})
  Temp=${det.element_points.temp} pts (${dir.temp}, raw ${inputs.temp_c}°C)
  SBP=${det.element_points.sbp} pts (${dir.sbp}, raw ${inputs.sbp})
  HR=${det.element_points.hr} pts (${dir.hr}, raw ${inputs.hr})
  Consciousness=${det.element_points.consciousness} pts (${dir.consciousness}, AVPU ${inputs.consciousness})
Write the interpretation paragraph then the bullets. Tie the explanation to the named clinical directions above — do not infer direction from the points value alone.`;

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
    interpretation = INTERPRETATION_FALLBACKS.news2({ score: det.score });
  }

  // Log to user_queries
  try {
    const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await sqlFn(
      `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
       VALUES ($1, 'news2', $2, $3, $4::jsonb, $5)`,
      [
        1,
        JSON.stringify(inputs),
        interpretation,
        JSON.stringify({
          score: det.score, band: det.band, element_points: det.element_points,
          any_single_three: det.any_single_three, triggered_coach_banner: banner?.tone ?? null,
        }),
        traceId,
      ],
    );
  } catch {}

  await finishTrace(traceId, llmFailed ? 'partial' : 'success');

  const result = {
    trace_id: traceId,
    deterministic: {
      score: det.score,
      band: det.band,
      element_points: det.element_points,
      any_single_three: det.any_single_three,
    },
    sections: [{ section: 'interpretation', text: interpretation, complete: true }],
    banner,
    llm_failed: llmFailed,
    computed_at: new Date().toISOString(),
  };

  if (body.idempotency_key) storeIdem(body.idempotency_key, result);

  return NextResponse.json(result, { headers: { 'X-Trace-Id': traceId } });
}
