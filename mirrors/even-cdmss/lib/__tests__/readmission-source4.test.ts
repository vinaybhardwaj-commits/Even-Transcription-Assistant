/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-source4.test.ts
 * R2 source 4 wired end-to-end through the PURE layers: assemble (the PHI choke point —
 * FIRST-EVER test on deidText for template text, R2-6), reconcile-core (weight by side,
 * coverage + refusal lines on the finding, negligence invariants), surface-core (five-state
 * chips, delayed-SSI layout guards) and the brief's bill-sentence guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleThreeSource, deidText, templateItems } from '../readmission/assemble.ts';
import {
  deriveJudgements, evidenceWeight, isDisinterested, isInterested, reconcileFinding, templateRefusalLines,
  JUDGEMENT_RULE_VERSION, type EvidenceItem, type PassClaims,
} from '../readmission-reconcile-core.ts';
import { flattenTemplateRow, type KxTemplateRow } from '../readmission-template-core.ts';
import {
  chipText, coverageChips, isDelayedSsi, justificationCell, returnStayBill, situationLine, templateChipState,
  type SurfaceFinding,
} from '../readmission-surface-core.ts';
import { BILL_SENTENCE_NO_SECOND_STAY, composeBrief } from '../readmission/brief.ts';
import type { ExtractedCase } from '../doc-audit-core.ts';

const identity = { names: ['Asha Khan'], uhids: ['UH-77812'] };
const tRow = (over: Partial<KxTemplateRow> = {}): KxTemplateRow => ({
  uid: 'u1', encounterId: 'IPNO-229', uhid: 'UH-77812', templateName: 'Doctor: OT Notes', status: 'final',
  createdAt: '2026-06-01T09:00:00Z', surgeryName: 'Cemented hemiarthroplasty for Asha Khan',
  note: 'Asha Khan, UH-77812. Spinal anaesthesia. Calcar crack noted at impaction, cerclage wire applied. Mrs Khan tolerated well.',
  componentJson: JSON.stringify([{ name: 'opfinf', valueString: 'Displaced fracture; calcar crack — Khan' }, { name: 'TF-1', valueString: 'Asha' }]),
  ...over,
});
const ec = (over: Partial<ExtractedCase> = {}): ExtractedCase => ({
  docType: 'discharge_summary' as ExtractedCase['docType'], detectedDocType: 'discharge_summary' as ExtractedCase['docType'], confidence: 0.9,
  patient: {}, diagnosis: 'Fracture neck of femur', indication: null, procedure: 'Hemiarthroplasty',
  investigations: ['Potassium 2.9 (3.5-5.1)'], treatments: [], medications: [], courseSummary: 'Patient stable at discharge.',
  disposition: 'Home', followUp: null, rawNotes: '', ...over,
});
const base = (over: Partial<Parameters<typeof assembleThreeSource>[0]> = {}) => assembleThreeSource({
  indexCase: ec(), readmitCase: ec({ courseSummary: 'Presented with wound discharge.' }), structuredLabs: [],
  indexAdmitAt: '2026-05-28T10:00:00Z', indexDischargeAt: '2026-06-01T10:00:00Z', readmitAdmitAt: '2026-06-05T09:00:00Z',
  identity, labWindow: null, caseSources: { index: 'store', readmit: 'store' }, documentIds: { index: 'D1', readmit: 'D2' },
  extractionVersion: 'doc-extract/1', ...over,
});

// ── R2-6: the choke point, tested for the first time ────────────────────────────

test('deid: a patient name and UHID planted in a template note, a fact value, the surgery name AND the template name are all scrubbed', () => {
  const flat = flattenTemplateRow(tRow({ templateName: 'OT note — Asha Khan' }), 'ot_note', 'index');
  const { items, deidentified } = templateItems([flat], identity);
  assert.equal(items.length, 1);
  const text = items[0].text;
  assert.doesNotMatch(text, /Asha|Khan|UH-77812/);
  assert.match(text, /\[PATIENT\]/); assert.match(text, /\[UHID\]/);
  assert.match(text, /calcar crack/);   // the clinical content survives
  assert.doesNotMatch(text, /TF-1|should never/);   // dropped by the allowlist before it could leak
  // The de-identified flattened rows (what coverage is judged on) carry no name either.
  assert.doesNotMatch(JSON.stringify(deidentified), /Asha|Khan|UH-77812/);
  // Sanity on the primitive itself.
  assert.equal(deidText('Khan wound', identity), '[PATIENT] wound');
});

test('template items slot AFTER structured labs (L) and BEFORE tier-2 case labs (IX/RX); ids OT1 / PAC1 / P1 never collide', () => {
  const templates = [
    flattenTemplateRow(tRow(), 'ot_note', 'index'),
    flattenTemplateRow(tRow({ uid: 'p1', note: 'ASA II' }), 'pac_note', 'index'),
    flattenTemplateRow(tRow({ uid: 'g1', note: 'wound dry' }), 'progress_note', 'index'),
    flattenTemplateRow(tRow({ uid: 'g2', note: 'wound discharging, culture sent' }), 'progress_note', 'readmit'),
  ];
  const out = base({ templates, templateFetch: { ot_note: 'ok', pac_note: 'ok', progress_note: 'ok' } });
  const ids = out.catalog.items.map((i) => i.id);
  const firstTemplate = ids.findIndex((id) => /^(OT|PAC|P)\d+$/.test(id));
  const lastS = ids.lastIndexOf(ids.filter((id) => /^S\d+$/.test(id)).at(-1)!);
  const firstIX = ids.findIndex((id) => /^IX\d+$/.test(id));
  assert.ok(firstTemplate > lastS, 'after the summaries');
  assert.ok(firstIX === -1 || firstTemplate < firstIX, 'before the tier-2 case labs');
  assert.deepEqual(ids.filter((id) => /^(OT|PAC|P)\d+$/.test(id)), ['OT1', 'PAC1', 'P1', 'P2']);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids anywhere in the catalog');
  assert.equal(out.labTier, 'tier2');   // no structured labs — the templates did not change the tier
  assert.deepEqual(out.templateCoverage, { ot: { status: 'present', count: 1 }, pac: { status: 'present', count: 1 }, progress: { status: 'present', count: 2 } });
  // Every template item's text is de-identified.
  for (const it of out.catalog.items.filter((i) => /^(OT|PAC|P)\d+$/.test(i.id))) assert.doesNotMatch(it.text, /Asha|Khan|UH-77812/);
});

test('a pair with NO templates is exactly the three-source audit it was, plus honest coverage; never-looked writes no coverage at all', () => {
  const looked = base({ templates: [], templateFetch: { ot_note: 'ok', pac_note: 'ok', progress_note: 'ok' } });
  assert.deepEqual(looked.templateCoverage, { ot: { status: 'absent', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 } });
  assert.equal(looked.notAuditableReason, undefined);   // still auditable
  const neverLooked = base();
  assert.equal(neverLooked.templateCoverage, undefined);
  assert.deepEqual(neverLooked.catalog.items.map((i) => i.id), looked.catalog.items.map((i) => i.id));   // byte-for-byte the R1 catalog
  const faulted = base({ templates: [], templateFetch: { ot_note: 'fetch_failed', pac_note: 'ok', progress_note: 'ok' } });
  assert.equal(faulted.templateCoverage?.ot.status, 'fetch_failed');
  // Blank rows → empty, never present.
  const blank = base({ templates: [flattenTemplateRow(tRow({ note: ' ', componentJson: null, surgeryName: null }), 'progress_note', 'index')], templateFetch: { ot_note: 'ok', pac_note: 'ok', progress_note: 'ok' } });
  assert.deepEqual(blank.templateCoverage?.progress, { status: 'empty', count: 1 });
  assert.equal(blank.catalog.items.some((i) => /^P\d+$/.test(i.id)), false);   // contributes nothing to the ledger
});

// ── R2-2: weight by side, exhaustive ────────────────────────────────────────────

test('evidence weight: index-side template items are interested, readmit-side disinterested; no side → interested (fail-closed); old sources unchanged', () => {
  const it = (source: EvidenceItem['source'], side?: EvidenceItem['side']): EvidenceItem => ({ id: 'x', source, side, text: 't' });
  for (const src of ['ot_note', 'pac_note', 'progress_note'] as const) {
    assert.equal(evidenceWeight(it(src, 'index')), 'interested', src);
    assert.equal(evidenceWeight(it(src, 'readmit')), 'disinterested', src);
    assert.equal(evidenceWeight(it(src)), 'interested', src);
    assert.equal(isInterested(it(src, 'index')), true); assert.equal(isDisinterested(it(src, 'readmit')), true);
  }
  assert.equal(evidenceWeight(it('index_summary', 'index')), 'interested');
  assert.equal(evidenceWeight(it('readmit_summary', 'readmit')), 'disinterested');
  assert.equal(evidenceWeight(it('lab', 'index')), 'disinterested');
  assert.equal(evidenceWeight(it('adt')), 'disinterested');
  assert.equal(evidenceWeight(it('cm_form')), 'neither');
  assert.equal(isInterested(it('cm_form')), false); assert.equal(isDisinterested(it('cm_form')), false);
});

test('provenance ratio: an avoidable verdict resting on an INDEX OT note alone still routes to a human; a READMIT progress note counts as disinterested', () => {
  const catalog = { items: [
    { id: 'S1', source: 'index_summary' as const, side: 'index' as const, text: 'Patient stable at discharge.' },
    { id: 'OT1', source: 'ot_note' as const, side: 'index' as const, text: 'OT note: calcar crack, cerclage applied.' },
    { id: 'P1', source: 'progress_note' as const, side: 'readmit' as const, text: 'progress note: wound discharging.' },
  ] };
  const passA: PassClaims = {
    planned: { verdict: 'unplanned', evidenceIds: ['S1'] },
    omissions: [{ claim: 'calcar crack intra-op, cerclage applied — not recorded in discharge', contradictingEvidenceIds: ['OT1'], danger: 'moderate' }],
    avoidable: { verdict: 'avoidable', evidenceIds: ['OT1'] },
  };
  const f = reconcileFinding({ findingClass: 'even_even', catalog, labProfile: 'no_labs', indexDischargeAt: null, passA, passB: { avoidable: { verdict: 'avoidable', evidenceIds: ['OT1'] } } });
  assert.equal(f.provenance.disinterested, 0);
  assert.equal(f.provenance.needsHumanReview, true);
  const g = reconcileFinding({ findingClass: 'even_even', catalog, labProfile: 'no_labs', indexDischargeAt: null,
    passA: { ...passA, avoidable: { verdict: 'avoidable', evidenceIds: ['OT1', 'P1'] } }, passB: { avoidable: { verdict: 'avoidable', evidenceIds: ['P1'] } } });
  assert.equal(g.provenance.disinterested, 1);
});

// ── coverage + refusal record on the finding (§3.4, constraint 21) ───────────────

test('templateCoverage rides the finding blob unchanged and writes the refusal lines: absent ↔ found:false, fetch_failed → unwritten, present → found:true', () => {
  const cov = { ot: { status: 'present' as const, count: 1 }, pac: { status: 'absent' as const, count: 0 }, progress: { status: 'fetch_failed' as const, count: 0 } };
  const f = reconcileFinding({ findingClass: 'even_even', catalog: { items: [] }, labProfile: 'no_labs', indexDischargeAt: null, passA: {}, passB: null, templateCoverage: cov });
  assert.deepEqual(f.templateCoverage, cov);
  const lines = f.refusalRecord.filter((r) => /^(ot|pac|progress)_note$/.test(r.lookedFor));
  assert.deepEqual(lines.map((l) => [l.lookedFor, l.found]), [['ot_note', true], ['pac_note', false]]);   // progress: unwritten
  // empty → found:false with the reason; the condition-only pass carries it too
  const e = reconcileFinding({ findingClass: 'even_even', catalog: { items: [] }, labProfile: 'no_labs', indexDischargeAt: null, passA: {}, passB: null, conditionOnly: true,
    templateCoverage: { ot: { status: 'empty', count: 2 }, pac: { status: 'absent', count: 0 }, progress: { status: 'present', count: 3 } } });
  assert.equal(e.templateCoverage?.ot.status, 'empty');
  assert.match(e.refusalRecord.find((r) => r.lookedFor === 'ot_note')!.note!, /2 row\(s\) exist but none carries usable text/);
  assert.equal(e.refusalRecord.find((r) => r.lookedFor === 'ot_note')!.found, false);
  // never looked → nothing written, blob field null
  const n = reconcileFinding({ findingClass: 'even_even', catalog: { items: [] }, labProfile: 'no_labs', indexDischargeAt: null, passA: {}, passB: null });
  assert.equal(n.templateCoverage, null);
  assert.equal(n.refusalRecord.some((r) => /^(ot|pac|progress)_note$/.test(r.lookedFor)), false);
  assert.deepEqual(templateRefusalLines(null), []);
});

// ── constraints 18-19: judgements do not move on coverage alone ──────────────────

test('negligence: absent / empty / present OT alone never yields suspected or not_suggested; a named intra-op event IN USABLE TEXT on an unplanned same-condition pair can', () => {
  const unplannedSame = { planned: { verdict: 'unplanned' }, sameCondition: { verdict: 'same' }, corroborationTrack: 'prose_only', stabilityAssessment: 'unverifiable' };
  for (const status of ['absent', 'empty', 'present', 'fetch_failed'] as const) {
    const j = deriveJudgements({ ...unplannedSame, omissions: [], templateCoverage: { ot: { status, count: 1 }, pac: { status, count: 0 }, progress: { status, count: 0 } } } as never);
    assert.equal(j.negligence, 'unknown', status);
    assert.equal(j.preventableInjury, 'unknown', status);
  }
  // The recon cited the OT text: a named peri-op event in the omission claim → suspected (rule 3, unchanged since R1).
  const j = deriveJudgements({ ...unplannedSame, omissions: [{ claim: 'calcar crack at impaction, cerclage wire applied — not recorded in discharge', danger: 'moderate' }] });
  assert.equal(j.negligence, 'suspected');
  // The R1 rule text is byte-identical — the version did not move.
  assert.equal(JUDGEMENT_RULE_VERSION, 'readmit-judgement/1');
});

// ── surface: five-state chips + delayed-SSI guards ───────────────────────────────

const sf = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'tight_bounce', auditStatus: 'audited',
  patientName: null, uhid: 'UH-1', ageGender: null, gapDays: 4,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', indexDoctor: null, readmitDoctor: null,
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:00:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 0,
  needsHumanReview: false, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null, ...over,
});
const st = (row: SurfaceFinding) => Object.fromEntries(coverageChips(row).map((c) => [c.key, c.state]));

test('chip mapping: present / empty / absent map through; fetch_failed and a pre-R2 blob (no templateCoverage) are BOTH unknown, never absent', () => {
  const s1 = st(sf({ finding: { templateCoverage: { ot: { status: 'present', count: 1 }, pac: { status: 'empty', count: 2 }, progress: { status: 'absent', count: 0 } } } }));
  assert.equal(s1.ot, 'present'); assert.equal(s1.pac, 'empty'); assert.equal(s1.progress, 'absent');
  const s2 = st(sf({ finding: { templateCoverage: { ot: { status: 'fetch_failed', count: 0 }, pac: null, progress: undefined } } }));
  assert.equal(s2.ot, 'unknown'); assert.equal(s2.pac, 'unknown'); assert.equal(s2.progress, 'unknown');
  const pre = st(sf({ finding: { labSourceProvenance: { indexCase: 'store', structuredLabCount: 3 } } }));   // R1-era blob
  assert.equal(pre.ot, 'unknown'); assert.equal(pre.pac, 'unknown'); assert.equal(pre.progress, 'unknown');
  assert.equal(templateChipState({ status: 'weird' }), 'unknown');
  assert.equal(templateChipState(undefined), 'unknown');
  // Bill does not move on template work (constraint 22) — R3 drives it from returnBill instead.
  assert.equal(s1.bill, 'unknown');
  assert.equal(st(sf({ finding: s1 as never, returnBill: { state: 'billed', netRs: 51968, lines: 40 } })).bill, 'present');
  // Copy per state.
  assert.equal(chipText({ label: 'OT', state: 'empty' }), 'OT empty');
  assert.equal(chipText({ label: 'OT', state: 'absent' }), 'OT none');
  assert.equal(chipText({ label: 'OT', state: 'unknown' }), 'OT');
  assert.equal(chipText({ label: 'OT', state: 'present' }), 'OT');
  assert.equal(chipText({ label: 'Bill', state: 'n/a' }), 'Bill n/a');
  // R3 §3.3: the ONE documented divergence — the Bill chip's `absent` reads "Bill pending", not "Bill none".
  assert.equal(chipText({ key: 'bill', label: 'Bill', state: 'absent' }), 'Bill pending');
  assert.equal(chipText({ key: 'pac', label: 'PAC', state: 'absent' }), 'PAC none');
});

test('delayed-SSI layout guards (constraints 6-11; NO producer in R2): situation line exclusive, chips n/a, justification n/a, bill n/a, brief sentence', () => {
  const d = sf({ findingClass: 'delayed_ssi', readmitDepartment: null, readmitAdmitAt: null, gapDays: null, planned: 'unplanned', sameCondition: 'same' });
  assert.equal(isDelayedSsi(d), true);
  assert.equal(situationLine(d), 'Situation · Delayed SSI');   // and NOT "Unplanned return" even though unplanned+same
  assert.equal(situationLine(sf()), 'Situation · Unplanned return');
  const s = st(d);
  assert.equal(s.readmit_ds, 'n/a'); assert.equal(s.bill, 'n/a');
  assert.equal(s.ot, 'unknown');   // source-4 rules still apply to the rest
  assert.equal(justificationCell(d), 'n/a');
  assert.equal(returnStayBill(d), 'n/a');
  // R3: the class guard wins over any returnBill object — chip, cell and brief stay n/a.
  const dBilled = { ...d, returnBill: { state: 'billed' as const, netRs: 51968, lines: 40 } };
  assert.equal(st(dBilled).bill, 'n/a');
  assert.equal(returnStayBill(dBilled), 'n/a');
  assert.match(composeBrief({ row: dBilled, indexExtract: null, readmitExtract: null }).markdown, /Return stay bill: n\/a/);
  const b = composeBrief({ row: d, indexExtract: null, readmitExtract: null });
  assert.match(b.markdown, new RegExp(BILL_SENTENCE_NO_SECOND_STAY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(b.markdown, /Situation · Delayed SSI/);
  assert.doesNotMatch(b.markdown, /Unplanned same-condition return after/);   // candidate pattern is the IP–IP line only
  assert.match(b.markdown, /Return stay bill: n\/a/);
  // Even–Even and OON are untouched by the guard (R3: Even–Even without a returnBill object still reads the R1 unknown).
  assert.equal(justificationCell(sf()), 'Needs adjudication');
  assert.equal(returnStayBill(sf()), 'unknown — not yet measured');
  assert.equal(returnStayBill(sf({ returnBill: { state: 'billed', netRs: 51968, lines: 40 } })), '₹51,968');
  assert.equal(st(sf({ findingClass: 'out_of_network' })).readmit_ds, 'n/a');
});
