// scripts/ipd-flash-tiering.mjs — v2 COST STUDY: Gemini 2.5 Flash tiering over the 25 gold cases.
// MEASUREMENT ONLY. The shipped default (all-Pro) is not touched: this script changes no engine
// code and no production config — it drives the alternate model configs purely by running each
// pass in its OWN PROCESS with GEMINI_MODEL set in the shell (shell env beats --env-file, verified).
// That is why this is phased rather than one run: `geminiModelFor('doc_audit')` reads the process's
// GEMINI_MODEL, so a single process cannot host two model tiers.
//
//   --phase extract  --out <pack>     extractCase over the 25 gold cases (TRACED — cost needs it)
//   --phase analyze  --in <pack> --out <pack>   analyzeCase over a saved extract pack (TRACED)
//   --phase report   --a <pack> --b <pack> --c <pack> --out <md>   scores + writes the study
//
// THE ARMS (K=1, per the kickoff):
//   A — all-Pro                    extract(pro)   + analyze(pro)     [the shipped baseline]
//   B — Flash-extract + Pro-analyze extract(flash) + analyze(pro)    [V's hypothesis]
//   C — all-Flash                   extract(flash) + analyze(flash)  [the bound, not a candidate]
// B and C SHARE one flash extract pack on purpose: it isolates the analyze variable (B vs C differ
// ONLY in the analyze model) and halves the extract spend. A vs B then differ only in extract.
//
// ALREADY-FLASH, UNCHANGED IN EVERY ARM (per the kickoff's note): the idealised-pathway skeleton
// (lib/doc-audit.ts:376, "cheap Flash skeleton; untraced") and the utility passes
// (geminiUtilityModel() → GEMINI_FLASH_MODEL). The skeleton is UNTRACED upstream, so its Flash
// tokens are NOT in any ₹/doc here — the same caveat S6 carried. All arms are equally understated.
//
// SEMANTIC THEME AGREEMENT is not computed here: each arm's pack is emitted in the
// ipd-audit-s4-k5-v2 shape so the SHIPPED S4.1 matcher (scripts/ipd-s4-theme-rescore.mjs) can be
// run over it verbatim — reusing that judge rather than forking a second copy of it.
//
// Run (credentialed, never CI):
//   GEMINI_MODEL=gemini-2.5-pro   node --env-file=.env.local --import tsx scripts/ipd-flash-tiering.mjs --phase extract --out /tmp/ft-extract-pro.json
//   GEMINI_MODEL=gemini-2.5-flash node --env-file=.env.local --import tsx scripts/ipd-flash-tiering.mjs --phase extract --out /tmp/ft-extract-flash.json
//   GEMINI_MODEL=gemini-2.5-pro   node --env-file=.env.local --import tsx scripts/ipd-flash-tiering.mjs --phase analyze --in /tmp/ft-extract-pro.json --out /tmp/ft-A.json
//   ... then --phase report
//
// Numbers are REPORTED, never self-certified — V decides adoption.
// scoring:false · the engine is called, never edited; nothing is persisted to ipd_discharge_audits.

import { writeFileSync, readFileSync } from 'fs';
import { metabaseQuery } from '../lib/metabase.ts';
import { extractCase, analyzeCase } from '../lib/doc-audit.ts';
import { getVertexAccessToken } from '../lib/gcp-auth.ts';
import { loadIpdAuditGold } from '../lib/ipd-audit/gold.ts';
import { GEMINI_MODEL, GEMINI_FLASH_MODEL } from '../lib/llm.ts';
import { sql } from '../lib/db.ts';
import { costInr } from '../lib/llm-cost-core.ts';
import PRICING from '../data/llm-pricing.json' with { type: 'json' };
import GOLD from '../data/ipd-audit-gold.json' with { type: 'json' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const PHASE = argOf('--phase');
const OUT = argOf('--out');
const WIDTH = Math.max(1, Number(argOf('--width') ?? 4) | 0);
const log = (...a) => console.error(...a);          // stderr: stdout block-buffers through a pipe

const DOCS = '"accounts-members-miscellaneous_documents"';
const CLS = `document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const BAND_ORDER = 'ABCDE';
const within1 = (a, b) => Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b)) <= 1;
const lvcSubjects = (f) => (f ?? []).filter((x) => x.verdict === 'low-value' || x.verdict === 'context-dependent').map((x) => x.subject);

// The S4 token-containment matcher, kept ONLY to fill the rescore pack's baseline column so each
// arm's S4.1 output stays self-consistent. Mirrors scripts/ipd-s4-bench.mjs `themesMatch` (that
// module can't be imported — it exits on load without its own --phase). S4.1 measured this matcher
// UNDER-counts paraphrase; the study reports the SEMANTIC number, never this one.
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

/**
 * ₹ from the traces, grouped by the model that ACTUALLY ran — read from the PAYLOAD, not the
 * envelope columns. Two measured reasons (both verified 17-Jul-2026), and both mean a
 * column-only reader under-reports real spend:
 *
 *  1. THE MULTIMODAL PDF READ IS INVISIBLE TO THE COLUMNS. trace_events.call_model/tokens_in/
 *     tokens_out are only filled when logEvent is handed an `envelope`; gemini-multimodal's
 *     self-logged llm_response passes none, so the extract's columns are NULL while its usage
 *     sits in payload.usage. A column-only cost query prices the entire PDF read at ₹0.
 *     (This is why S6's ₹11.30/doc is analyze-only — reported in the study, not silently fixed.)
 *  2. REASONING TOKENS ARE BILLED AS OUTPUT BUT EXCLUDED FROM completion_tokens. Measured on a
 *     real analyze call: total 9,639 = prompt 4,489 + completion 2,716 + reasoning 2,434. Gemini
 *     2.5 bills thinking tokens at the output rate ($10/M on Pro), so counting `completion` alone
 *     drops ~47% of the output. We take output = total − prompt (falling back to completion when
 *     a payload has no total), which captures completion + reasoning.
 *
 * COALESCE order puts the payload first and the columns second, so an event that has both is
 * counted exactly once. Retried and never fatal — a Neon blip cost run 1 its whole extract phase.
 */
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
    // The trace ids are saved in the pack — cost is recomputable later; never lose the LLM spend.
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
    // the S6 basis (completion only, no reasoning) — kept so V can reconcile with ₹11.30/doc
    inr_completion_only_basis: +inrCompletionOnly.toFixed(2),
    byModel: byModel.sort((a, b) => b.inr - a.inr),
  };
}

// ── phase extract ───────────────────────────────────────────────────────────────────────────────
if (PHASE === 'extract') {
  const gold = loadIpdAuditGold(GOLD);              // hash-pinned — a drifted gold refuses to load
  log(`[extract] model=${GEMINI_MODEL} · ${gold.cases.length} gold cases · width ${WIDTH}`);
  const ids = gold.cases.map((c) => `'${c.document_id}'`).join(',');
  const urlRows = await metabaseQuery(`SELECT _doc_id, document__upload_uri AS url FROM ${DOCS} WHERE _doc_id IN (${ids}) AND ${CLS}`);
  const urlOf = Object.fromEntries(urlRows.map((r) => [String(r._doc_id), String(r.url)]));

  const t0 = Date.now();
  let done = 0;
  const cases = await pool(gold.cases, WIDTH, async (c) => {
    const s = Date.now();
    // RETRY on a null read. generateFromDocument returns null for EVERY failure mode — network
    // blip, 429, safety block, genuinely unreadable — so a single null cannot be attributed to the
    // MODEL. Run 1 proved the risk: a DNS blip produced 3 "UNREADABLE" Pro cases on gold documents
    // Pro had already read cleanly when the gold was built. Without this retry the arm with the
    // unluckier network would be scored the worse reader. Only a null that survives 3 attempts is
    // reported as unreadable, and the attempt count rides the pack.
    let attempts = 0, lastErr = null, traceId = null;
    for (; attempts < 3; attempts++) {
      if (attempts) await sleep(attempts * 5000);
      try {
        const buf = await fetchPdf(urlOf[c.document_id]);
        const r = await extractCase({
          base64: buf.toString('base64'), mime: 'application/pdf',
          docTypeHint: 'discharge_summary', bytes: buf.length,
        });
        traceId = r.traceId ?? traceId;
        if (r.extracted) {
          done++;
          log(`[extract] ${done}/${gold.cases.length} ${c.id} ok${attempts ? ` (after ${attempts} retr${attempts === 1 ? 'y' : 'ies'})` : ''} (${Math.round((Date.now() - s) / 1000)}s)`);
          return { id: c.id, ip_uid: c.ip_uid, document_id: c.document_id, extracted: r.extracted,
            traceId, ms: Date.now() - s, attempts: attempts + 1, error: null };
        }
        lastErr = 'extract returned null';
      } catch (e) { lastErr = String(e?.message ?? e); }
    }
    done++;
    log(`[extract] ${done}/${gold.cases.length} ${c.id} FAILED after ${attempts} attempts (${lastErr})`);
    return { id: c.id, ip_uid: c.ip_uid, document_id: c.document_id, extracted: null, traceId,
      ms: Date.now() - s, attempts, error: lastErr };
  });

  const ok = cases.filter((c) => c.extracted);
  const cost = await costOf(cases.map((c) => c.traceId));
  const retried = cases.filter((c) => (c.attempts ?? 1) > 1);
  const pack = {
    phase: 'extract', model: GEMINI_MODEL, gold_version: gold.version,
    attempted: cases.length, ok: ok.length, errors: cases.length - ok.length,
    // Execution honesty: a run that needed retries is reported as such, and a run with residual
    // failures is contaminated — discard and re-run, never report it as clean.
    retried: retried.length, retried_ids: retried.map((c) => c.id),
    failed_ids: cases.filter((c) => !c.extracted).map((c) => c.id),
    wall_ms: Date.now() - t0, mean_ms: Math.round(mean(ok.map((c) => c.ms))),
    cost, cases,
  };
  writeFileSync(OUT, JSON.stringify(pack, null, 2));
  log(`\n[extract] ${ok.length}/${cases.length} ok · ₹${cost.inr} (₹${(cost.inr / (ok.length || 1)).toFixed(2)}/doc) · mean ${Math.round(pack.mean_ms / 1000)}s/doc → ${OUT}`);
  process.exit(0);
}

// ── phase analyze ───────────────────────────────────────────────────────────────────────────────
if (PHASE === 'analyze') {
  const IN = argOf('--in');
  const inPack = JSON.parse(readFileSync(IN, 'utf8'));
  const gold = loadIpdAuditGold(GOLD);
  const usable = inPack.cases.filter((c) => c.extracted);
  log(`[analyze] model=${GEMINI_MODEL} · extract pack ${IN} (extract model=${inPack.model}) · ${usable.length} cases · width ${WIDTH}`);

  const t0 = Date.now();
  let done = 0;
  const runs = await pool(usable, WIDTH, async (c) => {
    const s = Date.now();
    // Same rule as extract: retry so a network blip is never scored as this model's failure.
    let report = null, traceId = null, attempts = 0, lastErr = null;
    for (; attempts < 3 && !report?.valueScore; attempts++) {
      if (attempts) await sleep(attempts * 5000);
      try {
        const r = await analyzeCase(c.extracted, {}, {});
        report = r.report; traceId = r.traceId ?? traceId;
        if (!report?.valueScore) lastErr = 'analyze returned no valueScore';
      } catch (e) { lastErr = String(e?.message ?? e); }
    }
    try {
      if (!report?.valueScore) throw new Error(lastErr ?? 'analyze failed');
      const f = report.findings ?? [];
      done++;
      log(`[analyze] ${done}/${usable.length} ${c.id} band ${report.valueScore.band} cvi ${Math.round(report.valueScore.headline)} (${Math.round((Date.now() - s) / 1000)}s)`);
      return {
        id: c.id, ip_uid: c.ip_uid,
        cvi: Math.round(report.valueScore.headline), band: report.valueScore.band,
        compl: Math.round((report.completeness?.coverage ?? 0) * 100),
        nF: f.length, nLV: f.filter((x) => x.verdict === 'low-value').length,
        lvcSubjects: lvcSubjects(f),
        // extraction-fidelity probes (arms where extract is Flash): does the structured read still
        // carry the fields Pro's read did? Counts + presence only — never the values (PHI rule).
        extractFidelity: {
          diagnosis: !!c.extracted.diagnosis,
          n_medications: (c.extracted.medications ?? []).length,
          n_investigations: (c.extracted.investigations ?? []).length,
          n_treatments: (c.extracted.treatments ?? []).length,
          procedure: !!c.extracted.procedure,
          course_chars: (c.extracted.courseSummary ?? '').length,
        },
        extractTraceId: c.traceId, analyzeTraceId: traceId ?? null,
        extract_ms: c.ms, analyze_ms: Date.now() - s, attempts, extract_attempts: c.attempts ?? 1, error: null,
      };
    } catch (e) {
      done++; log(`[analyze] ${done}/${usable.length} ${c.id} FAILED after ${attempts} attempts (${e?.message})`);
      return { id: c.id, ip_uid: c.ip_uid, error: String(e?.message ?? e), attempts, extract_ms: c.ms, analyze_ms: Date.now() - s };
    }
  });

  const ok = runs.filter((r) => !r.error);
  const analyzeCost = await costOf(runs.map((r) => r.analyzeTraceId));
  const extractCost = inPack.cost;

  // Emit in the ipd-audit-s4-k5-v2 shape (perCase[].raw_runs[]) so the SHIPPED S4.1 semantic
  // matcher runs over this pack verbatim — one matcher, not two.
  const perCase = ok.map((r) => {
    const gc = gold.cases.find((c) => c.id === r.id);
    const goldThemes = lvcSubjects(gc?.findings);
    const matchedGold = goldThemes.filter((g) => r.lvcSubjects.some((s) => themesMatch(g, s)));
    const matchedRun = r.lvcSubjects.filter((s) => goldThemes.some((g) => themesMatch(g, s)));
    return {
      id: r.id, ip_uid: r.ip_uid, speciality: gc?.speciality ?? null,
      gold: { band_modal: gc?.band_modal, band_range: gc?.band_range, completeness_pct: gc?.completeness_pct },
      raw_runs: [{ cvi: r.cvi, band: r.band, compl: r.compl, lvcSubjects: r.lvcSubjects }],
      // the rescore pack's token baseline column (K=1 ⇒ one draw). Reported for contrast only.
      theme_recall: goldThemes.length ? +(matchedGold.length / goldThemes.length).toFixed(2) : 1,
      theme_precision: r.lvcSubjects.length ? +(matchedRun.length / r.lvcSubjects.length).toFixed(2) : 1,
      band_within1: within1(r.band, gc?.band_modal ?? 'C'),
      compl_delta: Math.abs(r.compl - (gc?.completeness_pct ?? 0)),
      extractFidelity: r.extractFidelity,
      extract_ms: r.extract_ms, analyze_ms: r.analyze_ms,
    };
  });

  const pack = {
    phase: 'analyze', gold_version: gold.version,
    config: { extract_model: inPack.model, analyze_model: GEMINI_MODEL, skeleton_model: `${GEMINI_FLASH_MODEL} (already Flash, untraced, all arms)` },
    attempted: usable.length, ok: ok.length, errors: runs.length - ok.length,
    wall_ms: Date.now() - t0,
    latency: {
      extract_mean_ms: Math.round(mean(ok.map((r) => r.extract_ms))),
      analyze_mean_ms: Math.round(mean(ok.map((r) => r.analyze_ms))),
      total_mean_ms: Math.round(mean(ok.map((r) => r.extract_ms + r.analyze_ms))),
    },
    cost: {
      extract: extractCost, analyze: analyzeCost,
      total_inr: +(extractCost.inr + analyzeCost.inr).toFixed(2),
      per_doc_inr: +((extractCost.inr + analyzeCost.inr) / (ok.length || 1)).toFixed(2),
    },
    band_within1_rate: +mean(perCase.map((c) => (c.band_within1 ? 1 : 0))).toFixed(3),
    compl_mean_abs_delta: +mean(perCase.map((c) => c.compl_delta)).toFixed(1),
    perCase, runs,
  };
  writeFileSync(OUT, JSON.stringify(pack, null, 2));
  log(`\n[analyze] ${ok.length}/${usable.length} ok · ±1 band ${(pack.band_within1_rate * 100).toFixed(0)}% · complΔ ${pack.compl_mean_abs_delta}pp · ₹${pack.cost.per_doc_inr}/doc · ${Math.round(pack.latency.total_mean_ms / 1000)}s/doc → ${OUT}`);
  process.exit(0);
}

// ── phase report ────────────────────────────────────────────────────────────────────────────────
if (PHASE === 'report') {
  const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const arms = [
    { key: 'A', label: 'all-Pro (shipped baseline)', pack: load(argOf('--a')), sem: load(argOf('--a-sem')) },
    { key: 'B', label: 'Flash-extract + Pro-analyze', pack: load(argOf('--b')), sem: load(argOf('--b-sem')) },
    { key: 'C', label: 'all-Flash', pack: load(argOf('--c')), sem: load(argOf('--c-sem')) },
  ];

  // RECOMPUTE cost here from the saved trace ids rather than trusting each pack's in-run figure:
  // the packs were produced by an earlier, column-only cost reader that priced the multimodal PDF
  // read at ₹0 and dropped reasoning tokens. Trace ids are the durable record — this is why they
  // ride the pack. (Same discipline as the S6 outage: recompute, never re-run the LLM spend.)
  for (const a of arms) {
    const extractIds = a.pack.runs.map((r) => r.extractTraceId);
    const analyzeIds = a.pack.runs.map((r) => r.analyzeTraceId);
    const [ex, an] = [await costOf(extractIds), await costOf(analyzeIds)];
    const n = a.pack.ok || 1;
    a.pack.cost = {
      extract: ex, analyze: an,
      total_inr: +(ex.inr + an.inr).toFixed(2),
      per_doc_inr: +((ex.inr + an.inr) / n).toFixed(2),
      per_doc_inr_completion_only_basis: +((ex.inr_completion_only_basis + an.inr_completion_only_basis) / n).toFixed(2),
    };
    log(`[report] ${a.key}: extract ₹${(ex.inr / n).toFixed(2)}/doc + analyze ₹${(an.inr / n).toFixed(2)}/doc = ₹${a.pack.cost.per_doc_inr}/doc`);
  }
  const CORPUS = 1613;      // the S6 backlog denominator
  const DAILY = 8;          // ~discharge summaries/day (the S5 worker's observed order of magnitude)
  const gold = loadIpdAuditGold(GOLD);

  const row = (a) => {
    const p = a.pack;
    const fid = p.perCase.map((c) => c.extractFidelity).filter(Boolean);
    return {
      key: a.key, label: a.label,
      extract_model: p.config.extract_model, analyze_model: p.config.analyze_model,
      n: p.ok, errors: p.errors,
      sem_recall: a.sem.summary.semantic.recall, sem_precision: a.sem.summary.semantic.precision,
      band_within1: +(p.band_within1_rate * 100).toFixed(0),
      compl_delta: p.compl_mean_abs_delta,
      inr_per_doc: p.cost.per_doc_inr,
      extract_inr: +(p.cost.extract.inr / (p.ok || 1)).toFixed(2),
      analyze_inr: +(p.cost.analyze.inr / (p.ok || 1)).toFixed(2),
      sec_per_doc: +(p.latency.total_mean_ms / 1000).toFixed(0),
      extract_sec: +(p.latency.extract_mean_ms / 1000).toFixed(0),
      analyze_sec: +(p.latency.analyze_mean_ms / 1000).toFixed(0),
      real_miss_cases: a.sem.summary.cases_with_real_misses,
      fidelity: {
        diagnosis: fid.filter((f) => f.diagnosis).length,
        procedure: fid.filter((f) => f.procedure).length,
        meds: +mean(fid.map((f) => f.n_medications)).toFixed(1),
        invs: +mean(fid.map((f) => f.n_investigations)).toFixed(1),
        course: Math.round(mean(fid.map((f) => f.course_chars))),
      },
      lv_per_doc: +mean(p.perCase.map((c) => c.raw_runs[0].lvcSubjects.length)).toFixed(1),
    };
  };
  const R = arms.map(row);
  const A = R[0], B = R[1], C = R[2];
  const save = (x) => +(A.inr_per_doc - x.inr_per_doc).toFixed(2);
  const pct = (x) => +((1 - x.inr_per_doc / A.inr_per_doc) * 100).toFixed(0);

  const md = [
    `# IPD Discharge Audit — v2 cost study: Gemini 2.5 Flash tiering (measured, NOT adopted)`, '',
    `> **Study only.** The shipped default remains **all-Pro**; no engine, frozen core, or production config was changed. Alternate configs were driven per-process via \`GEMINI_MODEL\` (shell env beats \`--env-file\`), so the pipeline itself is byte-identical in every arm.`,
    `> Bench: the **${gold.cases.length} frozen gold cases** (\`${gold.version}\`, hash-pinned loader), **K=1** per arm, theme agreement scored with the **S4.1 semantic matcher** (LLM judge; the shipped \`scripts/ipd-s4-theme-rescore.mjs\` run verbatim over each arm's pack — not a second copy).`,
    `> Numbers are **reported, not self-certified**. V decides adoption.`, '',
    `## 1. Per-config results`, '',
    `| Config | Extract | Analyze | Theme R / P (semantic) | Band ±1 vs gold | Compl Δ | ₹/doc | Latency |`,
    `|---|---|---|---|---|---|---|---|`,
    ...R.map((x) => `| **${x.key}** — ${x.label} | ${x.extract_model} | ${x.analyze_model} | ${x.sem_recall} / ${x.sem_precision} | ${x.band_within1}% | ${x.compl_delta}pp | **₹${x.inr_per_doc}** | ${x.sec_per_doc}s |`),
    '',
    `₹/doc split, and what the model swap actually buys:`, '',
    `| Config | Extract ₹ | Analyze ₹ | Total ₹/doc | vs A | Extract s | Analyze s |`,
    `|---|---|---|---|---|---|---|`,
    ...R.map((x) => `| ${x.key} | ₹${x.extract_inr} | ₹${x.analyze_inr} | ₹${x.inr_per_doc} | ${x.key === 'A' ? '—' : `−₹${save(x)} (${pct(x)}%)`} | ${x.extract_sec}s | ${x.analyze_sec}s |`),
    '',
    `> **Not counted in any arm** (equally understated everywhere): the idealised-pathway skeleton (\`lib/doc-audit.ts:376\`) is **already Flash and untraced upstream**, so its tokens are outside these ₹ — the same caveat S6 carried. The utility passes (\`geminiUtilityModel()\`) are also already Flash in every arm. Neither was changed.`, '',
    `## 2. Headline — B vs A`, '',
    `**B (Flash-extract + Pro-analyze) vs A (all-Pro):**`, '',
    `| Metric | A | B | Δ |`, `|---|---|---|---|`,
    `| Theme recall (semantic) | ${A.sem_recall} | ${B.sem_recall} | ${(B.sem_recall - A.sem_recall).toFixed(2)} |`,
    `| Theme precision (semantic) | ${A.sem_precision} | ${B.sem_precision} | ${(B.sem_precision - A.sem_precision).toFixed(2)} |`,
    `| Band ±1 vs gold modal | ${A.band_within1}% | ${B.band_within1}% | ${B.band_within1 - A.band_within1}pp |`,
    `| Completeness mean abs Δ | ${A.compl_delta}pp | ${B.compl_delta}pp | ${(B.compl_delta - A.compl_delta).toFixed(1)}pp |`,
    `| Low-value findings/doc | ${A.lv_per_doc} | ${B.lv_per_doc} | ${(B.lv_per_doc - A.lv_per_doc).toFixed(1)} |`,
    `| Cases with judge-confirmed real misses | ${A.real_miss_cases}/${A.n} | ${B.real_miss_cases}/${B.n} | ${B.real_miss_cases - A.real_miss_cases} |`,
    `| **₹/doc** | **₹${A.inr_per_doc}** | **₹${B.inr_per_doc}** | **−₹${save(B)} (${pct(B)}%)** |`,
    `| Latency/doc | ${A.sec_per_doc}s | ${B.sec_per_doc}s | ${B.sec_per_doc - A.sec_per_doc}s |`,
    '',
    `**Extraction fidelity** (does the Flash read still carry the fields Pro's read did?):`, '',
    `| Config | Diagnosis present | Procedure present | Meds/doc | Investigations/doc | Course chars |`,
    `|---|---|---|---|---|---|`,
    ...R.map((x) => `| ${x.key} | ${x.fidelity.diagnosis}/${x.n} | ${x.fidelity.procedure}/${x.n} | ${x.fidelity.meds} | ${x.fidelity.invs} | ${x.fidelity.course} |`),
    '',
    `**Scale:** at ₹${B.inr_per_doc}/doc, the full ${CORPUS}-doc backlog is **₹${Math.round(B.inr_per_doc * CORPUS).toLocaleString('en-IN')}** vs **₹${Math.round(A.inr_per_doc * CORPUS).toLocaleString('en-IN')}** on A — a **₹${Math.round(save(B) * CORPUS).toLocaleString('en-IN')}** saving. Forward-only (~${DAILY} discharges/day) that is ₹${Math.round(save(B) * DAILY)}/day, ~₹${Math.round(save(B) * DAILY * 365).toLocaleString('en-IN')}/year.`, '',
    `## 3. Where C (all-Flash) breaks`, '',
    `## 4. Recommendation`, '',
  ].join('\n');

  writeFileSync(OUT, md + '\n');
  writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({ arms: R, generated_from: { a: argOf('--a'), b: argOf('--b'), c: argOf('--c') } }, null, 2));
  log(`wrote ${OUT} (sections 3 + 4 are authored from the numbers, not templated)`);
  process.exit(0);
}

log('need --phase extract|analyze|report');
process.exit(2);
