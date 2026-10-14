#!/usr/bin/env node
/**
 * scripts/corpus-eval/coverage-deficit.mjs — Brainstem PR 0: the coverage-deficit probe (PRD §2.3).
 *
 * READ-ONLY, reuses the shipped `retrieve()` (no new path, no engine change). Over the topics each
 * surface actually surfaces (its finding subjects/claims, from the assembled pack), computes the
 * histogram of `1 − top-hit similarity` — the demand-bus's own thinness signal (D3), as a baseline.
 * Pure retrieval + arithmetic, NO model generation.
 *
 * Run AFTER assemble-pack. `node --env-file=.env.local --import tsx scripts/corpus-eval/coverage-deficit.mjs [--per=120]`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { retrieve } from '../../lib/retrieve.ts';
import { deficitHistogram } from '../../lib/corpus-eval/verify-core.ts';

const PER = Math.max(1, parseInt((process.argv.find((a) => a.startsWith('--per='))?.split('=')[1]) || process.env.PER || '120', 10));
const PACK = '.corpus-eval/pack.json';
const STATUS = '.corpus-eval/status.json';
const CONSUMERS = ['opd', 'ipd', 'ccb'];
const nowIso = () => new Date().toISOString();

/** Deterministic stratified pick: first PER distinct subjects per consumer (stable order from the pack). */
function subjectsFor(units, consumer) {
  const seen = new Set(); const out = [];
  for (const u of units) {
    if (u.consumer !== consumer) continue;
    const subj = (u.finding_ref && u.finding_ref.length > 3) ? u.finding_ref : u.claim;
    const key = subj.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key); out.push(subj.slice(0, 300));
    if (out.length >= PER) break;
  }
  return out;
}

async function main() {
  const pack = JSON.parse(readFileSync(PACK, 'utf8'));
  const result = {};
  const started_at = nowIso();
  const subjectsByC = Object.fromEntries(CONSUMERS.map((c) => [c, subjectsFor(pack.units, c)]));
  const totalTarget = CONSUMERS.reduce((n, c) => n + subjectsByC[c].length, 0);
  const scoredByC = Object.fromEntries(CONSUMERS.map((c) => [c, 0]));
  const t0 = Date.now();
  const heartbeat = () => {
    const total = Object.values(scoredByC).reduce((a, b) => a + b, 0);
    writeFileSync(STATUS, JSON.stringify({
      stage: 'coverage-deficit', pid: process.pid, started_at, updated_at: nowIso(),
      per_consumer: Object.fromEntries(CONSUMERS.map((c) => [c, { scored: scoredByC[c], total: subjectsByC[c].length }])),
      total_scored: total, total_target: totalTarget, pct: totalTarget ? Math.round((total / totalTarget) * 100) : 100,
      eta_seconds: total ? Math.round(((totalTarget - total) * ((Date.now() - t0) / total)) / 1000) : null,
      fallback_fired: 0, done: false,
    }, null, 2));
  };
  for (const consumer of CONSUMERS) {
    const subjects = subjectsByC[consumer];
    const deficits = [];
    for (const s of subjects) {
      try {
        const r = await retrieve(s, { topK: 1 });
        const sim = r?.hits?.[0]?.similarity;
        deficits.push(typeof sim === 'number' ? 1 - sim : 1);   // no hit ⇒ deficit 1 (maximally thin)
      } catch { deficits.push(1); }
      scoredByC[consumer]++; heartbeat();
    }
    const hist = deficitHistogram(deficits);
    result[consumer] = { n_subjects: subjects.length, ...hist };
    console.error(`[deficit] ${consumer}: n=${hist.n} median=${hist.median?.toFixed(3)} p90=${hist.p90?.toFixed(3)} mean=${hist.mean?.toFixed(3)}`);
    console.error(`          hist ${hist.bins.map((b) => b.count).join(',')} (deciles 0→1)`);
  }
  writeFileSync('.corpus-eval/coverage-deficit.json', JSON.stringify(result, null, 2));
  writeFileSync(STATUS, JSON.stringify({
    stage: 'coverage-deficit', pid: process.pid, started_at, updated_at: nowIso(),
    per_consumer: Object.fromEntries(CONSUMERS.map((c) => [c, { scored: scoredByC[c], total: subjectsByC[c].length }])),
    total_scored: totalTarget, total_target: totalTarget, pct: 100, eta_seconds: 0, fallback_fired: 0, done: true,
  }, null, 2));
  console.error('[deficit] wrote .corpus-eval/coverage-deficit.json');
  process.exit(0);
}
main().catch((e) => { console.error('coverage-deficit failed:', e); process.exit(1); });
