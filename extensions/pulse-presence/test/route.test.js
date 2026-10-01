const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoute, isImpersonating } = require('../src/lib/route.js');
const { classifyUrl, parseConsultBody } = require('../src/lib/body.js');
const { bytes } = require('./fakes.js');

test('route parsing yields a type and an opaque ref only', () => {
  assert.deepEqual(parseRoute('https://pulse.even.in/'), { type: 'home', prescription_ref: null, doctor_email_present: false });
  assert.deepEqual(parseRoute('https://pulse.even.in/login'), { type: 'login', prescription_ref: null, doctor_email_present: false });
  const p = parseRoute('https://pulse.even.in/prescription?individual_uid=IND1&prescription_uid=RX-1');
  assert.deepEqual(p, { type: 'prescription', prescription_ref: 'RX-1', doctor_email_present: false });
  const q = parseRoute('https://pulse.even.in/patient/MEM123?prescription_uid=RX_2');
  assert.deepEqual(q, { type: 'patient', prescription_ref: 'RX_2', doctor_email_present: false });
  assert.ok(!JSON.stringify([p, q]).includes('IND1') && !JSON.stringify(q).includes('MEM123'));
});

test('route parsing rejects odd refs, other origins, other paths', () => {
  assert.equal(parseRoute('https://pulse.even.in/prescription?prescription_uid=a%20b').prescription_ref, null);
  assert.equal(parseRoute('https://pulse.even.in/prescription?prescription_uid=' + 'a'.repeat(129)).prescription_ref, null);
  assert.equal(parseRoute('https://pulse.even.in/vaccination?prescription_uid=RX1').prescription_ref, null);
  assert.equal(parseRoute('https://evil.example/prescription?prescription_uid=RX1').type, 'other');
  assert.equal(parseRoute('not a url').type, 'other');
});

test('impersonation rule: doctor_email param or is-impersonation == "true"', () => {
  assert.equal(isImpersonating('https://pulse.even.in/?doctor_email=a%40b.c', null), true);
  assert.equal(isImpersonating('https://pulse.even.in/patient/X?prescription_uid=R&doctor_email=', null), true);
  assert.equal(isImpersonating('https://pulse.even.in/', 'true'), true);
  assert.equal(isImpersonating('https://pulse.even.in/', 'false'), false);
  assert.equal(isImpersonating('https://pulse.even.in/', null), false);
});

test('Start/End URL classification', () => {
  assert.equal(classifyUrl('https://pulse.even.in/api/emr/startConsult'), 'start');
  assert.equal(classifyUrl('https://pulse.even.in/api/emr/endConsult?x=1'), 'end');
  assert.equal(classifyUrl('https://pulse.even.in/api/emr/getConsults'), null);
  assert.equal(classifyUrl('https://other.example/api/emr/startConsult'), null);
});

test('body parsing extracts only consult_uid', () => {
  const body = { consult_uid: 'C-1', individual_uid: 'IND9', name: 'Patient Name', data: { x: 1 } };
  const r = parseConsultBody(bytes(body));
  assert.deepEqual(r, { ok: true, consult_uid: 'C-1' });
  assert.ok(!JSON.stringify(r).includes('IND9') && !JSON.stringify(r).includes('Patient'));
  assert.deepEqual(parseConsultBody(bytes({ data: { consult_uid: 'C-2', membership: 'M' } })), { ok: true, consult_uid: 'C-2' });
  assert.deepEqual(parseConsultBody({ formData: { consult_uid: ['C-3'], individual_uid: ['I'] } }), { ok: true, consult_uid: 'C-3' });
});

test('body parsing fails safe when the body is unavailable or malformed', () => {
  const fail = { ok: false, consult_uid: null };
  assert.deepEqual(parseConsultBody(undefined), fail);
  assert.deepEqual(parseConsultBody({ error: 'Unknown error' }), fail);
  assert.deepEqual(parseConsultBody({ raw: [{ file: '/x' }] }), fail);
  assert.deepEqual(parseConsultBody({ raw: [{ bytes: new TextEncoder().encode('not json').buffer }] }), fail);
  assert.deepEqual(parseConsultBody(bytes({ individual_uid: 'only' })), fail);
  assert.deepEqual(parseConsultBody(bytes({ consult_uid: 'has space' })), fail);
  assert.deepEqual(parseConsultBody(bytes({ consult_uid: 42 })), fail);
});
