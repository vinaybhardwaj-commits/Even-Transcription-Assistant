/**
 *   node --experimental-strip-types --test lib/__tests__/opd-gov-signal-core.test.ts
 * Pure core: governance audit-signal reference, SLA, status machine, validation, object shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAuditRef, parseAuditRef, isAuditRef, computeSlaDueAt, mintStatus, isOverdue,
  statusAfterResponse, statusAfterAction, validateDoctorResponse, validateSignalAction,
  signalObject, signalLabel, type SignalRow,
} from '../opd-gov-signal-core.ts';

test('reference format + parse round-trips and validates', () => {
  assert.equal(formatAuditRef(2026, 7), 'EHRC-AUD-2026-0007');
  assert.deepEqual(parseAuditRef('EHRC-AUD-2026-0007'), { year: 2026, n: 7 });
  assert.equal(parseAuditRef('EHRC-INC-2026-0001'), null);
  assert.equal(isAuditRef('EHRC-AUD-2026-0042'), true);
  assert.equal(isAuditRef('nope'), false);
});

test('SLA only when a timely response is owed; privilege-review escalates on mint', () => {
  assert.equal(computeSlaDueAt('2026-07-03T00:00:00Z', 'acknowledgment', 7), '2026-07-10T00:00:00.000Z');
  assert.equal(computeSlaDueAt('2026-07-03T00:00:00Z', 'none', 7), null);
  assert.equal(computeSlaDueAt('2026-07-03T00:00:00Z', 'recommend_privilege_review', 7), null);
  assert.equal(mintStatus('acknowledgment'), 'routed');
  assert.equal(mintStatus('none'), 'routed');
  assert.equal(mintStatus('recommend_privilege_review'), 'escalated');
});

test('isOverdue: only a routed, past-SLA, response-owed signal is overdue', () => {
  const base = { status: 'routed', response_required: 'acknowledgment', sla_due_at: '2026-07-10T00:00:00Z' };
  assert.equal(isOverdue(base, '2026-07-11T00:00:00Z'), true);
  assert.equal(isOverdue(base, '2026-07-09T00:00:00Z'), false);
  assert.equal(isOverdue({ ...base, status: 'responded' }, '2026-07-11T00:00:00Z'), false);
  assert.equal(isOverdue({ ...base, response_required: 'none', sla_due_at: null }, '2026-07-11T00:00:00Z'), false);
});

test('status machine: response + action transitions', () => {
  assert.equal(statusAfterResponse('acknowledgment', null), 'responded');
  assert.equal(statusAfterResponse('explanation', 'agree'), 'responded');
  assert.equal(statusAfterResponse('explanation', 'disagree'), 'escalated');
  assert.equal(statusAfterAction('acknowledged_by_governance'), 'ruled');
  assert.equal(statusAfterAction('privilege_action'), 'ruled');
  assert.equal(statusAfterAction('dismissed'), 'closed');
  assert.equal(statusAfterAction('closed'), 'closed');
});

test('validateDoctorResponse: type must match; explanation needs comment+verdict; guards', () => {
  const sig = { doctor_uid: 'HalPy', response_required: 'acknowledgment', status: 'routed' };
  assert.equal(validateDoctorResponse({ type: 'explanation' }, sig).ok, false);           // wrong type
  assert.ok(validateDoctorResponse({ type: 'acknowledgment', doctor_uid: 'HalPy' }, sig).ok);
  // wrong doctor → 403
  const wrongDoc = validateDoctorResponse({ type: 'acknowledgment', doctor_uid: 'OTHER' }, sig);
  assert.equal(wrongDoc.ok, false); if (!wrongDoc.ok) assert.equal(wrongDoc.code, 403);
  // explanation signal
  const esig = { doctor_uid: 'HalPy', response_required: 'explanation', status: 'routed' };
  assert.equal(validateDoctorResponse({ type: 'explanation', comment: '' }, esig).ok, false);         // no comment
  assert.equal(validateDoctorResponse({ type: 'explanation', comment: 'x' }, esig).ok, false);        // no verdict
  const good = validateDoctorResponse({ type: 'explanation', comment: 'reviewed externally', verdict: 'disagree' }, esig);
  assert.ok(good.ok); if (good.ok) assert.equal(good.value.verdict, 'disagree');
  // no-response signals reject
  assert.equal(validateDoctorResponse({ type: 'acknowledgment' }, { doctor_uid: 'X', response_required: 'none', status: 'routed' }).ok, false);
  // closed → 409
  const closed = validateDoctorResponse({ type: 'acknowledgment' }, { doctor_uid: 'X', response_required: 'acknowledgment', status: 'closed' });
  assert.equal(closed.ok, false); if (!closed.ok) assert.equal(closed.code, 409);
});

test('validateSignalAction: enum guard + normalize', () => {
  assert.equal(validateSignalAction({ action: 'bogus' }).ok, false);
  const r = validateSignalAction({ action: 'privilege_action', note: 'held 1:1', actor: 'gov:benita', gov_intervention_ref: 'epi:gi:1234' });
  assert.ok(r.ok); if (r.ok) { assert.equal(r.value.action, 'privilege_action'); assert.equal(r.value.gov_intervention_ref, 'epi:gi:1234'); }
});

test('signalObject: shape + overdue + label; no patient fields', () => {
  const row: SignalRow = {
    reference: 'EHRC-AUD-2026-0001', signal_id: 'uuid', doctor_uid: 'HalPy', signal_type: 'drug_interaction',
    importance: 'high', response_required: 'acknowledgment', status: 'routed', instances: 46,
    window_from: '2026-07-02', window_to: '2026-07-02', routed_at: '2026-07-03T00:00:00Z',
    sla_due_at: '2026-07-10T00:00:00Z', latest_response: null, ruling: null,
  };
  const o = signalObject(row, { audit_id: 'a', finding_ref: 'f', subject: 'Interaction: A + B', verdict: 'low-value', rationale: 'r', note_date: '2026-07-02', citations: [] }, '2026-07-11T00:00:00Z');
  assert.equal(o.label, 'Drug interaction');
  assert.equal(o.overdue, true);              // now past SLA, still routed
  assert.equal(o.instances, 46);
  assert.equal(o.response, null);
  assert.equal(signalLabel('appropriateness_low_value'), 'Low-value / inappropriate care');
  assert.ok(!('patient' in o) && !('uhid' in o));
});
