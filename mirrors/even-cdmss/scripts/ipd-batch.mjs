// scripts/ipd-batch.mjs — the IPD audit BATCH runner (credentialed, never CI). Model-agnostic:
// the shipped chain (lib/ipd-audit/run.ts) with one flag. Persists prod rows by default
// (ipd-discharge-audit/0.1, gemini-2.5-pro); --mini writes the isolated '-mini' engine version
// (RETIRED for Qwen — it rubber-stamps; see lib/ipd-audit/backfill.ts).
//
// WHY A SCRIPT, NOT THE CRON: a batch of this size far exceeds the routes' 300s maxDuration cap;
// the daily worker (S5) handles the steady-state trickle, this runner handles measured batches.
//
// Selection: --select stratified (default — proportional quotas across kx specialities, months
// spread within each; the M0 sample idiom) | oldest (backlog order). Already-audited docs are
// excluded by the audit table itself (the watermark idiom). Scanned/no-text-layer PDFs surface as
// skips and are counted, never fabricated.
//
// COST: each doc's extract (Gemini multimodal PDF read) and analyze chain are SEPARATE traces;
// both ids are collected and their tokens_in/tokens_out summed from trace_events, priced through
// the shipped lib/llm-cost-core + data/llm-pricing.json. Caveat printed with the result: the
// idealised-pathway skeleton call inside analyzeCase is deliberately untraced upstream, so its
// (Flash-tier) tokens are NOT in this number — the true cost is slightly higher.
//
// RESILIENCE: every doc runs under a hard per-doc timeout (--timeout, default 420s) with a retry
// cap (--retries, default 1). A timeout frees the pool slot and is counted as a timeout, never a
// silent stall — note the in-flight HTTP request itself is not cancellable from here, so a timed-out
// doc's tokens may still be spent (counted in the traced cost).
// Progress prints to STDERR: stdout is block-buffered into a pipe, so stderr is what streams live.
//
// Run:
//   node --env-file=.env.local --import tsx scripts/ipd-batch.mjs [--n 75] [--conc 4] [--mini]
//                    [--select stratified|oldest] [--timeout 420] [--retries 1] [--out ipd-batch.json]

import { writeFileSync } from 'fs';
import { metabaseQuery } from '../lib/metabase.ts';
import { fetchBacklogDocs } from '../lib/ipd-audit/db13.ts';
import { auditedDocIdsAnyVersion } from '../lib/ipd-audit/store.ts';
import { runIpdAudit } from '../lib/ipd-audit/run.ts';
import { sql } from '../lib/db.ts';
import { costInr, fmtInr } from '../lib/llm-cost-core.ts';
import PRICING from '../data/llm-pricing.json' with { type: 'json' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const N = Math.max(1, Number(argOf('--n') ?? 75) | 0);
const CONC = Math.max(1, Math.min(8, Number(argOf('--conc') ?? 4) | 0));
const MINI = argv.includes('--mini');
const SELECT = argOf('--select') ?? 'stratified';
const OUT = argOf('--out') ?? 'ipd-batch.json';
const TIMEOUT_MS = Math.max(60, Number(argOf('--timeout') ?? 420)) * 1000;
const RETRIES = Math.max(0, Math.min(3, Number(argOf('--retries') ?? 1)));
const log = (...a) => console.error(...a);   // stderr streams live; stdout is pipe-buffered

/** One doc under a hard timeout + bounded retries. Never throws. */
async function runWithGuard(d) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const started = Date.now();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ documentId: d.documentId, error: `timeout >${TIMEOUT_MS / 1000}s`, timedOut: true, latencyMs: Date.now() - started }), TIMEOUT_MS);
    });
    const r = await Promise.race([runIpdAudit(d, MINI ? { mini: true } : {}), timeout]);
    clearTimeout(timer);
    if (!r.timedOut && !r.error) return r;
    if (attempt < RETRIES) { log(`[batch] retry ${attempt + 1}/${RETRIES} ${d.documentId.slice(0, 10)} after ${r.error}`); continue; }
    return r;
  }
}

const DOCS = '"accounts-members-miscellaneous_documents"';
const CLS = `document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// ── stratified pool: proportional per-speciality quotas, months spread within each ──────────────
async function stratifiedPick(excludeIds, n) {
  const rows = await metabaseQuery(
    `SELECT m._doc_id AS document_id, m._parent_doc_id AS member_id, m.additional_metadata__booking_id AS ip_uid,
            m.document__upload_uri AS pdf_url,
            coalesce(k.treating_doctor_speciality,'(no kx match)') AS spec,
            to_char(coalesce(k.discharge_date_time, m.upload_timestamp::timestamptz) AT TIME ZONE 'Asia/Kolkata','YYYY-MM') AS month
     FROM ${DOCS} m
     LEFT JOIN (SELECT DISTINCT ON (ipd_no) ipd_no, treating_doctor_speciality, discharge_date_time
                FROM kx_discharge_summary_records ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST) k
       ON k.ipd_no = m.additional_metadata__booking_id
     WHERE m.${CLS} AND m.document__upload_uri ILIKE '%.pdf' AND m.document__is_ingested IS NULL`);
  const ex = new Set(excludeIds);
  const pool = rows.filter((r) => !ex.has(String(r.document_id)));

  const bySpec = new Map();
  for (const r of pool) {
    const s = String(r.spec);
    if (!bySpec.has(s)) bySpec.set(s, []);
    bySpec.get(s).push(r);
  }
  const ranked = [...bySpec.entries()].filter(([s]) => s !== '(no kx match)').sort((a, b) => b[1].length - a[1].length);
  // Strata count must leave room for the per-stratum floor, else the balancing loop below can
  // never reach `n` (that bug spun the CPU forever at small n and blocked the event loop, so even
  // the per-doc timeout couldn't fire — found the hard way on an n=1 smoke run).
  const FLOOR = n >= 20 ? 2 : 1;
  const maxStrata = Math.max(1, Math.min(10, ranked.length, Math.floor(n / FLOOR)));
  const top = ranked.slice(0, maxStrata);
  const total = top.reduce((s, [, v]) => s + v.length, 0) || 1;
  const quotas = top.map(([, v]) => Math.max(FLOOR, Math.round((v.length / total) * n)));
  let sum = quotas.reduce((a, b) => a + b, 0);
  // Converge with an explicit no-progress guard — never an unbounded spin.
  for (let guard = 0; sum !== n && guard < 10_000; guard++) {
    const before = sum;
    for (let i = 0; i < quotas.length && sum !== n; i++) {
      if (sum > n && quotas[i] > FLOOR) { quotas[i]--; sum--; }
      else if (sum < n) { quotas[i]++; sum++; }
    }
    if (sum === before) break;   // nothing movable — take what we have
  }
  const picked = [];
  top.forEach(([, rowsIn], i) => {
    const sorted = [...rowsIn].sort((a, b) => String(a.month).localeCompare(String(b.month)));
    const q = Math.min(quotas[i], sorted.length);
    const step = sorted.length / q;
    const used = new Set();
    for (let j = 0; j < q; j++) {
      let idx = Math.min(sorted.length - 1, Math.floor(j * step + step / 2));
      while (used.has(idx) && idx < sorted.length - 1) idx++;
      used.add(idx);
      picked.push(sorted[idx]);
    }
  });
  return picked.slice(0, n).map((r) => ({
    documentId: String(r.document_id),
    ipUid: r.ip_uid == null || r.ip_uid === '' ? null : String(r.ip_uid),
    memberId: r.member_id == null ? null : String(r.member_id),
    pdfUrl: String(r.pdf_url),
    spec: String(r.spec), month: String(r.month),
  }));
}

// ── real cost from the traces (extract + analyze), priced through the shipped cost core ─────────
async function costOf(traceIds) {
  const ids = traceIds.filter(Boolean);
  if (!ids.length) return null;
  const rows = await sql(
    `SELECT call_model AS model, sum(tokens_in)::bigint AS tin, sum(tokens_out)::bigint AS tout, count(*)::int AS calls
     FROM trace_events WHERE trace_id = ANY($1) AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)
     GROUP BY call_model`, [ids]);
  let inr = 0, tin = 0, tout = 0, calls = 0;
  const byModel = [];
  for (const r of rows) {
    const i = Number(r.tin ?? 0), o = Number(r.tout ?? 0);
    const c = costInr(String(r.model ?? ''), i, o, false, PRICING);
    inr += c; tin += i; tout += o; calls += Number(r.calls);
    byModel.push({ model: r.model, calls: Number(r.calls), tokens_in: i, tokens_out: o, inr: +c.toFixed(2) });
  }
  return { inr: +inr.toFixed(2), tokens_in: tin, tokens_out: tout, calls, byModel };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
log(`[batch] start · resolving already-audited set…`);
const already = await auditedDocIdsAnyVersion();
log(`[batch] already-audited: ${already.length} (${Date.now() - t0}ms) · selecting docs (${SELECT})…`);
let docs;
if (SELECT === 'oldest') {
  docs = [];
  const seen = new Set(already);
  while (docs.length < N) {
    const page = await fetchBacklogDocs([...seen], Math.min(20, N - docs.length));
    if (!page.length) break;
    for (const d of page) { docs.push(d); seen.add(d.documentId); }
  }
} else {
  docs = await stratifiedPick(already, N);
}
log(`[batch] selection done: ${docs.length} docs (${Date.now() - t0}ms)`);
const specs = new Set(docs.map((d) => d.spec).filter(Boolean));
const months = new Set(docs.map((d) => d.month).filter(Boolean));
log(`[batch] ${docs.length} docs · ${MINI ? 'MINI (qwen)' : 'GEMINI (prod)'} · conc ${CONC} · select ${SELECT} · timeout ${TIMEOUT_MS / 1000}s · retries ${RETRIES}` +
  (SELECT === 'stratified' ? ` · ${specs.size} specialities · ${months.size} months` : ''));

const results = [];
let i = 0, done = 0;
await Promise.all(Array.from({ length: Math.min(CONC, docs.length) }, async () => {
  for (;;) {
    const idx = i++;
    if (idx >= docs.length) return;
    const d = docs[idx];
    log(`[batch] → start ${d.documentId.slice(0, 10)} (${d.spec ?? '?'})`);
    const r = await runWithGuard(d);
    results.push({ ...r, spec: d.spec, month: d.month });
    done++;
    const rate = done / ((Date.now() - t0) / 3600_000);
    log(`[batch] ${done}/${docs.length} ${r.ip_uid ?? r.documentId.slice(0, 10)} · ${d.spec ?? ''} · ${r.skip ?? r.error ?? `${r.band}·${r.cvi} (${r.nLowValue} LV)`} · ${Math.round((r.latencyMs ?? 0) / 1000)}s · ${rate.toFixed(1)}/hr`);
    writeFileSync(OUT, JSON.stringify({ results, elapsed_min: +((Date.now() - t0) / 60000).toFixed(1) }, null, 2));
  }
}));

const ok = results.filter((r) => r.status);
const mins = (Date.now() - t0) / 60000;
const bands = {};
for (const r of ok) bands[r.band] = (bands[r.band] ?? 0) + 1;
const cost = await costOf(results.flatMap((r) => [r.extractTraceId, r.analyzeTraceId]));
const perDoc = cost && ok.length ? cost.inr / ok.length : null;
const CORPUS = 1613;

const summary = {
  version: 'ipd-batch/1', model: MINI ? 'qwen (mini)' : 'gemini-2.5-pro', select: SELECT, conc: CONC,
  attempted: docs.length, persisted: ok.length,
  skips: results.filter((r) => r.skip).length, errors: results.filter((r) => r.error).length,
  timeouts: results.filter((r) => r.timedOut).length,
  minutes: +mins.toFixed(1), docs_per_hour: +(ok.length / (mins / 60)).toFixed(1),
  mean_s_per_doc: Math.round(mean(ok.map((r) => r.latencyMs ?? 0)) / 1000),
  bands, mean_cvi: +mean(ok.map((r) => r.cvi ?? 0)).toFixed(1),
  mean_findings: +mean(ok.map((r) => r.nFindings ?? 0)).toFixed(1),
  mean_low_value: +mean(ok.map((r) => r.nLowValue ?? 0)).toFixed(1),
  specialities: specs.size, months: months.size,
  cost, cost_per_doc_inr: perDoc == null ? null : +perDoc.toFixed(2),
  extrapolation_full_backlog: perDoc == null ? null : {
    docs: CORPUS,
    inr: Math.round(perDoc * CORPUS),
    hours_at_this_conc: +(CORPUS / (ok.length / (mins / 60))).toFixed(1),
  },
};

console.log(`\n== IPD BATCH · ${summary.model} ==`);
console.log(`persisted ${ok.length}/${docs.length} · skips ${summary.skips} · errors ${summary.errors} · ${summary.minutes} min`);
console.log(`throughput ${summary.docs_per_hour} docs/hr at conc ${CONC} · mean ${summary.mean_s_per_doc}s/doc`);
console.log(`bands: ${Object.entries(bands).sort().map(([b, n]) => `${b}×${n}`).join(' · ')} · mean CVI ${summary.mean_cvi}`);
console.log(`findings/doc ${summary.mean_findings} · low-value/doc ${summary.mean_low_value}`);
if (cost) {
  console.log(`\nCOST (traced): ${fmtInr(cost.inr)} over ${cost.calls} calls · ${cost.tokens_in.toLocaleString()} in / ${cost.tokens_out.toLocaleString()} out`);
  for (const m of cost.byModel) console.log(`  ${m.model}: ${m.calls} calls · ${m.tokens_in.toLocaleString()}/${m.tokens_out.toLocaleString()} tok · ${fmtInr(m.inr)}`);
  console.log(`PER DOC: ${fmtInr(perDoc, { paise: true })}`);
  console.log(`FULL BACKLOG (${CORPUS} docs) ≈ ${fmtInr(summary.extrapolation_full_backlog.inr)} · ${summary.extrapolation_full_backlog.hours_at_this_conc} h at conc ${CONC}`);
  console.log(`CAVEAT: the idealised-pathway skeleton call inside analyzeCase is untraced upstream — its (Flash-tier) tokens are NOT in this number; true cost is slightly higher.`);
}
writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
console.log(`\nwrote ${OUT}`);
process.exit(0);
