/**
 * Doctor-facing payload builders (lib/doctor-facing.ts) — the allowlist that stands between a
 * governance object and a physician.
 *
 *   node --test --import tsx lib/__tests__/doctor-facing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCTOR_ADVISORY, EVIDENCE_MAX_CHARS,
  doctorAuditMetrics, doctorCitations, doctorInstance, doctorNoteClass, doctorResponse, doctorSignal,
  emptyPatient, evidenceExcerpt, patientContext, resolveCitations, verdictPlain,
} from '../doctor-facing.ts';
import { signalObject, type SignalRow } from '../opd-gov-signal-core.ts';

test('note class: internal discharge_summary maps to discharge; unknown stays null', () => {
  assert.equal(doctorNoteClass('opd'), 'opd');
  assert.equal(doctorNoteClass('discharge_summary'), 'discharge');
  assert.equal(doctorNoteClass('discharge'), 'discharge');
  assert.equal(doctorNoteClass('ot'), 'ot');
  assert.equal(doctorNoteClass('progress'), null);
  assert.equal(doctorNoteClass(undefined), null);
});

test('evidence excerpt: joins points, collapses whitespace, clips to 600 with an ellipsis', () => {
  assert.equal(evidenceExcerpt(undefined), null);
  assert.equal(evidenceExcerpt([]), null);
  assert.equal(evidenceExcerpt(['  ', '']), null);
  assert.equal(evidenceExcerpt(['Dose  was\n 500 mg', ' BD ']), 'Dose was 500 mg · BD');
  const long = evidenceExcerpt(['x'.repeat(2000)]) as string;
  assert.equal(long.length, EVIDENCE_MAX_CHARS);
  assert.ok(long.endsWith('…'));
  const exact = 'y'.repeat(EVIDENCE_MAX_CHARS);
  assert.equal(evidenceExcerpt([exact]), exact, 'exactly 600 chars is not clipped');
});

test('citations: {title, url|null} only; the n index and unusable placeholders are dropped', () => {
  const got = doctorCitations([
    { n: 1, title: 'Harrison — Heart failure', url: 'https://pubmed.test/1' },
    { n: 2, title: 'StatPearls — Anemia', url: '' },
    { n: 3, title: 'Source 3', url: '' },
    { n: 4, title: 'Source 4', url: 'https://pubmed.test/4' },
    { n: 5, title: '', url: 'https://pubmed.test/5' },
    { n: 6, title: 'Harrison — Heart failure', url: 'https://pubmed.test/1' },
  ]);
  assert.deepEqual(got, [
    { title: 'Harrison — Heart failure', url: 'https://pubmed.test/1' },
    { title: 'StatPearls — Anemia', url: null },
    { title: 'Source 4', url: 'https://pubmed.test/4' },
  ]);
  assert.deepEqual(doctorCitations(undefined), []);
  for (const c of got) assert.deepEqual(Object.keys(c), ['title', 'url']);
});

test('resolveCitations: ids resolve against the audit sources; no sources means []', () => {
  const sources = [
    { n: 1, book: 'Harrison', chapter: 'Heart failure', url: 'https://pubmed.test/1' },
    { n: 2, book: 'StatPearls', chapter: null, url: null },
  ];
  assert.deepEqual(resolveCitations([2, 1, 9], sources), [
    { title: 'StatPearls', url: null },
    { title: 'Harrison — Heart failure', url: 'https://pubmed.test/1' },
  ]);
  assert.deepEqual(resolveCitations([1], undefined), []);
  assert.deepEqual(resolveCitations([], sources), []);
});

test('patient context: five nullable fields, nothing invented', () => {
  assert.deepEqual(emptyPatient(), { name: null, age: null, sex: null, ip_number: null, uhid: null });
  assert.deepEqual(patientContext(null), emptyPatient());
  assert.deepEqual(patientContext({ ip_number: ' IP-0111 ', uhid: '' }), { ...emptyPatient(), ip_number: 'IP-0111' });
  assert.equal(patientContext({ age: '67' }).age, 67);
  assert.equal(patientContext({ age: 'abc' }).age, null);
  assert.equal(patientContext({ age: 400 }).age, null);
  assert.deepEqual(Object.keys(patientContext({ stray: 'x', ssn: 'y' } as never)), ['name', 'age', 'sex', 'ip_number', 'uhid']);
});

test('verdict words are plain; an unknown verdict never prints raw', () => {
  assert.equal(verdictPlain('low-value'), 'Low value');
  assert.equal(verdictPlain('context-dependent'), 'Depends on the clinical context');
  assert.equal(verdictPlain('weird_enum'), 'Observation');
});

test('doctorInstance builds from an allowlist: no finding_ref, no citation index, no stray keys', () => {
  const inst = doctorInstance({
    audit_id: 'aud-1', subject: 'S', verdict: 'low-value', rationale: 'R', note_date: '2026-09-20',
    citations: [{ n: 1, title: 'Book', url: 'https://x.test' }],
    evidence_excerpt: 'E', patient: { ip_number: 'IP-1' },
    finding_ref: 'abc123', confidence: 0.82, engine: 'opd-note-audit/0.81.14',
  } as never, 'discharge_summary', true);
  assert.deepEqual(Object.keys(inst).sort(), [
    'audit_id', 'citations', 'evidence_excerpt', 'note_class', 'note_date', 'patient', 'rationale', 'routed', 'subject', 'verdict',
  ]);
  assert.equal(inst.note_class, 'discharge');
  assert.equal(inst.routed, true);
  assert.deepEqual(inst.citations, [{ title: 'Book', url: 'https://x.test' }]);
  assert.equal(inst.patient.ip_number, 'IP-1');
  assert.equal(inst.patient.name, null);
});

test('doctorResponse keeps the doctor\'s own answer and drops request ids and extras', () => {
  assert.equal(doctorResponse(null), null);
  assert.equal(doctorResponse('x'), null);
  assert.deepEqual(doctorResponse({
    verb: 'disagree', type: 'explanation', verdict: 'disagree', comment: 'No.', responded_at: '2026-09-03T10:00:00.000Z',
    client_request_id: 'req-1', cm_note: 'internal',
  }), { verb: 'disagree', type: 'explanation', verdict: 'disagree', comment: 'No.', responded_at: '2026-09-03T10:00:00.000Z' });
});

test('doctorSignal: ruling, importance and unknown future keys never reach the doctor', () => {
  const row: SignalRow = {
    reference: 'EHRC-AUD-2026-0001', signal_id: 'sig-1', doctor_uid: 'DOC', signal_type: 'antibiotic_stewardship',
    note_class: 'discharge_summary', importance: 'high', response_required: 'explanation', status: 'routed',
    instances: 2, window_from: '2026-09-01', window_to: '2026-09-30', routed_at: '2026-09-02T00:00:00.000Z',
    sla_due_at: '2026-09-09T00:00:00.000Z',
    latest_response: { verb: 'agree', client_request_id: 'req-9', comment: 'ok' },
    ruling: { action: 'privilege_action', note: 'INTERNAL NOTE', actor: 'gov:42', gov_intervention_ref: 'EPI-7' },
  };
  const obj = { ...signalObject(row, null, '2026-09-10T00:00:00.000Z'), triage: { rationale: 'jev:route conf=0.82', policy_version: 'triage-shadow-policy/0.1.3' }, future_field: 'x' };
  const doc = doctorSignal(obj as never, null);
  assert.deepEqual(Object.keys(doc).sort(), [
    'doctor_uid', 'instances', 'label', 'note_class', 'overdue', 'reference', 'representative', 'response',
    'response_required', 'routed_at', 'signal_id', 'signal_type', 'sla_due_at', 'status', 'window',
  ]);
  assert.equal(doc.note_class, 'discharge');
  assert.equal(doc.overdue, true);
  const blob = JSON.stringify(doc);
  for (const banned of ['ruling', 'INTERNAL NOTE', 'privilege_action', 'EPI-7', 'importance', 'triage', 'jev', 'policy', 'conf=', 'client_request_id', 'future_field']) {
    assert.ok(!blob.includes(banned), banned);
  }
});

test('audit metrics drop the engine fields and keep the doctor\'s own numbers', () => {
  const m = doctorAuditMetrics({
    notes_audited: 40, nqi_mean: 71, band_a_pct: 30, documentation_completeness: 80, prescribing_safety: 90,
    top_gap: 'allergies', as_of: '2026-09-20', engine_versions: 3, oldest_engine_version: 'opd-note-audit/0.80.1',
  });
  assert.deepEqual(Object.keys(m).sort(), [
    'as_of', 'band_a_pct', 'documentation_completeness', 'notes_audited', 'nqi_mean', 'prescribing_safety', 'top_gap',
  ]);
  assert.equal(m.notes_audited, 40);
});

test('the advisory line names no internal system', () => {
  assert.match(DOCTOR_ADVISORY, /not a performance score/);
  for (const banned of [/CDMSS/i, /CAT\b/, /RMO/, /engine/i, /triage/i, /Jev/i, /policy/i, /care manager/i]) {
    assert.doesNotMatch(DOCTOR_ADVISORY, banned);
  }
});
