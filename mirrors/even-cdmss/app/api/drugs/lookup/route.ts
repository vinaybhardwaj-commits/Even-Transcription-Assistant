import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { enrichDrug, type PubChemFacts } from '@/lib/pubchem';
import { llm, geminiModelFor } from '@/lib/llm';
import { startTrace, logEvent, finishTrace, tracedChat } from '@/lib/trace';
import { parseLooseJson, normalizeDrugName } from '@/lib/drugs';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';

export const runtime = 'nodejs';
// 500s — D13.0 bump from 300. Amiodarone trace 33d60f4b ran 241s (80% of the 300s cap)
// with deeper completions from D12.1's prompt re-tune. Drugs with denser clinically-rich
// content (rivaroxaban, methotrexate, anything with 10+ interactions) project to push past
// 300s and lose phase_extras when the lambda is killed mid-stream. 500s gives ~2× the
// observed worst case while staying well under Pro Plus's 800s ceiling. Trace will surface
// any drug that crosses the new bound via status='partial' + missing last llm_response.
export const maxDuration = 500;


function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const name = String(o.name ?? o.title ?? o.indication ?? o.condition ?? o.drug ?? o.label ?? '');
      const desc = String(o.description ?? o.detail ?? o.note ?? o.value ?? o.dose ?? o.dosing ?? '');
      if (name && desc) return `${name} — ${desc}`;
      if (name) return name;
      if (desc) return desc;
      try { return JSON.stringify(o).replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').trim(); } catch { return ''; }
    }
    return String(x);
  }).filter(Boolean);
}

function toStringDict(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
    else if (val && typeof val === 'object') {
      const o = val as Record<string, unknown>;
      const name = String(o.name ?? o.label ?? '');
      const desc = String(o.description ?? o.detail ?? o.value ?? '');
      out[k] = name && desc ? `${name} — ${desc}` : (name || desc || JSON.stringify(o));
    } else if (val != null) out[k] = String(val);
  }
  return out;
}


// Each phase owns specific fields. Later phases must NEVER emit Phase 1's fields,
// or empty values would overwrite populated skeleton data client-side.
const PHASE_FIELDS: Record<string, string[]> = {
  fast: ['drug_normalized', 'class', 'subclass', 'indications', 'typical_dosing', 'renal_adjust', 'hepatic_adjust', 'contraindications', 'adverse_effects', 'monitoring', 'citation_ids'],
  pharmacology: ['mechanism_of_action', 'receptors_targets', 'biochemistry', 'pharmacokinetics', 'pharmacodynamics'],
  extras: ['formulations', 'drug_interactions_summary', 'special_populations', 'key_pearls'],
};

const FAST_MODEL = 'llama3.1:8b';
const DEEP_MODEL = 'qwen2.5:14b';

const PHASE1_SYSTEM = `You write a clinical-skeleton drug card. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"drug_normalized":"generic lowercase","class":"pharmacologic class","subclass":"finer subclass or empty","indications":["..."],"typical_dosing":["adult dosing per indication"],"renal_adjust":"one sentence or 'Not specified'","hepatic_adjust":"one sentence or 'Not specified'","contraindications":["absolute first, then relative"],"adverse_effects":["common, then serious"],"monitoring":["what to check + frequency"],"citation_ids":[1,2]}

Rules:
- Be terse on this pass — each bullet 1 line.
- citation_ids: 1-based indices from the excerpts. Cite every claim.
- If unsupported by excerpts, empty array or "Not specified". Never invent.`;

const PHASE2_SYSTEM = `You add deep pharmacology to an existing drug card. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"mechanism_of_action":"4-7 dense sentences — name the SPECIFIC molecular machinery: receptor subtype, enzyme, channel, transporter, second messenger, downstream pathway, physiologic endpoint. Mechanistic, not symptomatic.","receptors_targets":["5-10 specific molecular targets when the excerpts support it — name the receptor subtype, enzyme (with EC if cited), channel, or transporter; one per item; do NOT just write 'opioid receptor' when the excerpts say 'mu-opioid receptor (MOR / OPRM1)'"],"biochemistry":"2-4 sentences on the biochemical pathway / metabolic step / cofactor / vitamin K cycle / clotting cascade position / etc., or empty string","pharmacokinetics":{"absorption":"1-2 sentences with route, F%, time-to-peak, food effect","distribution":"1-2 sentences with Vd in L/kg if cited, protein binding %, BBB / placental / breast milk if relevant","metabolism":"1-2 sentences naming CYPs / UGTs / specific enzymes, prodrug status, active metabolites by name","excretion":"1-2 sentences with renal/biliary/fecal split, % unchanged, dialyzability if cited","half_life":"t½ with range and what drives variability","bioavailability":"F% with range if oral","onset":"time-to-onset for therapeutic effect","duration":"duration of action with what drives offset"},"pharmacodynamics":"3-5 sentences — dose-response shape, therapeutic window, downstream physiologic effects, time-course separations from the mechanism (e.g. warfarin acts at vitamin-K-epoxide-reductase immediately but anticoagulation lags 36-72h because circulating factors must decay)"}

Rules:
- DEPTH IS THE POINT. If an excerpt names a receptor subtype, ion channel, CYP enzyme, half-life range, Vd, protein-binding %, or pathway step, INCLUDE IT. Brevity that drops detail from the excerpts is a failure mode.
- Worked example for one field — mechanism_of_action for warfarin:
  "Warfarin inhibits vitamin-K-epoxide-reductase (VKORC1) in hepatocytes, preventing the reduction of vitamin K 2,3-epoxide back to its active hydroquinone form. Without reduced vitamin K, the gamma-glutamyl carboxylase reaction that adds Gla residues to factors II, VII, IX, X and proteins C/S fails, producing functionally inactive 'PIVKA' clotting factors. Anticoagulant effect is therefore indirect and lagged — it appears only as circulating active factors decay (factor VII first at t½ ~6h, prothrombin last at t½ ~60-72h), explaining the 2-5 day onset and the need for bridging anticoagulation. The S-enantiomer is 2-5× more potent than R-warfarin and is cleared mainly by CYP2C9, the site of major pharmacogenomic variability."
  Aim for that density of named molecules + numbers + clinical implications. Do not write less when the excerpts support more.
- If a field is genuinely unsupported by the excerpts, return empty string or empty array. Never invent. But err strongly on the side of including everything the excerpts mention.
- Use the excerpts to ground but write at a teaching level — name the parts, show the mechanism's clinical consequences.`;

const PHASE3_SYSTEM = `You finish a drug card by adding clinical extras. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"formulations":["all formulations the excerpts mention — name strength AND route AND any combination products. e.g. 'Tablet — 1, 2, 2.5, 3, 4, 5, 6, 7.5, 10 mg (oral)'. 4-8 items typical when excerpts are thorough."],"drug_interactions_summary":["6-12 named interactions when excerpts support it — each item is one full sentence: 'interacting drug/class — mechanism — clinical consequence — magnitude/management if cited'. e.g. 'Amiodarone — inhibits CYP2C9 — raises warfarin AUC and INR; reduce warfarin dose 30-50% on initiation.'"],"special_populations":{"pregnancy":"2-3 sentences with category if cited (FDA legacy or new PLLR), specific teratogenic risks, alternatives, monitoring","pediatric":"2-3 sentences with approved age range, dosing differences, specific cautions","geriatric":"2-3 sentences with PD sensitivity, dose adjustments, fall/bleeding/QT/etc risk","renal_impairment":"2-3 sentences with eGFR cutoffs, dose adjustments, dialyzability","hepatic_impairment":"2-3 sentences with Child-Pugh class adjustments, contraindications"},"key_pearls":["5-8 high-yield teaching points — each pearl 1-2 sentences. Mix: classic exam fact, common error, distinguishing feature from sister drugs, monitoring pearl, drug-of-choice / not-of-choice scenario, antidote/reversal, dietary interactions. Concrete, not generic."]}

Rules:
- DEPTH IS THE POINT — when excerpts support 6-12 interactions, return 6-12, not 3. When excerpts list 9 strengths, list all 9.
- Worked example for one key_pearls item — warfarin:
  "Warfarin's onset is delayed 36-72h because circulating factors II/VII/IX/X must first decay; in acute venous thromboembolism, bridge with a parenteral anticoagulant for ≥5 days AND until INR is therapeutic for 2 consecutive days."
  That's the density: a specific number + the mechanism + the clinical rule. Aim for that level on every pearl.
- If a field is genuinely unsupported by the excerpts, return empty string or empty array. Never invent.
- 'special_populations.hepatic_impairment' is new — include it when excerpts touch on hepatic metabolism or liver-disease use.`;

function buildContext(hits: Awaited<ReturnType<typeof retrieve>>['hits']): string {
  return hits.map((h, i) =>
    `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text}`
  ).join('\n\n');
}

type Phase = { name: string; model: string; system: string; userSuffix: string; maxTokens: number };

const PHASES: Phase[] = [
  { name: 'fast',         model: FAST_MODEL, system: PHASE1_SYSTEM, userSuffix: 'Output the clinical skeleton JSON now.',           maxTokens: 800  },
  { name: 'pharmacology', model: DEEP_MODEL, system: PHASE2_SYSTEM, userSuffix: 'Output the pharmacology JSON now.',                maxTokens: 2000},
  // phase_extras maxTokens bumped 700 → 1500 after D12.1's depth re-tune. Trace ddea5afe-...
  // showed qwen hitting exactly completion_tokens=700 on the warfarin run — cut off mid-thought.
  // 1500 gives qwen room to finish the full set of pearls + hepatic_impairment + 6-12 interactions.
  { name: 'extras',       model: DEEP_MODEL, system: PHASE3_SYSTEM, userSuffix: 'Output the formulations/interactions/pops/pearls JSON now.', maxTokens: 1500 },
];

// v2.0.1 — self-critique pass on the pharmacology phase (default ON, killswitch via body.selfCritique).
// FAST_MODEL audits the DEEP_MODEL's pharmacology JSON against the source excerpts; if it flags
// issues, DEEP_MODEL revises the JSON in a second pass. Critique is intentionally scoped to the
// pharmacology phase because it carries the highest-stakes content (mechanism, dosing, renal
// adjustments, contraindications, AEs) — phases 1 (fast skeleton) + 3 (extras) stay single-pass
// to keep the total query under ~8min.
const PHARMACOLOGY_CRITIQUE_SYSTEM = `You are a clinical accuracy auditor reviewing a pharmacology JSON written by a medical study companion.

Given (1) the drug name, (2) the source excerpts (cited [1]..[n]), and (3) the draft JSON, identify problems.

Output ONLY this JSON, no prose:
{
  "unsupported_claims": ["a claim in the JSON not backed by any cited excerpt", ...],
  "missing_critical_info": ["a clinically-important field that's empty or trivial when source excerpts cover it (e.g. missing major contraindications, omitted renal adjustment)", ...],
  "incorrect_dosing": ["any dosing/frequency/formulation that contradicts the excerpts", ...],
  "missing_safety_signals": ["any black-box / contraindication / major interaction visible in excerpts but missing from the JSON", ...],
  "citation_problems": ["wrong source attributed, fabricated citation, etc.", ...],
  "needs_revision": true | false,
  "overall_severity": "none" | "minor" | "moderate" | "major"
}

Empty arrays are fine. Set needs_revision=true if ANY array has entries. Be specific — each item should be a concrete fix.`;

const PHARMACOLOGY_REVISION_SYSTEM = `You are the medical study companion revising your own pharmacology JSON based on an auditor's critique.

You receive: drug name, source excerpts (with [n] tags), your earlier draft JSON, and the auditor's critique JSON.

Rewrite the JSON to fix every issue. Add missing critical info, correct dosing, add missing safety signals, fix citations. Keep the same shape as the original (same lowercase keys, same nested structure). Output ONLY the revised JSON — no prose, no markdown fences, no commentary.`;



// CALC.1.3 — renal context pushed from /drugs/egfr via sessionStorage.cdmss_renal_ctx.
// When present, Phase 2 pharm prompt receives an addendum instructing qwen to use the
// more conservative of CKD-EPI / Cockcroft-Gault for narrow-therapeutic-window drugs.
type RenalCtx = {
  ckdepi_2021_ml_min_173?: number;
  cg_crcl_ml_min?: number | null;
  stage?: string;
  conservative_for_nti?: number;
  displayed_equation?: string;
  computed_at?: string;
  source_trace_id?: string;
};


// CALC.1.3 — Phase 2 (pharmacology) gets a renal-context addendum when /drugs/egfr
// has pushed a renal_ctx via sessionStorage. Phases 1 + 3 unchanged.
function buildPhaseUserMessage(
  phase: Phase,
  normalized: string,
  contextBlock: string,
  renalCtx: RenalCtx | undefined,
): string {
  const base = `Drug: ${normalized}\n\nExcerpts:\n${contextBlock}\n\n${phase.userSuffix}`;
  if (phase.name !== 'pharmacology' || !renalCtx) return base;
  const ckdepi = renalCtx.ckdepi_2021_ml_min_173;
  const cg = renalCtx.cg_crcl_ml_min;
  const stage = renalCtx.stage;
  const conservative = renalCtx.conservative_for_nti;
  const renalAddendum = `\n\n--- Renal context from this patient's recent eGFR computation ---\n` +
    `CKD-EPI 2021: ${ckdepi ?? '?'} mL/min/1.73 m\u00b2 (stage ${stage ?? '?'}). ` +
    (cg !== null && cg !== undefined ? `Cockcroft-Gault: ${cg} mL/min. ` : '') +
    `\nUse the more conservative value for narrow-therapeutic-window drugs (digoxin, vancomycin, ` +
    `aminoglycosides, DOACs, lithium). The more conservative value here is ${conservative ?? '?'} mL/min. ` +
    `For other drugs, use whichever the prescribing reference cites \u2014 typically Cockcroft-Gault. ` +
    `Flag any contraindication at this renal function. ` +
    `If renal dose adjustment is indicated, mention the threshold and the direction of adjustment ` +
    `(do not state a specific mg/mcg dose \u2014 say e.g. \"reduce by ~50%\" or \"avoid below GFR 30\").`;
  return base + renalAddendum;
}

export async function POST(req: NextRequest) {
  let body: { drug?: string; renal_ctx?: RenalCtx; selfCritique?: boolean };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }
  const raw = (body.drug || '').trim();
  const renalCtx = body.renal_ctx;
  if (!raw) return new Response(JSON.stringify({ error: 'drug required' }), { status: 400 });

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace(
    'drugs_lookup',
    { drug: raw, renal_ctx: renalCtx ?? null },
    1,
    { has_renal_ctx: !!renalCtx, source_egfr_trace_id: renalCtx?.source_trace_id ?? null }
  );


  if (renalCtx?.source_trace_id) {
    try {
      const { sql: sql_link } = await import('@/lib/db');
      const sqlFn = sql_link as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [renalCtx.source_trace_id, traceId]);
    } catch {}
  }

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      emit({ type: 'progress', stage: 'expanding', msg: `Normalizing "${raw}" to generic name…` });
      await logEvent(traceId, 'progress', 'expanding', { msg: 'Normalizing drug name', input: raw });
      const normalizeStart = Date.now();
      const normalized = await normalizeDrugName(raw);
      await logEvent(traceId, 'normalize', 'expanding', { input: raw, output: normalized }, Date.now() - normalizeStart);
      emit({ type: 'progress', stage: 'expanding', msg: `Resolved to "${normalized}"`, ms: Date.now() - t0 });

      const query = `${normalized} pharmacology — mechanism receptors pharmacokinetics indications dosing contraindications adverse effects monitoring special populations`;
      const retrieveStart = Date.now();
      // Reverted to topK=10. D12.0 tried topK=15 and quality regressed on phases 2 + 3
      // (qwen14b completion chars -8% / -14%) — the extra chunks at sim ~0.7 act as
      // distractor noise. Phase 1 (llama8b) did improve +60%. If we want more context
      // it should be per-phase (more for llama, same/less for qwen), and we should
      // first fix the bm25_pool=0 bug (D12.2) so hybrid retrieval is actually hybrid.
      // D12.2: BM25 leg gets just the drug name (highest-IDF term). The full boilerplate
      // query AND-tokenized to zero hits across all earlier traces.
      // v1.9: parallel PubChem enrichment. Soft-fails — never blocks retrieve.
      const pubchemPromise = enrichDrug(normalized).catch(() => null as PubChemFacts | null);

      const result = await retrieve(query, { topK: 10, minSimilarity: 0.3, bm25Query: normalized });
      const hits = result.hits;
      await logEvent(traceId, 'retrieve', 'retrieving', {
        query, expanded_query: result.expandedQuery,
        n_hits: hits.length,
        meta: result.meta,
        top_hits: hits.slice(0, 5).map(h => ({ id: h.id, book: h.book, chapter: h.chapter, similarity: h.similarity }))
      }, Date.now() - retrieveStart);
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} pharmacology excerpts`, ms: Date.now() - t0 });
      if (hits.length === 0) {
        emit({ type: 'error', message: `no excerpts for "${raw}"` });
        outcome = 'error'; outcomeMsg = 'no excerpts above threshold';
        close();
        return;
      }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        similarity: typeof h.similarity === "number" ? Number(h.similarity.toFixed(3)) : 0,
        preview: h.text.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations });

      // v1.9: await PubChem (started above, parallel with retrieve)
      const pubchem = await pubchemPromise;
      if (pubchem && pubchem.cid) {
        await logEvent(traceId, 'pubchem_enrich', 'retrieving', {
          cid: pubchem.cid,
          atc_codes: pubchem.atc_codes,
          synonyms_count: pubchem.synonyms.length,
          mesh_count: pubchem.mesh_pharmacological_actions.length,
        });
        emit({ type: 'pubchem_facts', data: pubchem });
        emit({ type: 'progress', stage: 'retrieving', msg: `PubChem CID ${pubchem.cid} · ${pubchem.synonyms.length} synonyms · ATC ${pubchem.atc_codes.join(', ') || '—'}`, ms: Date.now() - t0 });
      }

      // Pass PubChem facts to LLM context — augments MKSAP excerpts with identity + class data.
      const pubchemBlock = pubchem && pubchem.cid ? (
        `\n\n--- PUBCHEM IDENTITY (authoritative from PubChem CID ${pubchem.cid}) ---\n` +
        `Canonical name: ${pubchem.canonical_name}\n` +
        `Top synonyms: ${pubchem.synonyms.slice(0, 8).join(', ')}\n` +
        (pubchem.atc_codes.length ? `ATC: ${pubchem.atc_codes.join(', ')}\n` : '') +
        (pubchem.mesh_pharmacological_actions.length ? `MeSH actions: ${pubchem.mesh_pharmacological_actions.join(' | ')}\n` : '') +
        (pubchem.indication ? `Indication summary: ${pubchem.indication}\n` : '')
      ) : '';

      const contextBlock = buildContext(hits) + pubchemBlock;

      for (const phase of PHASES) {
        const phaseStart = Date.now();
        emit({ type: 'progress', stage: 'generating', msg: `Phase ${PHASES.indexOf(phase) + 1}/${PHASES.length}: ${phase.name} (${phase.model})…`, ms: Date.now() - t0 });

        // Heartbeat per phase
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - phaseStart) / 1000);
          emit({ type: 'progress', stage: 'generating', msg: `${phase.name}: still generating with ${phase.model}… (${elapsed}s on this phase)`, ms: Date.now() - t0 });
        }, 12000);

        let raw_out = '';
        try {
          const r = await tracedChat(traceId, `phase_${phase.name}`, {
            model: phase.model,
            messages: [
              { role: 'system', content: phase.system },
              { role: 'user', content: buildPhaseUserMessage(phase, normalized, contextBlock, renalCtx) },
            ],
            temperature: 0.2,
            max_tokens: phase.maxTokens,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: geminiModelFor('drugs') });
          raw_out = r.choices?.[0]?.message?.content ?? '';
          let parsed: Record<string, unknown>;
          try {
            parsed = parseLooseJson(raw_out) as Record<string, unknown>;
            await logEvent(traceId, 'parse_ok', phase.name, { keys: Object.keys(parsed), char_count: raw_out.length });
          } catch (parseErr) {
            await logEvent(traceId, 'parse_error', phase.name, {
              error: String((parseErr as Error).message),
              raw_response: raw_out
            });
            throw parseErr;
          }

          // v2.0.1 — self-critique pass on the pharmacology phase only.
          const useSelfCritique = body.selfCritique !== false; // default ON
          if (useSelfCritique && phase.name === 'pharmacology') {
            try {
              emit({ type: 'progress', stage: 'reviewing', msg: `pharmacology audit: checking JSON against ${citations.length} source excerpts…`, ms: Date.now() - t0 });
              const critStart = Date.now();
              const critRes = await tracedChat(traceId, 'phase_pharmacology_critique', {
                model: FAST_MODEL,
                messages: [
                  { role: 'system', content: PHARMACOLOGY_CRITIQUE_SYSTEM },
                  { role: 'user', content: `Drug: ${normalized}\n\nSource excerpts:\n${contextBlock}\n\nDraft pharmacology JSON:\n${raw_out}\n\nOutput the JSON critique now.` },
                ],
                temperature: 0.1,
                max_tokens: 600,
                ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
              }, { gemini: geminiModelFor('drugs') });
              let critRaw = critRes.choices?.[0]?.message?.content?.trim() || '{}';
              if (critRaw.startsWith('\`\`\`')) critRaw = critRaw.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\`\`\`\s*$/, '').trim();
              const ca = critRaw.indexOf('{'); const cb = critRaw.lastIndexOf('}');
              if (ca >= 0 && cb > ca) critRaw = critRaw.slice(ca, cb + 1);
              const critiqueJson = JSON.parse(critRaw) as {
                unsupported_claims?: string[]; missing_critical_info?: string[];
                incorrect_dosing?: string[]; missing_safety_signals?: string[];
                citation_problems?: string[]; needs_revision?: boolean; overall_severity?: string;
              };

              const issueCount = (critiqueJson.unsupported_claims?.length || 0)
                + (critiqueJson.missing_critical_info?.length || 0)
                + (critiqueJson.incorrect_dosing?.length || 0)
                + (critiqueJson.missing_safety_signals?.length || 0)
                + (critiqueJson.citation_problems?.length || 0);
              const severity = critiqueJson.overall_severity || (issueCount > 0 ? 'minor' : 'none');

              await logEvent(traceId, 'critique_parsed', 'reviewing', {
                issue_count: issueCount, severity,
                needs_revision: critiqueJson.needs_revision, critique: critiqueJson,
              }, Date.now() - critStart);

              emit({ type: 'critique', severity, issue_count: issueCount, details: critiqueJson as unknown as Record<string, unknown> });

              if (critiqueJson.needs_revision && issueCount > 0) {
                emit({ type: 'progress', stage: 'revising', msg: `pharmacology revision: addressing ${issueCount} issue${issueCount !== 1 ? 's' : ''} flagged by audit…`, ms: Date.now() - t0 });
                const revRes = await tracedChat(traceId, 'phase_pharmacology_revision', {
                  model: DEEP_MODEL,
                  messages: [
                    { role: 'system', content: PHARMACOLOGY_REVISION_SYSTEM },
                    { role: 'user', content: `Drug: ${normalized}\n\nSource excerpts:\n${contextBlock}\n\nEarlier draft JSON:\n${raw_out}\n\nAuditor critique JSON:\n${JSON.stringify(critiqueJson, null, 2)}\n\nOutput the revised pharmacology JSON now.` },
                  ],
                  temperature: 0.2,
                  max_tokens: 2000,
                  ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
                }, { gemini: geminiModelFor('drugs') });
                const revRaw = revRes.choices?.[0]?.message?.content ?? '';
                try {
                  parsed = parseLooseJson(revRaw) as Record<string, unknown>;
                  raw_out = revRaw;
                  await logEvent(traceId, 'revision_parse_ok', 'revising', { keys: Object.keys(parsed), char_count: revRaw.length });
                } catch (revParseErr) {
                  await logEvent(traceId, 'revision_parse_error', 'revising', { error: String((revParseErr as Error).message), raw_response: revRaw });
                  // Soft-fail: keep the draft if revision parse fails.
                }
              }
            } catch (critErr) {
              // Soft-fail: critique errors don't break the pipeline.
              await logEvent(traceId, 'critique_error', 'reviewing', { error: String((critErr as Error).message) });
            }
          }

          // Coerce all string-array fields (LLMs sometimes return [{name,description}] objects)
          const stringArrayFields = [
            'indications', 'typical_dosing', 'contraindications', 'adverse_effects', 'monitoring',
            'receptors_targets', 'formulations', 'drug_interactions_summary', 'key_pearls',
          ];
          for (const f of stringArrayFields) {
            if (f in (parsed as object)) {
              (parsed as Record<string, unknown>)[f] = toStringList((parsed as Record<string, unknown>)[f]);
            }
          }
          if ('pharmacokinetics' in (parsed as object)) {
            (parsed as Record<string, unknown>).pharmacokinetics = toStringDict((parsed as Record<string, unknown>).pharmacokinetics);
          }
          if ('special_populations' in (parsed as object)) {
            (parsed as Record<string, unknown>).special_populations = toStringDict((parsed as Record<string, unknown>).special_populations);
          }
          // Strings should be strings — coerce non-string scalars too
          for (const f of ['class', 'subclass', 'mechanism_of_action', 'biochemistry', 'pharmacodynamics', 'renal_adjust', 'hepatic_adjust']) {
            const v = (parsed as Record<string, unknown>)[f];
            if (v != null && typeof v !== 'string') (parsed as Record<string, unknown>)[f] = String(v);
          }

          // Whitelist: only fields belonging to THIS phase get emitted.
          // Phase 2's qwen sometimes returns indications:[] or other Phase 1 keys, which would overwrite skeleton data.
          const allowed = PHASE_FIELDS[phase.name] || [];
          const filtered: Record<string, unknown> = {};
          for (const k of allowed) {
            if (k in (parsed as object)) filtered[k] = (parsed as Record<string, unknown>)[k];
          }
          if (phase.name === 'fast') {
            const payload = { ...filtered, input: raw, normalized, drug_normalized: parsed.drug_normalized ?? normalized, citations };
            emit({ type: 'result', data: { phase: 'fast', ...payload } });
          } else {
            emit({ type: 'result', data: { phase: phase.name, ...filtered } });
          }
          emit({ type: 'progress', stage: 'generating', msg: `Phase ${PHASES.indexOf(phase) + 1}/${PHASES.length} ${phase.name} complete`, ms: Date.now() - t0 });
        } catch (e) {
          await logEvent(traceId, 'phase_error', phase.name, {
            error: String((e as Error).message),
            stack: (e as Error).stack?.slice(0, 2000)
          });
          outcome = 'partial';
          outcomeMsg = `${outcomeMsg ? outcomeMsg + '; ' : ''}phase ${phase.name} failed`;
          // Don't kill the whole pipeline if a later phase fails
          emit({ type: 'error', message: `phase ${phase.name} failed: ${String((e as Error).message)}` });
        } finally {
          clearInterval(heartbeat);
        }
      }

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
