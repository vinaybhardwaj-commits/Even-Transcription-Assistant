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

const { safeKeyNames, WHY } = require('../src/lib/body.js');
const rawText = (t) => ({ raw: [{ bytes: new TextEncoder().encode(t).buffer }] });
const why = (b) => { const r = parseConsultBody(b); assert.equal(r.ok, false); assert.equal(r.consult_uid, null); return r.why; };

test('every failure path names its why', () => {
  assert.equal(why(undefined), 'no_body');
  assert.equal(why({ error: 'Unknown error' }), 'no_body');
  assert.equal(why({ formData: { individual_uid: ['I'] } }), 'form_no_key');
  assert.equal(why({ formData: { consult_uid: ['has space'] } }), 'bad_uid');
  assert.equal(why({}), 'raw_missing');
  assert.equal(why({ raw: [] }), 'raw_missing');
  assert.equal(why({ raw: [{}] }), 'raw_missing');
  assert.equal(why({ raw: [{ file: '/x' }] }), 'raw_file_only');
  assert.equal(why({ raw: [{ bytes: new Uint8Array(40 * 1024).buffer }, { bytes: new Uint8Array(40 * 1024).buffer }] }), 'too_large');
  assert.equal(why(rawText('not json')), 'not_json');
  assert.equal(why(rawText('42')), 'not_json');
  assert.equal(why(rawText('null')), 'not_json');
  assert.equal(why(bytes({ individual_uid: 'only' })), 'json_no_key');
  assert.equal(why(bytes([{ consult_uid: 'C' }])), 'json_no_key');
  assert.equal(why(bytes({ consult_uid: 'has space' })), 'bad_uid');
  assert.equal(why(bytes({ consult_uid: 42 })), 'bad_uid');
  assert.equal(why(bytes({ data: { consultUid: '' } })), 'bad_uid');
  for (const w of ['no_body', 'form_no_key', 'raw_missing', 'raw_file_only', 'too_large', 'not_json', 'json_no_key', 'bad_uid']) assert.ok(WHY.includes(w));
});

test('accepted keys and nestings', () => {
  const holders = [(x) => x, (x) => ({ data: x }), (x) => ({ payload: x }), (x) => ({ consult: x }), (x) => ({ data: { consult: x } })];
  for (const k of ['consult_uid', 'consultUid', 'consult_id']) {
    holders.forEach((h, i) => {
      assert.deepEqual(parseConsultBody(bytes(h({ [k]: 'C-' + i, other: 'x' }))), { ok: true, consult_uid: 'C-' + i }, k + ' at path ' + i);
    });
  }
  assert.deepEqual(parseConsultBody({ formData: { consultUid: ['F-1'] } }), { ok: true, consult_uid: 'F-1' });
  assert.deepEqual(parseConsultBody({ formData: { consult_uid: ['F-2'] } }), { ok: true, consult_uid: 'F-2' });
});

test('exactness: no guessing from other fields or deeper paths', () => {
  assert.equal(why(bytes({ id: 'C-1', uid: 'C-2', consult: { id: 'C-3' } })), 'json_no_key');
  assert.equal(why(bytes({ a: { b: { consult_uid: 'C-1' } } })), 'json_no_key');
  assert.equal(why(bytes({ data: { x: { consult_uid: 'C-1' } } })), 'json_no_key');
  assert.equal(why(bytes({ consult: { consult: { consult_uid: 'C-1' } } })), 'json_no_key');
  assert.equal(why({ formData: { consult_id: ['C-1'] } }), 'form_no_key');
  // conflicts: any invalid candidate, or two different valid ones, is bad_uid with no consult_uid
  assert.equal(why(bytes({ consult_uid: 'bad uid', data: { consult_uid: 'C-9' } })), 'bad_uid');
  assert.equal(why(bytes({ consult_uid: 'C-9', data: { consultUid: 42 } })), 'bad_uid');
  assert.equal(why(bytes({ consult_uid: 'C-1', consultUid: 'C-2' })), 'bad_uid');
  assert.equal(why(bytes({ consult_uid: 'C-1', data: { consult: { consult_id: 'C-2' } } })), 'bad_uid');
  assert.equal(why({ formData: { consult_uid: ['C-1'], consultUid: ['C-2'] } }), 'bad_uid');
  assert.equal(why({ formData: { consult_uid: ['C-1'], consultUid: ['bad uid'] } }), 'bad_uid');
  assert.deepEqual(parseConsultBody(bytes({ consult_uid: 'C-1', data: { consult_uid: 'C-1' }, consult: { consultUid: 'C-1' } })), { ok: true, consult_uid: 'C-1' });
  assert.equal(why({ formData: { consult_uid: ['C-1', 'C-2'] } }), 'bad_uid');
  assert.equal(why({ formData: { consult_uid: ['C-1', 'bad uid'] } }), 'bad_uid');
  assert.equal(why({ formData: { consult_uid: [] } }), 'bad_uid');
  assert.deepEqual(parseConsultBody({ formData: { consult_uid: ['C-1', 'C-1'] } }), { ok: true, consult_uid: 'C-1' });
  assert.deepEqual(parseConsultBody({ formData: { consult_uid: ['C-1'], consultUid: ['C-1'] } }), { ok: true, consult_uid: 'C-1' });
});

test('body_keys drops digit runs, id-keyed maps, capitalised names and phone-like keys', () => {
  const r = parseConsultBody(bytes({ a1234: 1, '9876543210': 2, abc12: 3, Ramesh_Kumar: 4, Zeta: 5, _x: 6, '1abc': 7, '987654': 8, uid_00012345: 9, status: 10, dataKey2: 11 }));
  assert.deepEqual(r.body_keys, ['abc12', 'dataKey2', 'status']);
  const ids = {}; for (let i = 0; i < 20; i++) ids['id' + (100000 + i)] = 'v';
  assert.deepEqual(parseConsultBody(bytes(ids)).body_keys, []);
});

test('body_keys allows at most 3 digits in total', () => {
  const r = parseConsultBody(bytes({ p98_76_54_32_10: 1, a1b2c3: 2, a1b2c3d4: 3, x_1_2_3_4: 4, abc123: 5 }));
  assert.deepEqual(r.body_keys, ['a1b2c3', 'abc123']);
});

test('body_keys carries only sanitised key names, never values', () => {
  const r = parseConsultBody(bytes({ zeta: 'SECRET-VALUE', alpha: { nested: 'SECRET2' }, 'bad key': 1, 'x-y': 2, [('k'.repeat(33))]: 3, 'ok_32': 4 }));
  assert.equal(r.why, 'json_no_key');
  assert.deepEqual(r.body_keys, ['alpha', 'ok_32', 'zeta']);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const many = {}; for (let i = 0; i < 30; i++) many['k' + String(i).padStart(2, '0')] = 'v' + i;
  const m = parseConsultBody(bytes(many));
  assert.equal(m.body_keys.length, 12);
  assert.deepEqual(m.body_keys, [...m.body_keys].sort());
  assert.deepEqual(safeKeyNames([1, 2]), []);
  // only json_no_key carries body_keys
  assert.equal(parseConsultBody(rawText('nope')).body_keys, undefined);
  assert.equal(parseConsultBody(bytes({ consult_uid: 'bad uid', z: 1 })).body_keys, undefined);
});
