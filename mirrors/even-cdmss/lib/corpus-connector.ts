/**
 * lib/corpus-connector.ts — the reusable corpus connector spine (GC-CX, SL1).
 *
 * The DB/orchestration half of the framework whose pure logic lives in corpus-connector-core.ts.
 * Runs any CorpusConnector adapter through one governed-free ingestion pass:
 *
 *   listItems → per-item LICENCE gate (skips logged w/ reason) → fetchChunks(budget) → embed(nomic,
 *   free) → INSERT INTO mksap_chunks as source='labq:<name>' (INERT — retrieve.ts excludes labq:%)
 *   → dedup ON CONFLICT (book, text_hash) → per-run chunk cap (staged, logged — no silent truncation)
 *   → ingest_runs log.
 *
 * ₹0 inference: embeddings run on nomic (the mini) via embedQuery; no Gemini/Pro call anywhere in the
 * path. Activation (labq:<name> → the real source name) is a separate, explicit, V-gated step
 * (corpusActivate in lib/lab.ts) — nothing here changes production retrieval.
 */
import { createHash } from 'crypto';
import { sql } from './db';
import { embedQuery, vectorLiteral } from './llm';
import type { CorpusConnector, ConnectorChunk } from './corpus-connector-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Array<{ id?: number }>>;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const approxTokens = (s: string) => Math.max(1, Math.floor(s.length / 4));

export interface ConnectorRunStats {
  name: string;
  source: string;                 // labq:<name>
  items: number;                  // items offered by listItems()
  ingested: number;               // items that produced ≥1 chunk
  skipped_licence: Array<{ key: string; title: string; reason: string }>;
  chunks: number;                 // chunks emitted by adapters
  inserted: number;               // new rows in mksap_chunks
  skipped_dup: number;            // ON CONFLICT hits (incl. existing statpearls overlap)
  capped: boolean;                // run chunk-cap reached (staging boundary)
  errors: Array<{ key: string; error: string }>;
}

export interface RunConnectorOpts {
  maxChunks?: number;             // hard per-run cap (staging); default 4000
  maxItems?: number;              // optional cap on items processed this run
}

async function insertChunk(source: string, c: ConnectorChunk): Promise<'inserted' | 'dup'> {
  const text = c.text;
  const hash = sha256(text);
  const emb = vectorLiteral(await embedQuery(text));   // nomic on the mini — ₹0
  const ins = await run(
    `INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10)
     ON CONFLICT (book, text_hash) DO NOTHING RETURNING id`,
    [source, c.book, c.chapter ?? null, c.section ?? null, c.itemNumber ?? null, c.chunkType, text, hash, emb, approxTokens(text)],
  );
  return ins.length > 0 ? 'inserted' : 'dup';
}

/** Run one connector adapter, quarantined. Never throws per-item — an item error is logged and skipped. */
export async function runConnector(connector: CorpusConnector, opts: RunConnectorOpts = {}): Promise<ConnectorRunStats> {
  const maxChunks = opts.maxChunks ?? 4000;
  const source = `labq:${connector.name}`;
  const st: ConnectorRunStats = {
    name: connector.name, source, items: 0, ingested: 0, skipped_licence: [], chunks: 0,
    inserted: 0, skipped_dup: 0, capped: false, errors: [],
  };

  let items = await connector.listItems();
  st.items = items.length;
  if (opts.maxItems != null) items = items.slice(0, opts.maxItems);

  for (const item of items) {
    if (st.chunks >= maxChunks) { st.capped = true; break; }
    const lic = connector.licence(item);
    if (!lic.ok) { st.skipped_licence.push({ key: item.key, title: item.title, reason: lic.reason }); continue; }
    try {
      const budget = maxChunks - st.chunks;
      const chunks = await connector.fetchChunks(item, budget);
      let wroteForItem = 0;
      for (const c of chunks) {
        if (st.chunks >= maxChunks) { st.capped = true; break; }
        if (!c.text || c.text.length < 120) continue;   // drop fragments
        st.chunks++;
        const r = await insertChunk(source, c);
        if (r === 'inserted') { st.inserted++; wroteForItem++; } else st.skipped_dup++;
      }
      if (wroteForItem > 0) st.ingested++;
    } catch (e) {
      st.errors.push({ key: item.key, error: String((e as Error).message).slice(0, 200) });
    }
  }

  // Observability: one ingest_runs row (topic_id NULL — connectors aren't topic-scoped, like curator.ts).
  await run(
    `INSERT INTO ingest_runs (topic_id, kind, finished_at, found, inserted, skipped_dup, rejected, errors, detail)
     VALUES (NULL, $1, now(), $2, $3, $4, $5, $6, $7)`,
    [`connector_${connector.name}`, st.items, st.inserted, st.skipped_dup, st.skipped_licence.length, st.errors.length, JSON.stringify(st)],
  );
  return st;
}
