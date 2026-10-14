#!/usr/bin/env node
/**
 * scripts/corpus-eval/pr-migration-kappa.mjs — provider-migration SL3: Qwen-vs-Pro κ agreement.
 *
 * Validates OpenRouter Qwen candidates as the citation critic WITHOUT re-running Pro (zero Vertex).
 * It reuses the frozen Pro gold verdicts stored in pr5-agreement.json (the same 105 finding-citation
 * pairs the Flash probe scored), rebuilds each pair's (claim, cited-excerpt) deterministically from
 * the 0.2 rows, runs each Qwen candidate over them via OpenRouter (non-thinking), and reports
 * Cohen's κ vs Pro, drop-decision agreement, ₹ cost, and latency per candidate. Winner = cheapest
 * with κ ≥ 0.85 (Flash scored 0.87).
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/pr-migration-kappa.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';

const GOLD = '.corpus-eval/fix-remeasure/pr5-agreement.json';
const OUT = '.corpus-eval/fix-remeasure/pr-migration-kappa.json';
const FX = JSON.parse(readFileSync('data/llm-pricing.json', 'utf8')).fxUsdInr || 94.7;
const DROP = new Set(['not_supported', 'contradicts']);
const CONC = 4;
// candidate → [inUsdPerM, outUsdPerM] (from openrouter /models, pre-flight §6.2)
const CANDIDATES = [
  ['qwen/qwen3.5-flash-02-23', 0.065, 0.26],          // round-1 best cheap (κ 0.71)
  ['qwen/qwen3-235b-a22b-2507', 0.09, 0.55],          // round-2: cheap-strong big MoE
  ['qwen/qwen3-next-80b-a3b-instruct', 0.10, 1.10],   // round-2: mid-strong 80B MoE
  ['qwen/qwen3.5-plus-02-15', 0.26, 1.56],            // round-2: strong (≈Flash cost) — upper bound
];
const scrub = (s) => String(s ?? '').replace(/\bUHID[-\s:]*\d+/gi, '[uhid]').replace(/\b[6-9]\d{9}\b/g, '[phone]').replace(/\s+/g, ' ').trim();
const log = (...a) => console.error(...a);

async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
async function fetchChunks(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))]; const map = new Map();
  for (let i = 0; i < uniq.length; i += 500) {
    const rows = await sql(`SELECT id::text AS id, text FROM mksap_chunks WHERE id::text = ANY($1)`, [uniq.slice(i, i + 500)]);
    for (const r of rows) map.set(String(r.id), r.text);
  }
  return map;
}
/** Cohen's κ on a binary (drop/keep) decision vs the gold. */
function kappa(pairs) {
  const n = pairs.length; if (!n) return null;
  let dd = 0, kk = 0, dk = 0, kd = 0;
  for (const [a, g] of pairs) { if (a && g) dd++; else if (!a && !g) kk++; else if (a && !g) dk++; else kd++; }
  const po = (dd + kk) / n;
  const pA = (dd + dk) / n, pG = (dd + kd) / n;
  const pe = pA * pG + (1 - pA) * (1 - pG);
  return { kappa: pe < 1 ? (po - pe) / (1 - pe) : 1, agreement: po, dd, kk, dk_overdrop: dk, kd_underdrop: kd };
}

async function main() {
  const gold = JSON.parse(readFileSync(GOLD, 'utf8'));
  const goldByKey = new Map(gold.results.map((r) => [`${r.audit}::${r.cid}`, { pro: r.pro, pro_drop: DROP.has(r.pro), flash_drop: r.flash_drop }]));
  const auditIds = [...new Set(gold.results.map((r) => r.audit))];
  log(`[kappa] gold: ${gold.results.length} pairs across ${auditIds.length} audits (Pro reused — zero Vertex)`);

  // rebuild (claim, excerpt) per (audit, cid) from the 0.2 rows — same construction as pr5-agreement
  const rows = await sql(`SELECT id::text AS id, report FROM ipd_discharge_audits WHERE id::text = ANY($1)`, [auditIds]);
  const tasks = [];
  for (const row of rows) {
    const rep = typeof row.report === 'string' ? JSON.parse(row.report) : row.report;
    const byN = new Map((rep?.sources || []).map((s) => [Number(s.n), s]));
    for (const f of rep?.findings || []) {
      const claim = scrub(Array.isArray(f.evidence) ? f.evidence.join(' ') : (f.subject ?? ''));
      const cids = Array.isArray(f.citation_ids) ? f.citation_ids.map(Number).filter(Boolean) : [];
      if (!claim) continue;
      for (const cid of cids) {
        const key = `${row.id}::${cid}`;
        if (!goldByKey.has(key)) continue;   // only pairs we have Pro gold for
        const s = byN.get(cid); if (!s) continue;
        tasks.push({ key, claim, chunkId: String(s.id ?? ''), meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null } });
      }
    }
  }
  const chunkText = await fetchChunks(tasks.map((t) => t.chunkId));
  for (const t of tasks) t.excerpt = { text: scrub(chunkText.get(t.chunkId) || ''), meta: t.meta };
  log(`[kappa] rebuilt ${tasks.length} pairs with Pro gold`);

  // Flash reference (from the stored gold — no re-run)
  const flashPairs = tasks.map((t) => [goldByKey.get(t.key).flash_drop, goldByKey.get(t.key).pro_drop]);
  const flashK = kappa(flashPairs);

  const table = [{ model: 'google/gemini-2.5-flash (ref)', n: tasks.length, kappa: +flashK.kappa.toFixed(3), agreement: +flashK.agreement.toFixed(3), inr_per_cite: 0.045, avg_ms: null, fellback: 0, note: 'stored PR5 probe' }];

  for (const [model, inUsd, outUsd] of CANDIDATES) {
    log(`[kappa] ${model} …`);
    let fell = 0, ms = 0, inr = 0;
    const results = await pool(tasks, CONC, async (t) => {
      const out = await verifyClaim(t.claim, [t.excerpt], { openrouter: model });
      if (out.fellBack) fell++;
      ms += out.usage.ms;
      inr += (out.usage.prompt_tokens * inUsd + out.usage.completion_tokens * outUsd) / 1e6 * FX;
      return { drop: DROP.has(out.verdict), fell: out.fellBack, verdict: out.verdict };
    });
    const clean = tasks.map((t, i) => [results[i], t]).filter(([r]) => !r.fell);
    const pairs = clean.map(([r, t]) => [r.drop, goldByKey.get(t.key).pro_drop]);
    const k = kappa(pairs);
    table.push({
      model, n: pairs.length, fellback: fell,
      kappa: k ? +k.kappa.toFixed(3) : null, agreement: k ? +k.agreement.toFixed(3) : null,
      drop_confusion: k ? { both_drop: k.dd, both_keep: k.kk, overdrop: k.dk_overdrop, underdrop: k.kd_underdrop } : null,
      inr_per_cite: +(inr / (tasks.length || 1)).toFixed(4), avg_ms: Math.round(ms / (tasks.length || 1)),
      pass: k ? k.kappa >= 0.85 : false,
    });
  }

  const passing = table.filter((r) => r.pass && r.model.startsWith('qwen'));
  const winner = passing.sort((a, b) => a.inr_per_cite - b.inr_per_cite)[0] || null;
  writeFileSync(OUT, JSON.stringify({ n_pairs: tasks.length, fx_usd_inr: FX, table, winner: winner?.model ?? null }, null, 2));

  console.log(`\n== PROVIDER MIGRATION · κ agreement vs Pro gold (${tasks.length} pairs, zero Vertex) ==`);
  console.log('model'.padEnd(38), 'n'.padStart(4), 'κ'.padStart(7), 'agree'.padStart(7), '₹/cite'.padStart(8), 'ms'.padStart(6), 'fb'.padStart(4), 'κ≥.85');
  for (const r of table) {
    console.log(String(r.model).padEnd(38), String(r.n).padStart(4), String(r.kappa ?? '—').padStart(7), String(r.agreement ?? '—').padStart(7),
      String(r.inr_per_cite).padStart(8), String(r.avg_ms ?? '—').padStart(6), String(r.fellback).padStart(4), (r.pass ? ' ✓' : (r.model.startsWith('qwen') ? ' ✗' : '')).padStart(5));
  }
  console.log(`\nWINNER (cheapest qwen with κ≥0.85): ${winner?.model ?? 'NONE'}${winner ? ` @ ₹${winner.inr_per_cite}/cite (κ ${winner.kappa})` : ''}`);
  console.log(`wrote ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('kappa probe failed:', e); process.exit(1); });
