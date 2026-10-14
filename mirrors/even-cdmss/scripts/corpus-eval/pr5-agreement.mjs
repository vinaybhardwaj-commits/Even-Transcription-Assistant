#!/usr/bin/env node
/**
 * scripts/corpus-eval/pr5-agreement.mjs — Brainstem PR5 SL0: cost + Flash-vs-Pro agreement probe.
 *
 * The in-engine citation gate drops a citation when the FLASH critic calls it not_supported/
 * contradicts. Before enabling anything, this probe checks the Flash critic is a faithful cheap
 * proxy for the Pro verifier: over the citations of ~N recent 0.2 IPD audits, it runs BOTH the
 * Flash critic and the Pro verifier (verify.ts verifyClaim, per-citation grain) on the SAME
 * (claim, cited-excerpt) unit and reports (a) Flash cost + latency and (b) how often the two AGREE
 * on the drop/keep decision (plus the full verdict confusion).
 *
 * Read-only. Excerpts resolved to full chunk text via mksap_chunks.text by the persisted sources[].id
 * (mirrors assemble-pack). Never CI.
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/pr5-agreement.mjs [--n 10] [--conc 4]
 */
import { readFileSync as _rf, writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';
import { GEMINI_FLASH_MODEL, GEMINI_MODEL } from '../../lib/llm.ts';
import { perCallInr } from '../../lib/llm-cost-core.ts';

const PRICING = JSON.parse(_rf(new URL('../../data/llm-pricing.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); if (a) return a.split('=')[1]; const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N = Math.max(1, parseInt(argOf('n', '10'), 10));
const CONC = Math.max(1, parseInt(argOf('conc', '4'), 10));
const OUT = '.corpus-eval/fix-remeasure/pr5-agreement.json';
const DROP = new Set(['not_supported', 'contradicts']);
const scrub = (s) => String(s ?? '').replace(/\bUHID[-\s:]*\d+/gi, '[uhid]').replace(/\b[6-9]\d{9}\b/g, '[phone]').replace(/\s+/g, ' ').trim();
const inr = (model, u) => { try { return perCallInr(model, u.prompt_tokens, u.completion_tokens, PRICING); } catch { return 0; } };

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

async function main() {
  mkdirSync('.corpus-eval/fix-remeasure', { recursive: true });
  const rows = await sql(
    `SELECT id::text AS id, report FROM ipd_discharge_audits
     WHERE engine_version = 'ipd-discharge-audit/0.2' AND report IS NOT NULL
     ORDER BY audited_at DESC LIMIT $1`, [N]);
  console.error(`[pr5] ${rows.length} audits`);

  // build per-(finding,citation) tasks with full excerpt text
  const tasks = [];
  for (const row of rows) {
    const rep = typeof row.report === 'string' ? JSON.parse(row.report) : row.report;
    const findings = rep?.findings || []; const sources = rep?.sources || [];
    const byN = new Map(sources.map((s) => [Number(s.n), s]));
    for (const f of findings) {
      const claim = scrub(Array.isArray(f.evidence) ? f.evidence.join(' ') : (f.subject ?? ''));
      const cids = Array.isArray(f.citation_ids) ? f.citation_ids.map(Number).filter(Boolean) : [];
      if (!claim || !cids.length) continue;
      for (const cid of cids) {
        const s = byN.get(cid); if (!s) continue;
        tasks.push({ audit: row.id, claim, cid, chunkId: String(s.id ?? ''),
          meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null } });
      }
    }
  }
  const chunkText = await fetchChunks(tasks.map((t) => t.chunkId));
  for (const t of tasks) t.excerpt = { text: scrub(chunkText.get(t.chunkId) || ''), meta: t.meta };
  console.error(`[pr5] ${tasks.length} (finding,citation) pairs · running Flash + Pro (conc ${CONC})…`);

  const results = await pool(tasks, CONC, async (t) => {
    const [flash, pro] = await Promise.all([
      verifyClaim(t.claim, [t.excerpt], { model: GEMINI_FLASH_MODEL }),
      verifyClaim(t.claim, [t.excerpt], { model: GEMINI_MODEL }),
    ]);
    return {
      audit: t.audit, cid: t.cid,
      flash: flash.verdict, pro: pro.verdict, flashFellBack: flash.fellBack, proFellBack: pro.fellBack,
      flash_ms: flash.usage.ms, flash_inr: inr(GEMINI_FLASH_MODEL, flash.usage),
      flash_tok_in: flash.usage.prompt_tokens, flash_tok_out: flash.usage.completion_tokens,
      flash_drop: DROP.has(flash.verdict), pro_drop: DROP.has(pro.verdict),
    };
  });

  // ── agreement + cost ──
  const n = results.length;
  const both = results.filter((r) => !r.flashFellBack && !r.proFellBack);   // clean Pro+Flash only
  const dd = both.filter((r) => r.flash_drop && r.pro_drop).length;
  const kk = both.filter((r) => !r.flash_drop && !r.pro_drop).length;
  const dk = both.filter((r) => r.flash_drop && !r.pro_drop).length;   // Flash drops, Pro keeps (over-drop)
  const kd = both.filter((r) => !r.flash_drop && r.pro_drop).length;   // Flash keeps, Pro drops (missed)
  const nb = both.length;
  const agree = nb ? (dd + kk) / nb : null;
  // Cohen's kappa on the drop decision
  const po = agree ?? 0;
  const pFlashDrop = nb ? (dd + dk) / nb : 0, pProDrop = nb ? (dd + kd) / nb : 0;
  const pe = pFlashDrop * pProDrop + (1 - pFlashDrop) * (1 - pProDrop);
  const kappa = nb && pe < 1 ? (po - pe) / (1 - pe) : null;
  const exactVerdict = both.filter((r) => r.flash === r.pro).length;

  const flashInr = results.reduce((a, r) => a + r.flash_inr, 0);
  const avgMs = n ? results.reduce((a, r) => a + r.flash_ms, 0) / n : 0;

  const summary = {
    audits: rows.length, pairs: n, clean_pairs: nb,
    flash_cost: { total_inr: +flashInr.toFixed(3), per_citation_inr: n ? +(flashInr / n).toFixed(4) : null, avg_ms: Math.round(avgMs),
      avg_tok_in: n ? Math.round(results.reduce((a, r) => a + r.flash_tok_in, 0) / n) : 0, avg_tok_out: n ? Math.round(results.reduce((a, r) => a + r.flash_tok_out, 0) / n) : 0 },
    flash_fellback: results.filter((r) => r.flashFellBack).length, pro_fellback: results.filter((r) => r.proFellBack).length,
    drop_decision: { agreement: agree == null ? null : +agree.toFixed(3), cohens_kappa: kappa == null ? null : +kappa.toFixed(3),
      flash_drop_pro_drop: dd, flash_keep_pro_keep: kk, flash_drop_pro_keep_OVERDROP: dk, flash_keep_pro_drop_MISS: kd },
    flash_drop_rate: nb ? +((dd + dk) / nb).toFixed(3) : null, pro_drop_rate: nb ? +((dd + kd) / nb).toFixed(3) : null,
    exact_verdict_agreement: nb ? +(exactVerdict / nb).toFixed(3) : null,
  };
  writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));

  console.log(`\n== PR5 SL0 · Flash-vs-Pro citation-critic probe ==`);
  console.log(`audits ${summary.audits} · (finding,citation) pairs ${n} · clean (no fallback) ${nb}`);
  console.log(`FLASH cost: ₹${summary.flash_cost.total_inr} total · ₹${summary.flash_cost.per_citation_inr}/citation · ${summary.flash_cost.avg_ms}ms avg · ${summary.flash_cost.avg_tok_in}/${summary.flash_cost.avg_tok_out} tok`);
  console.log(`DROP-decision agreement: ${summary.drop_decision.agreement} · Cohen's κ ${summary.drop_decision.cohens_kappa}`);
  console.log(`  confusion: both-drop ${dd} · both-keep ${kk} · Flash-over-drop ${dk} · Flash-misses(Pro-drop) ${kd}`);
  console.log(`  drop rates: Flash ${summary.flash_drop_rate} · Pro ${summary.pro_drop_rate} · exact-verdict agree ${summary.exact_verdict_agreement}`);
  console.log(`  fallback: Flash ${summary.flash_fellback} · Pro ${summary.pro_fellback}`);
  console.log(`wrote ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('pr5-agreement failed:', e); process.exit(1); });
