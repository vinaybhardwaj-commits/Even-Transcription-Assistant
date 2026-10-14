// scripts/ipd-s4-bench.mjs — IPD Discharge Audit S4 measurement (K=5 reproducibility + the
// fresh-corpus slice). Two phases, run separately:
//
//   --phase k5    K=5 full-chain repeats (fetch-once → extract+analyze ×5, UNTRACED, nothing
//                 persisted) over the 25 frozen gold cases (data/ipd-audit-gold.json, loaded
//                 through the hash-pinned loader). REFRAMED METRICS (S4 decision, option b —
//                 exact-CVI/exact-band retired as targets): ±1-TIER band match vs the gold's
//                 K=5 modal band, COMPLETENESS point agreement, and low-value THEME agreement
//                 (recall/precision on finding subjects, not exact counts/verdicts — the
//                 primary quality metric). Raw draws (CVIs, bands, LVC subjects) are retained
//                 in the pack. Also emits an .md roll-up beside the JSON. The numbers are
//                 REPORTED, never self-certified — V reads the pass.
//   --phase slice Runs the shipped single-doc chain ONCE over N fresh, never-audited text
//                 PDFs (excluding the gold docs) and PERSISTS each via lib/ipd-audit/store
//                 (traced, exactly the audit-now path) so the surface fills with real rows.
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/ipd-s4-bench.mjs --phase k5 [--k 5] [--width 4] --out <path>
//   node --env-file=.env.local --import tsx scripts/ipd-s4-bench.mjs --phase slice [--n 50] [--width 4] --out <path>
//
// Execution honesty: every failed chain is counted and listed; a systemically contaminated
// run (e.g. a mid-run outage) is discarded and re-run, never reported as clean.
// scoring:false · the engine is called, never edited.

import { writeFileSync, readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { metabaseQuery } from '../lib/metabase.ts';
import { extractCase, analyzeCase } from '../lib/doc-audit.ts';
import { getVertexAccessToken } from '../lib/gcp-auth.ts';
import { loadIpdAuditGold } from '../lib/ipd-audit/gold.ts';
import { buildIpdAuditRow } from '../lib/ipd-audit/assemble.ts';
import { saveIpdAudit, IPD_ENGINE_VERSION } from '../lib/ipd-audit/store.ts';
import { fetchIpdAdmissionHeader } from '../lib/ipd-audit/db13.ts';
import { GEMINI_MODEL } from '../lib/llm.ts';
import { sql } from '../lib/db.ts';
import GOLD from '../data/ipd-audit-gold.json' with { type: 'json' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const PHASE = argOf('--phase');
const K = Math.max(2, Number(argOf('--k') ?? 5) | 0);
const N = Math.max(5, Number(argOf('--n') ?? 50) | 0);
const WIDTH = Math.max(1, Number(argOf('--width') ?? 4) | 0);
const OUT = argOf('--out');
if (PHASE !== 'k5' && PHASE !== 'slice') { console.error('need --phase k5|slice'); process.exit(2); }

const DOCS = '"accounts-members-miscellaneous_documents"';
const CLS = `document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function isTextPdf(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return false;
  const raw = buf.toString('latin1');
  if (/\b(Tj|TJ)\b/.test(raw)) return true;
  let i = 0, checked = 0;
  while ((i = raw.indexOf('stream', i)) !== -1 && checked < 40) {
    const start = raw[i + 6] === '\r' ? i + 8 : i + 7;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    try { if (/\b(Tj|TJ)\b/.test(inflateSync(buf.subarray(start, end)).toString('latin1'))) return true; } catch { /* skip */ }
    checked++; i = end + 9;
  }
  return false;
}

async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const modal = (a) => { const c = {}; for (const x of a) c[x] = (c[x] ?? 0) + 1; return Object.entries(c).sort((p, q) => q[1] - p[1])[0][0]; };

// ── theme matching (deterministic, documented) ──────────────────────────────────────────────────
// A "theme" is the SUBJECT of a low-value / context-dependent finding. Two subjects match when
// their content-token overlap clears 0.5 in EITHER direction (containment) — so "Post-operative
// Antibiotic Course" matches "Extended Post-Operative Antibiotic Course". Verdict flavour
// (LV vs CD) is deliberately ignored: the theme being SURFACED is the signal.
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'to', 'with', 'use', 'therapy', 'course']);
const themeTokens = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((t) => t.length > 2 && !STOP.has(t)));
export function themesMatch(a, b) {
  const ta = themeTokens(a), tb = themeTokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / ta.size >= 0.5 || inter / tb.size >= 0.5;
}
const lvcSubjects = (findings) => (findings ?? [])
  .filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent')
  .map((f) => f.subject);
const BAND_ORDER = 'ABCDE';
const within1 = (a, b) => Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b)) <= 1;

// ── phase k5 ────────────────────────────────────────────────────────────────────────────────────
if (PHASE === 'k5') {
  const t0 = Date.now();
  const gold = loadIpdAuditGold(GOLD);   // hash-pinned — a drifted gold refuses to load
  console.log(`[s4-k5] ${gold.cases.length} gold cases × K=${K} = ${gold.cases.length * K} full chains, width ${WIDTH}`);

  // resolve pdf urls by document_id (the gold deliberately carries no URLs)
  const ids = gold.cases.map((c) => `'${c.document_id}'`).join(',');
  const urlRows = await metabaseQuery(`SELECT _doc_id, document__upload_uri AS url FROM ${DOCS} WHERE _doc_id IN (${ids}) AND ${CLS}`);
  const urlOf = Object.fromEntries(urlRows.map((r) => [String(r._doc_id), String(r.url)]));

  const pdfCache = new Map();   // document_id → Promise<Buffer> (fetch once per case)
  const getPdf = (docId) => {
    if (!pdfCache.has(docId)) pdfCache.set(docId, fetchPdf(urlOf[docId]));
    return pdfCache.get(docId);
  };

  const jobs = [];
  gold.cases.forEach((c) => { for (let r = 0; r < K; r++) jobs.push(c); });
  let done = 0;
  const results = await pool(jobs, WIDTH, async (c) => {
    try {
      const buf = await getPdf(c.document_id);
      const { extracted } = await extractCase({ base64: buf.toString('base64'), mime: 'application/pdf', docTypeHint: 'discharge_summary', bytes: buf.length, trace: false });
      if (!extracted) return { id: c.id, error: 'extract failed' };
      const { report } = await analyzeCase(extracted, {}, { trace: false });
      if (!report?.valueScore) return { id: c.id, error: 'analyze failed' };
      const f = report.findings ?? [];
      const run = {
        id: c.id, cvi: report.valueScore.headline, band: report.valueScore.band,
        compl: Math.round((report.completeness?.coverage ?? 0) * 100),
        nF: f.length, nLV: f.filter((x) => x.verdict === 'low-value').length,
        lvcSubjects: lvcSubjects(f),   // raw draws retained (the 1.0 pack didn't — flagged)
      };
      done++; if (done % 10 === 0) console.log(`[s4-k5] ${done}/${jobs.length} chains done (${Math.round((Date.now() - t0) / 60000)} min)`);
      return run;
    } catch (e) { return { id: c.id, error: String(e?.message ?? e) }; }
  });

  const errors = results.filter((r) => r.error);
  const perCase = gold.cases.map((c) => {
    const runs = results.filter((r) => r.id === c.id && !r.error);
    const cvis = runs.map((r) => r.cvi);
    const bands = runs.map((r) => r.band);
    const goldThemes = lvcSubjects(c.findings);
    // per-run reframed scores vs the 1.1 distribution gold
    const runScores = runs.map((r) => {
      const matchedGold = goldThemes.filter((g) => r.lvcSubjects.some((s) => themesMatch(g, s)));
      const matchedRun = r.lvcSubjects.filter((s) => goldThemes.some((g) => themesMatch(g, s)));
      return {
        band_within1: within1(r.band, c.band_modal),
        compl_delta: Math.abs(r.compl - c.completeness_pct),
        theme_recall: goldThemes.length ? matchedGold.length / goldThemes.length : 1,
        theme_precision: r.lvcSubjects.length ? matchedRun.length / r.lvcSubjects.length : 1,
        missed_themes: goldThemes.filter((g) => !matchedGold.includes(g)),
      };
    });
    return {
      id: c.id, ip_uid: c.ip_uid, speciality: c.speciality,
      gold: { band_modal: c.band_modal, band_range: c.band_range, cvi_mean: c.cvi_mean, completeness_pct: c.completeness_pct, themes: goldThemes },
      k: runs.length,
      raw_runs: runs.map((r) => ({ cvi: r.cvi, band: r.band, compl: r.compl, lvcSubjects: r.lvcSubjects })),
      cvi_mean: +mean(cvis).toFixed(1), cvi_sd: +sd(cvis).toFixed(1),
      bands: bands.join(''), modal_band: bands.length ? modal(bands) : null,
      band_within1_rate: +mean(runScores.map((s) => (s.band_within1 ? 1 : 0))).toFixed(2),
      compl_mean_abs_delta: +mean(runScores.map((s) => s.compl_delta)).toFixed(1),
      theme_recall: +mean(runScores.map((s) => s.theme_recall)).toFixed(2),
      theme_precision: +mean(runScores.map((s) => s.theme_precision)).toFixed(2),
      themes_always_missed: goldThemes.filter((g) => runScores.every((s) => s.missed_themes.includes(g))),
    };
  });

  const allRunScores = perCase.flatMap((c) => c.raw_runs.map((r) => within1(r.band, c.gold.band_modal) ? 1 : 0));
  const summary = {
    version: 'ipd-audit-s4-k5/2 (reframed)', gold_version: gold.version, k: K,
    chains: jobs.length, errors: errors.length,
    band_within1_pct: +(100 * mean(allRunScores)).toFixed(1),
    band_within1_all_runs_cases: perCase.filter((c) => c.band_within1_rate === 1).length,
    theme_recall_mean: +mean(perCase.map((c) => c.theme_recall)).toFixed(2),
    theme_precision_mean: +mean(perCase.map((c) => c.theme_precision)).toFixed(2),
    compl_mean_abs_delta: +mean(perCase.map((c) => c.compl_mean_abs_delta)).toFixed(1),
    cases_with_always_missed_themes: perCase.filter((c) => c.themes_always_missed.length).map((c) => ({ id: c.id, missed: c.themes_always_missed })),
    minutes: +(((Date.now() - t0) / 60000).toFixed(1)),
  };

  console.log(`\n== S4 K=${K} · REFRAMED READ (vs ${gold.version}: ±1-tier band + completeness + themes) ==`);
  console.log(`chains ${summary.chains} · errors ${summary.errors} · ${summary.minutes} min`);
  if (errors.length) console.log(`!! errors: ${errors.map((e) => `${e.id}:${e.error}`).slice(0, 8).join(' · ')}`);
  console.log(`±1-tier band match: ${summary.band_within1_pct}% of runs (${summary.band_within1_all_runs_cases}/${perCase.length} cases at ${K}/${K})`);
  console.log(`theme agreement: recall ${summary.theme_recall_mean} · precision ${summary.theme_precision_mean}`);
  console.log(`completeness mean |Δ|: ${summary.compl_mean_abs_delta} pp`);
  console.log(`\n-- per-case (gold modal[range] → K${K} modal · ±1 rate · themes r/p · compl |Δ|) --`);
  for (const c of perCase) {
    console.log(`  ${c.id} ${String(c.ip_uid).padEnd(16)} ${c.gold.band_modal}[${c.gold.band_range}] → ${c.modal_band} ${c.bands} · ±1 ${(c.band_within1_rate * 100).toFixed(0)}% · themes ${c.theme_recall}/${c.theme_precision} · compl Δ${c.compl_mean_abs_delta}`);
  }
  if (summary.cases_with_always_missed_themes.length) {
    console.log(`\n-- gold themes NEVER surfaced in ${K} runs --`);
    for (const m of summary.cases_with_always_missed_themes) console.log(`  ${m.id}: ${m.missed.join(' · ')}`);
  }
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ summary, perCase }, null, 2));
    const mdOut = OUT.replace(/\.json$/, '.md');
    const md = [
      `# IPD audit S4 — K=${K} reframed roll-up (vs ${gold.version})`, '',
      `> Framing (S4 decision, option b): exact-CVI/exact-band retired. Pass-read = **±1-tier band match + low-value theme agreement + completeness**. Numbers reported, not self-certified.`, '',
      `| Metric | Value |`, `|---|---|`,
      `| Chains (errors) | ${summary.chains} (${summary.errors}) |`,
      `| **±1-tier band match** | **${summary.band_within1_pct}%** of runs · ${summary.band_within1_all_runs_cases}/${perCase.length} cases at ${K}/${K} |`,
      `| **Theme recall / precision** | **${summary.theme_recall_mean} / ${summary.theme_precision_mean}** |`,
      `| **Completeness mean abs. delta** | **${summary.compl_mean_abs_delta} pp** |`, '',
      `## Per case`, '',
      `| Case | IP | Gold modal [range] | K${K} bands | ±1 rate | Theme R/P | Compl. delta |`, `|---|---|---|---|---|---|---|`,
      ...perCase.map((c) => `| ${c.id} | ${c.ip_uid} | ${c.gold.band_modal} [${c.gold.band_range}] | ${c.bands} | ${(c.band_within1_rate * 100).toFixed(0)}% | ${c.theme_recall}/${c.theme_precision} | ${c.compl_mean_abs_delta} |`),
      '',
      summary.cases_with_always_missed_themes.length ? `## Gold themes never surfaced\n\n${summary.cases_with_always_missed_themes.map((m) => `- **${m.id}**: ${m.missed.join(' · ')}`).join('\n')}` : '## Gold themes never surfaced\n\nNone — every gold low-value theme appeared in at least one repeat.',
    ].join('\n');
    writeFileSync(mdOut, md + '\n');
    console.log(`\nwrote ${OUT} + ${mdOut}`);
  }
  process.exit(0);
}

// ── phase slice ─────────────────────────────────────────────────────────────────────────────────
if (PHASE === 'slice') {
  const t0 = Date.now();
  const gold = loadIpdAuditGold(GOLD);
  const goldDocIds = new Set(gold.cases.map((c) => c.document_id));
  const audited = (await sql(`SELECT DISTINCT document_id FROM ipd_discharge_audits`)).map((r) => r.document_id);
  const excluded = new Set([...goldDocIds, ...audited]);

  // fresh = most recent, never-audited, non-gold text PDFs (buffer 2× for scan/failure skips)
  const rows = await metabaseQuery(
    `SELECT m._doc_id AS document_id, m._parent_doc_id AS member_id,
            m.additional_metadata__booking_id AS ip_uid, m.document__upload_uri AS pdf_url
     FROM ${DOCS} m
     WHERE ${CLS} AND m.document__upload_uri ILIKE '%.pdf' AND m.document__is_ingested IS NULL
     ORDER BY m.upload_timestamp::timestamptz DESC LIMIT ${N * 2 + excluded.size}`);
  const candidates = rows.filter((r) => !excluded.has(String(r.document_id)));
  console.log(`[s4-slice] ${candidates.length} fresh candidates → target ${N}, width ${WIDTH}`);

  let taken = 0, idx = 0;
  const outcomes = [];
  await pool(Array.from({ length: WIDTH }, (_, w) => w), WIDTH, async () => {
    for (;;) {
      if (taken >= N || idx >= candidates.length) return;
      const c = candidates[idx++];
      try {
        const buf = await fetchPdf(String(c.pdf_url));
        if (!isTextPdf(buf)) { outcomes.push({ doc: c.document_id, skip: 'scan' }); continue; }
        const { extracted, traceId: extractTraceId } = await extractCase({ base64: buf.toString('base64'), mime: 'application/pdf', docTypeHint: 'discharge_summary', bytes: buf.length });
        if (!extracted) { outcomes.push({ doc: c.document_id, skip: 'extract failed', extractTraceId }); continue; }
        const { report, traceId } = await analyzeCase(extracted);
        if (!report?.valueScore) { outcomes.push({ doc: c.document_id, skip: 'analyze failed', traceId }); continue; }
        const header = c.ip_uid ? await fetchIpdAdmissionHeader(String(c.ip_uid)).catch(() => null) : null;
        const row = buildIpdAuditRow({
          documentId: String(c.document_id), ipUid: c.ip_uid ? String(c.ip_uid) : null,
          memberId: c.member_id ? String(c.member_id) : null,
          speciality: header?.speciality ?? null, dischargeType: header?.dischargeType ?? null,
          losDays: header?.losDays ?? null,
          dischargedAt: header?.dischargeDate ? `${header.dischargeDate}T00:00:00+05:30` : null,
          engineVersion: IPD_ENGINE_VERSION, model: GEMINI_MODEL, traceId: traceId ?? null,
        }, extracted, report);
        const saved = await saveIpdAudit(row);
        taken++;
        outcomes.push({ doc: c.document_id, ip: row.ipUid, saved, cvi: row.careValueIndex, band: row.band, nF: row.nFindings, nLV: row.nLowValue, compl: row.completenessPct, spec: row.speciality });
        console.log(`[s4-slice] ${taken}/${N} ${row.ipUid ?? c.document_id} · ${row.speciality ?? '—'} · ${row.band}·${row.careValueIndex} (${saved})`);
      } catch (e) { outcomes.push({ doc: c.document_id, skip: `error: ${String(e?.message ?? e)}` }); }
    }
  });

  const ok = outcomes.filter((o) => o.saved);
  const skips = outcomes.filter((o) => o.skip);
  const bands = {};
  for (const o of ok) bands[o.band] = (bands[o.band] ?? 0) + 1;
  console.log(`\n== S4 FRESH-CORPUS SLICE ==`);
  console.log(`persisted ${ok.length}/${N} · skips ${skips.length} (${skips.map((s) => s.skip).reduce((m, s) => { m[s] = (m[s] ?? 0) + 1; return m; }, {}) && JSON.stringify(skips.reduce((m, s) => { m[s.skip.split(':')[0]] = (m[s.skip.split(':')[0]] ?? 0) + 1; return m; }, {}))}) · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`bands: ${Object.entries(bands).sort().map(([b, n]) => `${b}×${n}`).join(' · ')}`);
  console.log(`CVI: mean ${+mean(ok.map((o) => o.cvi)).toFixed(1)} · min ${Math.min(...ok.map((o) => o.cvi))} · max ${Math.max(...ok.map((o) => o.cvi))}`);
  console.log(`completeness mean ${+mean(ok.map((o) => o.compl)).toFixed(1)}% · low-value findings/doc ${+mean(ok.map((o) => o.nLV)).toFixed(1)}`);
  if (OUT) { writeFileSync(OUT, JSON.stringify({ outcomes }, null, 2)); console.log(`wrote ${OUT}`); }
  process.exit(0);
}
