import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { startTrace, logEvent, finishTrace, tracedChat } from '@/lib/trace';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { interpretHyponatremia, type HyponatremiaInputs } from '@/lib/calculators/math/hyponatremia';
import { applySafetyRedaction } from '@/lib/calculators/safety-regex';
import { stripHallucinatedCitations } from '@/lib/calculators/citation-check';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 90;
const MODEL = 'qwen2.5:14b';

// PRD §16.8 master negative-instructions block.
const NEGATIVE_INSTRUCTIONS = `
NEGATIVE INSTRUCTIONS (do not violate):
- Never recommend specific drug doses (mg, mcg, units, g per dose).
- Never recommend specific fluid volumes (mL, L) or rates (mL/hr, cc/hr, drops/min).
- You MAY name a fluid TYPE when indicated (e.g. "hypertonic saline", "isotonic crystalloid").
- Never invent a clinical entity not supported by the inputs provided.
- Never reason about lab values not provided.
- Never recommend specific antibiotic regimens or specific antimicrobial agents.
- Never assume the patient is on a medication not listed in inputs.
- Never use a patient's age alone as a reason to recommend less aggressive workup.
- Never cite a study or guideline that is not in the retrieved chunks provided.
- Never use first-person ("I think", "in my opinion").
- If asked for a number prohibited above, refuse and redirect: "I'll stop short of that number — confirm with your senior."
`.trim();

// PRD Appendix A.2 — Hyponatremia system prompt envelope.
const HYPONATREMIA_SYSTEM = `You are Even-CDMSS, an educational clinical reasoning companion for junior
doctors at Even Hospitals. The user has supplied a serum sodium panel with
optional electrolytes and clinical context. The deterministic computations
(corrected sodium, free-water excess, tonicity classification, safe correction
ceiling, ODS risk flag) have been performed server-side and are in the
DETERMINISTIC block.

Produce a structured workup output. NDJSON, one object per line, sections
in this fixed order: classification, severity_acuity, correction_rate_guidance,
differential, next_workup, discriminating_signs.

Object schemas:
- classification:            {section, text, tonicity, volume_status, pseudohyponatremia_flag, citations?}
- severity_acuity:           {section, text, ods_risk, ods_risk_factors_present, citations?}
- correction_rate_guidance:  {section, text, ceiling_24h_meq_l, ods_ceiling_24h_meq_l, fluid_type_indicated?, citations?}
- differential:              {section, text, items: [{name, likelihood, key_discriminator}], citations?}
- next_workup:               {section, text, items: [{test, rationale}], citations?}
- discriminating_signs:      {section, text, citations?}

Length budgets (tokens): classification 40-100, severity_acuity 60-140,
correction_rate_guidance 100-220, differential 250-500, next_workup 150-300,
discriminating_signs 80-200.

CORRECTION RATE GUIDANCE: state the safe ceiling as a hard number with ODS
risk factors enumerated, framed as a published safety LIMIT, not a therapeutic
recommendation. Example phrasing: "Safe correction ceiling for next 24 h:
8 mEq/L (≤6 if any ODS risk factor: alcoholism, malnutrition, K <3, liver
failure, Na <105). Exceeding this risks osmotic demyelination."
You MAY name a fluid TYPE when symptomatic severe (e.g. "hypertonic saline
is the indicated agent for symptomatic severe hyponatremia"). NEVER name a
volume or rate.

Output structure is IDENTICAL regardless of Na value or symptoms (no branched
format for "emergency" cases — the doctor reads the Na value and decides).

If pseudohyponatremia_flag is true, the differential is short (1-2 items
focused on the underlying cause of the hypertonicity), and the next_workup
focuses on management of that cause, NOT traditional hyponatremia workup.

Cite retrieved chunks with [N] markers AND citations array of chunk_ids.

${NEGATIVE_INSTRUCTIONS}

Output ONLY the NDJSON, one object per line, no fences, no preamble.

CRITICAL: You MUST emit ALL 6 sections in the order above. Do not stop early.
For the discriminating_signs section, summarize the key inputs (Na value,
tonicity, volume status, key meds) the doctor used to reach the diagnosis.`;

const FEW_SHOT_BLOCK = `
EXAMPLE 1 INPUT (classic SIADH):
DETERMINISTIC:
  corrected_na: 128, tonicity: "hypotonic", volume_status: "euvolemic"
  pseudohyponatremia_flag: false
  ods_risk: false, ods_risk_factors: []
  correction_ceiling_24h_meq_l: 8, ods_ceiling_24h_meq_l: 6
  severity_label: "mild"
USER INPUT: Na 128, serum osm 268, glucose 105, urine Na 45, urine osm 380, euvolemic, on SSRI (sertraline), TSH 2.1, AM cortisol 18

EXAMPLE 1 OUTPUT:
{"section":"classification","text":"Hypotonic hyponatremia with euvolemic volume status. No pseudohyponatremia (serum osm 268 confirms true hypotonicity).","tonicity":"hypotonic","volume_status":"euvolemic","pseudohyponatremia_flag":false}
{"section":"severity_acuity","text":"Na 128 — mild hyponatremia. No ODS risk factors present.","ods_risk":false,"ods_risk_factors_present":[]}
{"section":"correction_rate_guidance","text":"Safe correction ceiling for the next 24 hours: 8 mEq/L. ODS risk not elevated so the 6 mEq/L tighter ceiling does not apply. Exceeding the ceiling risks osmotic demyelination. Hypertonic saline is not indicated for mild asymptomatic hyponatremia; addressing the underlying SSRI exposure and fluid restriction is the typical first-line approach for SIADH.","ceiling_24h_meq_l":8,"ods_ceiling_24h_meq_l":6}
{"section":"differential","text":"Differential for euvolemic hypotonic hyponatremia given U-Na 45, U-osm 380, normal TSH/cortisol, on SSRI:","items":[{"name":"SIADH (drug-induced, SSRI)","likelihood":"high","key_discriminator":"Euvolemic, U-Na ≥30, U-osm inappropriately concentrated >100, normal TSH and cortisol, on SSRI. Sertraline is well-documented."},{"name":"SIADH (other causes — CNS, pulmonary, malignancy)","likelihood":"medium","key_discriminator":"Same biochemical profile; screen once drug effect addressed."},{"name":"Reset osmostat","likelihood":"low","key_discriminator":"Chronic stable mild hyponatremia without progression."},{"name":"Hypothyroidism","likelihood":"low","key_discriminator":"TSH 2.1 normal, unlikely."},{"name":"Adrenal insufficiency","likelihood":"low","key_discriminator":"AM cortisol 18 reassuring; consider stim test only if suspicion persists."}]}
{"section":"next_workup","text":"Targeted studies:","items":[{"test":"Repeat serum and urine osmolality (paired)","rationale":"Confirms inappropriate urinary concentration."},{"test":"Serum uric acid","rationale":"Low uric acid (<4 mg/dL) supports SIADH."},{"test":"Chest imaging + basic CNS exam","rationale":"Screen for ectopic ADH source."},{"test":"Trend Na q12h during fluid restriction","rationale":"Confirms diagnosis and monitors correction rate."}]}
{"section":"discriminating_signs","text":"Key inputs: Na 128 (mild), serum osm 268 (true hypotonic), U-Na 45 (inappropriate natriuresis for hypotonicity), U-osm 380 (inappropriately concentrated), euvolemic, on sertraline, normal TSH and cortisol. Pattern fits drug-induced SIADH cleanly."}

EXAMPLE 2 (pseudohyponatremia — abbreviated): Na 130, glucose 580, osm 312 → corrected_na ~141 (Hillier), pseudohyponatremia_flag true, tonicity hypertonic. Classification.text MUST say "This is NOT true hypotonic hyponatremia — it is hypertonic hyponatremia from hyperglycemia. Treating as low-Na would be wrong." correction_rate_guidance does NOT apply (text says so; ceiling fields still set per schema). Differential short (1-2 items, focus on hyperglycemia cause: DKA, HHS). next_workup focused on glucose management not hyponatremia workup.

EXAMPLE 3 (hypovolemic — abbreviated): Na 122, U-Na 12, hypovolemic on exam, recent vomiting → classification hypotonic + hypovolemic. Differential leads with hypovolemic from extrarenal loss (low U-Na <30 with hypovolemia is the discriminator); SIADH explicitly ruled out. correction_rate_guidance still 8/6 ceiling but text mentions volume repletion with isotonic crystalloid often corrects Na briskly so careful monitoring is required. next_workup includes paired osm and urine Na if not done, no need for cortisol/TSH unless picture changes after volume repletion.
`.trim();

function buildDeterministicBlock(det: ReturnType<typeof interpretHyponatremia>): string {
  const lines: string[] = [];
  lines.push(`  corrected_na: ${det.corrected_na}`);
  lines.push(`  tonicity: "${det.tonicity}"`);
  lines.push(`  volume_status: "${det.volume_status}"`);
  lines.push(`  pseudohyponatremia_flag: ${det.pseudohyponatremia_flag}`);
  lines.push(`  serum_osm_estimated: ${det.serum_osm_estimated ?? 'measured'}`);
  if (det.free_water_deficit_l !== null) lines.push(`  free_water_excess_l: ${det.free_water_deficit_l}`);
  lines.push(`  ods_risk: ${det.ods_risk}`);
  lines.push(`  ods_risk_factors: ${JSON.stringify(det.ods_risk_factors)}`);
  lines.push(`  correction_ceiling_24h_meq_l: ${det.correction_ceiling_24h_meq_l}`);
  lines.push(`  ods_ceiling_24h_meq_l: ${det.ods_ceiling_24h_meq_l}`);
  lines.push(`  severity_label: "${det.severity_label}"`);
  return lines.join('\n');
}

function buildUserInputBlock(inputs: HyponatremiaInputs): string {
  const parts: string[] = [`Na ${inputs.na}`];
  if (inputs.serum_osm !== undefined) parts.push(`serum osm ${inputs.serum_osm}`);
  parts.push(`glucose ${inputs.glucose}`);
  if (inputs.urine_na !== undefined) parts.push(`urine Na ${inputs.urine_na}`);
  if (inputs.urine_osm !== undefined) parts.push(`urine osm ${inputs.urine_osm}`);
  parts.push(`volume status: ${inputs.volume_status}`);
  if (inputs.meds.length) parts.push(`meds: ${inputs.meds.join(', ')}`);
  if (inputs.recent_ivf) parts.push('recent IV fluids: yes');
  if (inputs.tsh !== undefined) parts.push(`TSH ${inputs.tsh}`);
  if (inputs.cortisol !== undefined) parts.push(`AM cortisol ${inputs.cortisol}`);
  if (inputs.suspect_adrenal_insuff) parts.push('suspected adrenal insufficiency');
  if (inputs.k !== undefined) parts.push(`K ${inputs.k}`);
  if (inputs.weight_kg) parts.push(`weight ${inputs.weight_kg}kg`);
  if (inputs.sex) parts.push(`sex ${inputs.sex}`);
  return parts.join(', ');
}

function buildGroundingBlock(hits: Awaited<ReturnType<typeof retrieve>>['hits']): string {
  return hits.map((h) =>
    `[${h.id}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text.slice(0, 600)}`
  ).join('\n\n');
}

export async function POST(req: NextRequest) {
  let body: HyponatremiaInputs & { parent_trace_id?: string; idempotency_key?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }

  if (typeof body.na !== 'number' || body.na < 100 || body.na > 180) {
    return new Response(JSON.stringify({ error: 'Na required and within 100-180' }), { status: 400 });
  }
  if (typeof body.glucose !== 'number' || body.glucose < 20 || body.glucose > 1500) {
    return new Response(JSON.stringify({ error: 'glucose required and within 20-1500' }), { status: 400 });
  }
  if (!['hypovolemic', 'euvolemic', 'hypervolemic', 'unsure'].includes(body.volume_status)) {
    return new Response(JSON.stringify({ error: 'volume_status required' }), { status: 400 });
  }
  if (!Array.isArray(body.meds)) body.meds = [];

  const det = interpretHyponatremia(body);

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('hyponatremia', body, 1, {
    corrected_na: det.corrected_na,
    tonicity: det.tonicity,
    volume_status: det.volume_status,
    pseudohyponatremia_flag: det.pseudohyponatremia_flag,
    ods_risk: det.ods_risk,
  });

  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  emit({ type: 'result', data: { phase: 'deterministic', deterministic: det } });

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;

    try {
      // PRD §16.6 retrieval signature
      const fullQuery = `hyponatremia workup ${det.tonicity} ${det.volume_status}` +
        (body.meds.length ? ` ${body.meds.join(' ')}` : '');
      const bm25Query = `hyponatremia ${det.tonicity} ${det.volume_status}`;

      emit({ type: 'progress', stage: 'retrieving', msg: 'Retrieving hyponatremia references…' });
      const retrieveStart = Date.now();
      const result = await retrieve(fullQuery, { topK: 12, bm25Query });
      const hits = result.hits;
      await logEvent(traceId, 'retrieve', 'rag', {
        full_query: fullQuery, bm25_query: bm25Query, n_hits: hits.length, meta: result.meta,
      }, Date.now() - retrieveStart);
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} chunks`, ms: Date.now() - t0 });

      if (hits.length === 0) {
        emit({ type: 'error', message: 'no grounding chunks retrieved' });
        outcome = 'error'; outcomeMsg = 'empty retrieval';
        close();
        return;
      }

      const retrievedIds = new Set(hits.map((h) => h.id));
      emit({ type: 'sources', items: hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter, page_start: h.page_start,
        similarity: Number(h.similarity.toFixed(3)), preview: h.text.slice(0, 400),
      })) });

      const userMessage = [
        `DETERMINISTIC:\n${buildDeterministicBlock(det)}`,
        ``,
        `USER INPUT: ${buildUserInputBlock(body)}`,
        ``,
        `GROUNDING (cite by [chunk_id], use only these):\n${buildGroundingBlock(hits)}`,
        ``,
        FEW_SHOT_BLOCK,
        ``,
        `Now produce the NDJSON for the user's case. One JSON object per line, no fences, no preamble.`,
      ].join('\n');

      emit({ type: 'progress', stage: 'generating', msg: 'Synthesizing (qwen 14b)…', ms: Date.now() - t0 });

      const llmStart = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await tracedChat(traceId, 'synthesis', {
        model: MODEL,
        messages: [
          { role: 'system', content: HYPONATREMIA_SYSTEM },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        stream: true,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });

      let buffer = '';
      let fullText = '';
      const emittedSections = new Set<string>();
      const safetyRedactCount: number[] = [];
      const hallucinationCount: number[] = [];

      for await (const chunk of r) {
        const delta = chunk?.choices?.[0]?.delta?.content ?? '';
        if (!delta) continue;
        buffer += delta;
        fullText += delta;

        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || line.startsWith('//')) continue;

          try {
            const obj = JSON.parse(line);
            if (!obj || !obj.section) continue;

            if (typeof obj.text === 'string') {
              const { redacted, matches } = applySafetyRedaction(obj.text);
              if (matches.length > 0) {
                safetyRedactCount.push(matches.length);
                await logEvent(traceId, 'safety_redact', obj.section, { matches });
                obj.text = redacted;
              }
            }
            if (Array.isArray(obj.items)) {
              for (const it of obj.items) {
                for (const k of ['key_discriminator', 'rationale'] as const) {
                  if (typeof it[k] === 'string') {
                    const { redacted, matches } = applySafetyRedaction(it[k]);
                    if (matches.length > 0) {
                      safetyRedactCount.push(matches.length);
                      await logEvent(traceId, 'safety_redact', `${obj.section}.items`, { matches });
                      it[k] = redacted;
                    }
                  }
                }
              }
            }

            const { section: cleaned, hallucinated } = stripHallucinatedCitations(obj, retrievedIds);
            if (hallucinated.length > 0) {
              hallucinationCount.push(hallucinated.length);
              await logEvent(traceId, 'citation_hallucination', cleaned.section, { hallucinated });
            }

            emit({ type: 'result', data: { phase: 'section', ...cleaned } });
            emittedSections.add(cleaned.section);
          } catch {
            // partial / malformed — keep accumulating
          }
        }
      }

      // CALC.4 — deterministic discriminating_signs fallback (mirrors CALC.3 red_flags fix).
      // Qwen 14b reliably stops at 5/6 sections; emit a deterministic last section if missing.
      try {
        await logEvent(traceId, 'last_section_fallback_check', 'synthesis', {
          already_emitted: emittedSections.has('discriminating_signs'),
          emitted_so_far: Array.from(emittedSections),
        });
        if (!emittedSections.has('discriminating_signs')) {
          const parts: string[] = [];
          parts.push(`Na ${body.na} (${det.severity_label}; corrected ${det.corrected_na})`);
          if (det.serum_osm_estimated !== null) parts.push(`estimated serum osm ${det.serum_osm_estimated}`);
          else if (body.serum_osm !== undefined) parts.push(`measured serum osm ${body.serum_osm}`);
          parts.push(`tonicity ${det.tonicity}`);
          if (det.pseudohyponatremia_flag) parts.push('pseudohyponatremia flag SET — not true hypotonic');
          parts.push(`volume status: ${body.volume_status}`);
          if (body.urine_na !== undefined) parts.push(`U-Na ${body.urine_na}`);
          if (body.urine_osm !== undefined) parts.push(`U-osm ${body.urine_osm}`);
          if (body.meds.length) parts.push(`meds: ${body.meds.join(', ')}`);
          if (det.ods_risk) parts.push(`ODS risk factors: ${det.ods_risk_factors.join('; ')}`);
          const text = `Key inputs and computed values: ${parts.join('; ')}.`;
          const fallback = { section: 'discriminating_signs', text, citations: [] };
          emit({ type: 'result', data: { phase: 'section', ...fallback } });
          emittedSections.add('discriminating_signs');
          await logEvent(traceId, 'last_section_fallback', 'synthesis', { reason: 'qwen_did_not_emit', text_length: text.length });
        }
      } catch (fbErr) {
        await logEvent(traceId, 'last_section_fallback_error', 'synthesis', { error: String((fbErr as Error).message) });
      }

      await logEvent(traceId, 'llm_response_stream_complete', 'synthesis', {
        sections_emitted: Array.from(emittedSections),
        safety_redact_total: safetyRedactCount.reduce((a, b) => a + b, 0),
        citation_hallucination_total: hallucinationCount.reduce((a, b) => a + b, 0),
        full_text_length: fullText.length,
      }, Date.now() - llmStart);

      const required = ['classification', 'severity_acuity', 'correction_rate_guidance', 'differential', 'next_workup', 'discriminating_signs'];
      const missing = required.filter((s) => !emittedSections.has(s));
      if (missing.length > 0) {
        outcome = 'partial';
        outcomeMsg = `missing sections: ${missing.join(', ')}`;
      }

      try {
        const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
        await sqlFn(
          `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
           VALUES ($1, 'hyponatremia', $2, $3, $4::jsonb, $5)`,
          [
            1,
            JSON.stringify(body),
            fullText.slice(0, 8000),
            JSON.stringify({
              corrected_na: det.corrected_na, tonicity: det.tonicity, volume_status: det.volume_status,
              pseudohyponatremia_flag: det.pseudohyponatremia_flag, ods_risk: det.ods_risk,
              sections_emitted: Array.from(emittedSections),
              safety_redact_total: safetyRedactCount.reduce((a, b) => a + b, 0),
              citation_hallucination_total: hallucinationCount.reduce((a, b) => a + b, 0),
            }),
            traceId,
          ],
        );
      } catch {}

      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      outcome = 'error';
      outcomeMsg = String((e as Error).message);
      emit({ type: 'error', message: outcomeMsg });
    } finally {
      await finishTrace(traceId, outcome, outcomeMsg);
      close();
    }
  })();

  const headers = ndjsonHeaders();
  headers.set('X-Trace-Id', traceId);
  return new Response(stream, { headers });
}
