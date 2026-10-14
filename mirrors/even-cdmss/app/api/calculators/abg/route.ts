import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { startTrace, logEvent, finishTrace, tracedChat } from '@/lib/trace';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { interpretAbg, type AbgInputs } from '@/lib/calculators/math/abg';
import { applySafetyRedaction } from '@/lib/calculators/safety-regex';
import { stripHallucinatedCitations } from '@/lib/calculators/citation-check';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 90;

const MODEL = 'qwen2.5:14b';

// PRD §16.8 — master negative-instructions block, applied verbatim to all synthesis prompts.
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

// PRD Appendix A.1 — ABG system prompt envelope.
const ABG_SYSTEM = `You are Even-CDMSS, an educational clinical reasoning companion for junior
doctors at Even Hospitals. The user has supplied an arterial blood gas with
optional electrolytes. The deterministic interpretation has been computed
server-side and is provided in the DETERMINISTIC block — use those values,
do not recompute.

Produce a structured interpretation, ranked differential, and suggested
next workup. Output is NDJSON, one object per line, sections in this fixed
order: primary_disorder, compensation, anion_gap, differential, next_workup, red_flags.

Object schemas:
- primary_disorder: {section, text, citations?}
- compensation:     {section, text, expected_range, citations?}
- anion_gap:        {section, text, ag_value, corrected_ag, delta_delta, citations?}
- differential:     {section, text, items: [{name, likelihood: "high"|"medium"|"low", key_discriminator}]}
- next_workup:      {section, text, items: [{test, rationale}]}
- red_flags:        {section, text, items?, citations?}

Length budgets per section (tokens): primary_disorder 30-80, compensation
60-140, anion_gap 60-160, differential 250-500 (5 items × ~80-100 each),
next_workup 150-300, red_flags 50-150. Hit the middle.

Cite retrieved chunks with [N] markers inline AND in a citations array of
chunk_ids. Never cite a chunk_id not in the GROUNDING block.

If no acid-base disorder is present, say so plainly. Do NOT fabricate a
disorder. Differential items array may be empty in that case.

${NEGATIVE_INSTRUCTIONS}

Output ONLY the NDJSON, one object per line, no fences, no preamble.

CRITICAL: You MUST emit ALL 6 sections in the order above, even if a section is "Not applicable" or "None". Do not stop after differential or next_workup — always finish with the red_flags object. For a normal ABG, red_flags should say "None on this gas." For a severe case, name the urgent findings.`;

// PRD Appendix A.1.1 — single fully-detailed few-shot (the high-AG met acid case).
// We embed one full example. Two abbreviated examples follow.
const FEW_SHOT_BLOCK = `
EXAMPLE 1 INPUT:
DETERMINISTIC:
  primary_disorder: "high-anion-gap metabolic acidosis"
  anion_gap: 33
  corrected_ag: 33
  expected_paco2_range: "19.5-23.5 mmHg PaCO2"
  compensation_verdict: "appropriate"
  delta_delta: 1.4
USER INPUT: pH 7.21, PaCO2 22, HCO3 9, Na 138, Cl 96, albumin 4.0

EXAMPLE 1 OUTPUT:
{"section":"primary_disorder","text":"High anion-gap metabolic acidosis with appropriate respiratory compensation."}
{"section":"compensation","text":"Winters' formula expects PaCO2 = (1.5 × 9) + 8 ± 2 = 19.5-23.5 mmHg. Measured PaCO2 22 mmHg falls in range — respiratory compensation is appropriate. No additional respiratory disorder.","expected_range":"19.5-23.5 mmHg PaCO2"}
{"section":"anion_gap","text":"Anion gap = 138 - (96 + 9) = 33 mEq/L, markedly elevated. Albumin 4.0 is normal — no correction. Delta-delta = (33-12)/(24-9) = 1.4, consistent with a pure high-AG process.","ag_value":33,"corrected_ag":33,"delta_delta":1.4}
{"section":"differential","text":"Top etiologies for high-AG metabolic acidosis with AG 33:","items":[{"name":"Diabetic ketoacidosis","likelihood":"high","key_discriminator":"Hyperglycemia + ketonemia or ketonuria; check glucose, β-hydroxybutyrate, urine ketones."},{"name":"Lactic acidosis","likelihood":"high","key_discriminator":"Serum lactate >4 mmol/L; sepsis, shock, tissue hypoperfusion, metformin in renal impairment."},{"name":"Toxic alcohol ingestion","likelihood":"medium","key_discriminator":"Elevated osmolar gap; methanol → visual changes; ethylene glycol → oxalate crystalluria."},{"name":"Uremic acidosis","likelihood":"medium","key_discriminator":"Advanced CKD or AKI with severe azotemia; check BUN and creatinine."},{"name":"Salicylate toxicity","likelihood":"low","key_discriminator":"Classic pattern is mixed resp alk + high-AG met acid; isolated met acid makes salicylate less likely."}]}
{"section":"next_workup","text":"Specific tests to disambiguate:","items":[{"test":"Serum glucose and serum/urine ketones","rationale":"Rule in or out DKA."},{"test":"Serum lactate","rationale":"Quantitates lactic acidosis; >4 is a sepsis red flag."},{"test":"Osmolar gap","rationale":"Elevated suggests toxic alcohols."},{"test":"BUN and creatinine","rationale":"Assesses uremic contribution and AKI/CKD severity."},{"test":"Urine toxicology + serum salicylate if history supports","rationale":"Levels for salicylate, methanol, ethylene glycol if exposure plausible."}]}
{"section":"red_flags","text":"pH 7.21 is severe acidemia warranting urgent disposition. pH <7.10 or rapidly progressive should escalate immediately. Lactate >4 mmol/L triggers the SSC 1-hour sepsis bundle."}

EXAMPLE 2 (mixed disorder — abbreviated): pH 7.50, PaCO2 26, HCO3 20, Na 140, Cl 100, AG 20, delta-delta 2.0 → primary_disorder text names BOTH "respiratory alkalosis with concurrent high-AG metabolic acidosis"; compensation explains delta-delta indicating a layered AG process; differential SPLITS into two ranked groups (causes of resp alk + causes of AG component, with salicylate elevated to "high" since this is its classic pattern); red_flags mentions salicylate level.

EXAMPLE 3 (normal — anti-fabrication anchor): pH 7.40, PaCO2 38, HCO3 23, normal AG 11 → primary_disorder text "No acid-base disorder identified."; compensation "Not applicable."; anion_gap "AG 11 is normal."; differential.items is EMPTY ARRAY with text "No etiology to differentiate; verify clinical context if disorder suspected on other grounds."; next_workup short (1-2 items, clinical re-assessment); red_flags "None on this gas. Clinical picture takes precedence over a normal gas if deterioration is observed."
`.trim();

// Helper: build the deterministic block for the prompt.
function buildDeterministicBlock(det: ReturnType<typeof interpretAbg>): string {
  const lines: string[] = [];
  lines.push(`  primary_disorder: "${det.primary_disorder_label}"`);
  if (det.compensation.formula) {
    lines.push(`  compensation_verdict: "${det.compensation.verdict}"`);
    lines.push(`  expected_range: "${det.compensation.expected_range}"`);
    lines.push(`  formula: "${det.compensation.formula}"`);
  }
  if (det.anion_gap.ag_value !== null) {
    lines.push(`  anion_gap: ${det.anion_gap.ag_value}`);
    if (det.anion_gap.albumin_correction_applied) lines.push(`  corrected_ag: ${det.anion_gap.corrected_ag}`);
    lines.push(`  anion_gap_state: "${det.anion_gap.state}"`);
  }
  if (det.delta_delta.ratio !== null) {
    lines.push(`  delta_delta: ${det.delta_delta.ratio}`);
    lines.push(`  delta_delta_interpretation: "${det.delta_delta.interpretation}"`);
  }
  if (det.oxygenation.pf_ratio !== null) {
    lines.push(`  pf_ratio: ${det.oxygenation.pf_ratio} (${det.oxygenation.pf_band})`);
  }
  if (det.oxygenation.aa_gradient !== null) {
    lines.push(`  aa_gradient: ${det.oxygenation.aa_gradient}`);
  }
  return lines.join('\n');
}

function buildUserInputBlock(inputs: AbgInputs): string {
  const parts: string[] = [`pH ${inputs.pH}, PaCO2 ${inputs.paco2}, HCO3 ${inputs.hco3}`];
  if (inputs.na !== undefined && inputs.cl !== undefined) parts.push(`Na ${inputs.na}, Cl ${inputs.cl}`);
  if (inputs.albumin !== undefined) parts.push(`albumin ${inputs.albumin}`);
  if (inputs.pao2 !== undefined) parts.push(`PaO2 ${inputs.pao2}`);
  if (inputs.fio2 !== undefined) parts.push(`FiO2 ${inputs.fio2}`);
  if (inputs.lactate !== undefined) parts.push(`lactate ${inputs.lactate}`);
  if (inputs.k !== undefined) parts.push(`K ${inputs.k}`);
  return parts.join(', ');
}

function buildGroundingBlock(hits: Awaited<ReturnType<typeof retrieve>>['hits']): string {
  return hits.map((h, i) =>
    `[${h.id}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text.slice(0, 600)}`
  ).join('\n\n');
}

// Lazy NDJSON line splitter for the qwen output. Sections arrive one per line.
function* splitLines(buffer: string): Generator<{ line: string; rest: string }> {
  let i: number;
  let cursor = 0;
  while ((i = buffer.indexOf('\n', cursor)) !== -1) {
    yield { line: buffer.slice(cursor, i).trim(), rest: '' };
    cursor = i + 1;
  }
  if (cursor > 0) {
    // signal residual via final yield with rest only
    yield { line: '', rest: buffer.slice(cursor) };
  }
}

export async function POST(req: NextRequest) {
  let body: AbgInputs & { parent_trace_id?: string; idempotency_key?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }

  // Minimal validation — relies on the form for the rest.
  if (typeof body.pH !== 'number' || body.pH < 6.8 || body.pH > 7.8 ||
      typeof body.paco2 !== 'number' || body.paco2 < 10 || body.paco2 > 100 ||
      typeof body.hco3 !== 'number' || body.hco3 < 4 || body.hco3 > 50) {
    return new Response(JSON.stringify({ error: 'pH/PaCO2/HCO3 required and within physiological range' }), { status: 400 });
  }

  const det = interpretAbg(body);

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('abg', body, 1, {
    primary_disorder: det.primary_disorder,
    anion_gap: det.anion_gap.ag_value,
    delta_delta: det.delta_delta.ratio,
    pf_ratio: det.oxygenation.pf_ratio,
  });

  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  // Stream the deterministic block immediately — UI can render the math before LLM arrives.
  emit({ type: 'result', data: { phase: 'deterministic', deterministic: det } });

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;

    try {
      // PRD §16.6 — RAG retrieval. Vector leg uses HyDE-expanded full query;
      // BM25 leg uses narrowed disorder name only (D12.2 lesson).
      const fullQuery = `acid-base interpretation primary ${det.primary_disorder_label.toLowerCase()}` +
        (det.anion_gap.state === 'high' ? ' high anion gap' : '');
      const bm25Query = `${det.primary_disorder.replace(/_/g, ' ')} ${det.anion_gap.state === 'high' ? 'anion gap' : ''}`.trim();

      emit({ type: 'progress', stage: 'retrieving', msg: 'Retrieving acid-base references…' });
      const retrieveStart = Date.now();
      const result = await retrieve(fullQuery, { topK: 12, bm25Query });
      const hits = result.hits;
      await logEvent(traceId, 'retrieve', 'rag', {
        full_query: fullQuery, bm25_query: bm25Query,
        n_hits: hits.length, meta: result.meta,
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
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 400),
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
      // Use streaming so sections can ship as they're emitted.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await tracedChat(traceId, 'synthesis', {
        model: MODEL,
        messages: [
          { role: 'system', content: ABG_SYSTEM },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        stream: true,
        // Ollama-specific: ensure num_ctx high enough for the prompt (D11.0e fix).
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

        // Try to extract complete lines (each NDJSON object).
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || line.startsWith('//')) continue;

          try {
            const obj = JSON.parse(line);
            if (!obj || !obj.section) continue;

            // Safety: redact drug doses / fluid rates
            if (typeof obj.text === 'string') {
              const { redacted, matches } = applySafetyRedaction(obj.text);
              if (matches.length > 0) {
                safetyRedactCount.push(matches.length);
                await logEvent(traceId, 'safety_redact', obj.section, { matches });
                obj.text = redacted;
              }
            }
            // Strip items text too if present
            if (Array.isArray(obj.items)) {
              for (const it of obj.items) {
                if (typeof it.key_discriminator === 'string') {
                  const { redacted, matches } = applySafetyRedaction(it.key_discriminator);
                  if (matches.length > 0) {
                    safetyRedactCount.push(matches.length);
                    await logEvent(traceId, 'safety_redact', `${obj.section}.items`, { matches });
                    it.key_discriminator = redacted;
                  }
                }
                if (typeof it.rationale === 'string') {
                  const { redacted, matches } = applySafetyRedaction(it.rationale);
                  if (matches.length > 0) {
                    safetyRedactCount.push(matches.length);
                    await logEvent(traceId, 'safety_redact', `${obj.section}.items`, { matches });
                    it.rationale = redacted;
                  }
                }
              }
            }

            // Citation grounding (§16.4)
            const { section: cleaned, hallucinated } = stripHallucinatedCitations(obj, retrievedIds);
            if (hallucinated.length > 0) {
              hallucinationCount.push(hallucinated.length);
              await logEvent(traceId, 'citation_hallucination', cleaned.section, { hallucinated });
            }

            emit({ type: 'result', data: { phase: 'section', ...cleaned } });
            emittedSections.add(cleaned.section);
          } catch {
            // partial / malformed line — keep accumulating
          }
        }
      }

      // CALC.3 fixup #4 — deterministic red_flags fallback (defensively wrapped).
      // Always log a diagnostic event so we can see whether the block was reached.
      try {
        await logEvent(traceId, 'red_flags_fallback_check', 'synthesis', {
          already_emitted: emittedSections.has('red_flags'),
          emitted_so_far: Array.from(emittedSections),
        });
        if (!emittedSections.has('red_flags')) {
          const flags: string[] = [];
          if (body.pH < 7.10) flags.push(`Severe acidemia (pH ${body.pH}) — urgent disposition.`);
          else if (body.pH > 7.60) flags.push(`Severe alkalemia (pH ${body.pH}) — urgent disposition.`);
          if (body.lactate !== undefined && body.lactate >= 4) flags.push(`Lactate ${body.lactate} mmol/L — sepsis until proven otherwise; consider SSC 1-h bundle.`);
          if (det.oxygenation.pf_band === 'moderate' || det.oxygenation.pf_band === 'severe') flags.push(`P/F ${det.oxygenation.pf_ratio} — ${det.oxygenation.pf_band} ARDS criterion.`);
          if (det.anion_gap.ag_value !== null && det.anion_gap.ag_value > 25) flags.push(`Markedly elevated anion gap (${det.anion_gap.ag_value}) — toxic alcohols, severe DKA, or massive lactic acidosis.`);
          const text = flags.length === 0
            ? 'None on this gas. Clinical picture takes precedence over a normal gas if deterioration is observed.'
            : flags.join(' ');
          const fallbackRedFlags = { section: 'red_flags', text, citations: [] };
          emit({ type: 'result', data: { phase: 'section', ...fallbackRedFlags } });
          emittedSections.add('red_flags');
          await logEvent(traceId, 'red_flags_fallback', 'synthesis', { reason: 'qwen_did_not_emit', flags_count: flags.length, text_length: text.length });
        }
      } catch (fbErr) {
        await logEvent(traceId, 'red_flags_fallback_error', 'synthesis', { error: String((fbErr as Error).message), stack: String((fbErr as Error).stack ?? '').slice(0, 600) });
      }

      await logEvent(traceId, 'llm_response_stream_complete', 'synthesis', {
        sections_emitted: Array.from(emittedSections),
        safety_redact_total: safetyRedactCount.reduce((a, b) => a + b, 0),
        citation_hallucination_total: hallucinationCount.reduce((a, b) => a + b, 0),
        full_text_length: fullText.length,
      }, Date.now() - llmStart);

      // Check if all 6 sections came through
      const required = ['primary_disorder', 'compensation', 'anion_gap', 'differential', 'next_workup', 'red_flags'];
      const missing = required.filter((s) => !emittedSections.has(s));
      if (missing.length > 0) {
        outcome = 'partial';
        outcomeMsg = `missing sections: ${missing.join(', ')}`;
        emit({ type: 'progress', stage: 'done', msg: `Synthesis ended with missing sections: ${missing.join(', ')}` });
      } else {
        emit({ type: 'progress', stage: 'done', msg: 'Synthesis complete', ms: Date.now() - t0 });
      }

      // Log to user_queries
      try {
        const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
        await sqlFn(
          `INSERT INTO user_queries (user_id, feature, query_text, answer_text, calculator_meta, session_id)
           VALUES ($1, 'abg', $2, $3, $4::jsonb, $5)`,
          [
            1,
            JSON.stringify(body),
            fullText.slice(0, 8000),
            JSON.stringify({
              primary_disorder: det.primary_disorder,
              anion_gap: det.anion_gap.ag_value,
              delta_delta: det.delta_delta.ratio,
              pf_ratio: det.oxygenation.pf_ratio,
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
