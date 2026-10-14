#!/usr/bin/env node
// DDx P0 benchmark harness (Phase 0a). Runs data/ddx-case-bank.json through the LIVE
// /api/ddx endpoint, consumes the NDJSON stream, scores the FINAL parsed differential
// with lib/ddx-eval-core.ts, prints the bank summary, writes a results JSON.
//
// Run via the package script (registers tsx so the .ts scorer imports cleanly):
//   BASE_URL=https://even-cdmss.vercel.app ADMIN_TOKEN=<token> npm run ddx:bench
// Optional:
//   CDMSS_URL=…            (legacy alias for BASE_URL)
//   ONLY=D01,D03           (run a subset)
//   DDX_CONCURRENCY=2      (parallel cases; default 2 — the engine is a 90s–3min pipeline)
//
// The token is read from the shell env only — never written to disk or the results file.
// MEASUREMENT ONLY: this script must never import from app/api/ddx or lib/ddx-*.ts
// engine code — lib/ddx-eval-core.ts is the one allowed import (the referee).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scoreDdxCase, summarizeDdx, freezeGuard, FROZEN_MATCHER, FROZEN_BANK } from '../lib/ddx-eval-core.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const BANK = resolve(REPO, 'data/ddx-case-bank.json');

const BASE = process.env.BASE_URL || process.env.CDMSS_URL || 'https://even-cdmss.vercel.app';
const TOKEN = process.env.ADMIN_TOKEN || '';
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, parseInt(process.env.DDX_CONCURRENCY || '2', 10) || 1);
const CASE_TIMEOUT_MS = 330_000; // engine maxDuration is 300s; give the stream a margin

/** POST one case's presentation and reduce the NDJSON stream to its FINAL result.
 *  Intermediate lines (progress/sources/critique/heartbeat) are consumed and ignored;
 *  only the last {type:'result'} wins, and a terminal {type:'error'} throws. */
async function runCase(presentation) {
  const body = {
    age: presentation.age,
    sex: presentation.sex,
    cc: presentation.complaint,
    history: presentation.history,
    exam: presentation.exam,
    vitals: presentation.vitals,
    investigations: presentation.investigations,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CASE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const resp = await fetch(`${BASE}/api/ddx`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    let result = null;
    let streamError = null;
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; } // tolerate partial/garbled lines
        if (ev.type === 'result') result = ev.data;
        else if (ev.type === 'error') streamError = ev.message || 'stream error';
      }
    }
    if (!result) throw new Error(streamError || 'stream ended without a result line');
    return { result, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

/** Tiny concurrency pool — workers pull the next case until the queue drains. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;

const main = async () => {
  if (!TOKEN) console.warn('Warning: ADMIN_TOKEN not set — proceeding without a Bearer header.');
  const raw = JSON.parse(await readFile(BANK, 'utf8'));
  let cases = Array.isArray(raw) ? raw : raw.cases; // tolerate {cases:[…]} wrapping
  if (!Array.isArray(cases)) throw new Error(`${BANK} is not an array of cases`);
  const bankVersion = (Array.isArray(raw) ? undefined : raw.version || raw.meta?.id || raw.meta?.version) || 'unknown';
  if (ONLY.length) cases = cases.filter((c) => ONLY.includes(c.id));
  if (!cases.length) { console.error('No cases to run.'); process.exit(1); }

  console.log(`DDx P0 benchmark — ${cases.length} cases → ${BASE} (concurrency ${CONCURRENCY})\n`);

  const rows = await pool(cases, CONCURRENCY, async (c) => {
    let run;
    try { run = await runCase(c.presentation); }
    catch (e) {
      console.log(`${c.id.padEnd(4)} ERROR ${String(e.message)}`);
      return { id: c.id, category: c.category, error: String(e.message) };
    }
    const score = scoreDdxCase(c, run.result);
    const flags = [
      score.top1Hit ? 'top1✓' : 'top1✗',
      score.top3Hit ? 'top3✓' : 'top3✗',
      score.cannotMissCovered === null ? 'cm–' : score.cannotMissCovered ? 'cm✓' : 'cm✗',
      score.forbiddenPresent ? 'FORBIDDEN' : '',
      score.unsafeActionPresent ? 'UNSAFE' : '',
      score.fabricatedFindingSuspected ? 'fab?' : '',
    ].filter(Boolean).join(' ');
    console.log(`${c.id.padEnd(4)} ${score.top1Hit && score.cannotMissCovered !== false ? 'OK ' : 'XX '} ${flags}  (${(run.ms / 1000).toFixed(0)}s)`);
    return { id: c.id, category: c.category, score, ms: run.ms, result: run.result };
  });

  const scored = rows.filter((r) => r.score).map((r) => r.score);
  const errored = rows.filter((r) => r.error);
  const latenciesMs = rows.filter((r) => typeof r.ms === 'number').map((r) => r.ms);
  const summary = summarizeDdx(scored, { latenciesMs, bankVersion });

  const opt = (x, f = pct) => (x === null || x === undefined ? 'n/a (no labels)' : f(x));
  console.log(`\n── DdxBankSummary (${summary.n} scored, ${errored.length} errored) ──`);
  console.log(`matcher / bank      ${summary.matcherVersion} / ${summary.bankVersion}`);
  console.log(`top-1 accuracy      ${pct(summary.top1Accuracy)}`);
  console.log(`top-3 recall        ${pct(summary.top3Recall)}`);
  console.log(`cannot-miss recall  ${pct(summary.cannotMissRecall)}`);
  console.log(`forbidden-dx rate   ${pct(summary.forbiddenDxRate)}`);
  console.log(`unsafe-action rate  ${pct(summary.unsafeActionRate)}`);
  console.log(`fabricated (heur.)  ${pct(summary.fabricatedFindingRate)}`);
  console.log(`lane coverage       ${opt(summary.laneCoverageRate)}`);
  console.log(`negative-misuse     ${opt(summary.negativeMisuseRate)}`);
  console.log(`cannot-miss overflg ${opt(summary.cannotMissOverFlagRate)}`);
  console.log(`latency p50 / p90   ${opt(summary.latencyP50Ms, (x) => `${(x / 1000).toFixed(0)}s`)} / ${opt(summary.latencyP90Ms, (x) => `${(x / 1000).toFixed(0)}s`)}`);
  console.log(`harm-weighted error ${summary.harmWeightedError.toFixed(2)} per case`);

  const runid = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const OUT = resolve(REPO, `ddx-p0-results-${runid}.json`);
  await writeFile(OUT, JSON.stringify({
    meta: { date: new Date().toISOString(), base: BASE, n_requested: cases.length, concurrency: CONCURRENCY },
    summary, rows,
  }, null, 2));
  console.log(`\nWrote ${OUT}`);

  // Freeze guard (Phase 2a): DORMANT by default. Set DDX_EVAL_FROZEN=1 to enforce the pinned
  // pair (FROZEN_MATCHER='ddx-eval/2', FROZEN_BANK='ddx-case-bank/1.0'); a run whose matcher
  // or bank version drifts from it then exits 3 — the numbers are only comparable within one
  // frozen (matcher, bank) pair. Env DDX_FROZEN_MATCHER/DDX_FROZEN_BANK override the pins for
  // a future re-freeze without a code edit.
  const freeze = freezeGuard(summary, {
    frozen: process.env.DDX_EVAL_FROZEN === '1',
    matcher: process.env.DDX_FROZEN_MATCHER || FROZEN_MATCHER,
    bank: process.env.DDX_FROZEN_BANK || FROZEN_BANK,
  });
  if (!freeze.ok) { console.error(`\n${freeze.message}`); process.exit(3); }

  // Hard gate (Phase 2a F5): the 60-case v1.0 bank IS the cannot-miss regression corpus.
  // DORMANT by default; arm with DDX_BENCH_HARD_GATE=1. The floor is cannotMissRecall ≥ 0.90
  // — the frozen baseline (0.92 case-level) minus a ~1-case/≈50 (≈0.02) temperature-0.2
  // run-to-run noise margin — and defaults to 0.90 when DDX_BASELINE_CANNOT_MISS is unset.
  // (CI live-bench arming stays deferred pending V's CI-provider + deployment-URL confirm.)
  if (process.env.DDX_BENCH_HARD_GATE === '1') {
    const floor = parseFloat(process.env.DDX_BASELINE_CANNOT_MISS || '0.90');
    if (Number.isFinite(floor) && summary.cannotMissRecall < floor) {
      console.error(`\nHARD GATE: cannot-miss recall ${pct(summary.cannotMissRecall)} < floor ${pct(floor)}`);
      process.exit(2);
    }
  }
  if (errored.length === rows.length) process.exit(1); // nothing scored at all → real failure even in report-only mode
};

main().catch((e) => { console.error(e); process.exit(1); });
