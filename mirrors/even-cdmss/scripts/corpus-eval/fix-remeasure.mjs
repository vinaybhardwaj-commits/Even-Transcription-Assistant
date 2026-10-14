#!/usr/bin/env node
/**
 * scripts/corpus-eval/fix-remeasure.mjs — IPD citation fix (PRD CDMSS-IPD-CITATION-FIX §6): the
 * PAIRED re-measure. Fresh-runs the FIXED engine (ipd-discharge-audit/0.2) on the SAME baseline
 * document ids the PR0 benchmark sampled, then scores the new cited findings with the FROZEN PR0
 * verifier (lib/corpus-eval/verify.ts — same prompts, same Gemini 2.5 Pro, same fallback guard).
 *
 * Pairing: the baseline doc set = the distinct IPD audit_refs in .corpus-eval/pack.json (the 0.1
 * rows the frozen baseline.json scored). We resolve each row → its document_id → its PDF (db13),
 * re-audit at 0.2 (UPSERT keys on (document_id, engine_version) → NEW 0.2 rows; the 0.1 baseline
 * rows are untouched), then read the fresh 0.2 rows back and verify.
 *
 * Excerpt resolution mirrors assemble-pack EXACTLY: full chunk text via mksap_chunks.text keyed by
 * the persisted sources[].id, else the as-served preview (fail-safe, never re-retrieved).
 *
 * Read/measure only for the verifier; the engine run itself persists 0.2 rows (the intended fixed
 * output). Artifacts under .corpus-eval/fix-remeasure/. Never CI.
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/fix-remeasure.mjs [--n 10] [--conc 3] [--label smoke]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { fetchIpdDoc } from '../../lib/ipd-audit/db13.ts';
import { runIpdAudit } from '../../lib/ipd-audit/run.ts';
import { IPD_ENGINE_VERSION } from '../../lib/ipd-audit/store.ts';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';
import { supportStats, wilson } from '../../lib/corpus-eval/verify-core.ts';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)) || (argv[argv.indexOf(`--${n}`) + 1] && !argv[argv.indexOf(`--${n}`) + 1].startsWith('--') ? argv[argv.indexOf(`--${n}`) + 1] : null); return a ? String(a).replace(`--${n}=`, '') : d; };
const N = Math.max(1, parseInt(argOf('n', '10'), 10));
const CONC = Math.max(1, parseInt(argOf('conc', '3'), 10));
const LABEL = argOf('label', 'smoke');
const SKIP_AUDITED = argv.includes('--skip-audited');   // resume: reuse existing 0.2 rows, don't re-audit/re-pay
const OUT_DIR = '.corpus-eval/fix-remeasure';
const STATUS = `${OUT_DIR}/status.json`;
const OUT = `${OUT_DIR}/run-${LABEL}.json`;
const nowIso = () => new Date().toISOString();
const log = (...a) => console.error(...a);

const scrub = (s) => String(s ?? '')
  .replace(/\bUHID[-\s:]*\d+/gi, '[uhid]').replace(/\b[6-9]\d{9}\b/g, '[phone]')
  .replace(/\b(Mr|Mrs|Ms|Master|Baby of|B\/O|W\/O|S\/O|D\/O)\.?\s+[A-Z][a-z]+/g, '[name]')
  .replace(/\s+/g, ' ').trim();

async function fetchChunks(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  const map = new Map();
  for (let i = 0; i < uniq.length; i += 500) {
    const rows = await sql(`SELECT id::text AS id, text FROM mksap_chunks WHERE id::text = ANY($1)`, [uniq.slice(i, i + 500)]);
    for (const r of rows) map.set(String(r.id), r.text);
  }
  return map;
}

/** Mirror assemble-pack citedExcerpts: numbered citation_ids → cited Source → full-text (else preview). */
function citedExcerpts(citationIds, sources, chunkText) {
  const byN = new Map((sources || []).map((s) => [Number(s.n), s]));
  const out = [];
  for (const cid of citationIds) {
    const s = byN.get(Number(cid));
    if (!s) continue;
    const full = chunkText.get(String(s.id ?? ''));
    out.push({ text: scrub(full || s.preview || ''), resolved: full ? 'full' : 'preview',
      meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null } });
  }
  return out;
}

async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const started_at = nowIso();

  // ── 1. baseline doc set from the frozen pack (the 0.1 rows baseline.json scored) ──
  const pack = JSON.parse(readFileSync('.corpus-eval/pack.json', 'utf8'));
  const ipdUnits = pack.units.filter((u) => u.consumer === 'ipd');
  const baselineByRow = new Map();  // row id → {findings, cited}
  for (const u of ipdUnits) {
    const r = baselineByRow.get(u.audit_ref) || { findings: 0, cited: 0 };
    r.findings++; if (u.cited) r.cited++; baselineByRow.set(u.audit_ref, r);
  }
  const rowIds = [...baselineByRow.keys()];
  log(`[remeasure] baseline pack: ${ipdUnits.length} IPD finding-units across ${rowIds.length} rows`);

  const rows = await sql(`SELECT id::text AS id, document_id, ip_uid, member_id, engine_version FROM ipd_discharge_audits WHERE id::text = ANY($1)`, [rowIds]);
  // deterministic order = pack order
  const order = new Map(rowIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const targets = rows.slice(0, N);

  // resume: skip docs that already have a fresh 0.2 row (reuse them in the read-back, don't re-pay)
  let alreadyAudited = new Set();
  if (SKIP_AUDITED) {
    const done = await sql(`SELECT DISTINCT document_id FROM ipd_discharge_audits WHERE engine_version=$1 AND document_id = ANY($2)`,
      [IPD_ENGINE_VERSION, targets.map((t) => t.document_id)]);
    alreadyAudited = new Set(done.map((d) => d.document_id));
    log(`[remeasure] --skip-audited: ${alreadyAudited.size} of ${targets.length} already have a 0.2 row (reusing)`);
  }
  log(`[remeasure] re-running the FIXED engine (${IPD_ENGINE_VERSION}) on ${targets.length}/${rows.length} paired docs · conc ${CONC}`);

  // ── 2. resolve PDFs + fresh-run the fixed engine (persists 0.2 rows) ──
  const t0 = Date.now();
  let ran = 0;
  const runResults = await pool(targets, CONC, async (t) => {
    const base = baselineByRow.get(t.id) || {};
    if (alreadyAudited.has(t.document_id)) { ran++; return { document_id: t.document_id, row_id: t.id, status: 'reused', base_findings: base.findings ?? 0, base_cited: base.cited ?? 0 }; }
    const doc = await fetchIpdDoc(t.document_id).catch(() => null);
    if (!doc?.pdfUrl) { ran++; return { document_id: t.document_id, skip: 'no-pdf' }; }
    const r = await runIpdAudit({ documentId: t.document_id, ipUid: doc.ipUid ?? t.ip_uid, memberId: doc.memberId ?? t.member_id, pdfUrl: doc.pdfUrl });
    ran++;
    log(`[remeasure] audit ${ran}/${targets.length} ${t.document_id.slice(0, 10)} · ${r.skip ?? r.error ?? `${r.band}·${r.nFindings}F/${r.nLowValue}LV`} · base ${base.findings}F/${base.cited}cited · ${Math.round((r.latencyMs ?? 0) / 1000)}s`);
    writeFileSync(STATUS, JSON.stringify({ stage: 'audit', started_at, updated_at: nowIso(), audited: ran, total: targets.length, elapsed_s: Math.round((Date.now() - t0) / 1000) }, null, 2));
    return { document_id: t.document_id, row_id: t.id, status: r.status, nFindings: r.nFindings, nLowValue: r.nLowValue,
      base_findings: base.findings ?? 0, base_cited: base.cited ?? 0, skip: r.skip, error: r.error };
  });

  const ranDocs = runResults.filter((r) => r.status).map((r) => r.document_id);
  log(`[remeasure] audited ${ranDocs.length} ok · reading back 0.2 rows…`);

  // ── 3. read the fresh 0.2 rows + assemble finding-units (mirror assemble-pack) ──
  const freshRows = await sql(
    `SELECT id::text AS id, document_id, report FROM ipd_discharge_audits
     WHERE engine_version = $1 AND document_id = ANY($2)`, [IPD_ENGINE_VERSION, ranDocs]);
  const units = [];
  for (const row of freshRows) {
    const rep = typeof row.report === 'string' ? JSON.parse(row.report) : row.report;
    const findings = rep?.findings || []; const sources = rep?.sources || [];
    for (const f of findings) {
      const citation_ids = Array.isArray(f.citation_ids) ? f.citation_ids.map(Number).filter(Boolean) : [];
      const claim = scrub(Array.isArray(f.evidence) ? f.evidence.join(' ') : (f.subject ?? ''));
      if (!claim) continue;
      units.push({ document_id: row.document_id, finding_ref: String(f.subject ?? ''), claim, cited: citation_ids.length > 0, citation_ids, _sources: sources });
    }
  }
  const chunkText = await fetchChunks(units.flatMap((u) => (u._sources || []).map((s) => s.id)));
  for (const u of units) { u.excerpts = citedExcerpts(u.citation_ids, u._sources, chunkText); delete u._sources; }

  const cited = units.filter((u) => u.cited && u.excerpts.length);
  log(`[remeasure] 0.2 findings: ${units.length} · cited ${cited.length} (rate ${(cited.length / (units.length || 1)).toFixed(2)}) · verifying with the frozen PR0 verifier…`);

  // ── 4. FROZEN verifier on the cited findings ──
  let done = 0, fellBack = 0;
  const verdicts = await pool(cited, CONC, async (u) => {
    const out = await verifyClaim(u.claim, u.excerpts.map((e) => ({ text: e.text, meta: e.meta })));
    done++; if (out.fellBack) fellBack++;
    if (done % 5 === 0) log(`[remeasure]   verified ${done}/${cited.length} · fallback ${fellBack}`);
    writeFileSync(STATUS, JSON.stringify({ stage: 'verify', started_at, updated_at: nowIso(), verified: done, total: cited.length, fallback_fired: fellBack }, null, 2));
    return { document_id: u.document_id, finding_ref: u.finding_ref, verdict: out.verdict, fellBack: out.fellBack };
  });

  const support = supportStats(verdicts.map((v) => v.verdict));
  support.support_rate_ci = wilson(support.directly_supports, support.n_assessable);

  // paired finding-count deltas (Gate 2 directional churn on real docs).
  // Derive the 0.2 count from the read-back rows (robust to reused/resumed docs whose run
  // result carries no nFindings), falling back to the run result for freshly-audited docs.
  const f02ByDoc = {};
  for (const row of freshRows) {
    const rep = typeof row.report === 'string' ? JSON.parse(row.report) : row.report;
    f02ByDoc[row.document_id] = (rep?.findings || []).length;
  }
  const paired = runResults.filter((r) => r.status).map((r) => {
    const v02 = f02ByDoc[r.document_id] ?? r.nFindings ?? 0;
    return { document_id: r.document_id, nFindings: v02, base_findings: r.base_findings ?? 0, base_cited: r.base_cited ?? 0, delta_findings: v02 - (r.base_findings ?? 0) };
  });
  const meanDelta = paired.length ? paired.reduce((s, r) => s + r.delta_findings, 0) / paired.length : 0;

  const result = {
    label: LABEL, engine_version: IPD_ENGINE_VERSION, verifier: 'corpus-eval/1.0 (frozen)',
    started_at, finished_at: nowIso(),
    docs: { targeted: targets.length, audited_ok: ranDocs.length, skips: runResults.filter((r) => r.skip).length, errors: runResults.filter((r) => r.error).length },
    citation_rate: { findings: units.length, cited: cited.length, rate: +(cited.length / (units.length || 1)).toFixed(3) },
    support: { ...support, fallback_fired: fellBack },
    baseline_ref: { strict: 0.054, ci: [0.018, 0.146], cited_rate: 1.0, note: '.corpus-eval/baseline.json (0.1, PR0)' },
    paired_findings: { mean_delta_vs_baseline: +meanDelta.toFixed(2), per_doc: paired.map((r) => ({ doc: r.document_id.slice(0, 10), v02: r.nFindings, v01: r.base_findings, cited01: r.base_cited })) },
    verdicts,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  writeFileSync(STATUS, JSON.stringify({ stage: 'done', started_at, updated_at: nowIso(), done: true }, null, 2));

  console.log(`\n== IPD FIX RE-MEASURE (${LABEL}) · ${IPD_ENGINE_VERSION} ==`);
  console.log(`docs: audited ${ranDocs.length}/${targets.length} (skips ${result.docs.skips}, errors ${result.docs.errors})`);
  console.log(`citation rate: ${result.citation_rate.cited}/${result.citation_rate.findings} = ${result.citation_rate.rate}  (baseline 1.00)`);
  console.log(`STRICT SUPPORT: ${support.support_rate?.toFixed(3) ?? '—'}  CI [${support.support_rate_ci.map((x) => x.toFixed(3)).join(', ')}]  (n_assessable ${support.n_assessable})  (baseline 0.054 [0.018,0.146])`);
  console.log(`  incl-partial: ${support.support_rate_incl_partial?.toFixed(3) ?? '—'} · verdicts D${support.directly_supports}/P${support.partially_supports}/N${support.not_supported}/C${support.contradicts}/NA${support.not_assessable} · fallback ${fellBack}`);
  console.log(`paired findings/doc Δ vs baseline: ${meanDelta.toFixed(2)}`);
  console.log(`\nwrote ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('fix-remeasure failed:', e); process.exit(1); });
