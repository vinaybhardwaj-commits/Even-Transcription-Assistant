
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractIdentity, readFirebaseIdentity, readPulseIdentity } = require('../src/lib/identity.js');
const { createContent } = require('../src/content.js');
const { makeIndexedDB, TOKEN_RECORD, makeChrome, makeApiFetch, ACCESS_OK, NAME_OK, ACCESS_URL, NAME_URL, DR, F3, F4, L1, lit } = require('./fakes.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const UID = 'FAKEUID000000000001';

test('extractIdentity keeps only uid, email, displayName and never a token', () => {
  const r = extractIdentity(TOKEN_RECORD);
  assert.equal(r.status, 'present');
  assert.deepEqual(Object.keys(r.identity).sort(), ['displayName', 'email', 'uid']);
  assert.equal(r.identity.email, 'fake.test@example.test');
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

// ---- readPulseIdentity (Pulse cookie-authed API) ----
test('readPulseIdentity: Google session shapes give doctor_uid + display_name, email null', async () => {
  const f = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK(`  ${DR} ${F3} ${L1} `) });
  const r = await readPulseIdentity(f);
  assert.deepEqual(r, { status: 'present', impersonating: false, identity: { doctor_uid: UID, display_name: lit(`${DR} ${F3} ${L1}`), email: null }, reason: null });
  assert.equal(f.calls[0].url, ACCESS_URL);
  assert.equal(f.calls[1].url, NAME_URL);
  for (const c of f.calls) {
    assert.equal(c.init.credentials, 'include');
    assert.equal(c.init.headers.Accept, 'application/json');
  }
  // nothing but the three identity fields comes out (no specialty / stream_data / user_type)
  const s = JSON.stringify(r);
  for (const bad of ['HEALTH_CHECK_UP', 'stream_data', 'DOCTOR', 'has_access']) assert.ok(!s.includes(bad), bad);
});

test('readPulseIdentity fails closed: network error and non-auth failures are invalid, 401/403 are absent', async () => {
  assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { throws: true } })), { status: 'invalid', reason: null });
  assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { status: 401, body: {} } })), { status: 'absent', reason: 'absent_401' });
  assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { status: 403, body: {} } })), { status: 'absent', reason: 'absent_403' });
  for (const st of [404, 429, 500, 502, 503]) {
    assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { status: st, body: {} } })), { status: 'invalid', reason: 'absent_' + st }, String(st));
  }
  assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { badJson: true } })), { status: 'invalid', reason: null });
  assert.deepEqual(await readPulseIdentity(async () => undefined), { status: 'invalid', reason: null });
  for (const body of [null, {}, { data: null }, { data: 'x' }, { data: [] }]) {
    assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { status: 200, body } })), { status: 'invalid', reason: 'invalid_no_doctor' }, JSON.stringify(body));
  }
});

test('readPulseIdentity rejects a missing or malformed doctor uid; carries is_impersonating', async () => {
  const bad = [undefined, '', 5, 'has space', 'a/b', 'x'.repeat(129), '../etc', 'a@b.c'];
  for (const uid of bad) {
    const access = { status: 200, body: { data: { doctor: uid === undefined ? {} : { uid }, is_impersonating: false } } };
    assert.deepEqual(await readPulseIdentity(makeApiFetch({ access, name: NAME_OK() })), { status: 'invalid', impersonating: false, reason: 'invalid_no_doctor' }, String(uid));
  }
  assert.deepEqual(await readPulseIdentity(makeApiFetch({ access: { status: 200, body: { data: { is_impersonating: true } } } })), { status: 'invalid', impersonating: true, reason: 'invalid_no_doctor' });
  const imp = await readPulseIdentity(makeApiFetch({ access: ACCESS_OK(UID, { is_impersonating: true }), name: NAME_OK() }));
  assert.equal(imp.impersonating, true);
  // only a literal true counts
  const notTrue = await readPulseIdentity(makeApiFetch({ access: ACCESS_OK(UID, { is_impersonating: 'true' }), name: NAME_OK() }));
  assert.equal(notTrue.impersonating, false);
});

test('readPulseIdentity: the name lookup is best effort and never fatal', async () => {
  const cases = [
    { throws: true }, { badJson: true }, { status: 500, body: {} }, { status: 401, body: {} },
    { status: 200, body: { data: 42 } }, { status: 200, body: { data: 'x'.repeat(201) } },
    { status: 200, body: { data: '   ' } }, { status: 200, body: {} },
  ];
  for (const name of cases) {
    const r = await readPulseIdentity(makeApiFetch({ access: ACCESS_OK(UID), name }));
    assert.equal(r.status, 'present', JSON.stringify(name));
    assert.deepEqual(r.identity, { doctor_uid: UID, display_name: null, email: null }, JSON.stringify(name));
  }
});

// ---- content script ----
function env(href, records, { session = null, fetch } = {}) {
  const sent = [];
  const chrome = makeChrome();
  chrome.runtime.sendMessage = async (m) => { sent.push(JSON.parse(JSON.stringify(m))); };
  const f = fetch || makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK() });
  return {
    sent, f,
    e: {
      chrome, indexedDB: makeIndexedDB(records), location: { href }, fetch: f,
      sessionStorage: { getItem: (k) => (k === 'is-impersonation' ? session : null) },
      document: { visibilityState: 'visible' },
    },
  };
}
const RX_URL = 'https://pulse.even.in/prescription?individual_uid=IND1&prescription_uid=RX9';

test('Google session: Firebase empty, API gives doctor_uid + display_name, email null', async () => {
  for (const records of [[], null]) {
    const { sent, e } = env(RX_URL, records);
    await createContent(e).check();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 'present');
    assert.deepEqual(sent[0].identity, { doctor_uid: UID, display_name: lit(`${DR} ${F3} ${L1}`), email: null });
    assert.equal(sent[0].impersonating, false);
    assert.deepEqual(sent[0].route, { type: 'prescription', prescription_ref: 'RX9' });
  }
});

test('OTP session (expired token record) with a working cookie: identity is doctor_uid + name; email dropped; cookie call; no reason', async () => {
  const { sent, e, f } = env(RX_URL, [clone(TOKEN_RECORD)]);
  await createContent(e).check();
  assert.equal(sent[0].status, 'present');
  assert.deepEqual(sent[0].identity, { doctor_uid: UID, display_name: lit(`${DR} ${F3} ${L1}`), email: null });
  assert.equal(sent[0].reason, null, 'stale_token only when the cookie call is a 401/403');
  assert.ok(f.calls.every((c) => !c.init.headers.Authorization), 'no Bearer for an expired token');
});

test('content message: tokens, Firebase uid, route internals and API extras never leave', async () => {
  const { sent, e } = env(RX_URL, [clone(TOKEN_RECORD)]);
  await createContent(e).check();
  const s = JSON.stringify(sent[0]);
  for (const bad of ['SECRET', 'stsTokenManager', 'uid-DOC-123', 'IND1', 'phoneNumber', 'individual_uid', 'https://', 'HEALTH_CHECK_UP', 'stream_data']) assert.ok(!s.includes(bad), bad);
  assert.deepEqual(Object.keys(sent[0].identity).sort(), ['display_name', 'doctor_uid', 'email']);
});

test('email bonus is never fatal: a broken or conflicting Firebase record leaves email null', async () => {
  const broken = clone(TOKEN_RECORD);
  delete broken.value.email;
  const a = env(RX_URL, [broken]);
  await createContent(a.e).check();
  assert.equal(a.sent[0].status, 'present');
  assert.equal(a.sent[0].identity.email, null);
  const b = env(RX_URL, [clone(TOKEN_RECORD)]);
  b.e.indexedDB = { open() { throw new Error('idb blocked'); } };
  await createContent(b.e).check();
  assert.equal(b.sent[0].status, 'present');
  assert.equal(b.sent[0].identity.email, null);
});

test('fail closed: network error is invalid with no identity; 401 is absent', async () => {
  const a = env(RX_URL, [clone(TOKEN_RECORD)], { fetch: makeApiFetch({ access: { throws: true } }) });
  await createContent(a.e).check();
  assert.equal(a.sent[0].status, 'invalid');
  assert.equal(a.sent[0].identity, null);
  assert.ok(!JSON.stringify(a.sent[0]).includes('fake.test'), 'a stale Firebase record must not stand in for a failed API read');
  const b = env(RX_URL, [], { fetch: makeApiFetch({ access: { status: 401, body: {} } }) }); // no Firebase record: a real cookie 401
  await createContent(b.e).check();
  assert.equal(b.sent[0].status, 'absent');
  assert.equal(b.sent[0].identity, null);
});

test('impersonation flag (URL or session): no identity fetch is made, the Firebase record is not even read', async () => {
  for (const [href, session] of [['https://pulse.even.in/?doctor_email=x%40y.z', null], ['https://pulse.even.in/', 'true']]) {
    const { sent, e, f } = env(href, [clone(TOKEN_RECORD)], { session });
    let opened = false;
    const orig = e.indexedDB.open;
    e.indexedDB.open = (...a) => { opened = true; return orig(...a); };
    await createContent(e).check();
    assert.equal(opened, false);
    assert.equal(f.calls.length, 0, 'no identity fetch');
    assert.equal(sent[0].impersonating, true);
    assert.equal(sent[0].status, 'absent');
    assert.equal(sent[0].identity, null);
    const s = JSON.stringify(sent[0]);
    assert.ok(!s.includes('fake.test') && !s.includes(UID));
  }
});

test('impersonation reported by the API (is_impersonating true): identity null, no token or identity leaves', async () => {
  const f = makeApiFetch({ access: ACCESS_OK(UID, { is_impersonating: true }), name: NAME_OK() });
  const { sent, e } = env('https://pulse.even.in/', [clone(TOKEN_RECORD)], { fetch: f });
  await createContent(e).check();
  assert.equal(sent[0].impersonating, true);
  assert.equal(sent[0].status, 'absent');
  assert.equal(sent[0].identity, null);
  const s = JSON.stringify(sent[0]);
  assert.ok(!s.includes('fake.test') && !s.includes(UID) && !s.includes(`${F3}`));
});

test('an unusable uid with is_impersonating true is still treated as impersonation', async () => {
  const f = makeApiFetch({ access: { status: 200, body: { data: { is_impersonating: true } } } });
  const { sent, e } = env('https://pulse.even.in/', [], { fetch: f });
  await createContent(e).check();
  assert.equal(sent[0].impersonating, true);
  assert.equal(sent[0].identity, null);
});

// ---- Bearer for OTP logins (presence/bearer-otp) ----
const LIVE_REC = (exp, tok = 'SECRET-ACCESS-TOKEN') => { const r = clone(TOKEN_RECORD); r.value.stsTokenManager.expirationTime = exp; r.value.stsTokenManager.accessToken = tok; return r; };
const NOW = 1_800_000_000_000;

test('OTP-like record with a live token: POST {} with Bearer to both Pulse URLs, 200 path taken, token not in the result', async () => {
  const f = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK(`${DR} ${F4}`) });
  const r = await readPulseIdentity(f, makeIndexedDB([LIVE_REC(NOW + 60000)]), () => NOW);
  assert.equal(r.status, 'present');
  assert.deepEqual(r.identity, { doctor_uid: UID, display_name: lit(`${DR} ${F4}`), email: null });
  assert.equal(r.reason, null);
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.ok(c.url === ACCESS_URL || c.url === NAME_URL);
    assert.ok(c.url.startsWith('https://pulse.even.in/'));
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.body, '{}');
    assert.equal(c.init.headers.Authorization, 'Bearer SECRET-ACCESS-TOKEN');
    assert.equal(c.init.credentials, 'include');
    assert.equal(c.init.redirect, 'error');
  }
  assert.ok(!JSON.stringify(r).includes('SECRET-ACCESS-TOKEN'));
});

test('no Firebase record (Google login) or no idb: cookie-only call unchanged, no reason', async () => {
  for (const idb of [makeIndexedDB([]), makeIndexedDB(null), undefined]) {
    const f = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK() });
    const r = await readPulseIdentity(f, idb, () => NOW);
    assert.equal(r.status, 'present');
    assert.equal(r.reason, null);
    for (const c of f.calls) { assert.equal(c.init.method, undefined); assert.equal(c.init.body, undefined); assert.equal(c.init.headers.Authorization, undefined); }
  }
});

test('expired token: cookie call and reason stale_token; a real failure reason other than 401/403 is kept; malformed records mean cookie call', async () => {
  const exp = LIVE_REC(NOW - 1);
  let f = makeApiFetch({ access: { status: 401, body: {} } });
  assert.deepEqual(await readPulseIdentity(f, makeIndexedDB([exp]), () => NOW), { status: 'invalid', reason: 'stale_token' });
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  f = makeApiFetch({ access: { status: 500, body: {} } });
  assert.equal((await readPulseIdentity(f, makeIndexedDB([exp]), () => NOW)).reason, 'absent_500');
  f = makeApiFetch({ access: { throws: true } });
  assert.deepEqual(await readPulseIdentity(f, makeIndexedDB([exp]), () => NOW), { status: 'invalid', reason: null }, 'network error keeps its null reason');
  f = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK() });
  assert.equal((await readPulseIdentity(f, makeIndexedDB([exp]), () => NOW)).reason, null, 'cookie 200: no stale_token');
  f = makeApiFetch({ access: { status: 200, body: { data: { has_access: true } } } });
  assert.equal((await readPulseIdentity(f, makeIndexedDB([LIVE_REC(NOW)]), () => NOW)).reason, 'invalid_no_doctor', 'expirationTime == now is expired but invalid_no_doctor is kept');
  for (const bad of [LIVE_REC('x'), LIVE_REC(NOW + 1000, ''), LIVE_REC(NOW + 1000, 'has space'), LIVE_REC(NOW + 1000, 'a'.repeat(9000))]) {
    f = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK() });
    const r = await readPulseIdentity(f, makeIndexedDB([bad]), () => NOW);
    assert.equal(r.reason, null);
    assert.equal(f.calls[0].init.headers.Authorization, undefined);
  }
  const two = [LIVE_REC(NOW + 1000), (() => { const r = LIVE_REC(NOW + 1000, 'OTHER'); r.fbase_key = 'firebase:authUser:K2:[DEFAULT]'; return r; })()];
  f = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK() });
  await readPulseIdentity(f, makeIndexedDB(two), () => NOW);
  assert.equal(f.calls[0].init.headers.Authorization, undefined, 'two records: ambiguous, cookie call');
});

test('Bearer fetch that rejects: invalid with null reason, token not in the result; the IndexedDB is never written', async () => {
  const idb = makeIndexedDB([LIVE_REC(NOW + 1000)]);
  const r = await readPulseIdentity(makeApiFetch({ access: { throws: true } }), idb, () => NOW);
  assert.deepEqual(r, { status: 'invalid', reason: null });
  assert.equal(idb.created, false);
});

test('content script passes the page IndexedDB: a live token reaches the Pulse call and not the worker message', async () => {
  const { sent, e, f } = env(RX_URL, [LIVE_REC(Date.now() + 3600000)]);
  await createContent(e).check();
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer SECRET-ACCESS-TOKEN');
  assert.equal(sent[0].status, 'present');
  assert.ok(!JSON.stringify(sent).includes('SECRET-ACCESS-TOKEN'));
});

// Grep: the token is read in identity.js only and no code path writes it to storage, console or a message.
test('source: stsTokenManager/accessToken appear in identity.js only; no console/storage/message/log path takes the token', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(d) { for (const x of fs.readdirSync(d, { withFileTypes: true })) x.isDirectory() ? walk(path.join(d, x.name)) : files.push(path.join(d, x.name)); })(dir);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    const base = path.basename(f);
    if (base !== 'identity.js') assert.ok(!/stsTokenManager|accessToken/.test(s), base + ' touches the token');
    assert.ok(!/console\./.test(s), base + ' uses console');
    if (base === 'identity.js') {
      for (const m of s.matchAll(/\b(?:token|b\.token|accessToken)\b[^;\n]*/g)) {
        assert.ok(!/(storage|sendMessage|postMessage|emit|log|set\()/i.test(m[0]), 'token line: ' + m[0]);
      }
      assert.equal((s.match(/'Bearer '/g) || []).length, 1, 'one place builds the Authorization header');
      assert.ok(!/localStorage|sessionStorage|chrome\./.test(s), 'identity.js has no storage or chrome access');
    }
  }
});

test('expired record on a visible tab never produces absent or a logout (fail closed, last-known kept)', async () => {
  const f = makeApiFetch({ access: { status: 401, body: {} } });
  const { sent, e } = env(RX_URL, [clone(TOKEN_RECORD)], { fetch: f }); // TOKEN_RECORD is expired
  await createContent(e).check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'invalid');
  assert.equal(sent[0].reason, 'stale_token');
  assert.equal(sent[0].identity, null);
});
