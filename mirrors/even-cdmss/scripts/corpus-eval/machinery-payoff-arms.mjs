// scripts/corpus-eval/machinery-payoff-arms.mjs — Machinery-Payoff Retrieval Ablation (Option 1).
// MEASUREMENT ONLY. Re-runs the 25 frozen gold cases (ipd-audit-gold/2.0) under THREE retrieval
// configurations, holding the model, prompts, temperature and everything else constant, then scores
// each arm's findings against the gold with the SHIPPED S4.1 semantic matcher (run separately via
// scripts/ipd-s4-theme-rescore.mjs, not a second copy). Nothing is persisted to ipd_discharge_audits;
// the engine is CALLED, never edited. Artifacts under .corpus-eval/machinery-payoff/ (gitignored).
//
// THE ARMS — produced ONLY through the AnalyzeDeps seam (deps.retrieveHits / deps.enrichHits); the
// engine (analyzeCase) is untouched:
//   A — none        retrieveHits: () => []   enrichHits: () => []        (no retrieval, no enrichment)
//   B — current     defaults (defaultRetrieveHits + defaultEnrichHits, ENRICH_POOL_CAP=20)  [control]
//   C — pooled only defaultRetrieveHits + enrichHits: () => []            (isolates SL1 enrichment)
// Extract is done ONCE (retrieval only affects analyze) and shared across arms — so A/B/C differ in
// EXACTLY the injected retrieval deps, nothing else. K=1 per arm.
//
// ENV — set explicitly here, not inherited (reported in the pack):
//   DOC_AUDIT_CITE_GATE=1  (production value per V, 20-Jul; repo default is dark)
//   DOC_AUDIT_AUDIT=1      (critique/revise on; production)
//   PROGNOSIS_AUDIT=0      (dark; production default)
// analyzeCase reads these at CALL time, so setting them before the phase logic runs is sufficient.
//
//   --phase extract --out <pack>            extractCase over the 25 gold cases (TRACED — cost needs it)
//   --phase arms    --in <pack> --dir <d>   analyze all 3 arms over the shared extract pack → arm{A,B,C}.json
//   --phase report  --dir <d> --out <md>    combine arm packs + their S4.1 sem re-scores → the study
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/corpus-eval/machinery-payoff-arms.mjs --phase extract --out .corpus-eval/machinery-payoff/extract.json
//   node --env-file=.env.local --import tsx scripts/corpus-eval/machinery-payoff-arms.mjs --phase arms --in .corpus-eval/machinery-payoff/extract.json --dir .corpus-eval/machinery-payoff
//   node --env-file=.env.local --import tsx scripts/ipd-s4-theme-rescore.mjs --pack .corpus-eval/machinery-payoff/armA.json --out .corpus-eval/machinery-payoff/armA-sem   (× A,B,C)
//   node --env-file=.env.local --import tsx scripts/corpus-eval/machinery-payoff-arms.mjs --phase report --dir .corpus-eval/machinery-payoff --out machinery-payoff-ablation.md
//
// Numbers are REPORTED, never self-certified; the gate conclusion is the orchestrator's step.

// ── EXPLICIT ENV (before any analyzeCase call; read at call time) ────────────────────────────────
process.env.DOC_AUDIT_CITE_GATE = '1';   // gate ON  (code: === '1')
process.env.DOC_AUDIT_AUDIT = '1';       // audit ON (code: !== '0')
process.env.PROGNOSIS_AUDIT = '0';       // prognosis DARK (code: === '1')

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { metabaseQuery } from '../../lib/metabase.ts';
import { extractCase, analyzeCase } from '../../lib/doc-audit.ts';
import { getVertexAccessToken } from '../../lib/gcp-auth.ts';
import { loadIpdAuditGold } from '../../lib/ipd-audit/gold.ts';
import { GEMINI_MODEL, GEMINI_FLASH_MODEL, geminiModelFor, geminiUtilityModel, geminiConfigured } from '../../lib/llm.ts';
import { sql } from '../../lib/db.ts';
import { costInr } from '../../lib/llm-cost-core.ts';
import PRICING from '../../data/llm-pricing.json' with { type: 'json' };
import GOLD from '../../data/ipd-audit-gold.json' with { type: 'json' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const PHASE = argOf('--phase');
const WIDTH = Math.max(1, Number(argOf('--width') ?? 4) | 0);
const log = (...a) => console.error(...a);

const DOCS = '"accounts-members-miscellaneous_documents"';
const CLS = `document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const BAND_ORDER = 'ABCDE';
const within1 = (a, b) => Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b)) <= 1;
const lvcSubjects = (f) => (f ?? []).filter((x) => x.verdict === 'low-value' || x.verdict === 'context-dependent').map((x) => x.subject);

// Token-containment matcher — ONLY to fill each arm pack's baseline column (kept self-consistent
// with the S4.1 pack shape). The study reports the SEMANTIC number, never this one. Verbatim from
// scripts/ipd-flash-tiering.mjs.
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'to', 'with', 'use', 'therapy', 'course']);
const themeTokens = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((t) => t.length > 2 && !STOP.has(t)));
function themesMatch(a, b) {
  const ta = themeTokens(a), tb = themeTokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / ta.size >= 0.5 || inter / tb.size >= 0.5;
}

async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function fetchPdf(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 4000);
    try {
      const plain = await fetch(url).catch(() => null);
      if (plain?.ok) return Buffer.from(await plain.arrayBuffer());
      const token = await getVertexAccessToken();
      const authed = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!authed.ok) throw new Error(`GCS fetch ${authed.status}`);
      return Buffer.from(await authed.arrayBuffer());
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ₹ from traces, payload-first (multimodal PDF read + reasoning tokens are invisible to the columns).
// Verbatim from scripts/ipd-flash-tiering.mjs costOf.
async function costOf(traceIds) {
  const ids = traceIds.filter(Boolean);
  if (!ids.length) return { inr: 0, tokens_in: 0, tokens_out: 0, calls: 0, byModel: [] };
  let rows = null, lastErr;
  for (let attempt = 0; attempt < 4 && !rows; attempt++) {
    if (attempt) await sleep(attempt * 5000);
    try {
      rows = await sql(
        `SELECT COALESCE(payload->>'model', call_model) AS model,
                sum(COALESCE((payload->'usage'->>'prompt_tokens')::bigint, tokens_in, 0))::bigint AS tin,
                sum(GREATEST(
                      COALESCE((payload->'usage'->>'total_tokens')::bigint, 0)
                        - COALESCE((payload->'usage'->>'prompt_tokens')::bigint, 0),
                      COALESCE((payload->'usage'->>'completion_tokens')::bigint, tokens_out, 0)
                ))::bigint AS tout,
                sum(COALESCE((payload->'usage'->>'completion_tokens')::bigint, tokens_out, 0))::bigint AS tout_completion_only,
                count(*)::int AS calls
         FROM trace_events
         WHERE trace_id = ANY($1) AND kind = 'llm_response'
           AND (payload->'usage' IS NOT NULL OR tokens_in IS NOT NULL OR tokens_out IS NOT NULL)
         GROUP BY 1`, [ids]);
    } catch (e) { lastErr = e; log(`[cost] attempt ${attempt + 1} failed: ${e?.message}`); }
  }
  if (!rows) {
    log(`[cost] UNAVAILABLE after retries (${lastErr?.message}) — pack keeps the trace ids; recompute with --phase report`);
    return { inr: 0, tokens_in: 0, tokens_out: 0, calls: 0, byModel: [], unavailable: true, error: String(lastErr?.message ?? lastErr) };
  }
  let inr = 0, inrCompletionOnly = 0, tin = 0, tout = 0, calls = 0;
  const byModel = [];
  for (const r of rows) {
    const i = Number(r.tin ?? 0), o = Number(r.tout ?? 0), oc = Number(r.tout_completion_only ?? 0);
    const c = costInr(String(r.model ?? ''), i, o, false, PRICING);
    inr += c; inrCompletionOnly += costInr(String(r.model ?? ''), i, oc, false, PRICING);
    tin += i; tout += o; calls += Number(r.calls);
    byModel.push({ model: r.model, calls: Number(r.calls), tokens_in: i, tokens_out: o, reasoning_tokens: o - oc, inr: +c.toFixed(3) });
  }
  return {
    inr: +inr.toFixed(2), tokens_in: tin, tokens_out: tout, calls,
    inr_completion_only_basis: +inrCompletionOnly.toFixed(2),
    byModel: byModel.sort((a, b) => b.inr - a.inr),
  };
}

// cite-or-label split for one finding: cited (≥1 citation) → estimate (≥1 estimate, no cite) → neither.
function labelOf(f) {
  if (Array.isArray(f.citation_ids) && f.citation_ids.length > 0) return 'evidence';
  if (Array.isArray(f.estimates) && f.estimates.length > 0) return 'estimate';
  return 'neither';
}

// ── phase extract ────────────────────────────────────────────────────────────────────────────────
if (PHASE === 'extract') {
  const OUT = argOf('--out');
  const gold = loadIpdAuditGold(GOLD);
  log(`[extract] model=${GEMINI_MODEL} · vertex=${geminiConfigured()} · ${gold.cases.length} gold cases · width ${WIDTH}`);
  const ids = gold.cases.map((c) => `'${c.document_id}'`).join(',');
  const urlRows = await metabaseQuery(`SELECT _doc_id, document__upload_uri AS url FROM ${DOCS} WHERE _doc_id IN (${ids}) AND ${CLS}`);
  const urlOf = Object.fromEntries(urlRows.map((r) => [String(r._doc_id), String(r.url)]));

  const t0 = Date.now();
  let done = 0;
  const cases = await pool(gold.cases, WIDTH, async (c) => {
    const s = Date.now();
    let attempts = 0, lastErr = null, traceId = null;
    for (; attempts < 3; attempts++) {
      if (attempts) await sleep(attempts * 5000);
      try {
        const buf = await fetchPdf(urlOf[c.document_id]);
        const r = await extractCase({ base64: buf.toString('base64'), mime: 'application/pdf', docTypeHint: 'discharge_summary', bytes: buf.length });
        traceId = r.traceId ?? traceId;
        if (r.extracted) {
          done++;
          log(`[extract] ${done}/${gold.cases.length} ${c.id} ok${attempts ? ` (after ${attempts} retr${attempts === 1 ? 'y' : 'ies'})` : ''} (${Math.round((Date.now() - s) / 1000)}s)`);
          return { id: c.id, ip_uid: c.ip_uid, document_id: c.document_id, extracted: r.extracted, traceId, ms: Date.now() - s, attempts: attempts + 1, error: null };
        }
        lastErr = 'extract returned null';
      } catch (e) { lastErr = String(e?.message ?? e); }
    }
    done++;
    log(`[extract] ${done}/${gold.cases.length} ${c.id} FAILED after ${attempts} attempts (${lastErr})`);
    return { id: c.id, ip_uid: c.ip_uid, document_id: c.document_id, extracted: null, traceId, ms: Date.now() - s, attempts, error: lastErr };
  });

  const ok = cases.filter((c) => c.extracted);
  const cost = await costOf(cases.map((c) => c.traceId));
  const retried = cases.filter((c) => (c.attempts ?? 1) > 1);
  const pack = {
    phase: 'extract', model: GEMINI_MODEL, vertex: geminiConfigured(), gold_version: gold.version,
    attempted: cases.length, ok: ok.length, errors: cases.length - ok.length,
    retried: retried.length, retried_ids: retried.map((c) => c.id), failed_ids: cases.filter((c) => !c.extracted).map((c) => c.id),
    wall_ms: Date.now() - t0, mean_ms: Math.round(mean(ok.map((c) => c.ms))), cost, cases,
  };
  writeFileSync(OUT, JSON.stringify(pack, null, 2));
  log(`\n[extract] ${ok.length}/${cases.length} ok · ₹${cost.inr} (₹${(cost.inr / (ok.length || 1)).toFixed(2)}/doc) · mean ${Math.round(pack.mean_ms / 1000)}s/doc → ${OUT}`);
  process.exit(0);
}

// ── phase arms ───────────────────────────────────────────────────────────────────────────────────
if (PHASE === 'arms') {
  const IN = argOf('--in');
  const DIR = argOf('--dir');
  mkdirSync(DIR, { recursive: true });
  const inPack = JSON.parse(readFileSync(IN, 'utf8'));
  const gold = loadIpdAuditGold(GOLD);
  const usable = inPack.cases.filter((c) => c.extracted);
  const analyzeModel = geminiModelFor('doc_audit') ?? geminiUtilityModel();
  log(`[arms] extract pack ${IN} (model=${inPack.model}) · ${usable.length} cases · analyze model=${analyzeModel} · citegate=${process.env.DOC_AUDIT_CITE_GATE} audit=${process.env.DOC_AUDIT_AUDIT} prognosis=${process.env.PROGNOSIS_AUDIT}`);

  const ARMS = {
    A: { label: 'none (no retrieval, no enrichment)', deps: () => ({ retrieveHits: async () => [], enrichHits: async () => [] }) },
    B: { label: 'current (production defaults)',       deps: () => ({}) },
    C: { label: 'pooled only (no enrichment)',         deps: () => ({ enrichHits: async () => [] }) },
  };

  for (const [key, arm] of Object.entries(ARMS)) {
    const t0 = Date.now();
    let done = 0;
    const runs = await pool(usable, WIDTH, async (c) => {
      const s = Date.now();
      let report = null, traceId = null, attempts = 0, lastErr = null;
      for (; attempts < 3 && !report?.valueScore; attempts++) {
        if (attempts) await sleep(attempts * 5000);
        try {
          const r = await analyzeCase(c.extracted, arm.deps(), { trace: true });
          report = r.report; traceId = r.traceId ?? traceId;
          if (!report?.valueScore) lastErr = 'analyze returned no valueScore';
        } catch (e) { lastErr = String(e?.message ?? e); }
      }
      try {
        if (!report?.valueScore) throw new Error(lastErr ?? 'analyze failed');
        const f = report.findings ?? [];
        const split = { evidence: 0, estimate: 0, neither: 0 };
        for (const x of f) split[labelOf(x)]++;
        done++;
        log(`[arms:${key}] ${done}/${usable.length} ${c.id} band ${report.valueScore.band} · ${f.length}F (${split.evidence}ev/${split.estimate}est/${split.neither}∅) · ${(report.sources ?? []).length} src (${Math.round((Date.now() - s) / 1000)}s)`);
        return {
          id: c.id, ip_uid: c.ip_uid,
          cvi: Math.round(report.valueScore.headline), band: report.valueScore.band,
          compl: Math.round((report.completeness?.coverage ?? 0) * 100),
          nF: f.length, nLV: f.filter((x) => x.verdict === 'low-value').length,
          nSources: (report.sources ?? []).length,
          split, lvcSubjects: lvcSubjects(f),
          analyzeTraceId: traceId ?? null, analyze_ms: Date.now() - s, attempts, error: null,
        };
      } catch (e) {
        done++; log(`[arms:${key}] ${done}/${usable.length} ${c.id} FAILED (${e?.message})`);
        return { id: c.id, ip_uid: c.ip_uid, error: String(e?.message ?? e), attempts, analyze_ms: Date.now() - s };
      }
    });

    const ok = runs.filter((r) => !r.error);
    const cost = await costOf(runs.map((r) => r.analyzeTraceId));
    // Emit in the ipd-audit-s4-k5-v2 shape so scripts/ipd-s4-theme-rescore.mjs scores it verbatim.
    const perCase = ok.map((r) => {
      const gc = gold.cases.find((c) => c.id === r.id);
      const goldThemes = lvcSubjects(gc?.findings);
      const matchedGold = goldThemes.filter((g) => r.lvcSubjects.some((sub) => themesMatch(g, sub)));
      const matchedRun = r.lvcSubjects.filter((sub) => goldThemes.some((g) => themesMatch(g, sub)));
      return {
        id: r.id, ip_uid: r.ip_uid, speciality: gc?.speciality ?? null,
        gold: { band_modal: gc?.band_modal, band_range: gc?.band_range, completeness_pct: gc?.completeness_pct },
        raw_runs: [{ cvi: r.cvi, band: r.band, compl: r.compl, lvcSubjects: r.lvcSubjects }],
        theme_recall: goldThemes.length ? +(matchedGold.length / goldThemes.length).toFixed(2) : 1,
        theme_precision: r.lvcSubjects.length ? +(matchedRun.length / r.lvcSubjects.length).toFixed(2) : 1,
        band_within1: within1(r.band, gc?.band_modal ?? 'C'),
        compl_delta: Math.abs(r.compl - (gc?.completeness_pct ?? 0)),
        nF: r.nF, nLV: r.nLV, nSources: r.nSources, split: r.split, analyze_ms: r.analyze_ms,
      };
    });
    const armPack = {
      phase: 'arms', arm: key, arm_label: arm.label, gold_version: gold.version,
      config: { extract_model: inPack.model, analyze_model: analyzeModel, cite_gate: process.env.DOC_AUDIT_CITE_GATE, audit: process.env.DOC_AUDIT_AUDIT, prognosis: process.env.PROGNOSIS_AUDIT },
      attempted: usable.length, ok: ok.length, errors: runs.length - ok.length,
      wall_ms: Date.now() - t0, analyze_mean_ms: Math.round(mean(ok.map((r) => r.analyze_ms))),
      cost, extract_cost: inPack.cost,
      band_within1_rate: +mean(perCase.map((c) => (c.band_within1 ? 1 : 0))).toFixed(3),
      perCase, runs,
    };
    writeFileSync(`${DIR}/arm${key}.json`, JSON.stringify(armPack, null, 2));
    log(`\n[arms:${key}] ${ok.length}/${usable.length} ok · analyze ₹${cost.inr} (₹${(cost.inr / (ok.length || 1)).toFixed(2)}/doc) · ${Math.round(armPack.analyze_mean_ms / 1000)}s/doc → ${DIR}/arm${key}.json\n`);
  }
  process.exit(0);
}

// ── phase report ─────────────────────────────────────────────────────────────────────────────────
if (PHASE === 'report') {
  const DIR = argOf('--dir');
  const OUT = argOf('--out');
  const gold = loadIpdAuditGold(GOLD);
  const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const KEYS = ['A', 'B', 'C'];
  const LABELS = { A: 'none', B: 'current (defaults)', C: 'pooled only' };
  const arms = KEYS.map((k) => ({ key: k, pack: load(`${DIR}/arm${k}.json`), sem: load(`${DIR}/arm${k}-sem.json`) }));

  // per-case sem recall/precision, aligned by case id across arms (paired).
  const caseIds = arms[0].sem.perCase.map((c) => c.id);
  const rec = {}, pre = {};       // rec[key] = Map(id → recall)
  for (const a of arms) {
    rec[a.key] = new Map(a.sem.perCase.map((c) => [c.id, c.sem_recall]));
    pre[a.key] = new Map(a.sem.perCase.map((c) => [c.id, c.sem_precision]));
  }
  // common case set (all arms scored) — pairing requires the same cases.
  const common = caseIds.filter((id) => KEYS.every((k) => rec[k].has(id) && pre[k].has(id)));

  // seeded bootstrap for paired-delta CIs (Math.random is available in scripts; seed for reproducibility).
  let _seed = 0x9e3779b9;
  const rnd = () => { _seed |= 0; _seed = (_seed + 0x6d2b79f5) | 0; let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const meanOf = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  function pairedCI(deltas, B = 10000) {
    const n = deltas.length; if (!n) return { mean: 0, lo: 0, hi: 0, tie: true };
    const m = meanOf(deltas);
    const boots = [];
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += deltas[(rnd() * n) | 0];
      boots.push(s / n);
    }
    boots.sort((x, y) => x - y);
    const lo = boots[Math.floor(0.025 * B)], hi = boots[Math.floor(0.975 * B)];
    return { mean: +m.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), tie: lo <= 0 && hi >= 0 };
  }
  const deltaCI = (map2, map1) => pairedCI(common.map((id) => map2.get(id) - map1.get(id)));

  // arm-level means (over common cases)
  const armMean = (map) => +meanOf(common.map((id) => map.get(id))).toFixed(3);
  const recallMean = Object.fromEntries(KEYS.map((k) => [k, armMean(rec[k])]));
  const precMean = Object.fromEntries(KEYS.map((k) => [k, armMean(pre[k])]));

  // cost per doc per arm = (extract + analyze) / ok  (recomputed from trace ids for durability)
  const perDocInr = {};
  for (const a of arms) {
    // extract cost is shared across arms and already priced in the extract pack; analyze is
    // recomputed from the durable trace ids (same discipline as flash-tiering's report phase).
    const extractInr = a.pack.extract_cost?.inr ?? 0;
    const an = await costOf(a.pack.runs.map((r) => r.analyzeTraceId));
    const n = a.pack.ok || 1;
    a.pack._cost = { extract_inr: extractInr, analyze_inr: an.inr, total_per_doc: +((extractInr + an.inr) / n).toFixed(2), analyze_per_doc: +(an.inr / n).toFixed(2) };
    perDocInr[a.key] = a.pack._cost.total_per_doc;
    log(`[report] ${a.key}: extract ₹${(extractInr / n).toFixed(2)}/doc + analyze ₹${(an.inr / n).toFixed(2)}/doc = ₹${a.pack._cost.total_per_doc}/doc`);
  }

  // IIE vs arm A (accuracy = material recall): (recall_M − recall_A) / (cost_M − cost_A)
  const iie = (k) => {
    const dR = recallMean[k] - recallMean.A;
    const dC = perDocInr[k] - perDocInr.A;
    return dC === 0 ? null : +(dR / dC).toFixed(4);
  };

  // findings/doc + cite-or-label split per arm (over common cases)
  const armFindings = (a) => {
    const pc = a.pack.perCase.filter((c) => common.includes(c.id));
    const sum = (f) => pc.reduce((s, c) => s + f(c), 0);
    const n = pc.length || 1;
    return {
      per_doc: +(sum((c) => c.nF) / n).toFixed(2),
      evidence: +(sum((c) => c.split.evidence) / n).toFixed(2),
      estimate: +(sum((c) => c.split.estimate) / n).toFixed(2),
      neither: +(sum((c) => c.split.neither) / n).toFixed(2),
      sources_per_doc: +(sum((c) => c.nSources) / n).toFixed(1),
    };
  };
  const findings = Object.fromEntries(arms.map((a) => [a.key, armFindings(a)]));

  // per-case win/loss on the primary measure (recall). Winner = strictly-max recall; ties listed.
  const perCaseWL = common.map((id) => {
    const r = Object.fromEntries(KEYS.map((k) => [k, rec[k].get(id)]));
    const best = Math.max(...KEYS.map((k) => r[k]));
    const winners = KEYS.filter((k) => r[k] === best);
    return { id, ...r, best: +best.toFixed(2), winners };
  });
  const soleWins = Object.fromEntries(KEYS.map((k) => [k, perCaseWL.filter((c) => c.winners.length === 1 && c.winners[0] === k).length]));
  const partOfTie = Object.fromEntries(KEYS.map((k) => [k, perCaseWL.filter((c) => c.winners.length > 1 && c.winners.includes(k)).length]));
  const allTie = perCaseWL.filter((c) => c.winners.length === KEYS.length).length;
  // pairwise recall win/tie/loss
  const pairwise = (x, y) => {
    let w = 0, t = 0, l = 0;
    for (const id of common) { const d = rec[x].get(id) - rec[y].get(id); if (d > 1e-9) w++; else if (d < -1e-9) l++; else t++; }
    return { win: w, tie: t, loss: l };
  };

  const rc = (k) => `${recallMean[k].toFixed(2)}`;
  const pc = (k) => `${precMean[k].toFixed(2)}`;
  const ciStr = (c) => `${c.mean >= 0 ? '+' : ''}${c.mean.toFixed(3)} [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]${c.tie ? ' — TIE' : ''}`;

  const md = [
    `# Machinery-Payoff Retrieval Ablation — IPD, 25 gold cases (measured, NOT a gate decision)`, '',
    `> **Study only.** No engine/prompt/gold/route/migration/prod-write. The three arms are produced ONLY through the \`AnalyzeDeps\` seam (\`deps.retrieveHits\`/\`deps.enrichHits\`); \`analyzeCase\` is byte-unchanged. Bench: the **${gold.cases.length} frozen gold cases** (\`${gold.version}\`, hash-pinned loader), **K=1** per arm, scored with the shipped **S4.1 semantic matcher** (\`scripts/ipd-s4-theme-rescore.mjs\` run verbatim per arm). Model, prompts, temperature, env held constant across arms.`, '',
    `> **Read the distribution as the primary result.** At n=${common.length} nearly every mean delta is a statistical tie; that is expected, not a failure. This study is **hypothesis-generating, not conclusive.** The gate decision is the orchestrator's.`, '',
    `**Config (constant across arms):** analyze model \`${arms[0].pack.config.analyze_model}\`, extract model \`${arms[0].pack.config.extract_model}\`, \`DOC_AUDIT_CITE_GATE=${arms[0].pack.config.cite_gate}\` · \`DOC_AUDIT_AUDIT=${arms[0].pack.config.audit}\` · \`PROGNOSIS_AUDIT=${arms[0].pack.config.prognosis}\`. Cases scored in all three arms (paired set): **${common.length}/${gold.cases.length}**.`, '',
    `## 1. Per-arm results (accuracy measure = material recall vs gold/2.0)`, '',
    `| Arm | Retrieval | Material recall | Precision | Findings/doc | ev / est / ∅ | Sources/doc | ₹/doc | IIE vs A |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...KEYS.map((k) => `| **${k}** | ${LABELS[k]} | ${rc(k)} | ${pc(k)} | ${findings[k].per_doc} | ${findings[k].evidence} / ${findings[k].estimate} / ${findings[k].neither} | ${findings[k].sources_per_doc} | ₹${perDocInr[k]} | ${k === 'A' ? '—' : (iie(k) ?? 'n/a (Δcost=0)')} |`),
    '',
    `IIE = (recall_arm − recall_A) / (₹/doc_arm − ₹/doc_A). Accuracy measure named inline: **material recall** (no MCQ accuracy exists for this task).`, '',
    `## 2. Paired deltas with 95% CI (bootstrap, ${common.length} paired cases, 10k resamples)`, '',
    `A delta whose CI crosses zero is a **TIE** — reported as such, not as a bare point difference.`, '',
    `| Delta | Recall | Precision |`, `|---|---|---|`,
    `| B − A (retrieval on) | ${ciStr(deltaCI(rec.B, rec.A))} | ${ciStr(deltaCI(pre.B, pre.A))} |`,
    `| C − A (pooled vs none) | ${ciStr(deltaCI(rec.C, rec.A))} | ${ciStr(deltaCI(pre.C, pre.A))} |`,
    `| B − C (enrichment payoff) | ${ciStr(deltaCI(rec.B, rec.C))} | ${ciStr(deltaCI(pre.B, pre.C))} |`,
    '',
    `Cost/doc deltas: B−A ₹${(perDocInr.B - perDocInr.A).toFixed(2)} · C−A ₹${(perDocInr.C - perDocInr.A).toFixed(2)} · B−C ₹${(perDocInr.B - perDocInr.C).toFixed(2)}.`, '',
    `## 3. Per-case win/loss on material recall (the decision-critical output)`, '',
    `Sole wins: **A ${soleWins.A} · B ${soleWins.B} · C ${soleWins.C}** · all-tie ${allTie}/${common.length}. Part-of-a-tie: A ${partOfTie.A} · B ${partOfTie.B} · C ${partOfTie.C}.`, '',
    `Pairwise recall (win/tie/loss): **B vs A** ${JSON.stringify(pairwise('B', 'A'))} · **C vs A** ${JSON.stringify(pairwise('C', 'A'))} · **B vs C** ${JSON.stringify(pairwise('B', 'C'))}.`, '',
    `| Case | Speciality | A recall | B recall | C recall | Winner(s) |`, `|---|---|---|---|---|---|`,
    ...perCaseWL.map((c) => {
      const spec = arms[0].pack.perCase.find((p) => p.id === c.id)?.speciality ?? '';
      return `| ${c.id} | ${spec} | ${c.A.toFixed(2)} | ${c.B.toFixed(2)} | ${c.C.toFixed(2)} | ${c.winners.join('=')} |`;
    }),
    '',
    `## 4. Provider / model routing (per arm — identical by construction)`, '',
    ...arms.map((a) => `- **${a.key}**: analyze \`${a.pack.config.analyze_model}\` (Vertex Gemini), cite-gate critic \`${geminiUtilityModel()}\` (Flash), extract \`${a.pack.config.extract_model}\`.`),
    '',
    `## 5. Notes`, '',
    `- Arm A produces findings with **no citations** (no retrieval), so its cite-or-label split is estimate/∅ only — recall/precision are still defined because the S4.1 matcher scores finding **subjects** against gold themes, independent of citations. This is why the gold-recall study (not citation-support) is the one that can answer "does retrieval help".`,
    `- Not counted in any arm (equally understated everywhere): the idealised-pathway Flash skeleton (\`lib/doc-audit.ts\`, untraced upstream) and utility passes. All arms share it.`,
    `- Extract is shared across arms (retrieval only affects analyze); extract ₹ is identical in every arm's ₹/doc.`,
  ].join('\n');

  writeFileSync(OUT, md + '\n');
  writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({
    n_paired: common.length, recall_mean: recallMean, precision_mean: precMean, per_doc_inr: perDocInr,
    iie: Object.fromEntries(KEYS.filter((k) => k !== 'A').map((k) => [k, iie(k)])),
    findings, sole_wins: soleWins, part_of_tie: partOfTie, all_tie: allTie,
    pairwise: { BA: pairwise('B', 'A'), CA: pairwise('C', 'A'), BC: pairwise('B', 'C') },
    deltas: {
      recall: { BA: deltaCI(rec.B, rec.A), CA: deltaCI(rec.C, rec.A), BC: deltaCI(rec.B, rec.C) },
      precision: { BA: deltaCI(pre.B, pre.A), CA: deltaCI(pre.C, pre.A), BC: deltaCI(pre.B, pre.C) },
    },
    per_case: perCaseWL,
  }, null, 2));
  log(`wrote ${OUT} + ${OUT.replace(/\.md$/, '.json')}`);
  process.exit(0);
}

log('need --phase extract|arms|report');
process.exit(2);
