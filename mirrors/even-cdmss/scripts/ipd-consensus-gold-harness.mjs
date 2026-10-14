// scripts/ipd-consensus-gold-harness.mjs — Consensus gold (#7) SL1: the union-assembly harness.
//
// Turns the thin single-shot IPD gold (1.1) into a per-case ADJUDICATION QUEUE: for each of the 25
// gold cases, union the 1.1 gold themes with everything the engine surfaced across K=5, deduped by
// the VERBATIM S4.1 matcher (lib/ipd-audit/theme-match) so V never sees the same clinical concern
// twice in different words. Each queue item carries provenance — was it in the 1.1 gold, and how
// many of the 5 runs surfaced it — so V adjudicates in context. V's verdicts (SL2 UI) build 2.0.
//
// THIS IS ASSEMBLY ONLY. No engine call, no frozen core, no gold mutation, nothing frozen here
// (2.0 is SL3, after V adjudicates). Pure over two existing artifacts:
//   - ipd-audit-s4-theme-rescore.json : per case → gold_themes, extras (non-gold, judge-deduped)
//   - ipd-audit-s4-k5-v2.json         : per case → the 5 raw runs (for the K=5 provenance counts)
//
// DEDUP MODEL (faithful to how S4.1 already drew its lines):
//   - GOLD side: each 1.1 gold theme is one candidate. Its K=5 support = how many runs surfaced a
//     finding the S4.1 judge mapped ONTO it (recomputed as a CACHE HIT — byte-identical to S4.1).
//   - EXTRA side: the non-gold extras are folded among THEMSELVES with the same judge (each extra
//     joins an existing cluster rep or starts a new one). One candidate per cluster.
//
// The S4.1 cache is loaded so the gold-mapping recompute is a hit; NEW extra-clustering calls are
// saved to a SEPARATE cache file, so the committed ipd-audit-s4-theme-rescore.cache.json is never
// written. De-identified: finding titles + case link-back keys only — asserted URL-free / PHI-free.
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/ipd-consensus-gold-harness.mjs            # dry run → JSON
//   node --env-file=.env.local --import tsx scripts/ipd-consensus-gold-harness.mjs --apply     # + seed the DB queue
//
// scoring:false · assembly + seed only; nothing persisted to ipd_discharge_audits, no 2.0 freeze.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { judgeMap as semanticJudgeMap } from './lib/theme-match.mjs';
import { loadIpdAuditGold } from '../lib/ipd-audit/gold.ts';
import { sql } from '../lib/db.ts';
import GOLD from '../data/ipd-audit-gold.json' with { type: 'json' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const RESCORE = argOf('--rescore') ?? 'ipd-audit-s4-theme-rescore.json';
const K5 = argOf('--k5') ?? 'ipd-audit-s4-k5-v2.json';
const OUT = argOf('--out') ?? 'consensus-gold-queue.json';
const APP = process.env.APP_SOURCE || 'standalone';
const log = (...a) => console.error(...a);

// Cache: SEED from the S4.1 judge cache (so the gold-mapping recompute hits, not re-judges), but
// SAVE to our own file — the committed S4.1 cache is never written.
const S4_CACHE = 'ipd-audit-s4-theme-rescore.cache.json';
const HARNESS_CACHE = 'consensus-gold-harness.cache.json';
const seed = existsSync(HARNESS_CACHE) ? HARNESS_CACHE : (existsSync(S4_CACHE) ? S4_CACHE : null);
const cache = seed ? JSON.parse(readFileSync(seed, 'utf8')) : { judge: {}, emb: {} };
if (!cache.judge) cache.judge = {};
const saveCache = () => writeFileSync(HARNESS_CACHE, JSON.stringify(cache));
const judge = (reference, candidates) => semanticJudgeMap(reference, candidates, cache, saveCache);

// VERBATIM S4.1 constructions (must match so the gold-mapping key is a cache hit).
const lvc = (findings) => (findings ?? []).filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent').map((f) => f.subject);

// De-identify gate: finding titles are clinical theme names; assert no URL and nothing name/UHID-
// shaped ever reaches the queue (the 2.0 gold lands in a public repo — the URL-redaction lesson).
const URL_RE = /https?:\/\/|gs:\/\/|www\./i;
const PHI_RE = /\buhid\b|\bmrn\b|\bpatient name\b|\+?\d[\d\s-]{7,}\d/i;   // phone/id-shaped or explicit
function assertClean(text, where) {
  if (URL_RE.test(text)) throw new Error(`URL in ${where}: ${text.slice(0, 80)}`);
  if (PHI_RE.test(text)) throw new Error(`PHI-shaped token in ${where}: ${text.slice(0, 80)}`);
}

const rescore = JSON.parse(readFileSync(RESCORE, 'utf8'));
const k5 = JSON.parse(readFileSync(K5, 'utf8'));
const gold = loadIpdAuditGold(GOLD);                 // hash-pinned — a drifted gold refuses to load
const k5by = Object.fromEntries(k5.perCase.map((c) => [c.id, c]));
const goldById = Object.fromEntries(gold.cases.map((c) => [c.id, c]));

log(`[harness] gold ${gold.version} · ${rescore.perCase.length} cases · rescore ${RESCORE} · k5 ${K5}`);
log(`[harness] ${APPLY ? 'APPLY (will seed ipd_gold_union_candidates)' : 'DRY RUN (JSON only)'}\n`);

// # of the 5 runs that surfaced ANY of `subjects` (exact-title membership, as S4.1 counted).
const runsSurfacing = (kc, subjects) => {
  const set = new Set(subjects);
  return kc.raw_runs.filter((r) => r.lvcSubjects.some((s) => set.has(s))).length;
};

const queueByCase = [];
let total = 0;

for (const pc of rescore.perCase) {
  const kc = k5by[pc.id];
  const gc = goldById[pc.id];
  if (!kc || !gc) throw new Error(`case ${pc.id} missing from k5/gold`);
  const goldThemes = pc.gold_themes;                 // == lvc(gc.findings) — cross-checked below
  const check = lvc(gc.findings);
  if (JSON.stringify(check) !== JSON.stringify(goldThemes)) throw new Error(`${pc.id}: rescore gold_themes drift vs gold`);

  const distinctSubjects = [...new Set(kc.raw_runs.flatMap((r) => r.lvcSubjects))];
  // gold-mapping: subject → gold idx | null. SAME inputs as S4.1 ⇒ cache HIT (no re-judge).
  const gmap = distinctSubjects.length && goldThemes.length ? await judge(goldThemes, distinctSubjects) : {};

  const items = [];
  // ── gold-side candidates: one per 1.1 gold theme, with its K=5 support ──
  goldThemes.forEach((theme, gi) => {
    assertClean(theme, `${pc.id} gold theme`);
    const matched = distinctSubjects.filter((s) => gmap[s] === gi);
    const k5count = runsSurfacing(kc, matched);
    items.push({
      finding_text: theme, in_gold: true, k5_count: k5count,
      cluster_size: 1 + matched.length, cluster_members: [theme, ...matched],
    });
  });

  // ── extra-side candidates: fold the non-gold extras among themselves ──
  const extras = pc.extras;                           // subjects the S4.1 judge mapped to null
  const reps = [];                                    // representative text per cluster
  const clusters = [];                                // parallel: { rep, members[] }
  for (const e of extras) {
    assertClean(e, `${pc.id} extra`);
    let placed = false;
    if (reps.length) {
      const m = await judge(reps, [e]);               // does e match an existing cluster rep?
      const idx = m[e];
      if (idx !== null && idx !== undefined) { clusters[idx].members.push(e); placed = true; }
    }
    if (!placed) { reps.push(e); clusters.push({ rep: e, members: [e] }); }
  }
  for (const cl of clusters) {
    // representative = the cluster member surfaced by the most runs (stable tie → first seen)
    const best = cl.members.map((m) => ({ m, n: runsSurfacing(kc, [m]) })).sort((a, b) => b.n - a.n)[0];
    items.push({
      finding_text: best.m, in_gold: false, k5_count: runsSurfacing(kc, cl.members),
      cluster_size: cl.members.length, cluster_members: cl.members,
    });
  }

  // stable ids + display order: gold themes first (gold order), then extra clusters (first-seen)
  const caseItems = items.map((it, i) => ({
    id: `${pc.id}::c${String(i).padStart(2, '0')}`,
    case_id: pc.id, ip_uid: pc.ip_uid, gold_version: gold.version, ord: i, ...it,
  }));
  total += caseItems.length;
  queueByCase.push({ id: pc.id, ip_uid: pc.ip_uid, n: caseItems.length, items: caseItems });
  const nGold = caseItems.filter((c) => c.in_gold).length;
  const nExtra = caseItems.length - nGold;
  const folded = pc.extras.length - nExtra;
  log(`[harness] ${pc.id}  ${caseItems.length} items  (${nGold} gold + ${nExtra} extra clusters; folded ${folded} near-dups)`);
}

const artifact = {
  version: 'ipd-consensus-gold-queue/1',
  built_from: { rescore: RESCORE, k5: K5, gold_version: gold.version },
  gold_pin: gold.version,
  total_candidates: total,
  cases: queueByCase.length,
  perCase: queueByCase,
};
writeFileSync(OUT, JSON.stringify(artifact, null, 2));
log(`\n[harness] ${total} union candidates across ${queueByCase.length} cases → ${OUT}`);

if (APPLY) {
  // Idempotent upsert on the stable id. Re-running rebuilds the queue in place; V's verdicts live
  // in a SEPARATE table (ipd_gold_adjudication) and are never touched here.
  const flat = queueByCase.flatMap((c) => c.items);
  let written = 0;
  for (const it of flat) {
    await sql(
      `INSERT INTO ipd_gold_union_candidates
         (id, app_source, gold_version, case_id, ip_uid, finding_text, in_gold, k5_count, cluster_size, cluster_members, ord)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         finding_text = EXCLUDED.finding_text, in_gold = EXCLUDED.in_gold, k5_count = EXCLUDED.k5_count,
         cluster_size = EXCLUDED.cluster_size, cluster_members = EXCLUDED.cluster_members, ord = EXCLUDED.ord`,
      [it.id, APP, it.gold_version, it.case_id, it.ip_uid, it.finding_text, it.in_gold, it.k5_count,
       it.cluster_size, JSON.stringify(it.cluster_members), it.ord],
    );
    written++;
  }
  log(`[harness] seeded ${written} candidates into ipd_gold_union_candidates (idempotent upsert)`);
}
process.exit(0);
