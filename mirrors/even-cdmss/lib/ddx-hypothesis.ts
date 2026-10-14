// lib/ddx-hypothesis.ts
// ─────────────────────────────────────────────────────────────────────────────
// Hypothesis-first DDx engine (part 2 of the retrieval-recall fix).
//
// The classic DDx pipeline retrieves a broad pool then lists whatever was
// retrieved — so the differential's BREADTH is capped by one semantic search,
// and the self-critique (which audits the same excerpts) is blind to omissions.
// That let a textbook pyoderma-gangrenosum case anchor on erythema induratum.
//
// This module decouples GENERATION from RETRIEVAL:
//   1. generateHypotheses() — the model proposes a broad differential from the
//      clinical presentation + its own medical knowledge (NOT limited to any
//      excerpts), so the right diagnosis is named even when broad retrieval
//      would miss it.
//   2. gatherHypothesisEvidence() — runs a TARGETED retrieval per named
//      hypothesis and unions it with the broad pool, so each candidate arrives
//      at synthesis already grounded in its own evidence.
//
// Fail-open throughout: any failure returns empty/partial so the caller can fall
// back to the broad pool and never blocks a differential.
// ─────────────────────────────────────────────────────────────────────────────
import { tracedChat, logEvent } from './trace';
import { retrieve } from './retrieve';
import type { ChunkHitWithMeta } from './retrieve';

export type DdxAxis = 'cannot_miss' | 'most_likely' | 'other';
export type Hypothesis = { dx: string; axis: DdxAxis; why?: string };

const AXES: DdxAxis[] = ['cannot_miss', 'most_likely', 'other'];

const HYPO_SYSTEM = `You are an expert physician building the DIFFERENTIAL DIAGNOSIS for one patient. Work from the clinical presentation and YOUR OWN medical knowledge — you are NOT limited to any source list here. Name the candidate diagnoses you would seriously consider.

RULES:
- Demographics are HARD constraints: never name a diagnosis anatomically/physiologically impossible for the stated sex; weight every candidate by age and sex prevalence.
- Reason only from the stated findings — chief complaint, history, exam, vitals, and any investigation results. Translate lay terms into clinical possibilities. Treat any stated negative/normal finding as ruling a diagnosis DOWN (e.g. "no TB history / negative cultures" lowers TB-dependent diagnoses).
- Think across ALL relevant organ systems, not just the one implied by the chief complaint's wording. Weight risk factors and red flags.
- ALWAYS include dangerous, time-sensitive "cannot-miss" diagnoses that fit the findings, even when their probability is LOW.
- Give 6–12 candidates: a few cannot-miss, the most-likely, and a couple of other reasonable considerations.

Return ONLY this JSON (no prose, no markdown fences):
{"hypotheses":[{"dx":"diagnosis name","axis":"cannot_miss|most_likely|other","why":"<=12 words, the finding(s) that put it on the list"}]}`;

function parseLooseJson(s: string): unknown {
  let t = (s || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

/**
 * Reasoning-first candidate differential. Returns [] on any failure (caller
 * falls back to the broad-retrieval pipeline).
 */
export async function generateHypotheses(
  presentation: string,
  opts: { model: string; traceId?: string; max?: number; gemini?: string },
): Promise<Hypothesis[]> {
  const max = opts.max ?? 12;
  try {
    const res = await tracedChat(opts.traceId ?? '', 'ddx_hypotheses', {
      model: opts.model,
      messages: [
        { role: 'system', content: HYPO_SYSTEM },
        { role: 'user', content: `CLINICAL PRESENTATION:\n${presentation}\n\nOutput the JSON now, starting with {.` },
      ],
      temperature: 0.3,
      max_tokens: 700,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { gemini: opts.gemini, promptRef: 'ddx-hypothesis/HYPO_SYSTEM' });
    const content = (res as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(content) as { hypotheses?: unknown };
    if (!Array.isArray(parsed.hypotheses)) return [];
    const seen = new Set<string>();
    const out: Hypothesis[] = [];
    for (const h of parsed.hypotheses) {
      if (!h || typeof h !== 'object') continue;
      const o = h as Record<string, unknown>;
      const dx = typeof o.dx === 'string' ? o.dx.trim() : '';
      if (!dx) continue;
      const key = dx.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const axisRaw = String(o.axis ?? '').toLowerCase().trim() as DdxAxis;
      const axis: DdxAxis = AXES.includes(axisRaw) ? axisRaw : 'most_likely';
      const why = typeof o.why === 'string' ? o.why.trim().slice(0, 100) : undefined;
      out.push({ dx: dx.slice(0, 90), axis, why });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

export type EvidenceResult = {
  hits: ChunkHitWithMeta[];
  perDx: { dx: string; n: number }[];
};

/**
 * For each hypothesis, run a TARGETED retrieval (the diagnosis name) and union
 * the results with the broad pool. Round-robins across hypotheses so every
 * candidate contributes at least its top evidence chunk before the budget runs
 * out — no diagnosis is starved. skipExpand=true keeps it to one embed per dx
 * (no per-dx LLM expansion call) to protect latency.
 */
export async function gatherHypothesisEvidence(
  hypotheses: Hypothesis[],
  broadHits: ChunkHitWithMeta[],
  opts: { perDxK?: number; maxTotal?: number; maxHypotheses?: number; traceId?: string },
): Promise<EvidenceResult> {
  const perDxK = opts.perDxK ?? 3;
  const maxTotal = opts.maxTotal ?? 22;
  const cap = Math.min(hypotheses.length, opts.maxHypotheses ?? 10);
  const picked = hypotheses.slice(0, cap);

  const perDxResults = await Promise.all(
    picked.map((h) =>
      retrieve(h.dx, { topK: perDxK, minSimilarity: 0.35, skipExpand: true, useSourceWeights: true })
        .then((r) => ({ dx: h.dx, hits: r.hits }))
        .catch(() => ({ dx: h.dx, hits: [] as ChunkHitWithMeta[] })),
    ),
  );

  // Round-robin merge: rank-1 of every dx, then rank-2 of every dx, …
  const ordered: ChunkHitWithMeta[] = [];
  const maxRank = Math.max(0, ...perDxResults.map((r) => r.hits.length));
  for (let rank = 0; rank < maxRank; rank++) {
    for (const r of perDxResults) {
      if (r.hits[rank]) ordered.push(r.hits[rank]);
    }
  }
  // Then top up with the broad pool (serendipity + general context).
  ordered.push(...broadHits);

  // Dedupe by chunk id, preserve first-seen order, cap to budget.
  const seen = new Set<number | string>();
  const hits: ChunkHitWithMeta[] = [];
  for (const h of ordered) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    hits.push(h);
    if (hits.length >= maxTotal) break;
  }

  const perDx = perDxResults.map((r) => ({ dx: r.dx, n: r.hits.length }));
  if (opts.traceId) {
    await logEvent(opts.traceId, 'hypothesis_evidence', 'retrieving', {
      hypotheses: picked.map((h) => ({ dx: h.dx, axis: h.axis })),
      per_dx_counts: perDx,
      broad_count: broadHits.length,
      merged_count: hits.length,
    });
  }
  return { hits, perDx };
}

/** Render the candidate list for the synthesis prompt. */
export function formatHypothesesForPrompt(hypotheses: Hypothesis[]): string {
  if (!hypotheses.length) return '';
  const line = (h: Hypothesis) => `- ${h.dx}${h.why ? ` — ${h.why}` : ''}`;
  return hypotheses.map(line).join('\n');
}
