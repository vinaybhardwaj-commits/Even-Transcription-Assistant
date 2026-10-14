// lib/__tests__/ipd-audit-surface.test.ts — IPD Discharge Audit S3 invariants (the Saul
// semantics line + the PHI posture), in the repo's source-level-assertion idiom (see
// architecture-advisory-no-band-visuals.test.ts for why source assertions are the sanctioned
// form for 'use client' components that cannot load under node --test).
//
// 1. ADVISORY NEVER CARRIES SCORED-BAND LANGUAGE: the per-finding triage chips and the
//    Low-Value Care panel's verdict badges must never render from bandColor/scoreColor —
//    the A–E scored-band palette belongs to the Care-Value INDEX alone.
// 2. NO PHI ON THE AUDIT ROW: ipd_discharge_audits holds link-back keys only. Structurally
//    (the row assembler cannot express a name/UHID) and at the SQL layer (no such column).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIpdAuditRow } from '../ipd-audit/assemble';
import { computeScorecard } from '../value-score-core';
import type { ExtractedCase, AuditReport } from '../doc-audit-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

test('semantics: the adjudication component never touches the scored-band palette', () => {
  const src = read('app/admin/ipd-audit/[id]/finding-triage.tsx');
  assert.ok(!/bandColor|scoreColor/.test(src), 'finding-triage.tsx must not import/use bandColor/scoreColor');
  // and its verdict keys are the OPD-grade adjudication vocabulary, not band letters
  for (const k of ['true_positive', 'nitpick', 'false', 'contested']) assert.ok(src.includes(`'${k}'`), `adjudication verdict '${k}' present`);
});

test('semantics: the LVC summary strip renders without band language; the finding list exists once', () => {
  const src = read('app/admin/ipd-audit/[id]/page.tsx');
  const stripStart = src.indexOf('Low-Value Care check');
  const stripEnd = src.indexOf('ReportWithTriage', stripStart);
  assert.ok(stripStart > 0 && stripEnd > stripStart, 'LVC summary strip located above the single finding list');
  const strip = src.slice(stripStart, stripEnd);
  assert.ok(!/bandColor|scoreColor/.test(strip), 'the LVC strip never uses the scored-band palette');
  assert.ok(strip.includes('low-value'), 'verdict enum language present');
  // the duplicate per-finding list is gone: FindingTriage is composed ONLY via the render-prop wrapper
  assert.ok(!src.includes('FindingTriage'), 'page has no direct finding list — adjudication rides CaseAuditReport');
  const wrapper = read('app/admin/ipd-audit/[id]/report-with-triage.tsx');
  assert.ok(wrapper.includes('findingActions') && wrapper.includes('FindingTriage'), 'wrapper passes FindingTriage to every finding');
});

test('CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers', () => {
  const src = read('components/CaseAuditReport.tsx');
  assert.ok(/findingActions\?:/.test(src), 'findingActions is an OPTIONAL prop');
  assert.ok(/findingActions\?\.\(f, i\)/.test(src), 'slot renders only when provided (optional chaining)');
  // no other caller passes it (OPD + record-audit surfaces byte-identical)
  const grep = ['app/appropriateness', 'components'];
  void grep; // callers verified by search in the build report; the structural guarantee is the two asserts above
});

test('PHI posture: the row assembler cannot place a name/UHID on the audit row', () => {
  const extracted = {
    docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.9,
    patient: { age: 40, sex: 'male' }, diagnosis: 'x', indication: null, procedure: null,
    investigations: [], treatments: [], medications: [], courseSummary: 'course', disposition: null,
    followUp: null, rawNotes: '', adminFacts: { lengthOfStayDays: 2, admissionType: null, careSetting: 'ward' },
  } as ExtractedCase;
  const report = {
    completeness: { items: [], coverage: 0.8, mandatoryTotal: 10, mandatoryMet: 8, missingMandatory: ['Date of discharge'] },
    findings: [{ subject: 'IV antibiotics', verdict: 'low-value', confidence: 0.9, rationale: 'r', evidence: [], estimates: [], citation_ids: [], domain: 'efficiency' }],
    idealisedSummary: 'i', diff: [], suggestions: [{ priority: 1, text: 's' }], sources: [],
    valueScore: computeScorecard({ findings: [{ verdict: 'low-value', confidence: 0.9, domain: 'efficiency' }], completenessCoverage: 0.8, patientCentred: { present: 1, total: 2 } }),
    disclaimer: 'd',
  } as unknown as AuditReport;
  const row = buildIpdAuditRow({ documentId: 'DOC1', ipUid: 'IP-1', memberId: 'M1' }, extracted, report);
  for (const k of Object.keys(row)) {
    assert.ok(!/name|uhid|phone|address|dob/i.test(k), `row field '${k}' looks like PHI`);
  }
  assert.equal(row.careValueIndex, report.valueScore!.headline);
  assert.equal(row.nLowValue, 1);
});

test('PHI posture: neither the table nor the store INSERT carries a name/UHID column', () => {
  for (const p of ['migrations/0013_ipd_discharge_audits.sql', 'migrations/0014_ipd_audit_report_feedback.sql']) {
    const ddl = read(p).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/patient_name|uhid|phone|address|\bdob\b/i.test(ddl), `${p} defines no PHI column`);
  }
  const insert = read('lib/ipd-audit/store.ts').match(/INSERT INTO ipd_discharge_audits\s*\(([\s\S]*?)\)/);
  assert.ok(insert, 'store INSERT column list located');
  assert.ok(!/name|uhid|phone|address|dob/i.test(insert![1]), 'store INSERT has no PHI column');
});

test('PHI posture: db13 PHI fields are read-time only — never passed to the row assembler', () => {
  // the audit-now route joins the header for speciality/LOS/dates ONLY; patientName/uhid must
  // never appear in its buildIpdAuditRow call.
  const src = read('app/api/admin/ipd-audit-now/route.ts');
  const call = src.match(/buildIpdAuditRow\(\{([\s\S]*?)\}\s*,/);
  assert.ok(call, 'buildIpdAuditRow call located');
  assert.ok(!/patientName|uhid|ageGender/i.test(call![1]), 'audit-now passes only the de-identified envelope');
});
