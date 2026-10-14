#!/usr/bin/env node
/**
 * scripts/corpus-eval/source-authority-probe.mjs — Source-Authority measure-first probe.
 * Spec: CDMSS-SOURCE-AUTHORITY-MEASUREMENT-SPEC-20-JUL-2026.md. READ-ONLY, zero Vertex, no writes.
 *
 * Three cheap numbers, no re-audit, no gold:
 *   M1  corpus composition by authority tier (active vs quarantined labq:bookshelf).
 *   M2  retrieval authority probe — production retrieve() over real appropriateness scenarios with
 *       source-weights ON vs OFF; how often a Tier-A source is retrievable but demoted out of the
 *       cited top-8 by the weight. (Weight isolated: one reranked pool, re-sorted by
 *       rerank_score × computeSourceQualityWeight exactly as retrieve.ts does.)
 *   M3  authority-cited rate on persisted appropriateness_runs (cited sources[] + audit findings
 *       with domain ∈ {appropriateness, efficiency}).
 *
 * ₹0 GUARANTEE: GCP_SA_KEY is deleted below → geminiConfigured() is false → the judge reranker and
 * every model call fall back to the LOCAL mini (llama3.1:8b); embeddings are nomic. No Vertex.
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/source-authority-probe.mjs [M1|M2|M3|all] [--per N]
 */
delete process.env.GCP_SA_KEY;                       // force local rerank — zero Vertex (see header)
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { geminiConfigured } from '../../lib/llm.ts';
import { retrieve } from '../../lib/retrieve.ts';
import { computeSourceQualityWeight } from '../../lib/source-quality.ts';

if (geminiConfigured()) { console.error('ABORT: Gemini still configured — probe would spend Vertex. Unset GCP_SA_KEY.'); process.exit(1); }

const OUTDIR = '.corpus-eval/source-authority';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const which = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'all';

// ── authority tiers (LOCKED against real M1 labels, 20 Jul) ─────────────────────────
const TIER_A_BOOKS = /expert panel report|joint national committee|preventive services|uspstf|\bjnc\b/i;   // quarantined guideline monographs
const TIER_B = /\bmksap\b|harrison|cecil|goldman|tintinalli|\bnms\b|oxford handbook|kaplan|neurosurgery/i;
function tierOf(source, book) {
  const s = String(source ?? '').toLowerCase();
  const b = String(book ?? '');
  if (s === 'choosing-wisely' || s === 'guidelines') return 'A';                 // society/appropriateness authority (active)
  if (s === 'labq:bookshelf' || s === 'bookshelf') return TIER_A_BOOKS.test(b) ? 'A' : 'C';  // activated or quarantined: EPR-3/JNC/USPSTF = A; Endotext = C
  if (s === 'mksap-19' || s === 'textbook' || TIER_B.test(b)) return 'B';        // board-review / specialty textbooks
  if (s === 'statpearls' || s === 'uptodate' || s === 'medscape' || s === 'aafp') return 'C';
  return 'D';                                                                     // pubmed / europepmc / openfda / unknown
}
const TIERS = ['A', 'B', 'C', 'D'];

// ── M1 ──────────────────────────────────────────────────────────────────────────────
async function m1() {
  const rows = await sql`SELECT source, book, count(*)::int n FROM mksap_chunks GROUP BY source, book`;
  const acc = { active: { A: 0, B: 0, C: 0, D: 0 }, quarantined: { A: 0, B: 0, C: 0, D: 0 } };
  const bySource = {};
  for (const r of rows) {
    const quar = String(r.source).startsWith('labq:');
    const t = tierOf(r.source, r.book);
    acc[quar ? 'quarantined' : 'active'][t] += r.n;
    const key = `${r.source} [${t}]`;
    bySource[key] = (bySource[key] || 0) + r.n;
  }
  const activeTot = Object.values(acc.active).reduce((a, b) => a + b, 0);
  const report = {
    active_by_tier: acc.active,
    quarantined_by_tier: acc.quarantined,
    active_total: activeTot,
    active_tierA_pct: +(100 * acc.active.A / activeTot).toFixed(4),
    tierA_active_sources: Object.entries(bySource).filter(([k]) => k.includes('[A]') && !k.startsWith('labq')).map(([k, n]) => `${k}=${n}`),
    tierA_quarantined: acc.quarantined.A,
  };
  console.log('== M1 corpus composition by authority tier ==');
  console.log('active     :', JSON.stringify(acc.active), `(total ${activeTot})`);
  console.log('quarantined:', JSON.stringify(acc.quarantined));
  console.log(`active Tier-A: ${acc.active.A} chunks = ${report.active_tierA_pct}% of active corpus`);
  console.log(`quarantined Tier-A (USPSTF/JNC/EPR-3): ${acc.quarantined.A}`);
  console.log('active Tier-A sources:', report.tierA_active_sources.join(', '));
  return report;
}

// ── M2 ──────────────────────────────────────────────────────────────────────────────
const POOL_PROD = 24;   // production pool for topK=8 (min(30, 8*3))
const TOPK = 8;

function weightedOrder(hits) {
  // Mirror retrieve.ts: score = rerank_score × computeSourceQualityWeight, re-sort desc.
  return hits.map((h) => {
    const w = computeSourceQualityWeight({ book: h.book, source: h.source, chunk_type: h.chunk_type, token_count: h.token_count });
    return { ...h, w, weighted: (h.rerank_score ?? h.similarity ?? 0) * w };
  }).sort((a, b) => b.weighted - a.weighted);
}
const bestRank = (arr, t) => { const i = arr.findIndex((h) => tierOf(h.source, h.book) === t); return i < 0 ? null : i + 1; };

async function m2() {
  const per = parseInt(arg('per', '50'), 10);
  const rows = await sql`
    SELECT DISTINCT ON (scenario) scenario FROM appropriateness_runs
    WHERE mode IN ('check','pathway') AND n_sources > 0
      AND scenario NOT ILIKE '%neutrality probe%' AND scenario NOT ILIKE '%verify run%'
    ORDER BY scenario LIMIT ${per}`;
  const scenarios = rows.map((r) => r.scenario).filter((s) => String(s).trim().length > 20);
  console.log(`== M2 retrieval authority probe · ${scenarios.length} distinct appropriateness scenarios · rerank=local(llama3.1:8b) ==`);

  const per_scenario = [];
  let poolHasA = 0, aInTop8_off = 0, aInTop8_on = 0, demotedOut = 0, rerankLocal = 0;
  const rankDeltas = [];
  let i = 0;
  for (const scenario of scenarios) {
    const r = await retrieve(scenario, { topK: 30, useReranker: true, useSourceWeights: false, hybrid: true });
    const off = r.hits;                                  // rerank order (weights OFF)
    if (off.some((h) => h.rerank_backend === 'judge')) rerankLocal++;
    const on = weightedOrder(off);                       // weights ON (exact retrieve.ts re-sort)
    const pool = off.slice(0, POOL_PROD);                // production candidate pool
    const aRankOff = bestRank(off, 'A'), aRankOn = bestRank(on, 'A');
    const bRankOn = bestRank(on, 'B');
    const aInPool = pool.some((h) => tierOf(h.source, h.book) === 'A');
    const aTop8Off = aRankOff != null && aRankOff <= TOPK;
    const aTop8On = aRankOn != null && aRankOn <= TOPK;
    if (aInPool) poolHasA++;
    if (aTop8Off) aInTop8_off++;
    if (aTop8On) aInTop8_on++;
    if (aTop8Off && !aTop8On) demotedOut++;              // present weights-off top-8, pushed out by the weight
    if (aRankOn != null && bRankOn != null) rankDeltas.push(aRankOn - bRankOn);
    const comp = (arr) => { const c = { A: 0, B: 0, C: 0, D: 0 }; for (const h of arr.slice(0, TOPK)) c[tierOf(h.source, h.book)]++; return c; };
    per_scenario.push({
      scenario: scenario.slice(0, 80), a_in_pool: aInPool, a_rank_off: aRankOff, a_rank_on: aRankOn,
      b_rank_on: bRankOn, demoted_out_of_top8: aTop8Off && !aTop8On,
      top8_off: comp(off), top8_on: comp(on),
    });
    if (++i % 5 === 0) console.error(`  … ${i}/${scenarios.length}`);
  }
  const n = scenarios.length;
  const meanDelta = rankDeltas.length ? +(rankDeltas.reduce((a, b) => a + b, 0) / rankDeltas.length).toFixed(2) : null;
  const report = {
    n_scenarios: n, rerank_local_scenarios: rerankLocal,
    tierA_in_candidate_pool: poolHasA, tierA_in_top8_weightsOff: aInTop8_off, tierA_in_top8_weightsOn: aInTop8_on,
    tierA_retrievable_but_demoted_out_of_top8_by_weight: demotedOut,
    pct_scenarios_tierA_available_but_not_in_cited_top8: +(100 * (poolHasA - aInTop8_on) / (n || 1)).toFixed(1),
    mean_guidelineA_minus_textbookB_rank_delta_weightsOn: meanDelta,
    per_scenario,
  };
  console.log(`Tier-A in candidate pool: ${poolHasA}/${n} · in top-8 (weights OFF): ${aInTop8_off} · (weights ON): ${aInTop8_on} · demoted out by weight: ${demotedOut}`);
  console.log(`% scenarios where Tier-A was retrievable but NOT in cited top-8: ${report.pct_scenarios_tierA_available_but_not_in_cited_top8}%`);
  console.log(`mean (Tier-A rank − Tier-B textbook rank), weights ON: ${meanDelta ?? 'n/a'} (positive = guideline ranked below textbook)`);
  return report;
}

// ── M3 ──────────────────────────────────────────────────────────────────────────────
async function m3() {
  const runs = await sql`SELECT mode, output FROM appropriateness_runs WHERE output IS NOT NULL`;
  let runsWithSources = 0, runsCitingA = 0;
  const citedTierCount = { A: 0, B: 0, C: 0, D: 0 };
  let findAE = 0, findAE_citeA = 0;
  for (const row of runs) {
    const o = typeof row.output === 'string' ? JSON.parse(row.output) : row.output;
    const sources = o.report?.sources || o.sources || o.valueSources || [];
    if (sources.length) {
      runsWithSources++;
      const tiers = sources.map((s) => tierOf(s.source, s.book));
      for (const t of tiers) citedTierCount[t]++;
      if (tiers.includes('A')) runsCitingA++;
    }
    // finding-level: audit findings with domain ∈ {appropriateness, efficiency}
    const findings = o.report?.findings || [];
    const srcByN = new Map(sources.map((s) => [Number(s.n), s]));
    for (const f of findings) {
      if (!['appropriateness', 'efficiency'].includes(f?.domain)) continue;
      findAE++;
      const cited = new Set();
      for (const ev of (f.evidence || [])) for (const m of String(ev).matchAll(/\[(\d[\d,\s]*)\]/g)) for (const x of m[1].split(',')) cited.add(Number(x.trim()));
      const citesA = [...cited].some((nn) => { const s = srcByN.get(nn); return s && tierOf(s.source, s.book) === 'A'; });
      if (citesA) findAE_citeA++;
    }
  }
  const report = {
    runs_with_cited_sources: runsWithSources,
    runs_citing_ge1_tierA: runsCitingA,
    pct_runs_citing_tierA: +(100 * runsCitingA / (runsWithSources || 1)).toFixed(1),
    cited_source_tier_distribution: citedTierCount,
    appropriateness_efficiency_findings: findAE,
    ae_findings_citing_tierA: findAE_citeA,
    pct_ae_findings_citing_tierA: +(100 * findAE_citeA / (findAE || 1)).toFixed(1),
  };
  console.log('== M3 authority-cited rate (persisted, no re-audit) ==');
  console.log(`runs citing ≥1 Tier-A: ${runsCitingA}/${runsWithSources} (${report.pct_runs_citing_tierA}%)`);
  console.log('cited-source tier distribution:', JSON.stringify(citedTierCount));
  console.log(`appropriateness/efficiency findings citing Tier-A: ${findAE_citeA}/${findAE} (${report.pct_ae_findings_citing_tierA}%)`);
  return report;
}

// ── main ─────────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUTDIR, { recursive: true });
  const out = {};
  if (which === 'all' || which === 'M1') out.M1 = await m1();
  if (which === 'all' || which === 'M3') out.M3 = await m3();          // cheap SQL first
  if (which === 'all' || which === 'M2') out.M2 = await m2();          // slower (local rerank)
  writeFileSync(`${OUTDIR}/results.json`, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUTDIR}/results.json`);
  process.exit(0);
}
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
