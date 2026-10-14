#!/usr/bin/env node
/**
 * scripts/corpus-eval/askddx-freshrun.mjs — Brainstem PR 0: the Ask/DDx fresh-run harness (PRD §5.1).
 *
 * Ask/DDx persist NO served sources (PRD §4), so their verifier inputs are produced by re-running the
 * SHIPPED pipelines (no engine/prompt change) and capturing (claim, cited-source) fresh. This harness
 * HTTP-POSTs each seed query to the LIVE /api/ask + /api/ddx routes (a running dev server), reads the
 * SSE stream, collects the numbered `sources`, concatenates the streamed `token` answer, and extracts
 * every answer sentence carrying an inline [n] as a (claim, cited-sources) unit for the SAME verifier.
 * Coverage-deficit for Ask/DDx rides the same run's retrieval (the sources' similarities).
 *
 * MEASUREMENT BASIS (flagged, PRD §7): this measures Ask/DDx's CURRENT pipeline, not as-served — not
 * head-to-head comparable with the three as-served surfaces.
 *
 * QUERY SET (PRD §5.1): a CURATED, de-identified clinical seed (no PHI by construction). Real-query
 * extraction with clean PHI-stripping is a recommended follow-on, not this pass — reported as used.
 *
 * Requires a dev server: `npm run dev` (with GEMINI_ALL=1 for the Pro pipeline). Then:
 * `node --env-file=.env.local --import tsx scripts/corpus-eval/askddx-freshrun.mjs [--base=http://localhost:3000] [--n=12]`
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deficitHistogram } from '../../lib/corpus-eval/verify-core.ts';

const BASE = (process.argv.find((a) => a.startsWith('--base='))?.split('=')[1]) || 'http://localhost:3000';
const N = Math.max(1, parseInt((process.argv.find((a) => a.startsWith('--n='))?.split('=')[1]) || '12', 10));
const PACK = '.corpus-eval/pack.json';

// Curated, de-identified clinical seed (generic questions — no patient identifiers by construction).
const SEED = [
  'When is imaging indicated for acute low back pain in an adult with no red flags?',
  'First-line antibiotic for uncomplicated community-acquired pneumonia in a healthy outpatient?',
  'Does adding aspirin to anticoagulation reduce stroke risk in non-valvular atrial fibrillation?',
  'Indications for statin therapy in primary prevention of cardiovascular disease?',
  'Duration of dual antiplatelet therapy after drug-eluting stent placement?',
  'When is PPI therapy indicated for stress ulcer prophylaxis in a ward patient?',
  'Empirical antibiotic choice for acute uncomplicated cystitis in a non-pregnant woman?',
  'Is routine thyroid function testing indicated in new-onset atrial fibrillation?',
  'Target HbA1c for an older adult with type 2 diabetes and multiple comorbidities?',
  'When should prophylactic anticoagulation be started for a medical inpatient?',
  'Is a chest X-ray required before an elective day-care surgical procedure in a healthy adult?',
  'Indications for CT head in minor head injury per validated decision rules?',
  'First-line management of newly diagnosed mild hypertension without target-organ damage?',
  'When is proton-pump inhibitor deprescribing appropriate after long-term use?',
];

async function sseRun(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`${path} → ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', answer = '', sources = [], result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop() || '';
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'sources') sources = ev.items || [];
      else if (ev.type === 'token') answer += ev.content || '';
      else if (ev.type === 'result') result = ev;
    }
  }
  return { answer, sources, result };
}

/** Extract (claim, cited-source-ns) units: answer sentences carrying an inline [n]. */
function claimsFromAnswer(answer, sources) {
  const bySrcN = new Map(sources.map((s) => [Number(s.n), s]));
  const units = [];
  for (const sent of String(answer).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
    const ns = [...sent.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (!ns.length) { units.push({ claim: sent.trim(), cited: false, citation_ids: [], excerpts: [] }); continue; }
    const excerpts = [...new Set(ns)].map((n) => bySrcN.get(n)).filter(Boolean).map((s) => ({
      n: s.n, chunk_id: String(s.id ?? ''), resolved: 'preview',
      text: String(s.preview ?? '').replace(/\s+/g, ' ').trim(),   // Ask/DDx sources carry preview only (not persisted; no chunk-text join here)
      meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null },
    }));
    units.push({ claim: sent.replace(/\[\d+\]/g, '').trim(), cited: excerpts.length > 0, citation_ids: [...new Set(ns)], excerpts });
  }
  return units.filter((u) => u.claim.length > 12);
}

async function main() {
  const queries = SEED.slice(0, N);
  const packUnits = [];
  const deficits = { ask: [], ddx: [] };
  let ok = 0;
  for (const [i, q] of queries.entries()) {
    for (const consumer of ['ask', 'ddx']) {
      try {
        const path = consumer === 'ask' ? '/api/ask' : '/api/ddx';
        const { answer, sources } = await sseRun(path, { question: q });
        for (const s of sources) if (typeof s.similarity === 'number') deficits[consumer].push(1 - s.similarity);
        const units = claimsFromAnswer(answer, sources);
        for (const u of units) packUnits.push({ consumer, audit_ref: `freshrun-${consumer}-${i}`, finding_ref: q.slice(0, 60), ...u });
        ok++;
        console.error(`  [${consumer}] q${i + 1}: ${sources.length} sources · ${units.filter((u) => u.cited).length} cited claims`);
      } catch (e) { console.error(`  [${consumer}] q${i + 1} FAILED: ${String(e.message).slice(0, 80)}`); }
    }
  }
  // merge fresh-run units into the pack; write coverage-deficit for ask/ddx
  const pack = existsSync(PACK) ? JSON.parse(readFileSync(PACK, 'utf8')) : { version: 'corpus-eval/1.0', units: [] };
  pack.units = pack.units.filter((u) => u.consumer !== 'ask' && u.consumer !== 'ddx').concat(packUnits);
  pack.freshrun = { base: BASE, n_queries: queries.length, query_set: 'curated de-identified clinical seed', runs_ok: ok, basis: 'current-pipeline (NOT as-served)' };
  writeFileSync(PACK, JSON.stringify(pack, null, 2));
  const cov = existsSync('.corpus-eval/coverage-deficit.json') ? JSON.parse(readFileSync('.corpus-eval/coverage-deficit.json', 'utf8')) : {};
  for (const c of ['ask', 'ddx']) cov[c] = { n_subjects: deficits[c].length, ...deficitHistogram(deficits[c]) };
  writeFileSync('.corpus-eval/coverage-deficit.json', JSON.stringify(cov, null, 2));
  console.error(`\n[freshrun] merged ${packUnits.length} ask/ddx claim units into the pack (${packUnits.filter((u) => u.cited).length} cited).`);
  process.exit(0);
}
main().catch((e) => { console.error('askddx-freshrun failed:', e); process.exit(1); });
