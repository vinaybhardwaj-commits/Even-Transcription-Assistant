import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { retrieveMultiQuery } from '@/lib/multi-query';
import { searchPlos, formatPlosForPrompt, type PlosHit } from '@/lib/plos';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { startTrace, finishTrace, tracedChat, logEvent, setTraceQuestionPreview, setTraceSeverity, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';
import { filterByDemographics, crossLinkDdxBuckets } from '@/lib/ddx-constraints';
import { rerank } from '@/lib/rerank';
import { computeSourceQualityWeight } from '@/lib/source-quality';
import { parseInvestigations, type ParsedInvestigations } from '@/lib/investigations';
import { generateHypotheses, gatherHypothesisEvidence, formatHypothesesForPrompt, type Hypothesis } from '@/lib/ddx-hypothesis';
import { geminiConfigured, GEMINI_MODEL } from '@/lib/llm';
import { resolveLabOverride, labRoutingOpts } from '@/lib/lab-override';
import { buildDdxClinicalState } from '@/lib/clinical-state/from-primitives';
import { stateCounts, type ClinicalState } from '@/lib/clinical-state/schema';
import { normalizeWithLlm, mergeLlmFindings } from '@/lib/clinical-state/extract';
import { clinicalStateResultField } from '@/lib/clinical-state/ui-view';

export const runtime = 'nodejs';
export const maxDuration = 300;  // hypothesis-first beta adds passes; Pro allows 300s. Classic still finishes ~2min.

const DDX_MODEL = 'llama3.1:8b';            // fast pre-passes only: hypotheses + investigations parse
const DDX_DRAFT_MODEL = 'qwen2.5:14b';      // FULL reasoning pipeline: draft + critique + revise. 8b anchored/fabricated as the drafter AND (as the reviser) rewrote good 14b drafts into garbage — keep the reasoning model consistent.

const SYSTEM = `You are an expert physician generating a differential diagnosis as JSON. Use ONLY the supplied excerpts for clinical content, and reason ONLY from the patient findings stated in the presentation.

HARD RULES (a violation makes the output unsafe):
1. DEMOGRAPHICS ARE CONSTRAINTS, NOT HINTS. Never include a diagnosis anatomically or physiologically impossible for the patient's stated sex — e.g. NO ovarian/uterine/cervical/vaginal/pregnancy/eclampsia diagnoses for a male; NO testicular/prostatic/scrotal/penile diagnoses for a female. Weight every diagnosis by age and sex prevalence; exclude diagnoses with negligible prevalence at this age unless a specific stated risk factor supports them (e.g. do not list aortic dissection in a healthy 14-year-old).
2. GROUND EVERYTHING IN STATED FINDINGS. Do not invent or assume any symptom, sign, lab, or imaging result that is not explicitly given. Every why_consider/distinguishing_feature must reference only provided findings. If a finding is explicitly negative or normal (e.g. "no fever", "soft, non-tender abdomen"), use it to LOWER or exclude diagnoses that depend on it — never cite an absent finding as supporting evidence. INVESTIGATION RESULTS, when supplied, are stated findings: reconcile every diagnosis against them — an abnormal result that fits rules a diagnosis IN, a normal/negative result that would be expected to be abnormal rules it DOWN. Never invent or assume a result that is not in the supplied investigation list.
3. INTERPRET, DON'T ANCHOR. Translate lay/patient terms into clinical possibilities (e.g. "indigestion"/epigastric discomfort in an older adult with cardiac risk factors MUST include acute coronary syndrome). Consider diagnoses across ALL relevant organ systems — do not stay inside the system implied by the chief complaint's wording. Explicitly weight risk factors and red flags: age, sex, comorbidities (diabetes, hypertension), sudden onset, diaphoresis, pallor, syncope, symptoms waking the patient from sleep, failure of symptomatic therapy.
4. SPECIFIC / PATHOGNOMONIC RESULTS DOMINATE. When a supplied investigation result is characteristic of or pathognomonic for a particular diagnosis (e.g. PAS-positive macrophages on small-bowel biopsy → Whipple disease; ST-elevation + raised troponin → acute coronary syndrome; anti-CCP → rheumatoid arthritis), that diagnosis MUST be a LEADING consideration — ranked high — not a low-probability afterthought. Never let a common chief-complaint pattern (e.g. chronic diarrhoea → gluten/lactose intolerance) outrank a specific result that points elsewhere. investigation_fit MUST BE TRUTHFUL: a result may support, argue against, OR be non-specific for a diagnosis — NEVER claim a result "supports" a diagnosis when that result is actually characteristic of a DIFFERENT diagnosis.

RANKING — two INDEPENDENT axes:
- cannot_miss = ranked by CONSEQUENCE of a missed or delayed diagnosis (dangerous / time-sensitive), even when probability is LOW. Never place benign or self-limited conditions here. Worst-first. Each item's "likelihood" is its probability for THIS patient and may be low.
- most_likely = ranked by PROBABILITY for this exact presentation.
- CROSS-LISTING: a diagnosis MAY appear on BOTH axes ONLY when it is simultaneously your leading-probability diagnosis AND dangerous to miss (e.g. a confirmed Wilson's disease). When it legitimately belongs on both, write the IDENTICAL diagnosis name in each list and keep its why_consider / distinguishing_features / citations CONSISTENT — it is ONE diagnosis viewed on two axes (the interface cross-links the two entries), not two separate diagnoses. Do NOT duplicate a diagnosis that is only dangerous-but-unlikely (cannot_miss only) or only likely-but-benign (most_likely only).

Return ONLY this JSON object, lowercase keys exactly as shown:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"investigation_fit":"","citation_ids":[1,2],"plos_citation_ids":["P1"]}],"most_likely":[...same shape...],"other":[...same shape...]}

- cannot_miss: 2-3 items (worst-first)
- most_likely: 2-3 items (by probability)
- other: 1-2 less likely but reasonable
- investigations = SUGGESTED next workup to confirm/refute this diagnosis (what to ORDER).
- investigation_fit = ONLY when INVESTIGATION RESULTS are supplied in the presentation: one TRUTHFUL clause (<14 words) on how those already-back results bear on THIS diagnosis — it may "support", "argue against", or be "non-specific" (e.g. "troponin elevated + anterior ST-elevation → supports"; "CT head normal → lowers but does not exclude"; "PAS-positive macrophages → characteristic of Whipple, not this dx"). Use "" (empty string) when no results were supplied. Do NOT restate results that were not provided, and do NOT claim a result supports this diagnosis when it is actually characteristic of a different one.
- citation_ids = 1-based numbers from the MEDICAL EXCERPTS (textbook). Cite every textbook claim.
- plos_citation_ids = strings like "P1", "P2" from PLOS ONE ABSTRACTS, if any inform the diagnosis. May be empty array []. CRITICAL: each entry MUST be a JSON string with DOUBLE QUOTES — write ["P1","P2"] not [P1,P2]. Unquoted barewords are invalid JSON and will fail parse.
- No prose, no markdown fences, lowercase keys.`;

type Body = { age?: number | string; sex?: string; cc?: string; history?: string; exam?: string; vitals?: string; investigations?: string; includePlos?: boolean; multiQuery?: boolean; selfCritique?: boolean; engine?: 'classic' | 'hypothesis'; providerOverride?: 'gemini' | 'ollama'; labModel?: string };

const DDX_CRITIQUE_SYSTEM = `You are a clinical auditor reviewing a draft differential diagnosis (DDx) JSON for a SPECIFIC patient.

Given (1) the clinical presentation (note the patient's age, sex, and any negative/normal findings), (2) the available source excerpts (textbook [n] and PLOS [P{n}]), and (3) the draft DDx JSON, identify problems.

Output ONLY a JSON object of this shape:
{
  "demographic_impossibility": ["diagnoses impossible for the patient's stated sex/age, e.g. ovarian pathology in a male, prostatitis in a female, aortic dissection in a young child without risk factors"],
  "fabricated_findings": ["findings asserted anywhere in the draft that are NOT present in the clinical presentation"],
  "ignored_negatives": ["diagnoses kept or up-ranked despite a stated negative/normal finding that argues against them"],
  "missing_cannot_miss": ["dangerous, time-sensitive diagnoses that should be in cannot_miss but aren't (include classic atypical high-risk presentations, e.g. ACS presenting as indigestion)"],
  "cannot_miss_misuse": ["benign/self-limited diagnoses wrongly placed in cannot_miss, or dangerous diagnoses mis-ranked vs likelihood"],
  "likelihood_errors": ["diagnoses with wrong/implausible likelihood for this presentation"],
  "anchoring_or_atypical_miss": ["diagnostic anchoring on the chief-complaint wording or one organ system, missing cross-system possibilities the findings support"],
  "investigation_misread": ["ONLY if investigation RESULTS were supplied: a result that is CHARACTERISTIC or PATHOGNOMONIC for a diagnosis which is MISSING or ranked too LOW (e.g. PAS-positive macrophages but Whipple disease absent or low-likelihood; ST-elevation but ACS not top); a diagnosis kept or up-ranked despite a supplied result that argues strongly against it; a supplied abnormal result not reflected anywhere in the DDx; an investigation_fit that claims a result SUPPORTS this diagnosis when the result is actually characteristic of a DIFFERENT diagnosis (fabricated support); or an investigation_fit that misstates or invents a result not in the supplied list"],
  "unsupported_claims": ["claims that aren't backed by the cited excerpt"],
  "investigation_problems": ["wrong, missing, or low-yield investigations"],
  "citation_problems": ["wrong source attributed, missing citation_ids, etc."],
  "needs_revision": true | false,
  "overall_severity": "none" | "minor" | "moderate" | "major"
}

Empty arrays are fine. Set needs_revision=true if ANY of demographic_impossibility, fabricated_findings, ignored_negatives, missing_cannot_miss, cannot_miss_misuse, or investigation_misread is non-empty, OR there are major likelihood_errors. Set overall_severity to "major" if any demographic_impossibility, fabricated_findings, missing_cannot_miss, or investigation_misread exist. Be specific and actionable. No prose outside the JSON.`;

const DDX_REVISION_SYSTEM = `You are revising your earlier DDx draft based on a clinical auditor's critique.

You will receive (1) the clinical presentation, (2) source excerpts, (3) the draft JSON, (4) the auditor's critique. Output the REVISED full DDx JSON using the EXACT shape required:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"investigation_fit":"","citation_ids":[1,2],"plos_citation_ids":["P1"]}],"most_likely":[...],"other":[...]}

Apply every fix in the critique: REMOVE diagnoses impossible for the patient's sex/age, DELETE any fabricated findings (reason only from stated findings), remove or down-rank diagnoses contradicted by a stated negative/normal finding OR by a supplied investigation result, ADD missing cannot-miss diagnoses (including atypical high-risk presentations), MOVE benign/self-limited conditions out of cannot_miss, correct likelihoods, broaden across organ systems where the findings support it, replace unsupported claims, swap weak investigations, fix citations. When investigation RESULTS were supplied, set investigation_fit on every diagnosis to a true clause about how the supplied results bear on it (and never invent a result not in the supplied list); leave investigation_fit as "" if no results were supplied. Respect patient demographics as hard constraints. If a diagnosis legitimately belongs on BOTH the cannot_miss and most_likely axes (leading probability AND dangerous), use the IDENTICAL name and consistent rationale in both lists — it is cross-linked as one diagnosis, not duplicated. No prose, no markdown fences, lowercase keys only. CRITICAL: plos_citation_ids must be quoted strings — write ["P1","P2"] not [P1,P2]. Output MUST be valid JSON.`;


function buildPresentation(b: Body): { display: string; queryHint: string } {
  const parts: string[] = [];
  const agePart = b.age ? `${b.age}` : null;
  const sexPart = b.sex && b.sex !== '?' ? `${b.sex}` : null;
  const demo = [agePart, sexPart].filter(Boolean).join(' / ');
  if (demo) parts.push(`Patient: ${demo}`);
  if (b.cc) parts.push(`Chief complaint: ${b.cc.trim()}`);
  if (b.history) parts.push(`Key history: ${b.history.trim()}`);
  if (b.exam) parts.push(`Exam: ${b.exam.trim()}`);
  if (b.vitals) parts.push(`Vitals: ${b.vitals.trim()}`);
  // queryHint drives RETRIEVAL only (display drives the prompt). Keep it to the
  // clinically discriminating text — chief complaint, history, exam morphology —
  // and DROP demographics ("38 / F") and vitals ("normal"), which carry no useful
  // semantic signal and drag the embedding toward the wrong neighbourhood.
  return { display: parts.join('\n'), queryHint: [b.cc, b.history, b.exam].filter(Boolean).join('; ') };
}

function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  // v1.7c hotfix: model sometimes emits ["plos_citation_ids":[P1, P2]] (unquoted barewords)
  // on the revision pass — JSON.parse rejects that. Coerce to ["P1","P2"] before parse.
  t = t.replace(/("plos_citation_ids"\s*:\s*\[)([^\]]*)(\])/g, (_match, open, inner, close) => {
    const items = String(inner).split(',').map((raw: string) => {
      const tr = raw.trim();
      if (!tr) return '';
      if (/^["'].*["']$/.test(tr)) return tr;                  // already quoted
      return JSON.stringify(tr.replace(/^["']|["']$/g, ''));   // wrap bareword
    }).filter(Boolean).join(',');
    return open + items + close;
  });
  // Same fix for citation_ids if model wraps numbers in strings instead of bare ints — harmless coverage
  return JSON.parse(t);
}

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  if (!body.cc || !body.cc.trim()) {
    return new Response(JSON.stringify({ error: 'chief_complaint required' }), { status: 400 });
  }
  const { display, queryHint } = buildPresentation(body);

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('ddx', { cc: body.cc, age: body.age, sex: body.sex, history: body.history, exam: body.exam, vitals: body.vitals, investigations: body.investigations });

  // Hybrid backend: route the DDx reasoning to Gemini (Vertex) when enabled.
  // Per-request body.providerOverride (used by the A/B harness) wins; otherwise the
  // global GEMINI_DDX flag. G = the Gemini model to use, or undefined for the
  // unchanged local path. tracedChat falls back to the Ollama models on any error.
  const wantGemini =
    body.providerOverride === 'gemini' ||
    (body.providerOverride !== 'ollama' && (process.env.GEMINI_DDX === '1' || process.env.GEMINI_ALL === '1'));
  const G: string | undefined = wantGemini && geminiConfigured() ? GEMINI_MODEL : undefined;

  // F11 (addendum A12, decision 15) — the Lab provider override, evaluated at exactly the point
  // providerOverride is already interpreted, identically to app/api/ask. SIX gate conditions, all
  // required, in order; ANY failure returns null and this route behaves EXACTLY as today. `labModel`
  // is additive: absent ⇒ the gate short-circuits before touching env or cookies, LAB is {}, and
  // `{ gemini: G, ...LAB }` is byte-identical to `{ gemini: G }`. A refused override is silent.
  const labOverride = await resolveLabOverride(req, body.labModel, 'app/api/ddx');
  const LAB = labRoutingOpts(labOverride);

  // v1.7b S2: capture request + denormalize fast-access fields on traces row.
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, display.replace(/\n+/g, ' • ')),
    setTraceModelSummary(traceId, labOverride
      // F11: record the RESOLVED model and its provider, never the requested string.
      ? { draft: labOverride.model, critique: labOverride.model, revise: labOverride.model, embedding: 'mxbai-embed-large', provider: labOverride.provider }
      : { draft: G ?? DDX_DRAFT_MODEL, critique: G ?? DDX_DRAFT_MODEL, revise: G ?? DDX_DRAFT_MODEL, embedding: 'mxbai-embed-large', provider: G ? 'gemini' : 'ollama' }),
  ]);

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      const includePlos = body.includePlos !== false;
      const useMultiQuery = body.multiQuery !== false;  // default true

      // Investigation findings: LLM-parse the free text into structured, flagged
      // findings BEFORE retrieval so abnormal terms steer recall, and inject the
      // normalised block into the reasoning presentation. Fail-open: on any parse
      // failure the verbatim text still flows in via promptBlock.
      let investigations: ParsedInvestigations | null = null;
      if (body.investigations && body.investigations.trim()) {
        emit({ type: 'progress', stage: 'expanding', msg: 'Interpreting investigation results…' });
        investigations = await parseInvestigations(body.investigations, { age: body.age, sex: body.sex, model: DDX_MODEL, traceId, gemini: G, ...LAB });
      }
      const displayForPrompt = investigations?.promptBlock ? `${display}\n\n${investigations.promptBlock}` : display;
      const investigationTerms = investigations?.abnormalTerms ?? [];

      // Phase 1a — ClinicalState: computed + traced ALONGSIDE the pipeline. It feeds
      // nothing (displayForPrompt untouched) and blocks nothing (fail-open). The
      // stage-2 LLM normalisation is gated OFF by default (CLINICAL_STATE_LLM=1);
      // default path adds zero model calls.
      // Build 1c: the built state is captured here for the OPTIONAL additive response field
      // (gated by CLINICAL_STATE_UI, default off — see the emit below). Capture only; the
      // differential path is untouched.
      let clinicalStateForUi: ClinicalState | null = null;
      let rejectedSpanCount = 0;
      try {
        let clinicalState = buildDdxClinicalState(body, investigations);
        let rejectedSpans: unknown[] = [];
        if (process.env.CLINICAL_STATE_LLM === '1') {
          const llmPass = await normalizeWithLlm(
            { surface: 'ddx', age: body.age, sex: body.sex, fields: { complaint: body.cc, history: body.history, exam: body.exam, vitals: body.vitals } },
            async (system, user) => {
              const res = await tracedChat(traceId, 'clinical_state_normalise', {
                model: DDX_MODEL,
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                temperature: 0.1,
                max_tokens: 900,
                ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
              }, { gemini: G, ...LAB, promptRef: 'extract/NORMALISE_SYSTEM' });
              return res.choices?.[0]?.message?.content ?? '';
            },
          );
          clinicalState = mergeLlmFindings(clinicalState, llmPass);
          rejectedSpans = llmPass.rejected;
        }
        clinicalStateForUi = clinicalState;       // 1c: capture for the optional response field
        rejectedSpanCount = rejectedSpans.length;
        await logEvent(traceId, 'clinical_state_extracted', 'expanding', {
          ok: true,
          counts: stateCounts(clinicalState),
          unstable: clinicalState.instability.unstable,
          rejected_spans: rejectedSpans,
          state: clinicalState,
        });
      } catch (e) {
        await logEvent(traceId, 'clinical_state_extracted', 'expanding', { ok: false, error: String((e as Error).message) }).catch(() => {});
      }

      // Hypothesis-first engine (flag-gated; default classic so production is
      // unchanged). When on, the model proposes a broad differential from clinical
      // reasoning FIRST (run in parallel with the broad retrieval below), then we
      // retrieve evidence targeted at each named candidate — so the differential's
      // breadth is no longer capped by a single semantic search.
      // Hypothesis-first is now the DEFAULT: it proposes diagnoses from clinical
      // reasoning, then retrieves evidence per candidate — the only robust fix for
      // clue-based diagnoses (e.g. cutaneous leishmaniasis from a camping/exposure
      // history) that aren't reliably retrievable from the presentation embedding.
      // Explicit engine:'classic' opts out; env DDX_HYPOTHESIS_FIRST='0' is a global
      // kill switch if the heavier path causes production timeouts.
      const useHypothesisFirst = body.engine !== 'classic'
        && process.env.DDX_HYPOTHESIS_FIRST !== '0';
      if (useHypothesisFirst) emit({ type: 'progress', stage: 'expanding', msg: 'Generating candidate differential from clinical reasoning…' });
      const hypothesesPromise: Promise<Hypothesis[]> = useHypothesisFirst
        ? generateHypotheses(displayForPrompt, { model: DDX_MODEL, traceId, max: 8, gemini: G, ...LAB })
        : Promise.resolve([]);

      const plosQuery = (body.cc || queryHint || display).trim();
      emit({ type: 'progress', stage: 'expanding', msg: useMultiQuery ? 'Generating query variants…' : 'Building clinical summary, expanding query…' });

      const retrievalQuery = [queryHint || display, ...investigationTerms].filter(Boolean).join('; ');
      const bm25Query = [(body.cc || '').trim(), ...investigationTerms].filter(Boolean).join(' ');
      // Widened from 8 → 16: the differential-enumerating chunks (e.g. the
      // "nodular masses" differential tables) and key cannot-miss diagnoses
      // routinely sit at ranks 9–18, so topK=8 silently truncated the differential.
      const DDX_TOP_K = 16;
      // In hypothesis-first mode the per-candidate retrieval is the primary signal,
      // so run the broad pool as a single query (skips the variant-gen LLM call) to
      // cut Mac-Mini Ollama load. Classic keeps multi-query.
      const broadMultiQuery = useMultiQuery && !useHypothesisFirst;
      const retrievePromise = broadMultiQuery
        // Broad pool gets BOTH source-quality weighting (free) AND the LLM reranker
        // (Gemini Flash, ~1 parallel round-trip). Post the Jun-2026 2M-abstract load,
        // raw similarity alone floats off-topic journal abstracts above textbooks
        // (a JACC abstract at 0.85 over a relevant UpToDate chunk at 0.42); the reranker
        // judges actual relevance and demotes them, the weights bias toward textbooks.
        ? retrieveMultiQuery(retrievalQuery, { topK: DDX_TOP_K, minSimilarity: 0.4, bm25Query, useReranker: true, useSourceWeights: true, useNormativeLeg: true })
        : retrieve(retrievalQuery, { topK: DDX_TOP_K, minSimilarity: 0.4, bm25Query, useReranker: true, useSourceWeights: true }).then((r) => ({ hits: r.hits, variants: [retrievalQuery], perVariantCounts: [r.hits.length] }));
      const [retrieveResult, plosHits] = await Promise.all([
        retrievePromise,
        includePlos ? searchPlos(plosQuery, { rows: 5, yearsBack: 5 }) : Promise.resolve([] as PlosHit[]),
      ]);

      // Resolve hypotheses (generated in parallel) and, when on, replace the broad
      // pool with targeted per-hypothesis evidence merged with the broad pool.
      // Fail-open: if generation produced nothing, fall back to the broad pool.
      const hypotheses = await hypothesesPromise;
      let hits = retrieveResult.hits;
      if (useHypothesisFirst && hypotheses.length) {
        emit({ type: 'progress', stage: 'retrieving', msg: `Retrieving evidence for ${Math.min(hypotheses.length, 6)} candidate diagnoses…`, ms: Date.now() - t0 });
        const ev = await gatherHypothesisEvidence(hypotheses, retrieveResult.hits, { perDxK: 2, maxTotal: 14, maxHypotheses: 6, traceId });
        if (ev.hits.length) hits = ev.hits;
      }

      // Investigation-driven retrieval leg (BOTH engines), TIGHTENED: only fire for
      // SPECIFIC findings — pathology/imaging/micro/ECG, where a named entity like
      // "PAS-positive macrophages" lives — NEVER plain labs (anemia/ESR/albumin pull
      // non-specific junk that the model then turns into spurious diagnoses). Hits are
      // relevance-gated (≥0.6) so low-similarity chunks can't leak in. Prepended so the
      // decisive evidence sits at the front of the context.
      if (investigations && investigations.findings.length) {
        const SPECIFIC_CATS = new Set(['imaging', 'pathology', 'micro', 'ecg']);
        const findingQueries = investigations.findings
          .filter((f) => f.flag !== 'normal' && f.flag !== 'indeterminate' && SPECIFIC_CATS.has(f.category))
          .map((f) => [f.test, f.value, f.note].filter(Boolean).join(' ').trim())
          .filter((q) => q.length >= 4)
          .slice(0, 4);
        if (findingQueries.length) {
          emit({ type: 'progress', stage: 'retrieving', msg: 'Retrieving evidence for the supplied investigation findings…', ms: Date.now() - t0 });
          const findingHits = (await Promise.all(
            findingQueries.map((q) => retrieve(q, { topK: 3, minSimilarity: 0.55, skipExpand: true, useSourceWeights: true }).then((r) => r.hits).catch(() => [])),
          )).flat().filter((h) => (h.similarity ?? 0) >= 0.6);
          if (findingHits.length) {
            const seen = new Set<number | string>();
            const merged: typeof hits = [];
            for (const h of [...findingHits, ...hits]) { if (!seen.has(h.id)) { seen.add(h.id); merged.push(h); } }
            hits = merged.slice(0, Math.max(18, hits.length));
            await logEvent(traceId, 'investigation_retrieval', 'retrieving', { finding_queries: findingQueries, finding_hit_count: findingHits.length, merged_count: hits.length });
          }
        }
      }

      // FINAL-POOL RERANK + noise gate. The broad leg is reranked inside retrieve(),
      // but in hypothesis-first mode (default) the final pool is dominated by the
      // per-candidate + investigation legs (source-weighted only), which still admit
      // high-similarity OFF-TOPIC abstracts the Jun-2026 2M-row load introduced (e.g.
      // a cardiology / obstetrics journal on a dermatology case). One LLM-judge rerank
      // (Gemini Flash, batched-parallel → ~1 round-trip) over the merged ~14-18 chunks
      // scores each for actual relevance to the presentation; we sort by judge-score ×
      // source-quality weight and DROP the clear noise (judge < 0.2 = "barely related"),
      // always keeping ≥12 so the differential is never starved. Soft-fail: on any
      // rerank error we keep the merged order unchanged (never blocks the differential).
      if (hits.length > 2) {
        try {
          const judged = await rerank(displayForPrompt, hits.map((h) => ({ id: h.id, text: h.text })));
          const judgeRan = judged.some((r) => r.rerank_backend !== 'none');
          const scoreById = new Map(judged.map((r) => [r.id, r.rerank_score] as const));
          const ranked = hits
            .map((h) => {
              const rs = scoreById.get(h.id) ?? 0;
              const w = computeSourceQualityWeight({ book: h.book, source: h.source, chunk_type: h.chunk_type, token_count: h.token_count });
              return { h: { ...h, rerank_score: rs, rerank_backend: 'judge' as const, source_quality_weight: w }, score: rs, eff: rs * w };
            })
            .sort((a, b) => b.eff - a.eff);
          // Drop judge-scored noise only when the judge actually ran; keep ≥12.
          const kept = judgeRan
            ? ranked.filter((x, i) => i < 12 || x.score >= 0.2)
            : ranked;
          const before = hits.length;
          hits = kept.map((x) => x.h);
          await logEvent(traceId, 'final_pool_rerank', 'retrieving', { reranked: judgeRan, kept: hits.length, dropped: before - hits.length });
        } catch (e) {
          await logEvent(traceId, 'final_pool_rerank', 'retrieving', { reranked: false, error: String((e as Error).message) }).catch(() => {});
        }
      }

      // v1.7b S2: forensic capture — full chunk text + scores + PLOS abstracts
      await Promise.all([
        logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
          variants: retrieveResult.variants,
          per_variant_counts: retrieveResult.perVariantCounts,
          hits: hits.map((h) => ({
            id: h.id, book: h.book, chapter: h.chapter,
            page_start: h.page_start, page_end: h.page_end,
            chunk_type: h.chunk_type,
            similarity: h.similarity,
            // @ts-expect-error v1.6 added these
            source_quality_weight: h.source_quality_weight,
            // @ts-expect-error v1.6 added these
            rerank_score: h.rerank_score,
            text: h.text,
          })),
        }),
        includePlos ? logEvent(traceId, 'plos_search', 'retrieving', {
          query: plosQuery.slice(0, 200),
          hit_count: plosHits.length,
          hits: plosHits.map((p) => ({ doi: p.doi, title: p.title, year: p.year, authors: p.authors, url: p.url, abstract: p.abstract })),
        }) : Promise.resolve(),
      ]);

      if (useMultiQuery && retrieveResult.variants.length > 1) {
        emit({ type: 'progress', stage: 'variants', msg: `Generated ${retrieveResult.variants.length - 1} query variants`, ms: Date.now() - t0 });
      }
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} textbook + ${plosHits.length} PLOS excerpts (fused from ${retrieveResult.variants.length} ${retrieveResult.variants.length === 1 ? 'query' : 'queries'})`, ms: Date.now() - t0 });
      if (hits.length === 0 && plosHits.length === 0) { emit({ type: 'error', message: 'no excerpts above threshold — presentation may be too vague' }); outcome = 'error'; outcomeMsg = 'no excerpts above threshold'; close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        item_number: h.item_number, chunk_type: h.chunk_type,
        similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 600),
      }));
      const plosCitations = plosHits.map((p, i) => ({
        n: i + 1, kind: 'plos' as const, doi: p.doi, title: p.title,
        authors: p.authors, year: p.year, url: p.url, full_url: p.full_url,
        preview: p.abstract.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations, plos: plosCitations });

      // Cap each excerpt so the widened pool (16) stays within the 16k context
      // window — overflow would silently drop the system prompt and degrade output.
      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text.slice(0, 1800)}`).join('\n\n');
      const plosBlock = formatPlosForPrompt(plosHits);
      const sexTxt = (body.sex && body.sex !== '?') ? String(body.sex).trim() : 'not given';
      const ageTxt = body.age ? String(body.age) : 'not given';
      const constraintLine = `PATIENT CONSTRAINTS — apply as hard rules:\n- Sex: ${sexTxt} → exclude any diagnosis impossible for this sex. Age: ${ageTxt} → weight by age prevalence; drop negligible-prevalence diagnoses unless a stated risk factor supports them.\n- Reason ONLY from the findings stated below; do not invent findings; treat any stated negative/normal finding as ruling-down.${investigations ? '\n- INVESTIGATION RESULTS are supplied below — reconcile every diagnosis against them (abnormal fitting results rule a diagnosis in; normal/negative results that would be expected abnormal rule it down) and fill investigation_fit for each diagnosis. A result that is CHARACTERISTIC or PATHOGNOMONIC for a specific diagnosis makes that diagnosis a LEADING, high-ranked consideration — do NOT let the chief-complaint pattern outrank it. investigation_fit must be truthful — never claim a result supports a diagnosis it does not. Never cite a result not in the supplied list.' : ''}\n- cannot_miss = by danger if missed (even at low probability; no benign conditions). most_likely = by probability. A diagnosis that is BOTH your leading probability AND dangerous belongs on both axes — name it identically in each (it is cross-linked as one diagnosis, not duplicated).`;
      // In hypothesis-first mode, hand the model the reasoned candidate list so it
      // EVALUATES each against the evidence + findings rather than only listing what
      // happened to be retrieved (the anchoring/omission failure mode).
      const candidatesBlock = (useHypothesisFirst && hypotheses.length)
        ? `CANDIDATE DIAGNOSES (proposed from clinical reasoning — evaluate EACH against the findings and the excerpts: keep those that fit, drop any the stated negatives/normals argue against, rank by the two axes below, and you MAY add a diagnosis the findings clearly support):\n${formatHypothesesForPrompt(hypotheses)}\n\n`
        : '';
      const userMsg = `${constraintLine}\n\nCLINICAL PRESENTATION:\n${displayForPrompt}\n\n${candidatesBlock}MEDICAL EXCERPTS:\n${contextBlock || '(none)'}\n\n${plosBlock ? 'PLOS ONE ABSTRACTS:\n' + plosBlock + '\n\n' : ''}Output ONLY the JSON object now, starting with {. No prose, no markdown fences.`;

      const useSelfCritique = body.selfCritique !== false;  // default true

      emit({ type: 'progress', stage: useSelfCritique ? 'drafting' : 'generating', msg: `${useSelfCritique ? 'Drafting' : 'Reasoning'} with the reasoning model…`, ms: Date.now() - t0 });
      const draftRes = await tracedChat(traceId, 'ddx_draft', {
        model: DDX_DRAFT_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
        temperature: 0.2,
        max_tokens: 1500,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: G, ...LAB });
      let raw = draftRes.choices?.[0]?.message?.content ?? '';

      if (useSelfCritique) {
        emit({ type: 'progress', stage: 'reviewing', msg: 'Auditing DDx for missing cannot-miss, likelihood errors, unsupported claims…', ms: Date.now() - t0 });
        let critiqueJson: {
          demographic_impossibility?: string[]; fabricated_findings?: string[]; ignored_negatives?: string[];
          missing_cannot_miss?: string[]; cannot_miss_misuse?: string[]; likelihood_errors?: string[];
          anchoring_or_atypical_miss?: string[]; investigation_misread?: string[]; unsupported_claims?: string[];
          missing_evidence?: string[]; investigation_problems?: string[]; citation_problems?: string[];
          needs_revision?: boolean; overall_severity?: string;
        } = { needs_revision: false };
        // Same swallow, same consequence as /api/ask — see the note there. Fixed together because
        // one of the two staying silent is how this class survives.
        let criticRan = true;
        try {
          const critRes = await tracedChat(traceId, 'ddx_critique', {
            model: DDX_DRAFT_MODEL,
            messages: [
              { role: 'system', content: DDX_CRITIQUE_SYSTEM },
              { role: 'user', content: `Clinical presentation:\n${displayForPrompt}\n\nSource excerpts:\n${contextBlock || '(none)'}\n${plosHits.length ? '\nPLOS abstracts:\n' + plosHits.map((p, i) => `[P${i+1}] ${p.title} (${p.year})`).join('\n') + '\n' : ''}\nDraft DDx JSON:\n${raw}\n\nOutput the JSON critique now.` },
            ],
            temperature: 0.1,
            max_tokens: 700,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          }, { gemini: G, ...LAB });
          let critRaw = critRes.choices?.[0]?.message?.content?.trim() || '{}';
          if (critRaw.startsWith('```')) critRaw = critRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          const a = critRaw.indexOf('{'); const b = critRaw.lastIndexOf('}');
          if (a >= 0 && b > a) critRaw = critRaw.slice(a, b + 1);
          critiqueJson = JSON.parse(critRaw);
        } catch (e) {
          criticRan = false;
          console.warn('[ddx critique] did not complete — the draft is UNAUDITED, not clean:', (e as Error).message);
        }

        const issueCount = (critiqueJson.demographic_impossibility?.length || 0)
          + (critiqueJson.fabricated_findings?.length || 0)
          + (critiqueJson.ignored_negatives?.length || 0)
          + (critiqueJson.missing_cannot_miss?.length || 0)
          + (critiqueJson.cannot_miss_misuse?.length || 0)
          + (critiqueJson.likelihood_errors?.length || 0)
          + (critiqueJson.anchoring_or_atypical_miss?.length || 0)
          + (critiqueJson.investigation_misread?.length || 0)
          + (critiqueJson.unsupported_claims?.length || 0)
          + (critiqueJson.missing_evidence?.length || 0)
          + (critiqueJson.investigation_problems?.length || 0)
          + (critiqueJson.citation_problems?.length || 0);
        const severity = critiqueJson.overall_severity || (issueCount > 0 ? 'minor' : 'none');

        // v1.7b S2: forensic capture of critique JSON + denormalize severity
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

        emit({ type: 'critique', severity, issue_count: issueCount, critic_ran: criticRan, details: critiqueJson });

        // Classic always revises when flagged. Hypothesis-first only revises on a
        // MAJOR audit (the reasoned synthesis is already strong) — saves a whole
        // LLM pass on the latency-heavy beta path for minor/cosmetic issues.
        const allowRevision = !useHypothesisFirst || severity === 'major';
        if (critiqueJson.needs_revision && issueCount > 0 && allowRevision) {
          emit({ type: 'progress', stage: 'revising', msg: `Revising DDx to address ${issueCount} issue${issueCount !== 1 ? 's' : ''}…`, ms: Date.now() - t0 });
          const revRes = await tracedChat(traceId, 'ddx_revision', {
            model: DDX_DRAFT_MODEL,
            messages: [
              { role: 'system', content: DDX_REVISION_SYSTEM },
              { role: 'user', content: `Clinical presentation:\n${displayForPrompt}\n\nSource excerpts:\n${contextBlock || '(none)'}\n\nEarlier draft JSON:\n${raw}\n\nAuditor critique:\n${JSON.stringify(critiqueJson, null, 2)}\n\nOutput the revised JSON now.` },
            ],
            temperature: 0.2,
            max_tokens: 1500,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          }, { gemini: G, ...LAB });
          raw = revRes.choices?.[0]?.message?.content ?? raw;
        }
      }

      emit({ type: 'progress', stage: 'parsing', msg: 'Parsing differential…', ms: Date.now() - t0 });

      const parsed = parseLooseJson(raw) as {
        summary?: string; missing_info?: string[];
        cannot_miss?: unknown[]; most_likely?: unknown[]; other?: unknown[];
      };
      // Hard demographic guard: deterministically drop sex-impossible diagnoses
      // (belt-and-suspenders behind the prompt rules). See lib/ddx-constraints.
      const demoFilter = filterByDemographics(parsed, body.sex);
      // Cross-axis guard: when a diagnosis lands in BOTH cannot_miss and most_likely
      // (e.g. confirmed Wilson's — leading probability AND fatal if missed), flag both
      // entries so the UI cross-links them as one diagnosis on two axes rather than
      // two cards that look like separate, accidentally-duplicated diagnoses.
      const crossLink = crossLinkDdxBuckets(demoFilter.filtered);
      const ddx = crossLink.linked;
      if (demoFilter.removed.length) {
        await logEvent(traceId, 'demographic_filter', 'parsing', { sex: body.sex ?? null, removed: demoFilter.removed });
      }
      if (crossLink.crossListed.length) {
        await logEvent(traceId, 'bucket_cross_link', 'parsing', { cross_listed: crossLink.crossListed });
      }
      emit({
        type: 'result',
        data: {
          summary: ddx.summary ?? '',
          missing_info: Array.isArray(ddx.missing_info) ? ddx.missing_info : [],
          cannot_miss: Array.isArray(ddx.cannot_miss) ? ddx.cannot_miss : [],
          most_likely: Array.isArray(ddx.most_likely) ? ddx.most_likely : [],
          other: Array.isArray(ddx.other) ? ddx.other : [],
          citations,
          plos_citations: plosCitations,
          presentation: display,
          investigations: investigations ? { findings: investigations.findings, summary: investigations.summary, structured: investigations.structured } : undefined,
          // Build 1c: additive, flag-gated (CLINICAL_STATE_UI). Off (default) → {} → response
          // byte-identical to today. Never affects the differential above.
          ...clinicalStateResultField(clinicalStateForUi, rejectedSpanCount, process.env.CLINICAL_STATE_UI === '1'),
        },
      });
      // v1.7b S2: emit final_answer event + denormalize parsed DDx into traces.final_answer_text
      const finalAnswerText = [
        ddx.summary || '',
        ...((ddx.cannot_miss || []) as Array<{ diagnosis?: string }>).map((d) => 'Cannot-miss: ' + (d.diagnosis || '')),
        ...((ddx.most_likely || []) as Array<{ diagnosis?: string }>).map((d) => 'Likely: ' + (d.diagnosis || '')),
        ...((ddx.other || []) as Array<{ diagnosis?: string }>).map((d) => 'Other: ' + (d.diagnosis || '')),
      ].filter(Boolean).join(' | ');
      await Promise.all([
        logEvent(traceId, 'final_answer', 'done', {
          answer_text: finalAnswerText,
          parsed_full: ddx,
          demographic_removed: demoFilter.removed,
          char_count: finalAnswerText.length,
          total_ms: Date.now() - t0,
        }),
        setTraceFinalAnswer(traceId, finalAnswerText),
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
