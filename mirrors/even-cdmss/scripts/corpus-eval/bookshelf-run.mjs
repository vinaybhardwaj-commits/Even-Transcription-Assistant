#!/usr/bin/env node
/**
 * scripts/corpus-eval/bookshelf-run.mjs — GC-CX PR1 driver for the Bookshelf connector (SL2 + SL4).
 *
 * Subcommands (all ₹0 — embeddings on nomic, NO Pro/Gemini):
 *   manifest              dry: OA-subset size, seed books resolved, any missing seed ids.
 *   ingest [--max N]      run the connector QUARANTINED (source=labq:bookshelf); print run stats.
 *   storage               chunk count + text bytes + vector footprint + index sizes for the batch.
 *   quality [--per N]     coverage-deficit BEFORE vs AFTER (batch in scope, WITHOUT activating) over the
 *                         corpus-eval pack subjects + a relevance spot-check of where Bookshelf wins.
 *
 * Activation is deliberately NOT here — flip is `corpusActivate('bookshelf','bookshelf')`, V-gated.
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/bookshelf-run.mjs <cmd> [flags]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { embedQuery, vectorLiteral } from '../../lib/llm.ts';
import { runConnector } from '../../lib/corpus-connector.ts';
import { bookshelfConnector } from '../../lib/bookshelf.ts';

const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); if (a) return a.split('=')[1]; const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const cmd = process.argv[2];
const QSOURCE = 'labq:bookshelf';
const OUT = '.corpus-eval/bookshelf';
const run = sql;

async function manifest() {
  const c = bookshelfConnector();
  const info = await c.manifestInfo();
  const items = await c.listItems();
  console.log(`OA subset total books: ${info.total}`);
  console.log(`seed resolved:         ${info.selected}${info.missing.length ? `  (MISSING: ${info.missing.join(', ')})` : ''}`);
  for (const it of items) console.log(`  ${it.key.padEnd(12)} ${it.title.slice(0, 60)}  [${(it.meta.publisher || '').slice(0, 30)}]`);
}

async function ingest() {
  const max = parseInt(arg('max', '4000'), 10);
  const c = bookshelfConnector();
  console.error(`[ingest] running bookshelf connector, cap ${max} chunks, quarantined (${QSOURCE}) …`);
  const t0 = Date.now();
  const st = await runConnector(c, { maxChunks: max });
  st.wall_seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(`${OUT}-ingest.json`, JSON.stringify(st, null, 2));
  console.log(JSON.stringify({ ...st, skipped_licence: st.skipped_licence.length, errors: st.errors.length }, null, 2));
  if (st.skipped_licence.length) console.log('skipped(licence):', st.skipped_licence);
  if (st.errors.length) console.log('errors:', st.errors);
}

async function storage() {
  const [row] = await run`
    SELECT count(*)::int AS chunks,
           count(DISTINCT book)::int AS books,
           pg_size_pretty(sum(octet_length(text))::bigint) AS text_bytes,
           avg(token_count)::int AS avg_tokens
    FROM mksap_chunks WHERE source = ${QSOURCE}`;
  const vectorBytes = (row.chunks || 0) * 768 * 4;   // nomic-768 float32 footprint of the batch
  const idx = await run`SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS sz FROM pg_indexes WHERE tablename='mksap_chunks'`;
  const [tbl] = await run`SELECT pg_size_pretty(pg_total_relation_size('mksap_chunks')) AS total`;
  console.log('batch (labq:bookshelf):', JSON.stringify(row));
  console.log(`batch vector footprint: ~${(vectorBytes / 1048576).toFixed(1)} MB (chunks × 768 × 4B)`);
  console.log('mksap_chunks total size:', tbl.total);
  console.log('indexes:'); for (const i of idx) console.log(`  ${i.indexname.padEnd(34)} ${i.sz}`);
}

/** Top-1 cosine similarity for one embedded subject, scoped to production-only or production+batch. */
async function top1(vlit, withBatch) {
  const scope = withBatch
    ? `(source NOT LIKE 'labq:%' OR source = '${QSOURCE}')`
    : `source NOT LIKE 'labq:%'`;
  const rows = await run(
    `SELECT source, book, chapter, item_number, left(text, 240) AS preview,
            1 - (embedding <=> $1::vector) AS sim
     FROM mksap_chunks
     WHERE embedding IS NOT NULL AND text IS NOT NULL AND visible IS NOT FALSE AND ${scope}
     ORDER BY embedding <=> $1::vector LIMIT 1`, [vlit]);
  return rows[0] || null;
}

function pct(a) { const s = [...a].sort((x, y) => x - y); const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; return { n: s.length, median: q(0.5), p90: q(0.9), mean: s.reduce((x, y) => x + y, 0) / (s.length || 1) }; }

async function quality() {
  const per = parseInt(arg('per', '200'), 10);
  const pack = JSON.parse(readFileSync('.corpus-eval/pack.json', 'utf8'));
  // Deterministic distinct subjects across all consumers (the real demand).
  const seen = new Set(); const subjects = [];
  for (const u of pack.units) {
    const subj = (u.finding_ref && u.finding_ref.length > 3) ? u.finding_ref : u.claim;
    const k = String(subj).toLowerCase().slice(0, 80);
    if (seen.has(k)) continue; seen.add(k); subjects.push(String(subj).slice(0, 300));
    if (subjects.length >= per) break;
  }
  console.error(`[quality] ${subjects.length} distinct subjects; measuring deficit before vs after (batch in scope, NOT activated) …`);
  const before = [], after = [], wins = [];
  let i = 0;
  for (const s of subjects) {
    const vlit = vectorLiteral(await embedQuery(s));
    const [b, a] = [await top1(vlit, false), await top1(vlit, true)];
    const db = b ? 1 - b.sim : 1, da = a ? 1 - a.sim : 1;
    before.push(db); after.push(da);
    if (a && a.source === QSOURCE) wins.push({ subject: s.slice(0, 90), sim: +a.sim.toFixed(3), book: a.book, chapter: a.chapter, item: a.item_number, preview: a.preview.replace(/\s+/g, ' ').trim().slice(0, 160) });
    if (++i % 40 === 0) console.error(`  … ${i}/${subjects.length}`);
  }
  const B = pct(before), A = pct(after);
  const improved = before.filter((d, k) => after[k] < d - 1e-9).length;
  const report = {
    n_subjects: subjects.length,
    deficit_before: { median: +B.median.toFixed(3), p90: +B.p90.toFixed(3), mean: +B.mean.toFixed(3) },
    deficit_after: { median: +A.median.toFixed(3), p90: +A.p90.toFixed(3), mean: +A.mean.toFixed(3) },
    subjects_improved: improved,
    bookshelf_became_top_hit: wins.length,
    spotcheck: wins.slice(0, 12),
  };
  writeFileSync(`${OUT}-quality.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

/** Relevance/junk spot-check: the top labq:bookshelf hit for a fixed on-topic probe set (the PRD's
 *  ~10-retrieval relevance check). Independent of whether Bookshelf beats the existing corpus. */
async function spotcheck() {
  const subs = [
    'MODY genetic diabetes subtypes', 'insulin secretion beta cell physiology',
    'asthma severity classification and stepwise therapy', 'peak flow monitoring asthma action plan',
    'hypertension lifestyle modification DASH diet', 'thiazide diuretics blood pressure treatment',
    'preventive services screening adults', 'thyroid nodule evaluation',
    'adrenal insufficiency diagnosis', 'subclinical hypothyroidism TSH',
  ];
  const rows = [];
  let weak = 0;
  for (const s of subs) {
    const vlit = vectorLiteral(await embedQuery(s));
    const r = await run(
      `SELECT book, chapter, item_number, 1 - (embedding <=> $1::vector) AS sim, left(text,150) AS t
       FROM mksap_chunks WHERE source = '${QSOURCE}' ORDER BY embedding <=> $1::vector LIMIT 1`, [vlit]);
    const h = r[0]; if (!h) continue;
    if (h.sim < 0.55) weak++;
    rows.push({ subject: s, sim: +h.sim.toFixed(3), book: h.book, chapter: h.chapter, nbk: h.item_number,
      url: `https://www.ncbi.nlm.nih.gov/books/${h.item_number}/`, preview: h.t.replace(/\s+/g, ' ').trim() });
  }
  const out = { n: rows.length, weak_lt_0_55: weak, rows };
  writeFileSync(`${OUT}-spotcheck.json`, JSON.stringify(out, null, 2));
  for (const r of rows) console.log(`sim=${r.sim}  ${r.book.slice(0, 24)} › ${(r.chapter || '').slice(0, 40)}\n  ${r.subject}\n  ${r.url}\n  ${r.preview}\n`);
  console.log(`weak(<0.55): ${weak}/${rows.length}`);
}

const table = { manifest, ingest, storage, quality, spotcheck };
if (!table[cmd]) { console.error(`usage: bookshelf-run.mjs <manifest|ingest|storage|quality> [flags]`); process.exit(1); }
table[cmd]().then(() => process.exit(0)).catch((e) => { console.error(`${cmd} failed:`, e); process.exit(1); });
