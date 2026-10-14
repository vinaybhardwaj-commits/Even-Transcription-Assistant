#!/usr/bin/env node
/**
 * scripts/corpus-eval/pr5-remeasure.mjs — Brainstem PR5 SL3: the non-circular gate-on re-measure.
 *
 * Runs the fixed engine WITH the citation gate on (set DOC_AUDIT_CITE_GATE=1 when launching) over
 * the paired baseline docs, IN MEMORY (extract + analyze, trace:false, nothing persisted — the gate
 * stays dark, canonical 0.2 rows are untouched), then scores the SURVIVING cited findings with the
 * FROZEN PR0 Pro verifier. Non-circular by construction: the Flash critic drops in-engine, the Pro
 * verifier judges what survives — a different, stronger model on the finding-bundle grain.
 *
 * Excerpt resolution mirrors assemble-pack (full mksap_chunks.text by the report sources[].id).
 * Read-only. Artifacts under .corpus-eval/fix-remeasure/. Never CI.
 *
 * Run: DOC_AUDIT_CITE_GATE=1 node --env-file=.env.local --import tsx scripts/corpus-eval/pr5-remeasure.mjs [--n 60] [--conc 3] [--label gateon]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { fetchIpdDoc } from '../../lib/ipd-audit/db13.ts';
import { extractCase, analyzeCase } from '../../lib/doc-audit.ts';
import { getVertexAccessToken } from '../../lib/gcp-auth.ts';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';
import { supportStats, wilson } from '../../lib/corpus-eval/verify-core.ts';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); if (a) return a.split('=')[1]; const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const N = Math.max(1, parseInt(argOf('n', '60'), 10));
const CONC = Math.max(1, parseInt(argOf('conc', '3'), 10));
const LABEL = argOf('label', 'gateon');
const DIR = '.corpus-eval/fix-remeasure';
const STATUS = `${DIR}/pr5-status.json`;
const OUT = `${DIR}/pr5-remeasure-${LABEL}.json`;
const GATE_ON = process.env.DOC_AUDIT_CITE_GATE === '1';
const nowIso = () => new Date().toISOString();
const log = (...a) => console.error(...a);
const scrub = (s) => String(s ?? '').replace(/\bUHID[-\s:]*\d+/gi, '[uhid]').replace(/\b[6-9]\d{9}\b/g, '[phone]').replace(/\s+/g, ' ').trim();

async function fetchPdf(url) {
  let res = await fetch(url).catch(() => null);
  if (!res?.ok) { const token = await getVertexAccessToken(); res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
  if (!res.ok) throw new Error(`GCS ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function fetchChunks(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))]; const map = new Map();
  for (let i = 0; i < uniq.length; i += 500) {
    const rows = await sql(`SELECT id::text AS id, text FROM mksap_chunks WHERE id::text = ANY($1)`, [uniq.slice(i, i + 500)]);
    for (const r of rows) map.set(String(r.id), r.text);
  }
  return map;
}
function citedExcerpts(citationIds, sources, chunkText) {
  const byN = new Map((sources || []).map((s) => [Number(s.n), s]));
  const out = [];
  for (const cid of citationIds) {
    const s = byN.get(Number(cid)); if (!s) continue;
    const full = chunkText.get(String(s.id ?? ''));
    out.push({ text: scrub(full || s.preview || ''), meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null } });
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
  mkdirSync(DIR, { recursive: true });
  const started_at = nowIso();
  log(`[pr5-remeasure] DOC_AUDIT_CITE_GATE=${GATE_ON ? 'ON' : 'OFF'} · in-memory (no persist)`);

  const pack = JSON.parse(readFileSync('.corpus-eval/pack.json', 'utf8'));
  const rowIds = [...new Set(pack.units.filter((u) => u.consumer === 'ipd').map((u) => u.audit_ref))];
  const rows = await sql(`SELECT id::text AS id, document_id, ip_uid, member_id FROM ipd_discharge_audits WHERE id::text = ANY($1)`, [rowIds]);
  const order = new Map(rowIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const targets = rows.slice(0, N);
  log(`[pr5-remeasure] ${targets.length} paired docs · conc ${CONC}`);

  // ── extract + analyze in-memory (gate reads env at call time) ──
  const t0 = Date.now();
  let done = 0;
  const audits = await pool(targets, CONC, async (t) => {
    try {
      const doc = await fetchIpdDoc(t.document_id).catch(() => null);
      if (!doc?.pdfUrl) { done++; return { document_id: t.document_id, skip: 'no-pdf' }; }
      const buf = await fetchPdf(doc.pdfUrl);
      const { extracted } = await extractCase({ base64: buf.toString('base64'), mime: 'application/pdf', docTypeHint: 'discharge_summary', bytes: buf.length, trace: false });
      if (!extracted) { done++; return { document_id: t.document_id, skip: 'unreadable' }; }
      const ta = Date.now();
      const { report } = await analyzeCase(extracted, {}, { trace: false });
      const ms = Date.now() - ta;
      done++;
      const findings = report?.findings || []; const sources = report?.sources || [];
      log(`[pr5-remeasure] ${done}/${targets.length} ${t.document_id.slice(0, 10)} · ${findings.length}F · ${Math.round(ms / 1000)}s`);
      writeFileSync(STATUS, JSON.stringify({ stage: 'analyze', gate: GATE_ON, done, total: targets.length, elapsed_s: Math.round((Date.now() - t0) / 1000), updated_at: nowIso() }, null, 2));
      return { document_id: t.document_id, findings, sources, analyze_ms: ms };
    } catch (e) { done++; return { document_id: t.document_id, error: String(e.message).slice(0, 120) }; }
  });

  // ── assemble cited units + resolve excerpts ──
  const ok = audits.filter((a) => a.findings);
  const units = [];
  for (const a of ok) {
    for (const f of a.findings) {
      const claim = scrub(Array.isArray(f.evidence) ? f.evidence.join(' ') : (f.subject ?? ''));
      const cids = Array.isArray(f.citation_ids) ? f.citation_ids.map(Number).filter(Boolean) : [];
      units.push({ document_id: a.document_id, claim, cited: cids.length > 0, citation_ids: cids, _sources: a.sources });
    }
  }
  const chunkText = await fetchChunks(ok.flatMap((a) => (a.sources || []).map((s) => s.id)));
  for (const u of units) { u.excerpts = u.cited ? citedExcerpts(u.citation_ids, u._sources, chunkText) : []; delete u._sources; }
  const cited = units.filter((u) => u.cited && u.excerpts.length);
  const totalFindings = units.length;
  log(`[pr5-remeasure] ${ok.length} audits · ${totalFindings} findings · ${cited.length} cited (rate ${(cited.length / (totalFindings || 1)).toFixed(2)}) · verifying (Pro)…`);

  // ── FROZEN Pro verifier on survivors ──
  let vdone = 0, fell = 0;
  const verdicts = await pool(cited, CONC, async (u) => {
    const out = await verifyClaim(u.claim, u.excerpts.map((e) => ({ text: e.text, meta: e.meta })));
    vdone++; if (out.fellBack) fell++;
    if (vdone % 20 === 0) log(`[pr5-remeasure]   verified ${vdone}/${cited.length}`);
    writeFileSync(STATUS, JSON.stringify({ stage: 'verify', gate: GATE_ON, verified: vdone, total: cited.length, fallback_fired: fell, updated_at: nowIso() }, null, 2));
    return out.verdict;
  });
  const support = supportStats(verdicts);
  support.support_rate_ci = wilson(support.directly_supports, support.n_assessable);

  const analyzeMs = ok.map((a) => a.analyze_ms).filter((x) => x != null).sort((a, b) => a - b);
  const p = (q) => analyzeMs.length ? analyzeMs[Math.min(analyzeMs.length - 1, Math.floor(analyzeMs.length * q))] : null;

  const result = {
    label: LABEL, gate_on: GATE_ON, started_at, finished_at: nowIso(),
    docs: { targeted: targets.length, ok: ok.length, skipped: audits.filter((a) => a.skip).length, errored: audits.filter((a) => a.error).length },
    findings: { total: totalFindings, per_doc: +(totalFindings / (ok.length || 1)).toFixed(2), cited: cited.length, citation_rate: +(cited.length / (totalFindings || 1)).toFixed(3) },
    support: { ...support, fallback_fired: fell },
    analyze_latency_ms: { p50: p(0.5), p90: p(0.9), n: analyzeMs.length },
    baseline_ref: { enrichment_no_gate_strict: 0.457, enrichment_no_gate_incl_partial: 0.767, note: 'force-off 0.2 paired-60' },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  writeFileSync(STATUS, JSON.stringify({ stage: 'done', gate: GATE_ON, done: true, updated_at: nowIso() }, null, 2));

  console.log(`\n== PR5 SL3 · gate-${GATE_ON ? 'ON' : 'OFF'} re-measure (Pro PR0 verifier, non-circular) ==`);
  console.log(`docs ${ok.length}/${targets.length} · findings/doc ${result.findings.per_doc} · cited ${cited.length} (rate ${result.findings.citation_rate})`);
  console.log(`STRICT SUPPORT: ${support.support_rate?.toFixed(3) ?? '—'} CI [${support.support_rate_ci.map((x) => x.toFixed(3)).join(', ')}] (n ${support.n_assessable}) · vs enrichment-no-gate 0.457`);
  console.log(`  incl-partial ${support.support_rate_incl_partial?.toFixed(3) ?? '—'} · D${support.directly_supports}/P${support.partially_supports}/N${support.not_supported}/C${support.contradicts}/NA${support.not_assessable} · fallback ${fell}`);
  console.log(`analyze latency: p50 ${Math.round((result.analyze_latency_ms.p50 ?? 0) / 1000)}s · p90 ${Math.round((result.analyze_latency_ms.p90 ?? 0) / 1000)}s`);
  console.log(`wrote ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('pr5-remeasure failed:', e); process.exit(1); });
