// Europe PMC harvest path. Additive — leaves the E-utils harvester (lib/harvest.ts)
// untouched. Per ranked article: if it is OA + carries a redistributable CC licence
// + has full text in Europe PMC, fetch the JATS and section-chunk it (lib/jats-chunk);
// otherwise store the verbatim abstract. All chunks land in mksap_chunks with
// source='europepmc'; dedup is by article key (PMID/PMCID) + per-chunk text_hash.
// Reuses the ingest_topics / ingested_articles / ingest_runs control tables.

import { createHash } from 'crypto';
import { sql } from './db';
import { embedQuery, vectorLiteral } from './llm';
import { searchTopicEpmc, fetchFullTextXML, type EpmcRecord } from './europepmc';
import { chunkJatsFullText } from './jats-chunk';

export type TopicRow = { id: number; topic: string; query_terms: string; date_window_years: number; max_per_run: number };
type Stats = {
  topic: string; found: number; articles: number; chunks: number;
  fulltext: number; abstract_only: number; skipped_dup: number; rejected: number;
  oa_gated: number; ft_ok: number; error?: string;  // monitoring: how many passed the OA gate / fetched full text
};

const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id?: number }>>;
const approxTokens = (s: string) => Math.max(1, Math.floor(s.length / 4));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Redistributable open-access licences (the EPMC OA subset). ND/unknown → abstract only.
const OA_LICENSE = /^cc(0| by| by-sa| by-nc| by-nc-sa)?$/i;

function articleKey(a: EpmcRecord): string {
  return a.pmid || a.pmcid || `EPMC:${a.epmcId}`;
}

async function existingKeys(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ pmid: string }>>)(
    `SELECT pmid FROM ingested_articles WHERE pmid = ANY($1)`, [keys],
  );
  return new Set(rows.map((r) => r.pmid));
}

async function insertChunk(
  book: string, title: string, section: string, itemNo: string, chunkType: string, text: string,
): Promise<boolean> {
  const hash = sha256(text);
  const emb = vectorLiteral(await embedQuery(text));
  const ins = await sql2(
    `INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count)
     VALUES ('europepmc', $1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
     ON CONFLICT (book, text_hash) DO NOTHING RETURNING id`,
    [book, title, section, itemNo, chunkType, text, hash, emb, approxTokens(text)],
  );
  return ins.length > 0;
}

export async function harvestTopicEpmc(t: TopicRow, maxArticles: number): Promise<Stats> {
  const st: Stats = { topic: t.topic, found: 0, articles: 0, chunks: 0, fulltext: 0, abstract_only: 0, skipped_dup: 0, rejected: 0, oa_gated: 0, ft_ok: 0 };
  try {
    const ranked = await searchTopicEpmc(t.query_terms, { yearsBack: t.date_window_years, pageSize: Math.min(60, maxArticles + 20) });
    st.found = ranked.length;
    const known = await existingKeys(ranked.map(articleKey));
    for (const a of ranked) {
      if (st.articles >= maxArticles) break;
      const key = articleKey(a);
      if (known.has(key)) { st.skipped_dup++; continue; }

      let wrote = 0;
      let isFull = false;
      // Full text only for the redistributable OA subset.
      if (a.isOA && a.license && OA_LICENSE.test(a.license.trim()) && a.inEPMC && a.pmcid) {
        st.oa_gated++;
        const ft = await fetchFullTextXML(a.pmcid);
        if (ft.xml) {
          st.ft_ok++;
          const chunks = chunkJatsFullText(ft.xml, { maxTokens: 350, minTokens: 40, maxChunks: 25 });
          for (const c of chunks) {
            if (await insertChunk(a.journal, a.title, c.section, a.pmcid, 'fulltext', c.text)) wrote++;
          }
          if (wrote > 0) { isFull = true; st.fulltext++; }
        }
      }
      // Fallback: verbatim abstract.
      if (wrote === 0) {
        const text = a.abstract.trim();
        if (text.length < 120) { st.rejected++; continue; }
        if (await insertChunk(a.journal, a.title, 'abstract', a.pmid || a.pmcid || a.epmcId, 'abstract', text)) {
          wrote = 1; st.abstract_only++;
        } else { st.skipped_dup++; continue; }
      }

      st.chunks += wrote;
      await sql2(
        `INSERT INTO ingested_articles (pmid, doi, journal, title, year, pub_types, evidence_tier, citation_count, rcr, status, license, topic_id, last_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'active',$9,$10, now())
         ON CONFLICT (pmid) DO UPDATE SET last_checked_at = now(), citation_count = EXCLUDED.citation_count`,
        [key, a.doi, a.journal, a.title, a.year, a.pubTypes, a.tier, a.citedByCount, a.license, t.id],
      );
      st.articles++;
      void isFull;
    }
  } catch (e) {
    st.error = (e as Error).message;
  }
  await sql2(`UPDATE ingest_topics SET last_run_at = now() WHERE id = $1`, [t.id]);
  await sql2(
    `INSERT INTO ingest_runs (topic_id, kind, finished_at, found, inserted, skipped_dup, rejected, errors, detail)
     VALUES ($1,'harvest_epmc', now(), $2,$3,$4,$5,$6,$7)`,
    [t.id, st.found, st.chunks, st.skipped_dup, st.rejected, st.error ? 1 : 0, JSON.stringify(st)],
  );
  return st;
}

/** Run an EPMC harvest pass over enabled topics (oldest-run first), capped by article budget.
 *  Target a single topic by numeric id (onlyTopicId) or by case-insensitive name substring
 *  (onlyTopicName) — the UI doesn't expose ids, so name targeting is the usable handle. */
export async function runHarvestEpmc(
  opts: { maxArticles?: number; onlyTopicId?: number; onlyTopicName?: string; perTopic?: number } = {},
): Promise<{ total: number; topics: Stats[] }> {
  const maxArticles = opts.maxArticles ?? 20;
  const cols = 'id, topic, query_terms, date_window_years, max_per_run';
  let q: string;
  let params: unknown[];
  if (opts.onlyTopicId) {
    q = `SELECT ${cols} FROM ingest_topics WHERE id = $1`;
    params = [opts.onlyTopicId];
  } else if (opts.onlyTopicName) {
    q = `SELECT ${cols} FROM ingest_topics WHERE enabled AND topic ILIKE $1 ORDER BY last_run_at ASC NULLS FIRST`;
    params = [`%${opts.onlyTopicName}%`];
  } else {
    q = `SELECT ${cols} FROM ingest_topics WHERE enabled ORDER BY last_run_at ASC NULLS FIRST`;
    params = [];
  }
  const rows = await (sql as unknown as (qq: string, p: unknown[]) => Promise<TopicRow[]>)(q, params);
  const topics: Stats[] = [];
  let budget = maxArticles;
  for (const t of rows) {
    if (budget <= 0) break;
    const cap = Math.min(budget, opts.perTopic ?? t.max_per_run);
    const st = await harvestTopicEpmc(t, cap);
    topics.push(st);
    budget -= st.articles;
  }
  return { total: topics.reduce((n, s) => n + s.articles, 0), topics };
}
