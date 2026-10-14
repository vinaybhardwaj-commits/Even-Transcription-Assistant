#!/usr/bin/env node
// Platform B1 — ClinicalState / OPD note-audit FIDELITY harness. READ-ONLY: it SELECTs a
// sample of real opd_note_audits rows and round-trips each finding through the note-audit
// adapter, measuring how losslessly the canonical model represents real production output.
// It writes nothing to the database and never touches the live audit path.
//
//   DATABASE_URL=… SAMPLE=200 OUT=/path/report.md \
//     node --env-file=.env.local --import tsx scripts/clinical-state-audit-shadow.mjs
//
//   SAMPLE  number of rows to pull (default 200)
//   OUT     report path (default ./CLINICAL-STATE-AUDIT-SHADOW-FIDELITY.md)
//
// findings is de-identified structured data (no PHI in the round-trip). This script imports
// only the adapter primitives + the db client — never the note-audit engine.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from '../lib/db.ts';
import { noteAuditFindingToFinding, findingToNoteAuditFinding } from '../lib/clinical-state/to-audit-family.ts';
import { lossyKeys } from '../lib/clinical-state/audit-shadow-core.ts';
import { emptyClinicalState, stateCounts } from '../lib/clinical-state/schema.ts';

const SAMPLE = Math.max(1, parseInt(process.env.SAMPLE || '200', 10) || 200);
const OUT = resolve(process.env.OUT || './CLINICAL-STATE-AUDIT-SHADOW-FIDELITY.md');

const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : []);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');

const main = async () => {
  console.log(`Fidelity harness — sampling ${SAMPLE} opd_note_audits rows (read-only)…`);
  const rows = await sql(
    `SELECT id, engine_version, findings
       FROM opd_note_audits
      WHERE findings IS NOT NULL AND jsonb_typeof(findings) = 'array'
      ORDER BY random()
      LIMIT $1`,
    [SAMPLE],
  );
  console.log(`Pulled ${rows.length} rows.`);

  let nFindings = 0, nLossless = 0, nAuditsClean = 0, emptyAudits = 0, erroredAudits = 0;
  const findingsPerAudit = [];
  const lossyHist = {};                    // key -> # findings where it failed to round-trip
  const examples = {};                     // key -> { subject, orig, rt } (first offender)
  const engineVersions = {};

  for (const row of rows) {
    engineVersions[row.engine_version] = (engineVersions[row.engine_version] || 0) + 1;
    let findings;
    try { findings = asArray(row.findings); }
    catch { erroredAudits++; continue; }

    findingsPerAudit.push(findings.length);
    if (findings.length === 0) emptyAudits++;

    // build the note_audit ClinicalState for coverage counts (mirrors the in-pipeline hook)
    const state = emptyClinicalState('note_audit');
    try { state.positives = findings.map(noteAuditFindingToFinding); } catch { erroredAudits++; }

    let auditClean = true;
    for (const f of findings) {
      nFindings++;
      let rt;
      try { rt = findingToNoteAuditFinding(noteAuditFindingToFinding(f)); }
      catch { auditClean = false; lossyHist.__throw = (lossyHist.__throw || 0) + 1; continue; }
      const diff = lossyKeys(f, rt);
      if (diff.length === 0) { nLossless++; continue; }
      auditClean = false;
      for (const k of diff) {
        lossyHist[k] = (lossyHist[k] || 0) + 1;
        if (!examples[k]) examples[k] = { subject: String(f.subject ?? '').slice(0, 80), orig: f[k], rt: rt[k] };
      }
    }
    if (auditClean) nAuditsClean++;
  }

  findingsPerAudit.sort((a, b) => a - b);
  const median = findingsPerAudit.length ? findingsPerAudit[Math.floor(findingsPerAudit.length / 2)] : 0;
  const thin = findingsPerAudit.filter((n) => n <= 1).length; // 0- or 1-finding audits: thin coverage
  const lossyEntries = Object.entries(lossyHist).sort((a, b) => b[1] - a[1]);

  const lines = [];
  lines.push('# ClinicalState — OPD Note-Audit Fidelity (Platform B1)');
  lines.push('');
  lines.push(`**Date:** 12 Jul 2026 · **Harness:** \`scripts/clinical-state-audit-shadow.mjs\` (read-only) · **Sample:** ${rows.length} random \`opd_note_audits\` rows`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- **Findings round-tripped byte-lossless: ${nLossless} / ${nFindings} (${pct(nLossless, nFindings)})**`);
  lines.push(`- Audits fully lossless (every finding): ${nAuditsClean} / ${rows.length} (${pct(nAuditsClean, rows.length)})`);
  lines.push(`- Findings per audit: min ${findingsPerAudit[0] ?? 0}, median ${median}, max ${findingsPerAudit[findingsPerAudit.length - 1] ?? 0}`);
  lines.push(`- Thin coverage (≤1 finding): ${thin} audits (${pct(thin, rows.length)}); empty (0 findings): ${emptyAudits}`);
  lines.push(`- Adapter throws: ${erroredAudits} audit-level, ${lossyHist.__throw || 0} finding-level`);
  lines.push('');
  lines.push('## Lossy-field breakdown');
  lines.push('');
  if (!lossyEntries.length) {
    lines.push('**No lossy fields — the note-audit adapter is lossless on this sample.** The canonical model losslessly represents real production note-audit output; nothing blocks ClinicalState becoming canonical for this surface on fidelity grounds.');
  } else {
    lines.push('| Field | # findings lossy | % of findings | Example subject | orig → round-trip |');
    lines.push('|---|---:|---:|---|---|');
    for (const [k, n] of lossyEntries) {
      const ex = examples[k] || {};
      const o = JSON.stringify(ex.orig), r = JSON.stringify(ex.rt);
      lines.push(`| \`${k}\` | ${n} | ${pct(n, nFindings)} | ${(ex.subject || '').replace(/\|/g, '/')} | \`${o}\` → \`${r}\` |`);
    }
  }
  lines.push('');
  lines.push('## Sample composition (engine versions)');
  lines.push('');
  for (const [v, n] of Object.entries(engineVersions).sort((a, b) => b[1] - a[1])) lines.push(`- \`${v}\`: ${n}`);
  lines.push('');
  lines.push('_Read-only harness; no writes. `findings` is de-identified structured data._');

  await writeFile(OUT, lines.join('\n'));
  console.log(`\nLossless: ${nLossless}/${nFindings} (${pct(nLossless, nFindings)}) findings · ${nAuditsClean}/${rows.length} audits clean`);
  console.log(`Lossy fields: ${lossyEntries.length ? lossyEntries.map(([k, n]) => `${k}×${n}`).join(', ') : 'NONE'}`);
  console.log(`Wrote ${OUT}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
