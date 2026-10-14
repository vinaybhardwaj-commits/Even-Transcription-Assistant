// lib/__tests__/ipd-stay-audit.test.ts — the stay-level IPD auditor, P3
// (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026 §7: "stay assembly with missing document classes;
// append-not-rewrite").
//
// The two tests §7 names are the two ways this slice can do real harm, and they are different in
// kind. "Missing document classes" is a CLINICAL SAFETY property — §5's "the auditor never claims
// clean theatre from a missing OT note" — and it is tested behaviourally, on the composed material
// and on the stored coverage. "Append-not-rewrite" is a STORAGE property that no unit test can
// observe without a live Neon, so it is pinned where it is actually decided: the engine version
// constant, the composite-PK ON CONFLICT in saveIpdAudit, and the absence of any UPDATE against an
// existing row anywhere on this path. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeStayMaterial, stayCoverage, stayCoverageLine,
  IPD_STAY_ENGINE_VERSION, STAY_ABSENCE_INSTRUCTION, type StayLibraryDoc,
} from '../ipd-audit/stay-material';
import { buildIpdAuditRow, type StayAuditReport } from '../ipd-audit/assemble';
import { IPD_ENGINE_VERSION } from '../ipd-audit/store';
import { dischargeState, notAuditableState, otState, narrativeDocState } from '../stay-library/core';
import type { AuditReport, ExtractedCase } from '../doc-audit-core';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const noop = (t: string) => t;

const extracted = (over: Partial<ExtractedCase> = {}): ExtractedCase => ({
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.8,
  patient: { age: 54, sex: 'M' }, diagnosis: 'Cholelithiasis', indication: null, procedure: null,
  investigations: [], treatments: [], medications: [], courseSummary: 'Uneventful.',
  disposition: 'home', followUp: null, rawNotes: '', ...over,
});

const dischargeDoc = (): StayLibraryDoc => ({
  docKind: 'discharge', status: 'ok',
  state: dischargeState({ extracted: extracted(), documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop }),
});
const otDoc = (): StayLibraryDoc => ({
  docKind: 'ot', status: 'ok',
  state: otState({
    sourceUid: 'ot-1', encounterRef: 'IPNO-19', surgeryName: 'Laparoscopic cholecystectomy',
    facts: [
      { name: 'surgery-name', label: 'surgery', value: 'Laparoscopic cholecystectomy' },
      { name: 'right-left', label: 'side', value: '["on-left"]' },   // the shape KX actually stores
      { name: 'opfinf', label: 'operative findings', value: 'Distended gallbladder, multiple calculi' },
    ],
    narrative: 'Port sites closed.', templateName: 'OT Notes', at: null, deid: noop,
  }),
});
const progressDoc = (): StayLibraryDoc => ({
  docKind: 'progress', status: 'ok',
  state: narrativeDocState({ docKind: 'progress', sourceUid: 'p-1', encounterRef: 'IPNO-19', narrative: 'Afebrile. Tolerating orals.', templateName: null, at: null, deid: noop }),
});
const absent = (docKind: 'ot' | 'pac' | 'progress', reason: 'absent' | 'unavailable' | 'empty'): StayLibraryDoc => ({
  docKind, status: 'not_auditable', reason,
  state: notAuditableState({ docKind, reason, encounterRef: 'IPNO-19' }),
});

// ══ stay assembly with missing document classes (§5, the clinical safety property) ══════

test('every class is named in the material, present or not — silence is never the signal', () => {
  const { text } = composeStayMaterial([dischargeDoc(), otDoc(), absent('pac', 'absent'), absent('progress', 'unavailable')]);
  for (const label of ['discharge summary', 'operative note', 'pre-anaesthetic check', 'progress note']) {
    assert.ok(text.includes(label), `${label} must be named in the block whether or not it was found`);
  }
  assert.match(text, /pre-anaesthetic check: NOT AVAILABLE/);
  assert.match(text, /progress note: NOT AVAILABLE/);
});

test('the material carries the absence instruction, and it names the four wrong conclusions', () => {
  const { text } = composeStayMaterial([dischargeDoc(), otDoc(), absent('pac', 'absent'), absent('progress', 'absent')]);
  assert.ok(text.includes(STAY_ABSENCE_INSTRUCTION), 'the instruction must survive composition verbatim');
  // A general "be careful" is easy to satisfy and easy to ignore. These are checkable sentences.
  for (const forbidden of ['theatre was clean', 'no operation took place', 'no drug was given', 'a check was not done']) {
    assert.ok(STAY_ABSENCE_INSTRUCTION.includes(forbidden), `the instruction must forbid "${forbidden}" by name`);
  }
  assert.match(STAY_ABSENCE_INSTRUCTION, /NOT evidence that the event did not happen/);
});

test('a FAULTED look never reads as an absent document, in the material or the coverage', () => {
  const { text, coverage } = composeStayMaterial([dischargeDoc(), absent('ot', 'unavailable')]);
  const ot = coverage.classes.find((c) => c.docKind === 'ot')!;
  assert.equal(ot.status, 'not_auditable');
  assert.equal(ot.reason, 'unavailable');
  assert.match(ot.copy, /not evidence the document is missing/);
  assert.match(text, /operative note: NOT AVAILABLE — the look for this document failed/);
  // and the two reasons must not render the same words
  const absentCopy = stayCoverage([absent('ot', 'absent')]).classes.find((c) => c.docKind === 'ot')!.copy;
  assert.notEqual(ot.copy, absentCopy);
});

test('the OT structured fields reach the material as STRUCTURED, with the stated side only', () => {
  const { text } = composeStayMaterial([dischargeDoc(), otDoc()]);
  // P2.1 — the prompt now carries the CANONICAL side, not KX's raw multi-select widget.
  assert.match(text, /procedure \(structured field\): Laparoscopic cholecystectomy — side: left/);
  assert.ok(!text.includes('on-left'), 'the raw widget string must not reach the model');
  assert.match(text, /operative findings: Distended gallbladder, multiple calculi/);
  // the surgery is stated once, as the procedure — not repeated as a loose fact line
  assert.equal((text.match(/Laparoscopic cholecystectomy/g) ?? []).length, 1);
});

test('an EMPTY library composes NO block, so the prompt degrades to the discharge-only one', () => {
  // Byte-identical-to-0.2 behaviour is the safe failure: an audit told it has a stay it does not
  // have is worse than an audit that read one document and says so.
  const { text, coverage } = composeStayMaterial([absent('ot', 'absent'), absent('pac', 'absent'), absent('progress', 'absent')]);
  assert.equal(text, '');
  assert.equal(coverage.documentsRead, 0);
  assert.equal(coverage.incomplete, true);
});

test('coverage counts documents, flags incompleteness, and its line refuses to imply a clean result', () => {
  const full = stayCoverage([dischargeDoc(), otDoc(), progressDoc(), { docKind: 'pac', status: 'ok', state: narrativeDocState({ docKind: 'pac', sourceUid: 'pac-1', encounterRef: 'IPNO-19', narrative: 'Fit for GA.', templateName: null, at: null, deid: noop }) }]);
  assert.equal(full.documentsRead, 4);
  assert.equal(full.incomplete, false);
  assert.match(stayCoverageLine(full), /all four classes/);

  const holed = stayCoverage([dischargeDoc(), absent('ot', 'absent'), absent('pac', 'absent'), progressDoc()]);
  assert.equal(holed.incomplete, true);
  const line = stayCoverageLine(holed);
  assert.match(line, /Not available: operative note, pre-anaesthetic check/);
  assert.match(line, /not evidence they did not happen/);
});

test('a class with no library row at all defaults to `absent`, never to a clean read', () => {
  const c = stayCoverage([dischargeDoc()]);   // ot / pac / progress produced nothing whatsoever
  for (const k of ['ot', 'pac', 'progress'] as const) {
    const cls = c.classes.find((x) => x.docKind === k)!;
    assert.equal(cls.status, 'not_auditable');
    assert.equal(cls.count, 0);
    assert.equal(cls.reason, 'absent');
  }
});

test('the coverage classes are in a FIXED order, so stored blocks are comparable across stays', () => {
  const a = stayCoverage([progressDoc(), otDoc(), dischargeDoc()]).classes.map((c) => c.docKind);
  const b = stayCoverage([dischargeDoc(), otDoc(), progressDoc()]).classes.map((c) => c.docKind);
  assert.deepEqual(a, ['discharge', 'ot', 'pac', 'progress']);
  assert.deepEqual(a, b);
});

// ══ the coverage reaches the AUDIT OUTPUT, not only the prompt (§5) ═════════════════════

const scored = (): AuditReport => ({
  completeness: { items: [], coverage: 0.9, mandatoryTotal: 10 } as unknown as AuditReport['completeness'],
  findings: [], idealisedSummary: '', diff: [], suggestions: [], sources: [],
  valueScore: { headline: 71, band: 'B', domains: [] } as unknown as AuditReport['valueScore'],
  disclaimer: '',
});

test('§5: a stay row STORES its coverage, so a missing class is visible in the audit output', () => {
  const { coverage } = composeStayMaterial([dischargeDoc(), otDoc(), absent('pac', 'absent'), absent('progress', 'unavailable')]);
  const row = buildIpdAuditRow(
    { documentId: 'doc-1', engineVersion: IPD_STAY_ENGINE_VERSION, stayCoverage: coverage },
    extracted(), scored(),
  );
  const stored = row.report as StayAuditReport;
  assert.equal(stored.stayCoverage?.engineVersion, IPD_STAY_ENGINE_VERSION);
  const pac = stored.stayCoverage?.classes.find((c) => c.docKind === 'pac');
  assert.equal(pac?.status, 'not_auditable');
});

test('a discharge-only row is UNCHANGED by P3: no stayCoverage key appears on it', () => {
  const report = scored();
  const row = buildIpdAuditRow({ documentId: 'doc-1', engineVersion: IPD_ENGINE_VERSION }, extracted(), report);
  assert.equal((row.report as StayAuditReport).stayCoverage, undefined);
  assert.equal(row.report, report, 'with no coverage the report object is passed through, not rebuilt');
  assert.equal(row.engineVersion, IPD_ENGINE_VERSION);
});

// ══ append-not-rewrite (O11) ═══════════════════════════════════════════════════════════

test('the stay engine is a NEW NAME, not a bump of the parked one', () => {
  assert.equal(IPD_STAY_ENGINE_VERSION, 'ipd-stay-audit/0.1');
  assert.equal(IPD_ENGINE_VERSION, 'ipd-discharge-audit/0.2', 'the parked engine version must not move');
  assert.notEqual(IPD_STAY_ENGINE_VERSION, IPD_ENGINE_VERSION);
  // and the constant lives in ONE place, re-exported, so the version and its material cannot drift
  assert.ok(code('lib/ipd-audit/store.ts').includes("export { IPD_STAY_ENGINE_VERSION } from './stay-material'"));
});

test('O11: the write is an APPEND by construction — the conflict key names the engine version', () => {
  const store = code('lib/ipd-audit/store.ts');
  assert.ok(store.includes('ON CONFLICT (document_id, engine_version) DO UPDATE'),
    'the composite key is what makes a second engine version a second ROW rather than an overwrite');
  // Nothing on the P3 path may write an existing row by id, or delete one.
  for (const f of ['lib/ipd-audit/stay-material.ts', 'app/api/admin/ipd-stay-audit-now/route.ts']) {
    const src = code(f);
    assert.ok(!/\bUPDATE\s+ipd_discharge_audits\b/i.test(src), `${f} updates the audits table directly`);
    assert.ok(!/\bDELETE\s+FROM\b/i.test(src), `${f} deletes rows`);
  }
});

test('the stay runner writes ONLY under the new engine version', () => {
  const run = code('lib/ipd-audit/run.ts');
  const stayFn = run.slice(run.indexOf('export async function runIpdStayAudit'));
  assert.ok(stayFn.length > 0, 'runIpdStayAudit must exist');
  assert.ok(stayFn.includes('const engineVersion = IPD_STAY_ENGINE_VERSION'));
  assert.ok(!stayFn.includes('IPD_ENGINE_VERSION'), 'the stay runner must never name the parked engine version');
  assert.ok(!stayFn.includes('IPD_MINI_ENGINE_VERSION'));
});

test('the discharge-only runner is untouched by P3 — it still writes the parked engine version', () => {
  const run = code('lib/ipd-audit/run.ts');
  const discharge = run.slice(run.indexOf('export async function runIpdAudit'), run.indexOf('export async function runIpdStayAudit'));
  assert.ok(discharge.includes('const engineVersion = mini ? IPD_MINI_ENGINE_VERSION : IPD_ENGINE_VERSION'));
  assert.ok(!discharge.includes('IPD_STAY_ENGINE_VERSION'), 'the discharge path must not learn about the stay engine');
  assert.ok(!discharge.includes('clinicalStateText'), 'the discharge prompt must stay byte-identical');
});

// ══ the engine is CALLED, never edited ═════════════════════════════════════════════════

test('P3 threads the stay through the EXISTING clinicalStateText seam and edits no engine file', () => {
  const run = code('lib/ipd-audit/run.ts');
  assert.ok(run.includes('clinicalStateText: stayText'), 'the stay picture rides the existing optional seam');
  // The seam is additive by construction in doc-audit-core — pinned here so a later edit that made
  // it mandatory would fail P3's suite rather than silently change the parked engine's prompt.
  const core = code('lib/doc-audit-core.ts');
  assert.ok(core.includes('clinicalStateText?: string'), 'the seam must stay OPTIONAL');
  assert.ok(core.includes("const picture = clinicalStateText && clinicalStateText.trim() ?"),
    'an empty/absent block must still render the ungrounded prompt');
});

// ══ chat never triggers a run, and never writes a score (§3.3 / §5) ════════════════════

test('no chat path can trigger a stay run or move a score', () => {
  for (const f of [
    'lib/case-ask-core.ts', 'lib/case-ask/ask.ts', 'lib/case-ask/serve.ts', 'lib/case-ask/store.ts',
    'app/api/admin/ipd-audit-ask/route.ts', 'app/api/admin/opd-audit-ask/route.ts',
  ]) {
    const src = code(f);
    for (const banned of ['runIpdStayAudit', 'runIpdAudit', 'ipd-stay-audit-now', 'saveIpdAudit', 'buildIpdAuditRow', 'buildStayLibrary']) {
      assert.ok(!src.includes(banned), `${f} can reach ${banned} — chat must never trigger a run`);
    }
  }
  // and the reverse edge: the auditor must not learn about the chat shell either
  for (const f of ['lib/ipd-audit/run.ts', 'lib/ipd-audit/stay-material.ts', 'lib/ipd-audit/assemble.ts']) {
    assert.ok(!/case-ask/.test(code(f)), `${f} imports the chat shell`);
  }
});

// ══ the parked surface survives (§5, acceptance #8 / #14) ══════════════════════════════

test('the parked IPD surface is not deleted: list, calendar, search, pills, PDF all still there', () => {
  for (const f of [
    'app/admin/ipd-audit/page.tsx', 'app/admin/ipd-audit/calendar/page.tsx',
    'app/admin/ipd-audit/search/page.tsx', 'app/admin/ipd-audit/[id]/finding-triage.tsx',
    'app/admin/ipd-audit/[id]/report-with-triage.tsx', 'app/api/admin/ipd-audit-feedback/route.ts',
    'app/api/admin/ipd-audit-now/route.ts',
  ]) {
    assert.ok(read(f).length > 0, `${f} must still exist`);
  }
  // the PDF pane and the gold-pill route are both still wired on the case page
  const page = read('app/admin/ipd-audit/[id]/page.tsx');
  assert.ok(page.includes('Discharge summary PDF'), 'the discharge PDF pane must remain');
  assert.ok(page.includes('<ReportWithTriage'), 'the adjudicable finding list must remain');
  assert.ok(page.includes('<StayPanel'), 'the stay panel is additive, beside the report');
});

test('the gold pills keep the C2 literals and stay keyed to a row, so the two engines never mix', () => {
  const feedback = code('app/api/admin/ipd-audit-feedback/route.ts');
  for (const v of ['true_positive', 'nitpick', 'false', 'contested']) {
    assert.ok(feedback.includes(`'${v}'`), `the ${v} literal must survive`);
  }
  // Keyed on audit_id — and the two engine versions are two ROWS with two ids, so an adjudication
  // of the stay reading can never be read as an adjudication of the discharge-only one.
  assert.ok(feedback.includes('INSERT INTO ipd_audit_feedback'));
  assert.ok(feedback.includes('audit_id'));
  const page = read('app/admin/ipd-audit/[id]/page.tsx');
  assert.ok(page.includes('FROM ipd_audit_feedback') && page.includes('WHERE audit_id = $1'),
    'the case page reads feedback for THIS row only');
});

test('the stay panel shows a gap as a gap and offers no rescore control', () => {
  const panel = code('app/admin/ipd-audit/[id]/stay-panel.tsx');
  assert.ok(panel.includes('not available'), 'an unread class must be labelled, not omitted');
  assert.ok(!/recompute|rescore/i.test(panel));
  const button = code('app/admin/ipd-audit/[id]/stay-run-button.tsx');
  assert.ok(button.includes('/api/admin/ipd-stay-audit-now'), 'the only action posts to the stay route');
  assert.ok(!button.includes('/api/admin/ipd-audit-now'), 'it must not be able to re-run the parked audit');
});

test('P3 is grep-clean of the refused transports', () => {
  for (const f of [
    'lib/ipd-audit/stay-material.ts', 'lib/ipd-audit/run.ts', 'lib/ipd-audit/assemble.ts',
    'app/api/admin/ipd-stay-audit-now/route.ts', 'app/admin/ipd-audit/[id]/stay-panel.tsx',
    'app/admin/ipd-audit/[id]/stay-run-button.tsx',
  ]) {
    const src = read(f).toLowerCase();
    for (const bad of ['gpt-5.6', 'bedrock-mantle', 'terra']) {
      assert.ok(!src.includes(bad), `${f} names ${bad}`);
    }
  }
});
