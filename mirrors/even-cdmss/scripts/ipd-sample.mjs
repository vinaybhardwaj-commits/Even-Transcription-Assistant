// scripts/ipd-sample.mjs — IPD Discharge Audit M0: the stratified 25-PDF sample + extract pack.
//
// Pulls N text discharge-summary PDFs from db13 (`accounts-members-miscellaneous_documents`,
// classification DISCHARGE_SUMMARY, un-ingested, real .pdf), STRATIFIED across specialities and
// months (kx_discharge_summary_records join on ipd_no = booking_id), fetches each PDF from GCS
// (plain URL first, then the CDMSS service-account Bearer token), and runs the SHIPPED engine —
// doc-audit extract → analyze (NABH completeness + Low-Value findings + diff) → value-score-core
// (Care-Value Index + 6 domains) — calling it, never editing it.
//
// Emits the sample pack for V's gold ratification: one row per case with the de-identified
// extract + audit + link-back keys, as JSON and a readable Markdown table. NO PHI in the pack
// (the extract is de-identified by the engine's cardinal privacy rule; document_id/ip_uid/
// member_id and source_pdf_url are the re-identification path for V's access-controlled review).
// The OUTPUT FILES are local/uncommitted — the repo is public; do NOT commit the pack.
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/ipd-sample.mjs [--n 25] [--width 3] [--out ipd-audit-m0-sample-pack]
//
// scoring:false · measurement setup only · nothing persisted to Neon (M0 gates the scale run).

import { writeFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { metabaseQuery } from '../lib/metabase.ts';
import { extractCase, analyzeCase } from '../lib/doc-audit.ts';
import { getVertexAccessToken } from '../lib/gcp-auth.ts';

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const N = Math.max(5, Number(argOf('--n') ?? 25) | 0);
const WIDTH = Math.max(1, Number(argOf('--width') ?? 3) | 0);
const OUT = argOf('--out') ?? 'ipd-audit-m0-sample-pack';

const T = '"accounts-members-miscellaneous_documents"';
const CLS = `m.document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;

// ── 1. candidate pool (db13, read-only) ─────────────────────────────────────────────────────────
// kx join: DISTINCT ON admission, Final over Draft (the ccb-dossier idiom).
const POOL_SQL = `SELECT m._doc_id AS document_id, m._parent_doc_id AS member_id,
  m.additional_metadata__booking_id AS ip_uid, m.document__upload_uri AS pdf_url,
  m.upload_timestamp::timestamptz AS uploaded_at,
  k.treating_doctor_speciality AS speciality, k.ward, k.discharge_type, k.status AS kx_status,
  to_char(k.admission_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS admit_date,
  to_char(k.discharge_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharge_date,
  greatest(0, (k.discharge_date_time::date - k.admission_date_time::date))::int AS los_days,
  to_char(coalesce(k.discharge_date_time, k.admission_date_time, m.upload_timestamp::timestamptz) AT TIME ZONE 'Asia/Kolkata','YYYY-MM') AS month
  FROM ${T} m
  LEFT JOIN (SELECT DISTINCT ON (ipd_no) * FROM kx_discharge_summary_records
             ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST) k
    ON k.ipd_no = m.additional_metadata__booking_id
  WHERE ${CLS} AND m.document__upload_uri ILIKE '%.pdf' AND m.document__is_ingested IS NULL
  ORDER BY m.upload_timestamp::timestamptz DESC`;

// ── 2. stratified pick: quotas over the top specialities, months spread within each ─────────────
function stratify(pool, n) {
  const bySpec = new Map();
  for (const r of pool) {
    const s = r.speciality || '(no kx match)';
    if (!bySpec.has(s)) bySpec.set(s, []);
    bySpec.get(s).push(r);
  }
  // top specialities by volume, excluding the unjoined bucket from the quota ranking
  const ranked = [...bySpec.entries()].filter(([s]) => s !== '(no kx match)').sort((a, b) => b[1].length - a[1].length);
  const K = Math.min(8, ranked.length);
  const top = ranked.slice(0, K);
  // proportional-ish quotas, min 2 per stratum, sum = n
  const total = top.reduce((s, [, v]) => s + v.length, 0);
  let quotas = top.map(([, v]) => Math.max(2, Math.round((v.length / total) * n)));
  let sum = quotas.reduce((a, b) => a + b, 0);
  for (let i = 0; sum !== n; i = (i + 1) % quotas.length) {
    if (sum > n && quotas[i] > 2) { quotas[i]--; sum--; }
    else if (sum < n) { quotas[i]++; sum++; }
  }
  // within a stratum: sort by month, take evenly spaced (spreads the month range)
  const picked = [];
  top.forEach(([spec, rows], i) => {
    const sorted = [...rows].sort((a, b) => String(a.month).localeCompare(String(b.month)));
    const q = quotas[i];
    const step = sorted.length / q;
    const used = new Set();
    for (let j = 0; j < q; j++) {
      let idx = Math.min(sorted.length - 1, Math.floor(j * step + step / 2));
      while (used.has(idx) && idx < sorted.length - 1) idx++;
      used.add(idx);
      picked.push(sorted[idx]);
    }
    // keep the rest as same-stratum fallbacks (scan replacements), nearest-first
    sorted.forEach((r, idx) => { if (!used.has(idx)) picked.push({ ...r, __fallback: spec }); });
  });
  return { picked: picked.filter((r) => !r.__fallback), fallbacks: picked.filter((r) => r.__fallback) };
}

// ── 3. GCS fetch (plain URL first → service-account Bearer) ─────────────────────────────────────
let openUrlWorked = null; // the infra question: is the bucket publicly readable?
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchPdf(url) {
  // 3 attempts with backoff — a transient network blip mid-run must not wipe a stratum
  // (first run lost 7/25 to one instantly-cascading 'fetch failed' burst).
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 4000);
    try {
      const plain = await fetch(url).catch(() => null);
      if (plain?.ok) { if (openUrlWorked === null) openUrlWorked = true; return Buffer.from(await plain.arrayBuffer()); }
      if (openUrlWorked === null) openUrlWorked = false;
      const token = await getVertexAccessToken();
      const authed = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!authed.ok) throw new Error(`GCS fetch ${authed.status}`);
      return Buffer.from(await authed.arrayBuffer());
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ── 4. text-PDF heuristic: any content stream with text-showing operators (Tj/TJ) ───────────────
function isTextPdf(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return false;
  const raw = buf.toString('latin1');
  if (/\b(Tj|TJ)\b/.test(raw)) return true;      // uncompressed text ops
  // inflate FlateDecode streams and look for text ops
  let i = 0, checked = 0;
  while ((i = raw.indexOf('stream', i)) !== -1 && checked < 40) {
    const start = raw[i + 6] === '\r' ? i + 8 : i + 7;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    try {
      const out = inflateSync(buf.subarray(start, end)).toString('latin1');
      if (/\b(Tj|TJ)\b/.test(out)) return true;
    } catch { /* not flate or partial — skip */ }
    checked++; i = end + 9;
  }
  return false;
}

// ── 5. per-case pipeline: fetch → extract → analyze (shipped engine, untraced) ──────────────────
async function runCase(row) {
  const t0 = Date.now();
  const buf = await fetchPdf(row.pdf_url);
  if (!isTextPdf(buf)) return { row, skipped: 'scan (no text layer)' };
  const { extracted } = await extractCase({
    base64: buf.toString('base64'), mime: 'application/pdf',
    docTypeHint: 'discharge_summary', bytes: buf.length, trace: false,
  });
  if (!extracted) return { row, skipped: 'extract failed' };
  const { report } = await analyzeCase(extracted, {}, { trace: false });
  if (!report) return { row, extracted, skipped: 'analyze failed' };
  return { row, extracted, report, ms: Date.now() - t0, bytes: buf.length };
}

async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ── 6. run ──────────────────────────────────────────────────────────────────────────────────────
console.log(`[ipd-sample] pulling candidate pool from db13…`);
const rows = await metabaseQuery(POOL_SQL);
console.log(`[ipd-sample] pool: ${rows.length} un-ingested text-candidate PDFs`);
const { picked, fallbacks } = stratify(rows, N);
console.log(`[ipd-sample] stratified pick: ${picked.length} across ${new Set(picked.map((r) => r.speciality)).size} specialities`);

const results = [];
const fallbackQueue = new Map(); // spec → fallback rows
for (const f of fallbacks) {
  if (!fallbackQueue.has(f.__fallback)) fallbackQueue.set(f.__fallback, []);
  fallbackQueue.get(f.__fallback).push(f);
}

const firstPass = await pool(picked, WIDTH, async (row, i) => {
  const r = await runCase(row).catch((e) => ({ row, skipped: `error: ${e.message}` }));
  console.log(`[ipd-sample] ${i + 1}/${picked.length} ${row.ip_uid ?? row.document_id} · ${row.speciality} · ${r.skipped ? `SKIP (${r.skipped})` : `CVI ${r.report.valueScore?.headline} (${r.report.valueScore?.band}) in ${Math.round((r.ms ?? 0) / 1000)}s`}`);
  return r;
});
results.push(...firstPass.filter((r) => r.report));

// replace skips from the same stratum (one retry round, sequential — the tail is small)
for (const skip of firstPass.filter((r) => !r.report)) {
  const q = fallbackQueue.get(skip.row.speciality) ?? [];
  let replaced = false;
  while (q.length && !replaced) {
    const cand = q.shift();
    const r = await runCase(cand).catch((e) => ({ row: cand, skipped: `error: ${e.message}` }));
    console.log(`[ipd-sample] replace ${skip.row.ip_uid} (${skip.skipped}) → ${cand.ip_uid} · ${r.skipped ? `SKIP (${r.skipped})` : `CVI ${r.report.valueScore?.headline} (${r.report.valueScore?.band})`}`);
    if (r.report) { results.push(r); replaced = true; }
  }
  if (!replaced) console.log(`[ipd-sample] !! no same-stratum replacement for ${skip.row.ip_uid} (${skip.skipped})`);
}

// ── 7. emit the pack (JSON + Markdown) ──────────────────────────────────────────────────────────
const cases = results.map(({ row, extracted, report }) => ({
  ip_uid: row.ip_uid, document_id: row.document_id, member_id: row.member_id,
  speciality: row.speciality, ward: row.ward, discharge_type: row.discharge_type || null,
  kx_status: row.kx_status, los_days: row.los_days, month: row.month,
  admit_date: row.admit_date, discharge_date: row.discharge_date,
  source_pdf_url: row.pdf_url,
  extract: extracted,
  completeness: {
    coverage: report.completeness.coverage,
    mandatoryMet: report.completeness.mandatoryMet, mandatoryTotal: report.completeness.mandatoryTotal,
    missingMandatory: report.completeness.missingMandatory,
  },
  low_value_findings: report.findings.map((f) => ({
    subject: f.subject, verdict: f.verdict, confidence: f.confidence, domain: f.domain ?? null,
    rationale: f.rationale, order: f.order ?? null, tariffs: f.tariffs ?? null,
  })),
  diff: report.diff, suggestions: report.suggestions,
  care_value_index: report.valueScore?.headline ?? null, band: report.valueScore?.band ?? null,
  domains: report.valueScore?.domains.map((d) => ({ domain: d.domain, score: d.score, basis: d.basis })) ?? [],
  low_value_spend: report.valueScore?.lowValueSpend ?? null,
}));

cases.sort((a, b) => String(a.speciality).localeCompare(String(b.speciality)) || String(a.month).localeCompare(String(b.month)));

const stability = {
  n: cases.length,
  detected_doc_type_mismatches: cases.filter((c) => c.extract.detectedDocType !== 'discharge_summary').map((c) => ({ ip_uid: c.ip_uid, detected: c.extract.detectedDocType })),
  low_confidence_extracts: cases.filter((c) => (c.extract.confidence ?? 0) < 0.7).map((c) => ({ ip_uid: c.ip_uid, confidence: c.extract.confidence })),
  thin_sections: cases.filter((c) => !c.extract.investigations.length || !c.extract.medications.length || !c.extract.courseSummary)
    .map((c) => ({ ip_uid: c.ip_uid, investigations: c.extract.investigations.length, medications: c.extract.medications.length, course: !!c.extract.courseSummary })),
  // the '28/1125'-style glitch: a dd/NNNN where NNNN is NOT a plausible year and the match is
  // not the mm/yyyy tail of a full dd/mm/yyyy date (which the extractor echoes legitimately)
  suspect_date_artefacts: cases.filter((c) => {
    const txt = JSON.stringify(c.extract);
    const rx = /(\d)?\/?(\b\d{1,2})\/(\d{3,4})\b/g;
    let m;
    while ((m = rx.exec(txt)) !== null) {
      if (m[1] !== undefined) continue;                    // tail of dd/mm/yyyy — legit date
      if (/^(19|20)\d\d$/.test(m[3])) continue;            // plausible mm/yyyy — legit
      return true;                                          // dd/garbled-year → the glitch
    }
    return false;
  }).map((c) => c.ip_uid),
  missing_los: cases.filter((c) => c.extract.adminFacts?.lengthOfStayDays == null).map((c) => c.ip_uid),
  raw_notes: cases.map((c) => ({ ip_uid: c.ip_uid, notes: c.extract.rawNotes })).filter((x) => x.notes),
};

const pack = {
  version: 'ipd-audit-m0-sample/1',
  purpose: "M0 sample pack for V's IPD audit gold ratification (single-validator). Engine: shipped doc-audit extract+analyze + value-score-core, untouched.",
  engine: 'ipd-discharge-audit/0.1 (candidate)',
  privacy: 'De-identified extract only; document_id/ip_uid/member_id + source_pdf_url are the link-back re-identification path. LOCAL PACK — do not commit (public repo).',
  gcs_open_url: openUrlWorked,
  stratification: Object.fromEntries([...new Set(cases.map((c) => c.speciality))].map((s) => [s, cases.filter((c) => c.speciality === s).length])),
  months: Object.fromEntries([...new Set(cases.map((c) => c.month))].sort().map((m) => [m, cases.filter((c) => c.month === m).length])),
  template_stability: stability,
  cases,
};
writeFileSync(`${OUT}.json`, JSON.stringify(pack, null, 2));

// Markdown table for V
const md = [];
md.push(`# IPD Discharge Audit — M0 sample pack (${cases.length} cases)\n`);
md.push(`> ${pack.purpose}\n> GCS open-URL fetch worked without auth: **${openUrlWorked}** (infra question — flagged, not relied on).\n`);
md.push(`## Stratification\n`);
md.push(`| Speciality | n | | Month | n |`);
md.push(`|---|---|---|---|---|`);
const specs = Object.entries(pack.stratification);
const months = Object.entries(pack.months);
for (let i = 0; i < Math.max(specs.length, months.length); i++) {
  md.push(`| ${specs[i]?.[0] ?? ''} | ${specs[i]?.[1] ?? ''} | | ${months[i]?.[0] ?? ''} | ${months[i]?.[1] ?? ''} |`);
}
md.push(`\n## Cases\n`);
md.push(`| # | IP | Speciality | Month | LOS | Discharge | CVI | Band | Compl. | LVC findings (low-value / context-dep) | Missing mandatory |`);
md.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
cases.forEach((c, i) => {
  const lv = c.low_value_findings.filter((f) => f.verdict === 'low-value').length;
  const cd = c.low_value_findings.filter((f) => f.verdict === 'context-dependent').length;
  md.push(`| ${i + 1} | ${c.ip_uid ?? '—'} | ${c.speciality} | ${c.month} | ${c.los_days ?? '—'} | ${c.discharge_type ?? '—'} | ${c.care_value_index} | ${c.band} | ${Math.round(c.completeness.coverage * 100)}% | ${lv} / ${cd} | ${c.completeness.missingMandatory.length} |`);
});
md.push(`\n## Per-case detail\n`);
cases.forEach((c, i) => {
  md.push(`### ${i + 1}. ${c.ip_uid ?? c.document_id} — ${c.speciality} (${c.month}, LOS ${c.los_days ?? '?'}d)\n`);
  md.push(`**Dx:** ${c.extract.diagnosis ?? '—'}${c.extract.procedure ? ` · **Proc:** ${c.extract.procedure}` : ''}`);
  md.push(`**Course:** ${c.extract.courseSummary}`);
  md.push(`**CVI ${c.care_value_index} (${c.band})** · completeness ${Math.round(c.completeness.coverage * 100)}% · missing: ${c.completeness.missingMandatory.join('; ') || 'none'}`);
  if (c.low_value_findings.length) {
    md.push(`\n| Finding | Verdict | Domain | Rationale |`);
    md.push(`|---|---|---|---|`);
    for (const f of c.low_value_findings) md.push(`| ${f.subject} | ${f.verdict} | ${f.domain ?? '—'} | ${f.rationale.slice(0, 160)} |`);
  }
  md.push(`\n[source PDF](${c.source_pdf_url})\n`);
});
md.push(`## Template stability\n`);
md.push('```json\n' + JSON.stringify(stability, null, 2) + '\n```\n');
writeFileSync(`${OUT}.md`, md.join('\n'));

console.log(`\n== M0 SAMPLE PACK ==`);
console.log(`cases ${cases.length} · specialities ${specs.length} · months ${months.length}`);
console.log(`GCS open-URL (no auth) worked: ${openUrlWorked}`);
console.log(`doc-type mismatches ${stability.detected_doc_type_mismatches.length} · low-confidence ${stability.low_confidence_extracts.length} · thin ${stability.thin_sections.length} · date artefacts ${stability.suspect_date_artefacts.length}`);
console.log(`wrote ${OUT}.json + ${OUT}.md (LOCAL — do not commit)`);
process.exit(0);
