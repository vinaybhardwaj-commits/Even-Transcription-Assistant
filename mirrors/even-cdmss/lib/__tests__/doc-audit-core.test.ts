/**
 * Pure-core tests for lib/doc-audit-core.ts.
 * Run: node --experimental-strip-types --test lib/__tests__/doc-audit-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDocType, normFieldStatus, normNetValue,
  parseExtraction, parseAnalysis, assembleCompleteness,
  parseStatusList, normAdminFacts, adminFactsLine, buildAnalyzeUser,
  enrichQueryForFinding, unionEnrichedHits, AUDIT_REVISE_SYSTEM,
  applyCitationGate,
  type RubricField, type AuditFinding,
} from '../doc-audit-core.ts';
import type { CiteHit } from '../citations-core.ts';

const hit = (id: number, text = `chunk ${id}`): CiteHit => ({ id, text, source: 'mksap', book: 'MKSAP', chapter: null, page_start: null, page_end: null, item_number: null, similarity: 0.5 });

test('normDocType maps synonyms + defaults to discharge_summary', () => {
  assert.equal(normDocType('OT'), 'ot_note');
  assert.equal(normDocType('operative note'), 'ot_note');
  assert.equal(normDocType('prescription'), 'opd_rx');
  assert.equal(normDocType('discharge'), 'discharge_summary');
  assert.equal(normDocType('???'), 'discharge_summary');
});

test('normFieldStatus + normNetValue map + default', () => {
  assert.equal(normFieldStatus('Not documented'), 'missing');
  assert.equal(normFieldStatus('incomplete'), 'partial');
  assert.equal(normFieldStatus('N/A'), 'na');
  assert.equal(normFieldStatus('weird'), 'missing');
  assert.equal(normNetValue('low value'), 'low-value');
  assert.equal(normNetValue('nonsense'), 'uncertain');
});

test('parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts', () => {
  const raw = '```json\n' + JSON.stringify({
    detected_doc_type: 'discharge_summary', confidence: 0.9,
    patient: { age: 54, sex: 'M' },
    diagnosis: 'acute calculous cholecystitis', procedure: 'laparoscopic cholecystectomy',
    investigations: ['USG abdomen', 'CT abdomen contrast', 'CT abdomen contrast'],
    treatments: ['IV antibiotics 6 days'], medications: ['Pantoprazole', 'Paracetamol'],
    course_summary: 'uneventful', disposition: 'Discharged', follow_up: null, raw_notes: 'typed EMR pdf',
    admin_facts: { length_of_stay_days: 5, admission_type: 'elective', care_setting: 'ward' },
    completeness: [
      { key: 'date_admission', status: 'present', note: '' },
      { key: 'treating_doctor', status: 'present', note: '' },
      { key: 'discharge_medication', status: 'missing', note: 'no dose/route/duration' },
    ],
  }) + '\n```';
  const ec = parseExtraction(raw, 'auto');
  assert.ok(ec);
  assert.equal(ec!.docType, 'discharge_summary');
  assert.equal(ec!.patient.age, 54);
  assert.equal(ec!.patient.sex, 'male');
  assert.equal(ec!.investigations.length, 3);
  assert.equal(ec!.procedure, 'laparoscopic cholecystectomy');
  // completeness now comes from the document read, not the analyze pass
  assert.equal(ec!.completeness!.length, 3);
  assert.equal(ec!.completeness!.find((c) => c.key === 'date_admission')!.status, 'present');
  assert.equal(ec!.completeness!.find((c) => c.key === 'discharge_medication')!.status, 'missing');
  // admin facts captured (LOS is a duration, not a date)
  assert.equal(ec!.adminFacts!.lengthOfStayDays, 5);
  assert.equal(ec!.adminFacts!.admissionType, 'elective');
});

test('parseExtraction docTypeHint overrides detected', () => {
  const ec = parseExtraction(JSON.stringify({ detected_doc_type: 'opd_rx', course_summary: 'x', medications: ['amox'] }), 'ot_note');
  assert.ok(ec);
  assert.equal(ec!.docType, 'ot_note');        // hint wins
  assert.equal(ec!.detectedDocType, 'opd_rx'); // detection preserved
});

test('parseExtraction returns null when nothing was read', () => {
  assert.equal(parseExtraction('garbage', 'auto'), null);
  assert.equal(parseExtraction(JSON.stringify({ detected_doc_type: 'opd_rx', course_summary: '', medications: [] }), 'auto'), null);
});

test('parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions', () => {
  const raw = JSON.stringify({
    findings: [
      { subject: 'Repeat CT abdomen', verdict: 'low-value', confidence: 0.8, rationale: 'USG was diagnostic', order: 'CT abdomen contrast', evidence: ['guideline'], estimates: ['est. ~₹6500'], citation_ids: [1, 5] },
    ],
    idealised_summary: 'early lap chole, short abx',
    diff: [
      { kind: 'overuse', text: 'repeat CT' },
      { kind: 'gap', text: 'no follow-up plan', ref: 'AAC.14' },
      { kind: 'missing thing', text: 'no HPE' },
    ],
    suggestions: [
      { priority: 3, text: 'document HPE' },
      { priority: 1, text: 'add follow-up + red flags', ref: 'AAC.14' },
    ],
  });
  const a = parseAnalysis(raw, 3);
  assert.ok(a);
  assert.equal(a!.findings[0].order, 'CT abdomen contrast');
  assert.equal(a!.findings[0].evidence.length, 1);
  assert.equal(a!.findings[0].estimates.length, 1);
  // citation_ids clamped to [1..3]: 5 dropped
  assert.deepEqual(a!.findings[0].citation_ids, [1]);
  // 'missing thing' → gap
  assert.equal(a!.diff[2].kind, 'gap');
  // suggestions sorted by priority
  assert.equal(a!.suggestions[0].priority, 1);
  assert.equal(a!.suggestions[0].text, 'add follow-up + red flags');
  // completeness is no longer part of the analyze pass
  assert.equal((a as unknown as Record<string, unknown>).completeness, undefined);
});

test('parseAnalysis returns null on empty/garbage; survives on idealised-only', () => {
  assert.equal(parseAnalysis('nope'), null);
  assert.equal(parseAnalysis(JSON.stringify({ findings: [], suggestions: [] })), null);
  // an idealised summary alone is still a usable analysis
  assert.ok(parseAnalysis(JSON.stringify({ findings: [], suggestions: [], idealised_summary: 'x' })));
});

test('parseStatusList + normAdminFacts: status-only, day-count not dates', () => {
  const sl = parseStatusList([{ key: 'date_admission', status: 'present' }, { status: 'present' }, { key: 'x', status: 'absent' }]);
  assert.equal(sl.length, 2);                       // entry with no key dropped
  assert.equal(sl[1].status, 'missing');            // 'absent' → missing
  const af = normAdminFacts({ length_of_stay_days: 8, admission_type: 'Elective', care_setting: 'room' });
  assert.equal(af!.lengthOfStayDays, 8);
  assert.equal(normAdminFacts({}), undefined);      // nothing → undefined
  assert.equal(adminFactsLine(af!), 'Stay: length of stay 8 days; Elective; room');
});

const RUBRIC: RubricField[] = [
  { key: 'diagnosis', label: 'Diagnosis', section: 'clinical', ref: 'AAC.14', mandatory: true, na: false },
  { key: 'urgent_care_instructions', label: 'Urgent care', section: 'followup', ref: 'AAC.14', mandatory: true, na: false },
  { key: 'procedures_performed', label: 'Procedures', section: 'course', ref: 'AAC.14', mandatory: true, na: true },
  { key: 'cause_of_death', label: 'Cause of death', section: 'outcome', ref: 'AAC.14', mandatory: true, na: false, cond: 'outcome=Death' },
];

test('assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields', () => {
  const rep = assembleCompleteness([
    { key: 'diagnosis', status: 'present', note: '' },
    { key: 'urgent_care_instructions', status: 'missing', note: 'absent' },
    { key: 'procedures_performed', status: 'na', note: 'no procedure' },
  ], RUBRIC);
  // denominator = 3 non-conditional mandatory (diagnosis, urgent, procedures); cause_of_death is conditional & unmarked → excluded
  assert.equal(rep.mandatoryTotal, 3);
  // present(1) + na(1) + missing(0) = 2 of 3
  assert.equal(rep.mandatoryMet, 2);
  assert.equal(rep.coverage, Math.round((2 / 3) * 100) / 100);
  assert.deepEqual(rep.missingMandatory, ['Urgent care']);
  assert.equal(rep.items.length, 4); // all rubric fields appear, including the conditional one (defaults missing in items)
});

test('assembleCompleteness counts partial as 0.5 and includes an applicable conditional field', () => {
  const rep = assembleCompleteness([
    { key: 'diagnosis', status: 'partial', note: 'vague' },
    { key: 'urgent_care_instructions', status: 'present', note: '' },
    { key: 'procedures_performed', status: 'present', note: '' },
    { key: 'cause_of_death', status: 'present', note: 'death case' }, // conditional, now applicable
  ], RUBRIC);
  // denom = 3 base + 1 applicable conditional = 4; met = 0.5 + 1 + 1 + 1 = 3.5
  assert.equal(rep.mandatoryTotal, 4);
  assert.equal(rep.mandatoryMet, 3.5);
  assert.equal(rep.coverage, Math.round((3.5 / 4) * 100) / 100);
});

// ── PX §6.3 regression pins (PRD risk R3): the extract schema change is ADDITIVE ──

test('PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys', () => {
  const oldShape = JSON.stringify({
    detected_doc_type: 'discharge_summary', confidence: 0.9,
    patient: { age: 38, sex: 'm' },
    diagnosis: 'Grade III hemorrhoids', indication: 'Painful defecation',
    procedure: 'Laser hemorrhoidopexy',
    investigations: ['PAC'], treatments: ['IV Ceftum'], medications: ['Tab Ceftum 500mg'],
    course_summary: 'Elective, uneventful.', disposition: 'Home', follow_up: 'After one week',
    admin_facts: { length_of_stay_days: 1, admission_type: 'elective', care_setting: 'room' },
    completeness: [{ key: 'diagnosis', status: 'present', note: '' }],
    raw_notes: 'legible',
  });
  const ec = parseExtraction(oldShape, 'auto');
  assert.ok(ec);
  assert.equal(ec!.docType, 'discharge_summary');
  assert.equal(ec!.confidence, 0.9);
  assert.deepEqual(ec!.patient, { age: 38, sex: 'male' });
  assert.equal(ec!.diagnosis, 'Grade III hemorrhoids');
  assert.deepEqual(ec!.medications, ['Tab Ceftum 500mg']);
  assert.equal(ec!.adminFacts!.lengthOfStayDays, 1);
  assert.equal(ec!.completeness!.length, 1);
  assert.equal(ec!.followUp, 'After one week');
  // New keys: safe defaults, nothing invented.
  assert.deepEqual(ec!.riskFactors, []);
  assert.equal(ec!.aftercare, undefined);
});

test('PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass', () => {
  const ec = parseExtraction(JSON.stringify({
    detected_doc_type: 'discharge_summary', course_summary: 'Elective procedure, uneventful.',
    medications: ['Inj Dynapar 75mg'],
    risk_factors: ['Known allergy to Diclofenac Sodium'],
  }), 'auto')!;
  const user = buildAnalyzeUser(ec, '[1] excerpt', 'NABH discharge summary');
  assert.match(user, /Stated risk factors \/ allergies: Known allergy to Diclofenac Sodium/);
  // and absent when there are none (old-shape) — no stray header
  const old = parseExtraction(JSON.stringify({ detected_doc_type: 'discharge_summary', course_summary: 'x', medications: ['amox'] }), 'auto')!;
  assert.doesNotMatch(buildAnalyzeUser(old, '', 'std'), /Stated risk factors/);
});

test('PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined', () => {
  const newShape = JSON.stringify({
    detected_doc_type: 'discharge_summary', course_summary: 'x', medications: ['amox'],
    risk_factors: ['Known allergy to Diclofenac Sodium', '', 'Diabetic'],
    aftercare: { instructions: ['Sitz bath 1-1-1'], warning_signs: ['Fever not subsiding'], follow_up_detail: 'Follow up after one week' },
  });
  const ec = parseExtraction(newShape, 'auto');
  assert.deepEqual(ec!.riskFactors, ['Known allergy to Diclofenac Sodium', 'Diabetic']);
  assert.deepEqual(ec!.aftercare!.warning_signs, ['Fever not subsiding']);
  assert.equal(ec!.aftercare!.follow_up_detail, 'Follow up after one week');

  const emptyAftercare = JSON.stringify({
    detected_doc_type: 'opd_rx', course_summary: 'x', medications: ['amox'],
    aftercare: { instructions: [], warning_signs: [], follow_up_detail: null },
  });
  const ec2 = parseExtraction(emptyAftercare, 'auto');
  assert.equal(ec2!.aftercare, undefined);
  assert.deepEqual(ec2!.riskFactors, []);
});

// ── IPD citation fix: per-finding enrichment helpers ────────────────────────

test('enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds', () => {
  assert.equal(
    enrichQueryForFinding({ subject: 'Widal test', evidence: ['low specificity', ''], rationale: 'anchoring on a low-utility result' }),
    'Widal test. low specificity. anchoring on a low-utility result',
  );
  // missing/empty fields collapse cleanly
  assert.equal(enrichQueryForFinding({ subject: 'IV antibiotics', evidence: [], rationale: '' }), 'IV antibiotics');
  // bounded to 500 chars
  assert.ok(enrichQueryForFinding({ subject: 'x'.repeat(400), evidence: ['y'.repeat(400)], rationale: 'z'.repeat(400) }).length <= 500);
});

test('unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap', () => {
  const base = [hit(1), hit(2), hit(3)];
  const enrichment = [
    [hit(2), hit(9)],   // 2 is a dup of base → dropped; 9 is net-new
    [hit(9), hit(10)],  // 9 already seen → dropped; 10 net-new
  ];
  const out = unionEnrichedHits(base, enrichment, 20);
  // base stays first, in order, at the SAME indices → draft [1..3] survive unchanged
  assert.deepEqual(out.slice(0, 3).map((h) => h.id), [1, 2, 3]);
  // net-new appended in first-seen order, no duplicates
  assert.deepEqual(out.map((h) => h.id), [1, 2, 3, 9, 10]);

  // cap bounds only the appended net-new; base is always retained in full
  const capped = unionEnrichedHits([hit(1), hit(2)], [[hit(3), hit(4), hit(5)]], 3);
  assert.deepEqual(capped.map((h) => h.id), [1, 2, 3]);

  // no enrichment → identity (byte-identical pool)
  assert.deepEqual(unionEnrichedHits(base, [], 20).map((h) => h.id), [1, 2, 3]);
  // malformed groups / hits are skipped, not thrown
  assert.deepEqual(unionEnrichedHits(base, [undefined as unknown as CiteHit[], [undefined as unknown as CiteHit]], 20).map((h) => h.id), [1, 2, 3]);
});

test('unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)', () => {
  // The Neon driver hands back bigint ids as strings; a typeof===number guard would empty the pool.
  const strBase = [{ ...hit(0), id: '35856' as unknown as number }, { ...hit(0), id: '8786' as unknown as number }];
  const strEnrich = [[{ ...hit(0), id: '8786' as unknown as number }, { ...hit(0), id: '157222' as unknown as number }]];
  const out = unionEnrichedHits(strBase, strEnrich, 20);
  assert.deepEqual(out.map((h) => String(h.id)), ['35856', '8786', '157222']);  // base kept, dup dropped, net-new appended
  assert.equal(out.length, 3);
  // mixed number/string ids dedupe consistently (String('8786') === String(8786))
  const mixed = unionEnrichedHits([hit(8786)], [[{ ...hit(0), id: '8786' as unknown as number }]], 20);
  assert.equal(mixed.length, 1);
});

test('SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool', () => {
  assert.match(AUDIT_REVISE_SYSTEM, /leave that finding's "citation_ids" EMPTY/);
  assert.match(AUDIT_REVISE_SYSTEM, /never attach a merely same-topic/i);
  assert.match(AUDIT_REVISE_SYSTEM, /BROADER than the draft/);
});

// ── PR5: in-engine citation gate (pure drop/relabel) ────────────────────────

const finding = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  subject: 'x', verdict: 'low-value', confidence: 0.5, rationale: 'r',
  evidence: ['grounded point A', 'grounded point B'], estimates: ['est. figure'],
  citation_ids: [1, 2], ...over,
});

test('applyCitationGate: partial drop keeps evidence + surviving citations', () => {
  const out = applyCitationGate([finding({ citation_ids: [1, 2, 3] })], [[0, 2]]);
  assert.deepEqual(out.findings[0].citation_ids, [1, 3]);
  assert.deepEqual(out.findings[0].evidence, ['grounded point A', 'grounded point B']);   // intact
  assert.deepEqual(out.findings[0].estimates, ['est. figure']);
  assert.equal(out.nDropped, 1); assert.equal(out.nRelabeled, 0);
});

test('applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)', () => {
  const out = applyCitationGate([finding({ citation_ids: [1, 2] })], [[0, 1], [0, 2]]);
  assert.deepEqual(out.findings[0].citation_ids, []);
  assert.deepEqual(out.findings[0].evidence, []);
  assert.deepEqual(out.findings[0].estimates, ['est. figure', 'grounded point A', 'grounded point B']);
  assert.equal(out.nDropped, 2); assert.equal(out.nRelabeled, 1);
});

test('applyCitationGate: no drops → untouched; multi-finding indices are respected', () => {
  const findings = [finding(), finding({ subject: 'y', citation_ids: [5] })];
  const noop = applyCitationGate(findings, []);
  assert.deepEqual(noop.findings, findings);
  assert.equal(noop.nDropped, 0); assert.equal(noop.nRelabeled, 0);
  // only finding index 1 targeted
  const out = applyCitationGate(findings, [[1, 5]]);
  assert.deepEqual(out.findings[0].citation_ids, [1, 2]);   // untouched
  assert.deepEqual(out.findings[1].citation_ids, []);
  assert.equal(out.nRelabeled, 1);   // finding y had evidence
});

test('applyCitationGate: emptying a finding with NO evidence drops cites without relabel', () => {
  const out = applyCitationGate([finding({ evidence: [], citation_ids: [1] })], [[0, 1]]);
  assert.deepEqual(out.findings[0].citation_ids, []);
  assert.deepEqual(out.findings[0].estimates, ['est. figure']);   // nothing moved
  assert.equal(out.nRelabeled, 0);
});
