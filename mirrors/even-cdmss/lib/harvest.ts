import { createHash } from 'crypto';
import { sql } from './db';
import { embedQuery, vectorLiteral } from './llm';
import { rankTopic, type Ranked } from './pubmed';

export type TopicRow = { id: number; topic: string; query_terms: string; date_window_years: number; max_per_run: number; seed_max: number };
type Stats = { topic: string; found: number; inserted: number; skipped_dup: number; rejected: number; error?: string };

const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id?: number }>>;
const approxTokens = (s: string) => Math.max(1, Math.floor(s.length / 4));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function existingPmids(pmids: string[]): Promise<Set<string>> {
  if (pmids.length === 0) return new Set();
  const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ pmid: string }>>)(
    `SELECT pmid FROM ingested_articles WHERE pmid = ANY($1)`, [pmids],
  ));
  return new Set(rows.map((r) => r.pmid));
}

/** Harvest one topic: rank → dedup → embed (nomic) → insert verbatim abstract → log article.
 *  embedding_v2 (mxbai) is written by the separate v2-backfill workstream once that column exists. */
export async function harvestTopic(t: TopicRow, maxNew: number): Promise<Stats> {
  const st: Stats = { topic: t.topic, found: 0, inserted: 0, skipped_dup: 0, rejected: 0 };
  try {
    const ranked: Ranked[] = await rankTopic(t.query_terms, { yearsBack: t.date_window_years, retmax: Math.min(60, maxNew + 30) });
    st.found = ranked.length;
    const known = await existingPmids(ranked.map((r) => r.pmid));
    for (const a of ranked) {
      if (st.inserted >= maxNew) break;
      if (known.has(a.pmid)) { st.skipped_dup++; continue; }
      const text = a.abstract.trim();
      if (text.length < 120) { st.rejected++; continue; }
      const hash = sha256(text);
      const emb = vectorLiteral(await embedQuery(text));
      const ins = await sql2(
        `INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count)
         VALUES ('pubmed', $1, $2, 'abstract', $3, 'abstract', $4, $5, $6::vector, $7)
         ON CONFLICT (book, text_hash) DO NOTHING RETURNING id`,
        [a.journal, a.title, a.pmid, text, hash, emb, approxTokens(text)],
      );
      if (ins.length === 0) { st.skipped_dup++; continue; }
      await sql2(
        `INSERT INTO ingested_articles (pmid, doi, journal, title, year, pub_types, evidence_tier, citation_count, rcr, status, topic_id, last_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10, now())
         ON CONFLICT (pmid) DO UPDATE SET last_checked_at = now()`,
        [a.pmid, a.doi, a.journal, a.title, a.year, a.pubTypes, a.tier, a.citationCount, a.rcr, t.id],
      );
      st.inserted++;
    }
  } catch (e) {
    st.error = (e as Error).message;
  }
  await sql2(`UPDATE ingest_topics SET last_run_at = now() WHERE id = $1`, [t.id]);
  await sql2(
    `INSERT INTO ingest_runs (topic_id, kind, finished_at, found, inserted, skipped_dup, rejected, errors, detail)
     VALUES ($1,'harvest', now(), $2,$3,$4,$5,$6,$7)`,
    [t.id, st.found, st.inserted, st.skipped_dup, st.rejected, st.error ? 1 : 0, JSON.stringify(st)],
  );
  return st;
}

/** Run a harvest pass over enabled topics (oldest-run first), capped to maxInserts total. */
export async function runHarvest(opts: { maxInserts?: number; onlyTopicId?: number; perTopic?: number } = {}): Promise<{ total: number; topics: Stats[] }> {
  const maxInserts = opts.maxInserts ?? 30;
  const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<TopicRow[]>)(
    opts.onlyTopicId
      ? `SELECT id, topic, query_terms, date_window_years, max_per_run, seed_max FROM ingest_topics WHERE id = $1`
      : `SELECT id, topic, query_terms, date_window_years, max_per_run, seed_max FROM ingest_topics WHERE enabled ORDER BY last_run_at ASC NULLS FIRST`,
    opts.onlyTopicId ? [opts.onlyTopicId] : [],
  ));
  const topics: Stats[] = [];
  let budget = maxInserts;
  for (const t of rows) {
    if (budget <= 0) break;
    const cap = Math.min(budget, opts.perTopic ?? t.max_per_run);
    const st = await harvestTopic(t, cap);
    topics.push(st);
    budget -= st.inserted;
  }
  return { total: topics.reduce((n, s) => n + s.inserted, 0), topics };
}
