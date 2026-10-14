// scripts/ipd-s4-theme-rescore.mjs — S4.1: SEMANTIC re-score of the theme-agreement metric
// over SAVED data (the K=5 raw runs in ipd-audit-s4-k5-v2.json vs ipd-audit-gold/1.1 themes).
// NO new audits, no engine call, no gold mutation — this fixes the METRIC: the token-containment
// matcher scored paraphrases as misses (e.g. G-16 "6-day stay + prolonged IV antibiotics" ≡
// "Length of Stay and Duration of IV Antibiotics" was scored 'missed' in all 5 runs).
//
//   Primary matcher  — LLM judge (Gemini utility model, Ollama fallback): per case, one call
//                      mapping each distinct run finding → the gold theme it expresses (or none).
//                      "Same clinical concern" is the criterion; verdict flavour ignored.
//   Cross-check      — embedding cosine (EMBED_MODEL via lib/llm.embedQuery, threshold 0.70,
//                      stated not tuned); pairwise disagreement with the judge is REPORTED.
//   Extras (Task 2)  — run findings matching NO gold theme, per case, deduped: the candidate
//                      valid-extra findings for a future union-gold. NOT adjudicated here (V's).
//
// Cache: judge + embedding results cached by content hash next to the pack, so re-runs are free.
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/ipd-s4-theme-rescore.mjs [--pack ipd-audit-s4-k5-v2.json] [--out ipd-audit-s4-theme-rescore]
// Numbers are REPORTED, never self-certified — V reads the true theme number.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { embedQuery } from '../lib/llm.ts';
import { loadIpdAuditGold } from '../lib/ipd-audit/gold.ts';
// The judge matcher now lives in ONE place (lib/ipd-audit/theme-match) so the consensus-gold
// harness reuses the exact S4.1 matcher, not a copy. keyOf + JUDGE_SYSTEM + judgeMap are the
// verbatim originals; this script's behaviour and its cache file are unchanged (proven byte-
// identical by re-running with the existing cache).
import { keyOf, judgeMap as semanticJudgeMap } from './lib/theme-match.mjs';
import GOLD from '../data/ipd-audit-gold.json' with { type: 'json' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const PACK = argOf('--pack') ?? 'ipd-audit-s4-k5-v2.json';
const OUT = argOf('--out') ?? 'ipd-audit-s4-theme-rescore';
const EMB_THRESHOLD = 0.70;

const gold = loadIpdAuditGold(GOLD);
const pack = JSON.parse(readFileSync(PACK, 'utf8'));
if (!pack.perCase?.[0]?.raw_runs) { console.error(`${PACK} has no raw_runs — need the v2 pack`); process.exit(2); }

const CACHE_PATH = `${OUT}.cache.json`;
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : { judge: {}, emb: {} };
const saveCache = () => writeFileSync(CACHE_PATH, JSON.stringify(cache));

// judgeCase = the shared judgeMap bound to THIS script's cache (goldThemes as the reference set).
const judgeCase = (goldThemes, runSubjects) => semanticJudgeMap(goldThemes, runSubjects, cache, saveCache);

async function embed(text) {
  const key = keyOf(text);
  if (!cache.emb[key]) { cache.emb[key] = await embedQuery(text); saveCache(); }
  return cache.emb[key];
}
const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const lvc = (findings) => (findings ?? []).filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent').map((f) => f.subject);
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

const perCase = [];
let judgeEmbAgree = 0, judgeEmbTotal = 0;

for (const pc of pack.perCase) {
  const gc = gold.cases.find((c) => c.id === pc.id);
  const goldThemes = lvc(gc.findings);
  const distinctSubjects = [...new Set(pc.raw_runs.flatMap((r) => r.lvcSubjects))];

  // judge once over the distinct subject set; apply per run
  const judgeMap = distinctSubjects.length && goldThemes.length ? await judgeCase(goldThemes, distinctSubjects) : {};

  // embedding cross-check on every (gold, subject) pair
  const embMatch = {};   // subject → matched gold idx (best cosine ≥ threshold) | null
  for (const s of distinctSubjects) {
    let best = -1, bestSim = 0;
    for (let gi = 0; gi < goldThemes.length; gi++) {
      const sim = cos(await embed(s), await embed(goldThemes[gi]));
      if (sim > bestSim) { bestSim = sim; best = gi; }
    }
    embMatch[s] = bestSim >= EMB_THRESHOLD ? best : null;
    // disagreement accounting (matched-vs-not, per subject)
    const j = distinctSubjects.length && goldThemes.length ? judgeMap[s] : null;
    judgeEmbTotal++;
    if ((j !== null) === (embMatch[s] !== null)) judgeEmbAgree++;
  }

  // per-run semantic recall/precision using the JUDGE (primary)
  const runScores = pc.raw_runs.map((r) => {
    const subs = r.lvcSubjects;
    const matchedGold = new Set(subs.map((s) => judgeMap[s]).filter((x) => x !== null && x !== undefined));
    return {
      recall: goldThemes.length ? matchedGold.size / goldThemes.length : 1,
      precision: subs.length ? subs.filter((s) => judgeMap[s] !== null && judgeMap[s] !== undefined).length / subs.length : 1,
    };
  });
  const matchedEver = new Set(distinctSubjects.map((s) => judgeMap[s]).filter((x) => x !== null && x !== undefined));
  const neverMatched = goldThemes.filter((_, gi) => !matchedEver.has(gi));
  const extras = distinctSubjects.filter((s) => judgeMap[s] === null || judgeMap[s] === undefined);

  perCase.push({
    id: pc.id, ip_uid: pc.ip_uid,
    gold_themes: goldThemes,
    token_recall: pc.theme_recall, token_precision: pc.theme_precision,
    sem_recall: +mean(runScores.map((s) => s.recall)).toFixed(2),
    sem_precision: +mean(runScores.map((s) => s.precision)).toFixed(2),
    real_misses: neverMatched,          // gold themes no run finding expressed, per the judge
    extras,                              // candidate valid-extras for the union-gold (V adjudicates)
  });
  console.log(`[rescore] ${pc.id} token ${pc.theme_recall}/${pc.theme_precision} → semantic ${perCase.at(-1).sem_recall}/${perCase.at(-1).sem_precision} · real misses ${neverMatched.length} · extras ${extras.length}`);
}

const summary = {
  version: 'ipd-audit-s4-theme-rescore/1',
  pack: PACK, gold_version: gold.version,
  token_baseline: { recall: +mean(perCase.map((c) => c.token_recall)).toFixed(2), precision: +mean(perCase.map((c) => c.token_precision)).toFixed(2) },
  semantic: { recall: +mean(perCase.map((c) => c.sem_recall)).toFixed(2), precision: +mean(perCase.map((c) => c.sem_precision)).toFixed(2) },
  cases_with_real_misses: perCase.filter((c) => c.real_misses.length).length,
  total_extras: perCase.reduce((s, c) => s + c.extras.length, 0),
  judge_vs_embedding_agreement_pct: +(100 * judgeEmbAgree / (judgeEmbTotal || 1)).toFixed(1),
  emb_threshold: EMB_THRESHOLD,
};

console.log(`\n== S4.1 SEMANTIC THEME RE-SCORE ==`);
console.log(`token baseline r/p: ${summary.token_baseline.recall}/${summary.token_baseline.precision} → SEMANTIC r/p: ${summary.semantic.recall}/${summary.semantic.precision}`);
console.log(`cases with REAL misses (judge-confirmed): ${summary.cases_with_real_misses}/25 · union extras: ${summary.total_extras}`);
console.log(`judge vs embedding (matched-or-not) agreement: ${summary.judge_vs_embedding_agreement_pct}% at cos≥${EMB_THRESHOLD}`);

const md = [
  `# IPD audit S4.1 — semantic theme re-score (metric fix; saved data only)`, '',
  `> The token-containment matcher scored paraphrases as misses. This re-score judges CLINICAL-CONCEPT equivalence (LLM judge primary; embedding cosine cross-check at ${EMB_THRESHOLD}). No engine re-run; gold untouched. Numbers reported, not certified.`, '',
  `| Metric | Token baseline | Semantic |`, `|---|---|---|`,
  `| Theme recall | ${summary.token_baseline.recall} | **${summary.semantic.recall}** |`,
  `| Theme precision | ${summary.token_baseline.precision} | **${summary.semantic.precision}** |`, '',
  `Judge↔embedding agreement (matched-or-not, per finding): **${summary.judge_vs_embedding_agreement_pct}%**.`, '',
  `## Per case`, '',
  `| Case | Token R/P | Semantic R/P | Real misses (judge-confirmed) | Extras (candidate union findings) |`, `|---|---|---|---|---|`,
  ...perCase.map((c) => `| ${c.id} | ${c.token_recall}/${c.token_precision} | **${c.sem_recall}/${c.sem_precision}** | ${c.real_misses.length ? c.real_misses.join(' · ') : '—'} | ${c.extras.length} |`),
  '',
  `## Union extras per case (deduped; V adjudicates — NOT judged valid here)`, '',
  ...perCase.filter((c) => c.extras.length).map((c) => `- **${c.id}** (${c.ip_uid}): ${c.extras.join(' · ')}`),
].join('\n');

writeFileSync(`${OUT}.md`, md + '\n');
writeFileSync(`${OUT}.json`, JSON.stringify({ summary, perCase }, null, 2));
console.log(`wrote ${OUT}.md + ${OUT}.json`);
process.exit(0);
