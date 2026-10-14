#!/usr/bin/env node
// Concordance P0 harness. Runs the 26-case bank through the LIVE clean single-shot
// endpoint (Mac-mini, ₹0), scores it, writes a results JSON for review.
//
// Usage (from anywhere):
//   ADMIN_TOKEN=<your admin token> node scripts/concordance-p0-run.mjs
// Optional:
//   CDMSS_URL=https://even-cdmss.vercel.app   (default)
//   ONLY=A1,B1                                (run a subset)
//
// The token is read from your shell env — it is never written to disk or the results file.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const BANK = resolve(REPO, 'data/concordance-case-bank.json');
const OUT = resolve(REPO, '../../CONCORDANCE-P0-RESULTS-4-JUL-2026.json'); // → Daily Dash EHRC folder

const BASE = process.env.CDMSS_URL || 'https://even-cdmss.vercel.app';
const TOKEN = process.env.ADMIN_TOKEN || '';
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

const VERDICTS = ['concordant', 'discordant-likely-error', 'discordant-likely-real', 'indeterminate'];
const branchForVerdict = (v) => v === 'discordant-likely-error' ? 'A' : v === 'discordant-likely-real' ? 'B' : 'none';
const anyKw = (hay, keys) => { const h = (hay || '').toLowerCase(); return keys.some((k) => h.includes(k.toLowerCase())); };

async function post(result, context) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 290_000);
  try {
    const r = await fetch(`${BASE}/api/concordance/single-shot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ result, context }),
      signal: ac.signal,
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(timer); }
}

const main = async () => {
  if (!TOKEN) { console.error('Set ADMIN_TOKEN in your env (Bearer token for the admin gate).'); process.exit(1); }
  const bank = JSON.parse(await readFile(BANK, 'utf8'));
  let cases = bank.cases;
  if (ONLY.length) cases = cases.filter((c) => ONLY.includes(c.id));

  console.log(`Concordance P0 — ${cases.length} cases → ${BASE} (mini, ₹0)\n`);
  const results = [];
  let vMatch = 0, gapHit = 0, cmOk = 0, cmTot = 0, overFlag = 0, ctrl = 0, committed = 0;

  for (const c of cases) {
    process.stdout.write(`${c.id.padEnd(3)} … `);
    let out; try { out = await post(c.result, c.context); }
    catch (e) { console.log(`ERROR ${e.message}`); results.push({ id: c.id, error: String(e.message) }); continue; }
    const p = out.parsed || {};
    const branch = p.verdict ? branchForVerdict(p.verdict) : 'none';
    const verdictMatch = p.verdict === c.expectedVerdict;
    const branchMatch = branch === c.expectedBranch;
    const gapHay = `${p.decisiveGap}\n${p.voiText}\n${p.nextStep}`;
    const decisiveGapHit = anyKw(gapHay, c.decisiveGapKeywords || []);
    const cannotMissCovered = (c.cannotMissKeywords && c.cannotMissKeywords.length) ? anyKw(p.branchBText, c.cannotMissKeywords) : null;
    const overFlagged = c.category === 'control' && (p.verdict === 'discordant-likely-error' || p.verdict === 'discordant-likely-real');

    if (verdictMatch) vMatch++;
    if (decisiveGapHit) gapHit++;
    if (cannotMissCovered !== null) { cmTot++; if (cannotMissCovered) cmOk++; }
    if (c.category === 'control') { ctrl++; if (overFlagged) overFlag++; }
    if (!p.multipleVerdicts && p.verdict) committed++;

    results.push({
      id: c.id, category: c.category, expectedVerdict: c.expectedVerdict, gotVerdict: p.verdict,
      multipleVerdicts: !!p.multipleVerdicts, expectedBranch: c.expectedBranch, gotBranch: branch,
      verdictMatch, branchMatch, decisiveGapHit, cannotMissCovered, overFlagged,
      ms: out.ms, parsed: p, raw: out.raw,
    });
    console.log(`${verdictMatch ? 'OK ' : 'XX '} got=${p.verdict}${p.multipleVerdicts ? '(+multi)' : ''} exp=${c.expectedVerdict}${overFlagged ? '  <-- OVER-FLAG' : ''}${decisiveGapHit ? '  gap✓' : ''}`);
  }

  const n = results.filter((r) => !r.error).length || 1;
  const summary = {
    n: results.length,
    verdictAccuracy: +(vMatch / n).toFixed(3),
    decisiveGapHitRate: +(gapHit / n).toFixed(3),
    cannotMissCoverage: cmTot ? +(cmOk / cmTot).toFixed(3) : null,
    controlOverFlagRate: ctrl ? +(overFlag / ctrl).toFixed(3) : null,
    committedRate: +(committed / n).toFixed(3),
  };
  await writeFile(OUT, JSON.stringify({ meta: { date: new Date().toISOString(), base: BASE, engine: 'mini/qwen2.5:14b' }, summary, results }, null, 2));
  console.log(`\n── Summary ──`);
  console.log(`verdict accuracy   ${(summary.verdictAccuracy * 100).toFixed(0)}%  (${vMatch}/${n})`);
  console.log(`decisive-gap hit   ${(summary.decisiveGapHitRate * 100).toFixed(0)}%`);
  console.log(`cannot-miss cover  ${summary.cannotMissCoverage != null ? (summary.cannotMissCoverage * 100).toFixed(0) + '%' : 'n/a'}  (${cmOk}/${cmTot})`);
  console.log(`control over-flag  ${summary.controlOverFlagRate != null ? (summary.controlOverFlagRate * 100).toFixed(0) + '%' : 'n/a'}  (${overFlag}/${ctrl})`);
  console.log(`committed 1 verdict ${(summary.committedRate * 100).toFixed(0)}%`);
  console.log(`\nWrote ${OUT}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
