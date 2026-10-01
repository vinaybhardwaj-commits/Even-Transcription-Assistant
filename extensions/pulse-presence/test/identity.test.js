const test = require('node:test');
const assert = require('node:assert/strict');
const { extractIdentity, readFirebaseIdentity } = require('../src/lib/identity.js');
const { createContent } = require('../src/content.js');
const { makeIndexedDB, TOKEN_RECORD, makeChrome } = require('./fakes.js');

const clone = (o) => JSON.parse(JSON.stringify(o));

test('extractIdentity keeps only uid, email, displayName and never a token', () => {
  const r = extractIdentity(TOKEN_RECORD);
  assert.equal(r.status, 'present');
  assert.deepEqual(Object.keys(r.identity).sort(), ['displayName', 'email', 'uid']);
  assert.equal(r.identity.email, 'dr.test@even.in');
  const s = JSON.stringify(r);
  for (const bad of ['SECRET-REFRESH-TOKEN', 'SECRET-ACCESS-TOKEN', 'stsTokenManager', 'phoneNumber', 'AIzaFAKEKEY']) {
    assert.ok(!s.includes(bad), bad + ' leaked');
  }
});

test('schema check fails closed', () => {
  const cases = [
    null, {}, { value: null }, { value: [] },
    { value: { uid: '', email: 'a@b.c' } },
    { value: { uid: 'u', email: 'not-an-email' } },
    { value: { uid: 'u', email: 'a@b.c', displayName: 42 } },
    { value: { uid: 5, email: 'a@b.c' } },
  ];
  for (const c of cases) assert.equal(extractIdentity(c).status, 'invalid', JSON.stringify(c));
});

test('readFirebaseIdentity: present, absent, invalid, conflicting', async () => {
  const p = await readFirebaseIdentity(makeIndexedDB([clone(TOKEN_RECORD), { fbase_key: 'other:key', value: { x: 1 } }]));
  assert.equal(p.status, 'present');
  assert.ok(!JSON.stringify(p).includes('SECRET'));

  const idbMissing = makeIndexedDB(null);
  assert.equal((await readFirebaseIdentity(idbMissing)).status, 'absent');
  assert.equal(idbMissing.created, false);

  assert.equal((await readFirebaseIdentity(makeIndexedDB([]))).status, 'absent');

  const broken = clone(TOKEN_RECORD);
  delete broken.value.email;
  assert.equal((await readFirebaseIdentity(makeIndexedDB([broken]))).status, 'invalid');

  const other = clone(TOKEN_RECORD);
  other.fbase_key = 'firebase:authUser:OTHER:[DEFAULT]';
  other.value.uid = 'different-uid';
  assert.equal((await readFirebaseIdentity(makeIndexedDB([clone(TOKEN_RECORD), other]))).status, 'invalid');
});

function env(href, records, session = null) {
  const sent = [];
  const chrome = makeChrome();
  chrome.runtime.sendMessage = async (m) => { sent.push(JSON.parse(JSON.stringify(m))); };
  return {
    sent,
    e: {
      chrome, indexedDB: makeIndexedDB(records), location: { href },
      sessionStorage: { getItem: (k) => (k === 'is-impersonation' ? session : null) },
      document: { visibilityState: 'visible' },
    },
  };
}

test('content script message carries email and display_name only; tokens and uid never leave', async () => {
  const { sent, e } = env('https://pulse.even.in/prescription?individual_uid=IND1&prescription_uid=RX9', [clone(TOKEN_RECORD)]);
  await createContent(e).check();
  assert.equal(sent.length, 1);
  const s = JSON.stringify(sent[0]);
  for (const bad of ['SECRET', 'stsTokenManager', 'uid-DOC-123', 'IND1', 'phoneNumber', 'individual_uid', 'https://']) assert.ok(!s.includes(bad), bad);
  assert.deepEqual(sent[0].identity, { email: 'dr.test@even.in', display_name: 'Dr Test' });
  assert.deepEqual(sent[0].route, { type: 'prescription', prescription_ref: 'RX9' });
});

test('impersonation: the Firebase record is not even read', async () => {
  for (const [href, sess] of [['https://pulse.even.in/?doctor_email=x%40y.z', null], ['https://pulse.even.in/', 'true']]) {
    const { sent, e } = env(href, [clone(TOKEN_RECORD)], sess);
    let opened = false;
    const orig = e.indexedDB.open;
    e.indexedDB.open = (...a) => { opened = true; return orig(...a); };
    await createContent(e).check();
    assert.equal(opened, false);
    assert.equal(sent[0].impersonating, true);
    assert.equal(sent[0].identity, null);
    assert.ok(!JSON.stringify(sent[0]).includes('dr.test'));
  }
});
