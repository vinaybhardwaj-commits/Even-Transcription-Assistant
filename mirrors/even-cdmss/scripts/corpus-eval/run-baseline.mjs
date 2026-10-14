#!/usr/bin/env node
/**
 * scripts/corpus-eval/run-baseline.mjs — Brainstem PR 0: orchestrate sample → verify → metrics.
 *
 * Grain = (finding, cited-sources-bundle): ONE verdict per cited finding, its cited excerpts passed
 * together (PRD §5, stated in the report). Scores each through the GOVERNED Pro verifier.
 *
 * DURABILITY (measurement-only, no engine change):
 *  • Live heartbeat — rewrites .corpus-eval/status.json every verdict (stage/pid/progress/eta/
 *    fallback_fired/done): `cat .corpus-eval/status.json` answers "running / how far / done?".
 *  • Incremental checkpoint + resume — appends each verdict to baseline.json as scored; a death loses
 *    nothing and a re-run RESUMES from the checkpoint (same pack) instead of restarting.
 *  • Fallback integrity — verify.ts flags any Ollama-fallback verdict; it is excluded (not_assessable)
 *    AND increments status.fallback_fired, so a rate-limit can never silently taint the Pro baseline.
 *
 * SL0 mode (`--sl0`): scores the first ~10 cited findings/consumer, reports measured cost. No resume.
 * `node --env-file=.env.local --import tsx scripts/corpus-eval/run-baseline.mjs [--sl0] [--per=120]`
 */
import { readFileSync as _rf, writeFileSync, existsSync } from 'node:fs';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';
import { supportStats, citeOrLabel } from '../../lib/corpus-eval/verify-core.ts';
import { perCallInr } from '../../lib/llm-cost-core.ts';

const PRICING = JSON.parse(_rf(new URL('../../data/llm-pricing.json', import.meta.url), 'utf8'));
const SL0 = process.argv.includes('--sl0');
const PER = Math.max(1, parseInt((process.argv.find((a) => a.startsWith('--per='))?.split('=')[1]) || process.env.PER || '120', 10));
const SL0_N = 10;
const PACK = '.corpus-eval/pack.json';
const OUT = SL0 ? '.corpus-eval/sl0-cost.json' : '.corpus-eval/baseline.json';
const STATUS = '.corpus-eval/status.json';
const CONSUMERS = ['opd', 'ipd', 'ccb'];
const nowIso = () => new Date().toISOString();
const inr = (u) => { try { return perCallInr('gemini-2.5-pro', u.prompt_tokens, u.completion_tokens, PRICING); } catch { return 0; } };
const packSig = (pack) => `${pack.assembled_per ?? '?'}:${pack.units.length}`;

function computeMetrics(pack, results, samples) {
  const per = {};
  for (const c of CONSUMERS) {
    const all = pack.units.filter((u) => u.consumer === c);
    const verdicts = results.filter((r) => r.consumer === c).map((r) => r.verdict);
    per[c] = {
      cite_or_label: citeOrLabel(all.map((u) => ({ cited: u.cited }))),
      n_cited_findings: all.filter((u) => u.cited && u.excerpts.length).length,
      n_scored: verdicts.length,
      n_target: samples[c].length,
      support: supportStats(verdicts),
    };
  }
  const n = results.length || 1;
  const sum = (k) => results.reduce((a, r) => a + (r[k] || 0), 0);
  const cost = {
    n_verdicts: results.length,
    avg_tokens_in: Math.round(sum('tokens_in') / n), avg_tokens_out: Math.round(sum('tokens_out') / n),
    avg_ms: Math.round(sum('ms') / n), avg_inr: sum('inr') / n, total_inr: sum('inr'),
    not_assessable: results.filter((r) => r.verdict === 'not_assessable').length,
    fallback_fired: results.filter((r) => r.fellBack).length,
  };
  return { per, cost };
}

function writeStatus(state) {
  writeFileSync(STATUS, JSON.stringify(state, null, 2));
}

async function main() {
  const pack = JSON.parse(_rf(PACK, 'utf8'));
  const sig = packSig(pack);

  // sample the cited findings per consumer (stable pack order → stable resume keys consumer::i)
  const samples = {};
  for (const c of CONSUMERS) {
    const cited = pack.units.filter((u) => u.consumer === c && u.cited && u.excerpts.length);
    samples[c] = (SL0 ? cited.slice(0, SL0_N) : cited.slice(0, PER)).map((u, i) => ({ ...u, __key: `${c}::${i}` }));
  }
  const totalTarget = CONSUMERS.reduce((n, c) => n + samples[c].length, 0);

  // RESUME: load checkpoint if the pack matches (never for SL0)
  let results = [];
  let started_at = nowIso();
  if (!SL0 && existsSync(OUT)) {
    try {
      const prev = JSON.parse(_rf(OUT, 'utf8'));
      if (prev.pack_sig === sig && Array.isArray(prev.results)) { results = prev.results; started_at = prev.started_at || started_at; }
    } catch { /* corrupt checkpoint → fresh */ }
  }
  const done = new Set(results.map((r) => r.__key));
  console.error(`[baseline] pack ${sig} · target ${totalTarget} · resuming from ${results.length} checkpointed`);

  for (const c of CONSUMERS) {
    for (const u of samples[c]) {
      if (done.has(u.__key)) continue;
      const out = await verifyClaim(u.claim, u.excerpts.map((e) => ({ text: e.text, meta: e.meta })));
      results.push({
        __key: u.__key, consumer: c, audit_ref: u.audit_ref, finding_ref: u.finding_ref,
        verdict: out.verdict, fellBack: out.fellBack,
        tokens_in: out.usage.prompt_tokens, tokens_out: out.usage.completion_tokens, ms: out.usage.ms, inr: inr(out.usage),
      });
      done.add(u.__key);

      // checkpoint (baseline.json rewritten every verdict — death-safe) + heartbeat
      const { per, cost } = computeMetrics(pack, results, samples);
      writeFileSync(OUT, JSON.stringify({ version: 'corpus-eval/1.0', mode: SL0 ? 'sl0-cost-probe' : 'baseline', pack_sig: sig, started_at, updated_at: nowIso(), results, per_consumer: per, measured_cost: cost, done: false }, null, 2));
      const scored = results.length;
      const avgMs = cost.avg_ms || 0;
      writeStatus({
        stage: SL0 ? 'sl0-cost-probe' : 'baseline', pid: process.pid, started_at, updated_at: nowIso(),
        per_consumer: Object.fromEntries(CONSUMERS.map((k) => [k, { scored: results.filter((r) => r.consumer === k).length, total: samples[k].length }])),
        total_scored: scored, total_target: totalTarget, pct: totalTarget ? Math.round((scored / totalTarget) * 100) : 100,
        eta_seconds: Math.round(((totalTarget - scored) * avgMs) / 1000), fallback_fired: cost.fallback_fired, done: false,
      });
      if (scored % 10 === 0) console.error(`  …scored ${scored}/${totalTarget} (${c}) · fallback ${cost.fallback_fired}`);
    }
  }

  // finalize
  const { per, cost } = computeMetrics(pack, results, samples);
  writeFileSync(OUT, JSON.stringify({ version: 'corpus-eval/1.0', mode: SL0 ? 'sl0-cost-probe' : 'baseline', pack_sig: sig, started_at, updated_at: nowIso(), results, per_consumer: per, measured_cost: cost, done: true }, null, 2));
  writeStatus({
    stage: SL0 ? 'sl0-cost-probe' : 'baseline', pid: process.pid, started_at, updated_at: nowIso(),
    per_consumer: Object.fromEntries(CONSUMERS.map((k) => [k, { scored: results.filter((r) => r.consumer === k).length, total: samples[k].length }])),
    total_scored: results.length, total_target: totalTarget, pct: 100, eta_seconds: 0, fallback_fired: cost.fallback_fired, done: true,
  });
  for (const c of CONSUMERS) console.error(`[${c}] scored ${per[c].n_scored}/${per[c].n_target} · support ${per[c].support.support_rate?.toFixed(3) ?? '—'} (incl-partial ${per[c].support.support_rate_incl_partial?.toFixed(3) ?? '—'})`);
  console.error(`[${SL0 ? 'SL0' : 'baseline'}] DONE · n=${cost.n_verdicts} · ₹${cost.avg_inr.toFixed(4)}/verdict (₹${cost.total_inr.toFixed(2)}) · not_assessable ${cost.not_assessable} · fallback_fired ${cost.fallback_fired}`);
  process.exit(0);
}
main().catch((e) => { console.error('run-baseline failed:', e); process.exit(1); });
