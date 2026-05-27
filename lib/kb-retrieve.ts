/**
 * Vector-only retrieval from the MKSAP knowledge base.
 *
 * BM25 hybrid is deferred — the CDMSS retrieve() uses raw SQL string +
 * positional params via neon's query-array form, which is more fragile
 * than the template-tag form. The clinical decision support pipeline
 * works fine on dense retrieval alone for v1; we'll layer BM25 + RRF
 * fusion in Sprint 3.A.5 if quality demands it.
 */

import { kbSql, type KbChunkHit } from "@/lib/kb-db";
import { embedQuery, vectorLiteral } from "@/lib/kb-embed";

const DEFAULT_TOP_K = parseInt(process.env.TOP_K || "8", 10);
const DEFAULT_MIN_SIM = 0.3;

export type RetrieveResult =
  | {
      ok: true;
      hits: KbChunkHit[];
      embed_ms: number;
      query_ms: number;
    }
  | { ok: false; error: string };

export async function retrieve(
  query: string,
  opts: {
    topK?: number;
    minSimilarity?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RetrieveResult> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIM;

  const embedRes = await embedQuery(query, { signal: opts.signal });
  if (!embedRes.ok) return { ok: false, error: `embed_failed: ${embedRes.error}` };
  const vlit = vectorLiteral(embedRes.vector);

  const t1 = Date.now();
  try {
    const sql = kbSql();
    const rows = (await sql`
      SELECT id, source, book, chapter, section, page_start, page_end,
             item_number, chunk_type, text, token_count,
             1 - (embedding <=> ${vlit}::vector) AS similarity
        FROM mksap_chunks
       WHERE text IS NOT NULL
         AND 1 - (embedding <=> ${vlit}::vector) > ${minSim}
       ORDER BY embedding <=> ${vlit}::vector
       LIMIT ${topK}
    `) as KbChunkHit[];

    return {
      ok: true,
      hits: rows,
      embed_ms: embedRes.latency_ms,
      query_ms: Date.now() - t1,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `kb_query_failed: ${msg.slice(0, 150)}` };
  }
}
