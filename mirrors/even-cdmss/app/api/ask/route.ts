import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { retrieveMultiQuery } from '@/lib/multi-query';
import { TEXT_MODEL, CRITIQUE_MODEL, geminiModelFor, geminiConfigured, GEMINI_MODEL } from '@/lib/llm';
import { resolveLabOverride, labRoutingOpts } from '@/lib/lab-override';
import { modelLabel } from '@/lib/model-labels';
import { searchPlos, formatPlosForPrompt, type PlosHit } from '@/lib/plos';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { startTrace, finishTrace, tracedChat, logStreamComplete, logEvent, setTraceQuestionPreview, setTraceSeverity, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';
import { parseInvestigations, type ParsedInvestigations } from '@/lib/investigations';

export const runtime = 'nodejs';
export const maxDuration = 300;  // v1.6 hotfix: was 180; full stack on Mac Mini Ollama needs 200-280s with all features on

const SYSTEM_PROMPT = `You are Even CDMSS, a medical study companion for residents and physicians.
You answer questions using ONLY the excerpts provided below — they come from two source families:
  - MKSAP / StatPearls / UpToDate excerpts (cite as [1], [2], …)
  - PLOS ONE primary research abstracts (cite as [P1], [P2], …)

Rules:
- Be concise, precise, and clinically useful — the audience is a working physician.
- Cite the source for every clinical claim using bracketed numbers like [1], [2] or [P1].
- If the excerpts do not cover the question, say so plainly. Do not invent.
- If INVESTIGATION FINDINGS are provided with the question, treat them as the patient's actual results: incorporate them, let normal/negative results lower and abnormal results raise the relevant possibilities, and never invent a result that was not provided.
- If an excerpt looks garbled or nonsensical, ignore it rather than quoting it.
- Match the voice of MKSAP: structured, evidence-based, practical.
- Prefer textbook excerpts for established clinical guidance; prefer PLOS for recent primary evidence and emerging biomarkers.

You may also emit two special fenced block types when they add value (use sparingly):

\`\`\`mermaid
graph TD
  A[Step 1] --> B{Decision?}
  B -->|Yes| C[Path A]
  B -->|No| D[Path B]
\`\`\`
Use for workup algorithms, decision trees, or short flowcharts.

\`\`\`dosing-card
{"drug":"Metformin","starting_dose":"500mg PO BID with meals","max_dose":"2000mg/day","indication":"Type 2 DM","renal":[{"egfr":"<30","guidance":"contraindicated"}],"key_warnings":["Hold for IV contrast","B12 deficiency long-term"],"citation_ids":[1,3]}
\`\`\`
Use for drug dosing questions. Required: drug, starting_dose. Optional: indication, max_dose, renal[], hepatic[], pediatric, elderly, pregnancy, key_warnings[], black_box, citation_ids[].

\`\`\`risk-score
{"name":"CHA2DS2-VASc","components":[{"label":"Congestive HF","value":true,"points":1},{"label":"Hypertension","value":true,"points":1},{"label":"Age ≥75","value":false,"points":0},{"label":"Diabetes","value":true,"points":1},{"label":"Stroke/TIA","value":false,"points":0},{"label":"Vascular disease","value":false,"points":0},{"label":"Age 65-74","value":true,"points":1},{"label":"Sex (female)","value":true,"points":1}],"total":5,"max_total":9,"interpretation_bands":[{"range":"0","meaning":"Low risk","action":"No anticoag","severity":"low"},{"range":"1","meaning":"Borderline","action":"Consider anticoag","severity":"moderate"},{"range":"≥2","meaning":"Anticoagulate","action":"DOAC preferred","severity":"high"}],"citation_ids":[1]}
\`\`\`
Use for clinical scoring tools (CHA2DS2-VASc, HEART, qSOFA, Wells, GBS, NIHSS, Centor, MELD…). Required: name + components[] + total. Optional: max_total, interpretation_bands[], citation_ids[]. Severity = low|moderate|high|critical.

\`\`\`drug-comparison
{"question":"DOAC vs warfarin in non-valvular AF","options":[{"drug":"Apixaban","dose":"5mg BID","monitoring":"None routine","monitoring_burden":"minimal","cost_tier":"$$$","evidence_grade":"Class I A","notes":"Renal dose adjust"},{"drug":"Warfarin","dose":"INR 2-3 target","monitoring":"INR weekly→monthly","monitoring_burden":"heavy","cost_tier":"$","evidence_grade":"Class I A","notes":"Diet + interactions"}],"bottom_line":"DOAC preferred in most pts; warfarin if mechanical valve or mod-severe MS.","citation_ids":[2]}
\`\`\`
Use for X-vs-Y pharma comparisons. Required: question + options[] (≥2). Optional per option: dose, indications, contraindications, monitoring, monitoring_burden (none|minimal|moderate|heavy), cost_tier ($|$$|$$$|$$$$), evidence_grade, notes. Optional top-level: bottom_line, citation_ids[].

\`\`\`lab-trend
{"test_name":"HbA1c","unit":"%","normal_range":"<5.7","values":[{"when":"Visit 1","value":9.2,"flag":"critical"},{"when":"Visit 2 (3mo)","value":7.8,"flag":"high"},{"when":"Visit 3 (6mo)","value":7.1,"flag":"high"},{"when":"Visit 4 (9mo)","value":6.8,"flag":"high"}],"narrative":"Steady improvement on metformin + lifestyle; target <7 reached at 9mo.","citation_ids":[3]}
\`\`\`
Use for serial labs (HbA1c trend, troponin rise/fall, INR titration, creatinine after AKI). Required: test_name + values[] (≥2 with numeric value). Optional: unit, normal_range, narrative, flag per value (low|normal|high|critical), citation_ids[].

\`\`\`decision-tree
{"title":"Suspected PE workup","root":{"question":"Wells score?","branches":[{"label":"≤4","leads_to":{"question":"D-dimer?","branches":[{"label":"Negative","leads_to":{"action":"PE excluded","urgency":"routine"}},{"label":"Positive","leads_to":{"action":"CTPA","urgency":"urgent"}}]}},{"label":">4","leads_to":{"action":"CTPA without D-dimer","urgency":"urgent","note":"Empirical anticoag if delay"}}]},"citation_ids":[4]}
\`\`\`
Use for clinical decision flows. Required: title + root. Root is recursive — either {question, branches[{label, leads_to}]} OR {action, urgency, note}. urgency = routine|urgent|emergent. Prefer this over mermaid when the flow has clinical actions/urgency at leaves.`;

const CRITIQUE_SYSTEM = `You are a clinical accuracy auditor. You are reviewing a draft answer written by an AI medical study companion.

Given (1) the original question, (2) the available source excerpts (with citation tags [1]..[n] and [P1]..[Pn]), and (3) the draft answer, you must identify problems in the draft.

Output ONLY a JSON object of this exact shape:
{
  "unsupported_claims": ["claim that isn't backed by the cited source", ...],
  "missing_caveats": ["important caveat or contraindication the draft omitted", ...],
  "clinical_errors": ["factual or reasoning error", ...],
  "citation_problems": ["wrong source attributed, missing citation, etc.", ...],
  "missing_relevant_evidence": ["important excerpt the draft ignored", ...],
  "important_omissions": ["an important consideration, contraindication, red-flag/cannot-miss diagnosis, or caveat that a physician would expect for THIS question but the draft omitted — reason from the question itself and your own clinical knowledge, NOT only from the excerpts", ...],
  "needs_revision": true | false,
  "overall_severity": "none" | "minor" | "moderate" | "major"
}

Empty arrays are fine. Set needs_revision=true if ANY array has entries OR if you found clinical_errors of any severity. If the draft is solid, return needs_revision=false and empty arrays.

Be specific and actionable — each item should be a concrete fix the writer can apply. No prose outside the JSON.`;

const REVISION_SYSTEM = `You are Even CDMSS revising your own draft answer based on a clinical auditor's critique.

You will receive:
1. The original question
2. The source excerpts (with citation tags)
3. Your earlier draft
4. The auditor's critique JSON (unsupported claims, missing caveats, clinical errors, etc.)

Rewrite the draft to fix every issue. Keep what's correct, correct what's wrong, add what's missing. Cite every clinical claim using the same [n] / [P{n}] format. Do not include any meta-commentary about the revision process — output the final clean answer the physician will read.`;

export async function POST(req: NextRequest) {
  let body: { question?: string; bookFilter?: string; investigations?: string; includePlos?: boolean; multiQuery?: boolean; selfCritique?: boolean; useReranker?: boolean; useSourceWeights?: boolean; useEmbeddingV2?: boolean; providerOverride?: 'gemini' | 'ollama'; labModel?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  const question = (body.question || '').trim();
  if (!question) {
    return new Response(JSON.stringify({ error: 'question is required' }), { status: 400 });
  }
  const useMultiQuery = body.multiQuery !== false;   // default true
  const useSelfCritique = body.selfCritique !== false;  // default true
  const useReranker = body.useReranker !== false;     // v1.6 default true
  const useSourceWeights = body.useSourceWeights !== false;  // v1.6 default true
  const useEmbeddingV2 = body.useEmbeddingV2;          // v1.6 undefined → env default

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('ask', { question, bookFilter: body.bookFilter, investigations: body.investigations, multiQuery: useMultiQuery, selfCritique: useSelfCritique, reranker: useReranker, sourceWeights: useSourceWeights, embeddingV2: useEmbeddingV2 });

  // Hybrid backend: route the reasoning passes to Gemini when GEMINI_ALL / GEMINI_ASK
  // is set (and Vertex configured); undefined = unchanged local Ollama path.
  // providerOverride (used by the Lab MCP free-testing harness) wins: 'ollama' forces
  // the mini (₹0), 'gemini' forces Vertex; absent → the env default. Mirrors /api/ddx.
  const G = body.providerOverride === 'ollama' ? undefined
    : body.providerOverride === 'gemini' ? (geminiConfigured() ? GEMINI_MODEL : undefined)
    : geminiModelFor('ask');

  // F11 (addendum A12, decision 15) — the Lab provider override, evaluated at exactly the point
  // providerOverride is already interpreted. SIX gate conditions, all required, in order; ANY
  // failure returns null and this route behaves EXACTLY as it does today. `labModel` is a new,
  // additive field: absent ⇒ resolveLabOverride short-circuits before touching env or cookies, LAB
  // is {}, and `{ gemini: G, ...LAB }` is byte-identical to `{ gemini: G }`. A refused override is
  // silent — it is never surfaced into a clinical response.
  const labOverride = await resolveLabOverride(req, body.labModel, 'app/api/ask');
  const LAB = labRoutingOpts(labOverride);

  // v1.7 Sprint A: capture request + denormalize fast-access fields on traces row.
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, question),
    setTraceModelSummary(traceId, labOverride
      // F11: record the RESOLVED model and its provider, never the requested string.
      ? { draft: labOverride.model, critique: labOverride.model, revise: labOverride.model, embedding: 'mxbai-embed-large', reranker: 'llama3.1:8b-judge', provider: labOverride.provider }
      : { draft: G ?? TEXT_MODEL, critique: G ?? CRITIQUE_MODEL, revise: G ?? CRITIQUE_MODEL, embedding: 'mxbai-embed-large', reranker: 'llama3.1:8b-judge', provider: G ? 'gemini' : 'ollama' }),
  ]);

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      // v1.7 Sprint A: track the final assembled answer across all branches
      // (clean draft, revised draft, single-pass with selfCritique off) so we
      // can emit a final_answer event + denormalize into traces.final_answer_text.
      let finalAnswer = '';

      // ── Phase 1: RETRIEVAL ──────────────────────────────────────────────
      emit({ type: 'progress', stage: 'expanding', msg: useMultiQuery ? 'Generating query variants…' : 'Rewriting query for semantic search…' });
      const includePlos = body.includePlos !== false;

      // Investigation findings (optional) — parse free text into structured,
      // flagged findings, inject into the prompt, and steer retrieval. Fail-open:
      // on any parse failure the verbatim text still flows in via promptBlock.
      let investigations: ParsedInvestigations | null = null;
      if (body.investigations && body.investigations.trim()) {
        emit({ type: 'progress', stage: 'expanding', msg: 'Interpreting investigation results…' });
        investigations = await parseInvestigations(body.investigations, { model: CRITIQUE_MODEL, traceId, gemini: G, ...LAB });
      }
      const questionForPrompt = investigations?.promptBlock ? `${question}\n\n${investigations.promptBlock}` : question;
      const retrievalQuery = [question, ...(investigations?.abnormalTerms ?? [])].filter(Boolean).join('; ');

      const retrieveOpts = {
        bookFilter: body.bookFilter,
        topK: 8,
        useReranker,
        useSourceWeights,
        useNormativeLeg: true,   // R-11 Stage 1: non-scoring surface — normative statements earn a pool seat
        ...(useEmbeddingV2 !== undefined ? { useEmbeddingV2 } : {}),
      };
      const retrievalPromise = useMultiQuery
        ? retrieveMultiQuery(retrievalQuery, retrieveOpts)
        : retrieve(retrievalQuery, retrieveOpts).then((r) => ({ hits: r.hits, variants: [question], perVariantCounts: [r.hits.length] }));
      const plosPromise: Promise<PlosHit[]> = includePlos ? searchPlos(question, { rows: 5, yearsBack: 5 }) : Promise.resolve([]);

      const [retrieveResult, plosHits] = await Promise.all([retrievalPromise, plosPromise]);
      const hits = retrieveResult.hits;
      // v1.7 Sprint A: forensic capture — full text of every retrieved chunk + scores
      await Promise.all([
        logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
          variants: retrieveResult.variants,
          per_variant_counts: retrieveResult.perVariantCounts,
          hits: hits.map((h) => ({
            id: h.id, book: h.book, chapter: h.chapter, section: h.section,
            page_start: h.page_start, page_end: h.page_end,
            chunk_type: h.chunk_type, token_count: h.token_count,
            similarity: h.similarity,
            // @ts-expect-error v1.6 added these fields to ChunkHitWithMeta
            source_quality_weight: h.source_quality_weight,
            // @ts-expect-error v1.6 added these fields
            rerank_score: h.rerank_score,
            // @ts-expect-error v1.6 added these fields
            rerank_backend: h.rerank_backend,
            text: h.text,  // FULL TEXT — biggest forensic capture
          })),
        }),
        includePlos ? logEvent(traceId, 'plos_search', 'retrieving', {
          query: question.slice(0, 200),
          hit_count: plosHits.length,
          hits: plosHits.map((p) => ({ doi: p.doi, title: p.title, year: p.year, authors: p.authors, url: p.url, abstract: p.abstract })),
        }) : Promise.resolve(),
      ]);

      if (useMultiQuery && retrieveResult.variants.length > 1) {
        emit({
          type: 'progress',
          stage: 'variants',
          msg: `Generated ${retrieveResult.variants.length - 1} query variants: ${retrieveResult.variants.slice(1).map((v) => `"${v.slice(0, 50)}${v.length > 50 ? '…' : ''}"`).join(' · ')}`,
          ms: Date.now() - t0,
        });
      }
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} textbook + ${plosHits.length} PLOS ONE excerpts (fused from ${retrieveResult.variants.length} ${retrieveResult.variants.length === 1 ? 'query' : 'queries'})`, ms: Date.now() - t0 });
      if (useReranker) emit({ type: 'progress', stage: 'reranking', msg: `Reranked by cross-encoder + ${useSourceWeights ? 'source-quality fusion' : 'no source weights'}`, ms: Date.now() - t0 });
      else if (useSourceWeights) emit({ type: 'progress', stage: 'fusing', msg: 'Applied source-quality weights', ms: Date.now() - t0 });

      if (hits.length === 0 && plosHits.length === 0) {
        emit({ type: 'error', message: 'no relevant excerpts above similarity threshold' });
        outcome = 'error'; outcomeMsg = 'no relevant excerpts';
        close();
        return;
      }

      const sources = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        item_number: h.item_number, chunk_type: h.chunk_type,
        similarity: typeof h.similarity === "number" ? Number(h.similarity.toFixed(3)) : 0,
        preview: h.text.slice(0, 600),
      }));
      const plosSources = plosHits.map((p, i) => ({
        n: i + 1, kind: 'plos' as const, doi: p.doi, title: p.title,
        authors: p.authors, year: p.year, url: p.url, full_url: p.full_url,
        preview: p.abstract.slice(0, 600),
      }));
      emit({ type: 'sources', items: sources, plos: plosSources });

      const contextBlock = hits.map((h, i) => {
        const cite = `[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}${h.item_number ? ' · Item ' + h.item_number : ''}`;
        return `--- Excerpt ${i + 1} ---\n${cite}\n${h.text}\n`;
      }).join('\n');
      const plosBlock = formatPlosForPrompt(plosHits);
      const sourceBlock = `MKSAP / StatPearls / UpToDate Excerpts:\n${contextBlock || '(none)'}\n\n${plosBlock ? 'PLOS ONE Primary Research Abstracts:\n' + plosBlock + '\n\n' : ''}`;

      // ── Phase 2: DRAFT (STREAMING when self-critique enabled — UX win) ────
      // The draft tokens go to the UI immediately so the user sees text at ~50s
      // instead of waiting for the full critique+revise loop (~4 min).
      // If critique later finds issues, we emit 'draft_superseded' and re-stream
      // the revision so the UI swaps the answer.
      let draftAnswer = '';
      if (useSelfCritique) {
        emit({ type: 'progress', stage: 'drafting', msg: `Drafting answer with ${modelLabel(TEXT_MODEL)}… (audit + revise will use ${modelLabel(CRITIQUE_MODEL)} after)`, ms: Date.now() - t0 });
        const draftStart = Date.now();
        const draftRes = await tracedChat(traceId, 'draft', {
          model: TEXT_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Question:\n${questionForPrompt}\n\n${sourceBlock}Answer using only these excerpts. Cite textbook claims with [n] and PLOS abstracts with [P{n}].` },
          ],
          temperature: 0.2,
          stream: true,
          ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
        }, { gemini: G, ...LAB });
        for await (const part of draftRes as AsyncIterable<{ choices?: { delta?: { content?: string } }[] }>) {
          const delta = part.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            draftAnswer += delta;
            emit({ type: 'token', content: delta });
            // v1.7 Sprint A: token-level forensic capture (TRACE_TOKENS lock #7 default ON)
            if (process.env.TRACE_TOKENS !== 'false') {
              // Fire-and-forget; don't block the stream on DB write latency
              logEvent(traceId, 'stream_event', 'drafting', { content: delta }).catch(() => {});
            }
          }
        }
        emit({ type: 'draft_complete', chars: draftAnswer.length });
        await logStreamComplete(traceId, 'draft', draftAnswer, draftStart, { model: TEXT_MODEL });

        // ── Phase 3: CRITIQUE ──────────────────────────────────────────────
        emit({ type: 'progress', stage: 'reviewing', msg: 'Auditing draft for unsupported claims, missing caveats, clinical errors…', ms: Date.now() - t0 });
        const critiqueStart = Date.now();
        let critiqueJson: {
          unsupported_claims?: string[]; missing_caveats?: string[]; clinical_errors?: string[];
          citation_problems?: string[]; missing_relevant_evidence?: string[]; important_omissions?: string[];
          needs_revision?: boolean; overall_severity?: string;
        } = { needs_revision: false };
        // ⚠️ DID THE CRITIC ACTUALLY RUN? (7 Aug 2026.) The catch below swallows every failure —
        // a transport error, a truncated response, unparseable JSON — and leaves the default
        // `{ needs_revision: false }`, which scores ZERO issues and severity 'none'. That is
        // indistinguishable from a draft the critic read and passed, and it is what a live Bedrock
        // run produced when its critique truncated: a stored answer that looked audited and clean
        // and had never been audited at all. The severity vocabulary is unchanged (readers depend
        // on it); this flag rides beside it so "0 issues" can be told from "no critique".
        let criticRan = true;
        try {
          const critiqueRes = await tracedChat(traceId, 'critique', {
            model: CRITIQUE_MODEL,  // 7b instead of 14b — ~3x faster, audit quality acceptable
            messages: [
              { role: 'system', content: CRITIQUE_SYSTEM },
              { role: 'user', content: `Question:\n${questionForPrompt}\n\n${sourceBlock}Draft answer to audit:\n${draftAnswer}\n\nOutput the JSON critique now.` },
            ],
            temperature: 0.1,
            stream: false,
            max_tokens: 800,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          }, { gemini: G, ...LAB });
          let critiqueRaw = (critiqueRes as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content?.trim() || '{}';
          if (critiqueRaw.startsWith('```')) critiqueRaw = critiqueRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          const a = critiqueRaw.indexOf('{'); const b = critiqueRaw.lastIndexOf('}');
          if (a >= 0 && b > a) critiqueRaw = critiqueRaw.slice(a, b + 1);
          critiqueJson = JSON.parse(critiqueRaw);
        } catch (e) {
          criticRan = false;
          console.warn('[ask critique] did not complete — the draft is UNAUDITED, not clean:', (e as Error).message);
        }
        await logStreamComplete(traceId, 'critique', JSON.stringify(critiqueJson), critiqueStart, { model: CRITIQUE_MODEL });

        const issueCount = (critiqueJson.unsupported_claims?.length || 0)
          + (critiqueJson.missing_caveats?.length || 0)
          + (critiqueJson.clinical_errors?.length || 0)
          + (critiqueJson.citation_problems?.length || 0)
          + (critiqueJson.missing_relevant_evidence?.length || 0)
          + (critiqueJson.important_omissions?.length || 0);

        const severity = critiqueJson.overall_severity || (issueCount > 0 ? 'minor' : 'none');

        // v1.7 Sprint A: forensic capture of critique JSON + denormalize severity
        await Promise.all([
          logEvent(traceId, 'critique_parsed', 'reviewing', {
            issue_count: issueCount,
            severity,
            needs_revision: critiqueJson.needs_revision,
            critic_ran: criticRan,
            critique: critiqueJson,
          }),
          setTraceSeverity(traceId, severity),
        ]);

        emit({
          type: 'critique',
          severity,
          issue_count: issueCount,
          critic_ran: criticRan,
          details: critiqueJson,
        });

        // ── Phase 4: REVISION (streaming) — only if critique flagged issues ────
        if (critiqueJson.needs_revision && issueCount > 0) {
          // Tell UI: the draft we already streamed is superseded; clear that buffer
          // and accept the NEW tokens we're about to stream as the canonical answer.
          emit({ type: 'draft_superseded', reason: `${issueCount} issue${issueCount !== 1 ? 's' : ''} found by audit` });
          emit({ type: 'progress', stage: 'revising', msg: `Revising with ${modelLabel(CRITIQUE_MODEL)} to address ${issueCount} issue${issueCount !== 1 ? 's' : ''}…`, ms: Date.now() - t0 });
          const revStart = Date.now();
          const revRes = await tracedChat(traceId, 'revision', {
            model: CRITIQUE_MODEL,  // 7b for the revise pass too
            messages: [
              { role: 'system', content: REVISION_SYSTEM },
              { role: 'user', content: `Question:\n${questionForPrompt}\n\n${sourceBlock}Earlier draft:\n${draftAnswer}\n\nAuditor's critique (JSON):\n${JSON.stringify(critiqueJson, null, 2)}\n\nOutput the revised final answer now.` },
            ],
            temperature: 0.2,
            stream: true,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          }, { gemini: G, ...LAB });
          let fullContent = '';
          for await (const part of revRes) {
            const delta = part.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              fullContent += delta;
              emit({ type: 'token', content: delta });
              if (process.env.TRACE_TOKENS !== 'false') {
                logEvent(traceId, 'stream_event', 'revising', { content: delta }).catch(() => {});
              }
            }
          }
          await logStreamComplete(traceId, 'revision', fullContent, revStart, { model: CRITIQUE_MODEL });
          finalAnswer = fullContent;
        } else {
          // Draft was clean — that's the final answer
          finalAnswer = draftAnswer;
        }
        // else: draft already streamed to UI during Phase 2; nothing to do.
      } else {
        // Self-critique disabled — original single-pass streaming behavior
        emit({ type: 'progress', stage: 'generating', msg: `Generating answer with ${modelLabel(TEXT_MODEL)}…`, ms: Date.now() - t0 });
        const llmStart = Date.now();
        const completion = await tracedChat(traceId, 'answer', {
          model: TEXT_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Question:\n${questionForPrompt}\n\n${sourceBlock}Answer using only these excerpts. Cite textbook claims with [n] and PLOS abstracts with [P{n}].` },
          ],
          temperature: 0.2,
          stream: true,
          ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
        }, { gemini: G, ...LAB });
        let fullContent = '';
        for await (const part of completion) {
          const delta = part.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            fullContent += delta;
            emit({ type: 'token', content: delta });
            if (process.env.TRACE_TOKENS !== 'false') {
              logEvent(traceId, 'stream_event', 'generating', { content: delta }).catch(() => {});
            }
          }
        }
        await logStreamComplete(traceId, 'answer', fullContent, llmStart, { model: TEXT_MODEL });
        finalAnswer = fullContent;
      }

      // v1.7 Sprint A: emit final_answer event + denormalize into traces.final_answer_text
      // for fast list rendering + tsvector indexing.
      await Promise.all([
        logEvent(traceId, 'final_answer', 'done', {
          answer: finalAnswer,
          char_count: finalAnswer.length,
          total_ms: Date.now() - t0,
        }),
        setTraceFinalAnswer(traceId, finalAnswer),
      ]);

      // trace_id rides the terminal event (F11 DEC-2, 7 Aug 2026) so a lab probe can ask the
      // TRACE what served it instead of asserting what it asked for. Additive: every existing
      // consumer ignores unknown fields, and the id is an opaque key that unlocks nothing
      // without the admin gate.
      emit({ type: 'done', ms: Date.now() - t0, trace_id: traceId });
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
