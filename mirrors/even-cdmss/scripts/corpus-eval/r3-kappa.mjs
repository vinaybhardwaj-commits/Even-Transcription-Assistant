#!/usr/bin/env node
/**
 * scripts/corpus-eval/r3-kappa.mjs — provider-migration ROUND-3 κ probe.
 *
 * Two levers that could flip the negative round-1/2 result, scored vs the SAME stored Pro gold
 * (pr5-agreement.json, zero Vertex) using the same (claim, cited-excerpt) reconstruction as
 * pr-migration-kappa.mjs:
 *   A. THINKING-MODE ON for the two most-relevant Qwens (best-cheap flash + strong-lenient plus).
 *   B. NON-QWEN cheap judges (Anthropic Haiku, DeepSeek V3-class).
 *
 * Thinking runs are cost/latency bombs (reasoning tokens ignore effort+max_tokens; 35–123 s/call,
 * ₹0.2–1.0/pair), so they run on a bounded SUBSET with a high max_tokens ceiling (so the JSON verdict
 * is not starved). Each thinking row is compared against the Flash reference κ on its OWN subset for
 * apples-to-apples. Non-Qwen runs are cheap/fast → full 105, directly comparable to round-1/2.
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/r3-kappa.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';

const GOLD = '.corpus-eval/fix-remeasure/pr5-agreement.json';
const OUT = '.corpus-eval/fix-remeasure/r3-kappa.json';
const FX = JSON.parse(readFileSync('data/llm-pricing.json', 'utf8')).fxUsdInr || 94.7;
const DROP = new Set(['not_supported', 'contradicts']);
const CONC = 4;

// candidate → { slug, inUsd, outUsd, reasoning?, maxTokens?, n? (subset size; default full) }
const CANDIDATES = [
  { slug: 'anthropic/claude-3-haiku',      inUsd: 0.25,  outUsd: 1.25, tag: 'non-qwen · cheapest current Haiku' },
  { slug: 'deepseek/deepseek-chat',        inUsd: 0.20,  outUsd: 0.80, tag: 'non-qwen · DeepSeek V3-class' },
  { slug: 'qwen/qwen3.5-flash-02-23',      inUsd: 0.065, outUsd: 0.26, reasoning: true, maxTokens: 12000, n: 36, tag: 'THINKING · best-cheap Qwen (0.72 non-think)' },
  { slug: 'qwen/qwen3.5-plus-02-15',       inUsd: 0.26,  outUsd: 1.56, reasoning: true, maxTokens: 12000, n: 5,  tag: 'THINKING · strong/lenient Qwen (0.67 non-think)' },
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
  const goldByKey = new Map(gold.results.map((r) => [`${r.audit}::${r.cid}`, { pro_drop: DROP.has(r.pro), flash_drop: r.flash_drop }]));
  const auditIds = [...new Set(gold.results.map((r) => r.audit))];
  log(`[r3] gold: ${gold.results.length} pairs across ${auditIds.length} audits (Pro reused — zero Vertex)`);

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
        if (!goldByKey.has(key)) continue;
        const s = byN.get(cid); if (!s) continue;
        tasks.push({ key, claim, chunkId: String(s.id ?? ''), meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null } });
      }
    }
  }
  const chunkText = await fetchChunks(tasks.map((t) => t.chunkId));
  for (const t of tasks) t.excerpt = { text: scrub(chunkText.get(t.chunkId) || ''), meta: t.meta };
  tasks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));  // deterministic order for stable subsets
  log(`[r3] rebuilt ${tasks.length} pairs with Pro gold`);

  const table = [];
  for (const c of CANDIDATES) {
    const subset = c.n ? tasks.slice(0, c.n) : tasks;
    log(`[r3] ${c.slug} ${c.reasoning ? 'THINK' : ''} n=${subset.length} …`);
    let fell = 0, ms = 0, inr = 0, na = 0, cTok = 0;
    const results = await pool(subset, CONC, async (t) => {
      const out = await verifyClaim(t.claim, [t.excerpt], { openrouter: c.slug, ...(c.reasoning ? { reasoning: c.reasoning } : {}), ...(c.maxTokens ? { maxTokens: c.maxTokens } : {}) });
      if (out.fellBack) fell++;
      if (out.verdict === 'not_assessable') na++;
      ms += out.usage.ms; cTok += out.usage.completion_tokens;
      inr += (out.usage.prompt_tokens * c.inUsd + out.usage.completion_tokens * c.outUsd) / 1e6 * FX;
      return { drop: DROP.has(out.verdict), fell: out.fellBack, verdict: out.verdict };
    });
    const clean = subset.map((t, i) => [results[i], t]).filter(([r]) => !r.fell);
    const pairs = clean.map(([r, t]) => [r.drop, goldByKey.get(t.key).pro_drop]);
    const k = kappa(pairs);
    // Flash reference on the SAME subset (stored — no re-run)
    const flashK = kappa(subset.map((t) => [goldByKey.get(t.key).flash_drop, goldByKey.get(t.key).pro_drop]));
    table.push({
      model: c.slug, tag: c.tag, thinking: !!c.reasoning, n: pairs.length, fellback: fell, not_assessable: na,
      kappa: k ? +k.kappa.toFixed(3) : null, agreement: k ? +k.agreement.toFixed(3) : null,
      flash_ref_kappa_same_subset: flashK ? +flashK.kappa.toFixed(3) : null,
      drop_confusion: k ? { both_drop: k.dd, both_keep: k.kk, overdrop: k.dk_overdrop, underdrop: k.kd_underdrop } : null,
      inr_per_cite: +(inr / (subset.length || 1)).toFixed(4), avg_ms: Math.round(ms / (subset.length || 1)),
      avg_completion_tok: Math.round(cTok / (subset.length || 1)),
      inr_total_this_run: +inr.toFixed(2),
      pass: k ? k.kappa >= 0.85 : false,
    });
    log(`[r3]   κ=${table.at(-1).kappa} agree=${table.at(-1).agreement} ₹/cite=${table.at(-1).inr_per_cite} run₹=${table.at(-1).inr_total_this_run} na=${na} fb=${fell}`);
  }

  const spend = table.reduce((s, r) => s + r.inr_total_this_run, 0);
  const winner = table.filter((r) => r.pass).sort((a, b) => a.inr_per_cite - b.inr_per_cite)[0] || null;
  writeFileSync(OUT, JSON.stringify({ n_full: tasks.length, fx_usd_inr: FX, total_spend_inr: +spend.toFixed(2), table, winner: winner?.model ?? null }, null, 2));

  console.log(`\n== ROUND-3 · κ vs Pro gold (zero Vertex) ==`);
  console.log('model'.padEnd(30), 'mode'.padEnd(6), 'n'.padStart(4), 'κ'.padStart(7), 'flashRef'.padStart(9), 'agree'.padStart(7), '₹/cite'.padStart(8), 'ms'.padStart(7), 'cTok'.padStart(6), 'κ≥.85');
  for (const r of table) {
    console.log(String(r.model).padEnd(30), (r.thinking ? 'THINK' : 'plain').padEnd(6), String(r.n).padStart(4),
      String(r.kappa ?? '—').padStart(7), String(r.flash_ref_kappa_same_subset ?? '—').padStart(9), String(r.agreement ?? '—').padStart(7),
      String(r.inr_per_cite).padStart(8), String(r.avg_ms).padStart(7), String(r.avg_completion_tok).padStart(6), (r.pass ? ' ✓' : ' ✗').padStart(5));
  }
  console.log(`\ntotal spend this probe: ₹${spend.toFixed(2)}   winner (κ≥0.85): ${winner?.model ?? 'NONE'}`);
  console.log(`wrote ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('r3 probe failed:', e); process.exit(1); });
