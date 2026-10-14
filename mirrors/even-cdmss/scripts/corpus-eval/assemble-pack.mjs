#!/usr/bin/env node
/**
 * scripts/corpus-eval/assemble-pack.mjs — Brainstem PR 0: assemble the de-identified (claim,
 * cited-excerpt, meta) eval pack for the THREE as-served surfaces (OPD, IPD, CCB; PRD §4).
 *
 * READ-ONLY. Per served output, emit one unit per finding:
 *   { consumer, audit_ref, finding_ref, claim, cited, citation_ids, excerpts[] }
 * where each excerpt is resolved from the persisted numbered Source: FULL chunk text via
 * `mksap_chunks.text` keyed by the persisted `sources[].id` (the fairer judgment, PRD §4), falling
 * back to the as-served `sources[].preview` when the id does not resolve. Every table.column read is
 * echoed to stderr for the report's SQL-honesty list.
 *
 * De-identified: a light PHI scrub on the claim text (the served findings are already de-identified
 * by the engines' privacy rule; this is belt-and-braces). The pack is LOCAL + gitignored.
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/assemble-pack.mjs [--per N]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';

const PER = Math.max(1, parseInt((process.argv.find((a) => a.startsWith('--per='))?.split('=')[1]) || process.env.PER || '150', 10));
const OUT_DIR = '.corpus-eval';
const j = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };
const scrub = (s) => String(s ?? '')
  .replace(/\bUHID[-\s:]*\d+/gi, '[uhid]')
  .replace(/\b[6-9]\d{9}\b/g, '[phone]')
  .replace(/\b(Mr|Mrs|Ms|Master|Baby of|B\/O|W\/O|S\/O|D\/O)\.?\s+[A-Z][a-z]+/g, '[name]')
  .replace(/\s+/g, ' ').trim();

/** Resolve numbered citation_ids → the cited Source objects → excerpts (full chunk text else preview). */
function citedExcerpts(citationIds, sources, chunkText) {
  const byN = new Map((sources || []).map((s) => [Number(s.n), s]));
  const out = [];
  for (const cid of citationIds) {
    const s = byN.get(Number(cid));
    if (!s) continue;
    const chunkId = String(s.id ?? '');
    const full = chunkText.get(chunkId);
    out.push({
      n: Number(cid),
      chunk_id: chunkId,
      resolved: full ? 'full' : 'preview',
      text: scrub(full || s.preview || ''),
      meta: { book: s.book ?? null, chapter: s.chapter ?? null, source: s.source ?? null, page_start: s.page_start ?? null, item_number: s.item_number ?? null },
    });
  }
  return out;
}

async function fetchChunks(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  const map = new Map();
  if (!uniq.length) return map;
  // mksap_chunks.id — cast both sides to text so string/int id columns both resolve.
  for (let i = 0; i < uniq.length; i += 500) {
    const batch = uniq.slice(i, i + 500);
    const rows = await sql(`SELECT id::text AS id, text FROM mksap_chunks WHERE id::text = ANY($1)`, [batch]);
    for (const r of rows) map.set(String(r.id), r.text);
  }
  return map;
}

function units(consumer, rows, getFindings, getSources) {
  const out = [];
  for (const row of rows) {
    const findings = getFindings(row) || [];
    const sources = getSources(row) || [];
    for (const f of findings) {
      const citation_ids = Array.isArray(f.citation_ids) ? f.citation_ids.map(Number).filter(Boolean) : [];
      // claim: OPD/IPD = evidence[] joined; CCB = the single claim string.
      const claim = scrub(Array.isArray(f.evidence) ? f.evidence.join(' ') : (f.claim ?? f.subject ?? ''));
      if (!claim) continue;
      out.push({
        consumer, audit_ref: String(row.__ref), finding_ref: String(f.subject ?? f.id ?? f.order ?? ''),
        claim, cited: citation_ids.length > 0, citation_ids,
        _sources: sources,     // held for excerpt resolution after chunk fetch
      });
    }
  }
  return out;
}

async function main() {
  const echoed = [];
  const echo = (s) => { echoed.push(s); console.error('[sql] ' + s); };

  // ── OPD: opd_note_audits.findings (jsonb) + opd_note_audits.sources (jsonb) ──
  echo('opd_note_audits.findings (jsonb) · opd_note_audits.sources (jsonb) · WHERE sources non-empty · ORDER BY audited_at DESC');
  const opdRows = await sql(`SELECT id, findings, sources FROM opd_note_audits WHERE sources IS NOT NULL AND jsonb_array_length(sources) > 0 ORDER BY audited_at DESC LIMIT $1`, [PER]);
  const opd = units('opd', opdRows.map((r) => ({ __ref: r.id, findings: j(r.findings), sources: j(r.sources) })), (r) => r.findings, (r) => r.sources);

  // ── IPD: ipd_discharge_audits.report->findings + report->sources ──
  echo('ipd_discharge_audits.report (jsonb) → .findings[] + .sources[] · WHERE report NOT NULL · ORDER BY audited_at DESC');
  const ipdRows = await sql(`SELECT id, report FROM ipd_discharge_audits WHERE report IS NOT NULL ORDER BY audited_at DESC LIMIT $1`, [PER]);
  const ipd = units('ipd', ipdRows.map((r) => { const rep = j(r.report) || {}; return { __ref: r.id, findings: rep.findings, sources: rep.sources }; }), (r) => r.findings, (r) => r.sources);

  // ── CCB: ccb_briefs.envelope->clinical[] (each .claim + .citation_ids) + envelope->sources ──
  echo('ccb_briefs.envelope (jsonb) → .clinical[] (.claim, .citation_ids) + .sources[] · WHERE envelope sources non-empty · ORDER BY created_at DESC');
  const ccbRows = await sql(`SELECT id, envelope FROM ccb_briefs WHERE envelope IS NOT NULL AND jsonb_array_length(envelope->'sources') > 0 ORDER BY created_at DESC LIMIT $1`, [PER]);
  const ccb = units('ccb', ccbRows.map((r) => { const e = j(r.envelope) || {}; return { __ref: r.id, findings: e.clinical, sources: e.sources }; }), (r) => r.findings, (r) => r.sources);

  // ── resolve excerpts: batch-fetch mksap_chunks.text by every cited source's chunk id ──
  echo('mksap_chunks.text · WHERE id::text = ANY(cited sources[].id) — full-text excerpt resolution (else as-served sources[].preview)');
  const all = [...opd, ...ipd, ...ccb];
  const chunkIds = all.flatMap((u) => (u._sources || []).map((s) => s.id));
  const chunkText = await fetchChunks(chunkIds);
  for (const u of all) { u.excerpts = citedExcerpts(u.citation_ids, u._sources, chunkText); delete u._sources; }

  // ── stats + write ──
  const byC = (c) => all.filter((u) => u.consumer === c);
  const summary = {};
  for (const c of ['opd', 'ipd', 'ccb']) {
    const us = byC(c);
    const cited = us.filter((u) => u.cited);
    const resolvable = cited.flatMap((u) => u.excerpts);
    summary[c] = {
      served_outputs: c === 'opd' ? opdRows.length : c === 'ipd' ? ipdRows.length : ccbRows.length,
      findings: us.length, cited: cited.length, uncited: us.length - cited.length,
      cited_excerpt_pairs: resolvable.length,
      full_resolved: resolvable.filter((e) => e.resolved === 'full').length,
      preview_fallback: resolvable.filter((e) => e.resolved === 'preview').length,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/pack.json`, JSON.stringify({ version: 'corpus-eval/1.0', assembled_per: PER, tables: echoed, summary, units: all }, null, 2));
  console.error('\n[pack] wrote .corpus-eval/pack.json');
  console.error('[pack] summary: ' + JSON.stringify(summary, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('assemble-pack failed:', e); process.exit(1); });
