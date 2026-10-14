import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { DRUGS_MODEL, parseLooseJson, normalizeDrugName } from '@/lib/drugs';
import { geminiModelFor } from '@/lib/llm';
import { deterministicInteractions } from '@/lib/ddi';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { startTrace, finishTrace, tracedChat, logEvent } from '@/lib/trace';
import { enrichDrug, findClassOverlap, type PubChemFacts } from '@/lib/pubchem';

export const runtime = 'nodejs';
export const maxDuration = 120;

const SYSTEM = `You analyze drug-drug interactions for clinicians. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"summary":"one sentence overall risk picture","pairs":[{"drug_a":"...","drug_b":"...","severity":"contraindicated|major|moderate|minor|none","mechanism":"<30 words","consequence":"<30 words","management":"<30 words","citation_ids":[1,2]}]}

- One object per UNIQUE pair.
- severity: contraindicated/major/moderate/minor/none
- For "none" pairs, set mechanism/consequence/management to "" and citation_ids to [].
- If excerpts don't cover a pair, list it severity:"none" consequence:"Not covered in available excerpts."
- No prose outside the JSON.`;

export async function POST(req: NextRequest) {
  let body: { drugs?: string[] };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }
  const raw = (body.drugs || []).map((s) => (s || '').trim()).filter(Boolean);
  if (raw.length < 2) return new Response(JSON.stringify({ error: 'at least 2 drugs required' }), { status: 400 });
  // Raised from 5 → 15: a full medication chart (the audit surface) can carry ~15 drugs.
  if (raw.length > 15) return new Response(JSON.stringify({ error: 'at most 15 drugs supported' }), { status: 400 });

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('drugs_interactions', { drugs: raw });

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      emit({ type: 'progress', stage: 'expanding', msg: `Normalizing ${raw.length} drug names in parallel…` });
      const normalized = await Promise.all(raw.map(normalizeDrugName));
      emit({ type: 'progress', stage: 'expanding', msg: `Checking: ${normalized.join(', ')}`, ms: Date.now() - t0 });

      // v1.9: parallel PubChem enrichment for class-overlap pre-flagging.
      // Soft-fails — empty facts means we skip class-overlap, the LLM-pairwise primary still runs.
      const pubchemFacts: (PubChemFacts | null)[] = await Promise.all(
        normalized.map((n) => enrichDrug(n).catch(() => null))
      );
      type ClassOverlapPair = {
        a: string; b: string; cid_a: number | null; cid_b: number | null;
        shared_atc3: string[]; shared_atc2: string[]; shared_labels: string[];
      };
      const classOverlapPairs: ClassOverlapPair[] = [];
      for (let i = 0; i < pubchemFacts.length; i++) {
        for (let j = i + 1; j < pubchemFacts.length; j++) {
          const fa = pubchemFacts[i], fb = pubchemFacts[j];
          if (!fa || !fb) continue;
          const ov = findClassOverlap(fa, fb);
          if (ov.any) {
            classOverlapPairs.push({
              a: normalized[i], b: normalized[j],
              cid_a: fa.cid, cid_b: fb.cid,
              shared_atc3: ov.shared_atc3, shared_atc2: ov.shared_atc2, shared_labels: ov.shared_labels,
            });
          }
        }
      }
      if (classOverlapPairs.length) {
        await logEvent(traceId, 'pubchem_class_overlap', 'retrieving', { pairs: classOverlapPairs });
        emit({ type: 'class_overlap', pairs: classOverlapPairs });
        emit({ type: 'progress', stage: 'retrieving', msg: `PubChem flagged ${classOverlapPairs.length} class-overlap pair(s): ${classOverlapPairs.map(p => `${p.a}↔${p.b} (${p.shared_labels.join(', ')})`).join('; ')}`, ms: Date.now() - t0 });
      }

      const query = `drug-drug interactions between ${normalized.join(', ')}`;
      // D12.2: BM25 leg gets just the drug names (highest-IDF tokens).
      // The "drug-drug interactions between" framing is boilerplate that AND-fails on most chunks.
      const result = await retrieve(query, { topK: 10, minSimilarity: 0.3, bm25Query: normalized.join(' ') });
      const hits = result.hits;
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} excerpts (n(n-1)/2 = ${normalized.length * (normalized.length - 1) / 2} pairs to check)`, ms: Date.now() - t0 });
      if (hits.length === 0) { emit({ type: 'error', message: 'no excerpts' }); outcome = 'error'; outcomeMsg = 'no excerpts'; close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        similarity: typeof h.similarity === "number" ? Number(h.similarity.toFixed(3)) : 0,
        preview: h.text.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations });

      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}\n${h.text}`).join('\n\n');

      // v1.9: append class-overlap hints (from PubChem ATC) so the LLM doesn't miss
      // pharmacodynamic interactions the MKSAP excerpts don't explicitly cover.
      const classOverlapHint = classOverlapPairs.length
        ? '\n\n--- DETERMINISTIC CLASS-OVERLAP FLAGS (from PubChem ATC) ---\n'
          + classOverlapPairs.map(p => `${p.a} ↔ ${p.b}: shared class(es) ${p.shared_labels.join(', ')} — flag as at minimum severity:"minor" with mechanism reflecting the shared pharmacological class.`).join('\n')
        : '';

      emit({ type: 'progress', stage: 'generating', msg: `Analyzing pairs with ${DRUGS_MODEL}…`, ms: Date.now() - t0 });
      const r = await tracedChat(traceId, 'interactions', {
        model: DRUGS_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Drugs to check: ${normalized.join(', ')}\n\nExcerpts:\n${contextBlock}${classOverlapHint}\n\nOutput ONLY the JSON object covering all pairs now.` },
        ],
        temperature: 0.2,
        max_tokens: 1500,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: geminiModelFor('drugs') });
      const llmRaw = r.choices?.[0]?.message?.content ?? '';
      emit({ type: 'progress', stage: 'parsing', msg: 'Deduplicating pairs…', ms: Date.now() - t0 });
      const parsed = parseLooseJson(llmRaw) as { summary?: string; pairs?: unknown[] };

      const rawPairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
      const seen = new Set<string>();
      const pairs = [];
      for (const p of rawPairs as Array<{ drug_a?: string; drug_b?: string }>) {
        const a = String(p.drug_a || '').trim().toLowerCase();
        const b = String(p.drug_b || '').trim().toLowerCase();
        if (!a || !b || a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(p);
      }

      // EHRC deterministic leg: curated rules + RxLabelGuard (FDA SPL). Appends any
      // pair the LLM/RAG pass didn't already cover, so CAT /drugs and the audit
      // surface share one engine. Soft-fails (no key + no curated match = no change).
      try {
        const det = await deterministicInteractions(normalized);
        for (const dp of det) {
          const a = dp.drug_a.trim().toLowerCase();
          const b = dp.drug_b.trim().toLowerCase();
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push({ drug_a: dp.drug_a, drug_b: dp.drug_b, severity: dp.severity, mechanism: dp.mechanism, consequence: '', management: dp.recommendation, citation_ids: [], source: dp.source });
        }
      } catch { /* intentional: deterministic leg is best-effort enrichment */ }

      emit({ type: 'result', data: { input: raw, normalized, summary: parsed.summary ?? '', pairs, citations, class_overlap_pairs: classOverlapPairs, pubchem_facts: pubchemFacts.map(f => f ? { cid: f.cid, canonical_name: f.canonical_name, atc_codes: f.atc_codes, url: f.url } : null) } });
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
