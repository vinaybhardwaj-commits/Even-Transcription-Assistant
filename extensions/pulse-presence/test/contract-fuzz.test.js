// T4 — parser / identity fuzz tests. Pulse responses are mutated and malformed on purpose; the invariants:
//   1. a logged-in-looking row (login / non-null doctor_uid) is NEVER emitted unless the verify body carries a valid
//      data.doctor.uid at exactly that path;
//   2. a Pulse contract change (renamed field, extra nesting, uid at the wrong path) is LOUD: no login, no logout,
//      and every later event carries doctor_uid=null with reason "identity_unreadable" (this is what the sink and
//      the q-contract.mjs monitor key on) instead of silently going quiet or fabricating an identity;
//   3. nothing throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPulseIdentity, UID_RE } = require('../src/lib/identity.js');
const { createContent } = require('../src/content.js');
const { createAgent, sanitizeMessage } = require('../src/agent.js');
const { makeChrome, makeFetch, makeApiFetch, makeIndexedDB, ACCESS_OK, NAME_OK, DR, F4, lit } = require('./fakes.js');

const UID = 'FAKEUID000000000001';
const CFG = { machine_id: 'MAC-F', room: 'OPD-F', ingest_url: 'https://ingest.example/v1/events', token: 'TOKEN-F' };
const HOME = 'https://pulse.even.in/';
const clone = (o) => JSON.parse(JSON.stringify(o));

// content.js -> agent.js -> transport (fake fetch), one rig per scenario.
function rig({ access = ACCESS_OK(UID), name = NAME_OK(`${DR} ${F4}`), href = HOME, visible = true } = {}) {
  const api = makeApiFetch({ access, name });
  const vis = { visibilityState: visible ? 'visible' : 'hidden' };
  const content = createContent({
    chrome: makeChrome(), indexedDB: makeIndexedDB(null), location: { href }, fetch: api,
    sessionStorage: { getItem: () => null }, document: vis,
  });
  const chrome = makeChrome({ managed: CFG });
  const sink = makeFetch();
  const clock = { t: Date.parse('2026-10-03T04:00:00Z') };
  const agent = createAgent(chrome, { fetch: sink, now: () => clock.t });
  const r = {
    api, vis, content, agent, clock,
    events: () => sink.calls.flatMap((c) => c.body.events),
  };
  r.pump = async () => { const m = await r.content.snapshot(); await agent.onState(m); await agent.settled(); return m; };
  r.beat = async () => { clock.t += 30000; await agent.onHeartbeat(); await agent.settled(); };
  return r;
}
const names = (evs) => evs.map((e) => e.event);

// ---------- 1. verify failures: never a fabricated logged-in row ----------
const FAILURES = [
  ['401', { status: 401, body: {} }, 'absent'],
  ['403', { status: 403, body: {} }, 'absent'],
  ['network throw', { throws: true }, 'invalid'],
  ['500', { status: 500, body: {} }, 'invalid'],
  ['empty / unparseable body', { badJson: true }, 'invalid'],
  ['body null', { status: 200, body: null }, 'invalid'],
  ['body {}', { status: 200, body: {} }, 'invalid'],
  ['{data:null}', { status: 200, body: { data: null } }, 'invalid'],
  ['{data:{}}', { status: 200, body: { data: {} } }, 'invalid'],
  ['{data:{doctor:null}}', { status: 200, body: { data: { doctor: null } } }, 'invalid'],
  ['{data:{doctor:{}}}', { status: 200, body: { data: { doctor: {} } } }, 'invalid'],
  ['{data:{doctor:"str"}}', { status: 200, body: { data: { doctor: 'str' } } }, 'invalid'],
  ['{data:{doctor:[]}}', { status: 200, body: { data: { doctor: [] } } }, 'invalid'],
];
test('verify failure shapes: status is absent/invalid, identity null, and the agent never emits a login', async () => {
  for (const [label, access, want] of FAILURES) {
    const r = rig({ access });
    const m = await r.pump();
    assert.equal(m.status, want, label);
    assert.equal(m.identity, null, label);
    await r.beat();
    const evs = r.events();
    assert.ok(!names(evs).includes('login'), label + ': fabricated login');
    for (const e of evs) assert.equal(e.doctor_uid, null, label + ': non-null doctor_uid on ' + e.event);
  }
});

test('401 after a real login is a logout of that doctor (visible tab); a network throw is NOT a logout', async () => {
  const r = rig();
  await r.pump();
  r.api.accessSpec = { throws: true };
  await r.pump();
  assert.deepEqual(names(r.events()), ['login'], 'transient failure must not log the doctor out');
  r.api.accessSpec = { status: 401, body: {} };
  await r.pump();
  const evs = r.events();
  assert.deepEqual(names(evs), ['login', 'logout']);
  assert.equal(evs[1].doctor_uid, UID);
});

// ---------- 2. impersonation ----------
test('data.is_impersonating true: identity suppressed end to end, no login/logout, events carry impersonating=true and no uid/name', async () => {
  const r = rig({ access: ACCESS_OK(UID, { is_impersonating: true }), name: NAME_OK('Impersonator Name') });
  const m = await r.pump();
  assert.equal(m.impersonating, true);
  assert.equal(m.status, 'absent');
  assert.equal(m.identity, null);
  await r.beat();
  const evs = r.events();
  assert.ok(!names(evs).includes('login') && !names(evs).includes('logout'));
  for (const e of evs) {
    assert.equal(e.doctor_uid, null);
    assert.equal(e.display_name, null);
    assert.equal(e.impersonating, true);
  }
  assert.ok(!JSON.stringify(evs).includes(UID) && !JSON.stringify(evs).includes('Impersonator'));
});

test('a real doctor session then impersonation starts: identity hidden from events while it lasts, no logout emitted', async () => {
  const r = rig();
  await r.pump();
  r.api.accessSpec = ACCESS_OK(UID, { is_impersonating: true });
  await r.pump();
  await r.beat();
  const evs = r.events();
  assert.deepEqual(names(evs).filter((n) => n === 'login' || n === 'logout'), ['login']);
  const last = evs[evs.length - 1];
  assert.equal(last.event, 'heartbeat');
  assert.equal(last.doctor_uid, null);
  assert.equal(last.impersonating, true);
});

// KNOWN GAP (documents current behaviour, not a desired one): the impersonation flag is read from exactly one
// key. If Pulse renames it, a genuinely impersonated session is reported as a normal login. Nothing downstream
// can detect that. Pinned here so a change to this behaviour is a conscious decision.
test('KNOWN GAP: a renamed is_impersonating key is not detected (session reported as normal login)', async () => {
  const body = ACCESS_OK(UID).body;
  delete body.data.is_impersonating;
  body.data.isImpersonating = true;
  const r = await readPulseIdentity(makeApiFetch({ access: { status: 200, body }, name: NAME_OK('X') }));
  assert.equal(r.status, 'present');
  assert.equal(r.impersonating, false);
});

// ---------- 3. getName missing / empty while verify has a uid ----------
const NAME_BREAKS = [
  ['404', { status: 404, body: {} }],
  ['500', { status: 500, body: {} }],
  ['network throw', { throws: true }],
  ['bad json', { badJson: true }],
  ['{}', { status: 200, body: {} }],
  ['{data:null}', { status: 200, body: { data: null } }],
  ['{data:""}', { status: 200, body: { data: '' } }],
  ['{data:"   "}', { status: 200, body: { data: '   ' } }],
  ['{data:{name:"x"}} (contract change to object)', { status: 200, body: { data: { name: `${DR} ${F4}` } } }],
  ['{data:12345}', { status: 200, body: { data: 12345 } }],
  ['over 200 chars', { status: 200, body: { data: 'n'.repeat(201) } }],
  ['name endpoint absent entirely', null],
];
// Defined behaviour: uid is enough for a login. display_name is null, the event is still a valid logged-in row,
// and nothing throws. (If getName silently changes shape fleet-wide, every login row will have display_name=null
// — q-contract.mjs does not flag that; name null with uid set is the tell in the sink.)
test('getName missing/empty/odd while verify has a uid: login carries doctor_uid with display_name null, no crash', async () => {
  for (const [label, name] of NAME_BREAKS) {
    const r = rig({ name });
    const m = await r.pump();
    assert.equal(m.status, 'present', label);
    assert.deepEqual(m.identity, { doctor_uid: UID, display_name: null, email: null }, label);
    const evs = r.events();
    assert.deepEqual(names(evs), ['login'], label);
    assert.equal(evs[0].doctor_uid, UID, label);
    assert.equal(evs[0].display_name, null, label);
  }
});

// ---------- 4. /login route ----------
test('/login route: absent without ever calling the Pulse API, even when a stale valid cookie would verify', async () => {
  for (const href of ['https://pulse.even.in/login', 'https://pulse.even.in/login/', 'https://pulse.even.in/login?next=%2F', 'https://pulse.even.in/login#x']) {
    const r = rig({ href });
    const m = await r.content.snapshot();
    assert.equal(m.status, 'absent', href);
    assert.equal(m.identity, null, href);
    assert.equal(m.route.type, 'login', href);
    assert.equal(r.api.calls.length, 0, href + ': identity read attempted on /login');
  }
});

test('/login visible after a login = logout; /login in a hidden tab does not evict', async () => {
  const a = rig();
  await a.pump();
  a.content = createContent({ chrome: makeChrome(), indexedDB: makeIndexedDB(null), location: { href: 'https://pulse.even.in/login' }, fetch: a.api, sessionStorage: { getItem: () => null }, document: { visibilityState: 'visible' } });
  await a.pump();
  assert.deepEqual(names(a.events()), ['login', 'logout']);
  const b = rig();
  await b.pump();
  b.content = createContent({ chrome: makeChrome(), indexedDB: makeIndexedDB(null), location: { href: 'https://pulse.even.in/login' }, fetch: b.api, sessionStorage: { getItem: () => null }, document: { visibilityState: 'hidden' } });
  await b.pump();
  assert.deepEqual(names(b.events()), ['login']);
});

// ---------- 5. contract change: the silent-breakage risk. MUST be loud. ----------
const okBody = () => ACCESS_OK(UID).body;
function withDoctor(f) { const b = okBody(); f(b); return b; }
const CONTRACT_BREAKS = [
  ['doctor.uid renamed doctor.id', withDoctor((b) => { b.data.doctor.id = b.data.doctor.uid; delete b.data.doctor.uid; })],
  ['doctor.uid renamed doctor.doctor_uid', withDoctor((b) => { b.data.doctor.doctor_uid = b.data.doctor.uid; delete b.data.doctor.uid; })],
  ['doctor renamed doctor_profile', withDoctor((b) => { b.data.doctor_profile = b.data.doctor; delete b.data.doctor; })],
  ['data renamed result', { result: okBody().data, message: 'OK' }],
  ['no data envelope (doctor at top level)', { doctor: { uid: UID }, message: 'OK' }],
  ['extra nesting data.data.doctor', { data: { data: okBody().data }, message: 'OK' }],
  ['extra nesting data.user.doctor', { data: { user: okBody().data }, message: 'OK' }],
  ['uid at data.uid', { data: { uid: UID, is_impersonating: false }, message: 'OK' }],
  ['uid at top-level', { uid: UID, data: {}, message: 'OK' }],
  ['doctor is an array', { data: { doctor: [{ uid: UID }], is_impersonating: false } }],
  ['data is an array', { data: [okBody().data] }],
  ['uid numeric', withDoctor((b) => { b.data.doctor.uid = 12345; })],
  ['uid null', withDoctor((b) => { b.data.doctor.uid = null; })],
  ['uid object', withDoctor((b) => { b.data.doctor.uid = { value: UID }; })],
  ['uid empty string', withDoctor((b) => { b.data.doctor.uid = ''; })],
  ['uid with illegal chars (format change)', withDoctor((b) => { b.data.doctor.uid = 'doc/' + UID; })],
  ['body is a JSON string', JSON.stringify(okBody())],
  ['body is an array', [okBody()]],
];
test('contract change: status invalid, no identity, no login (never a logged-in-looking row with null uid)', async () => {
  for (const [label, body] of CONTRACT_BREAKS) {
    const res = await readPulseIdentity(makeApiFetch({ access: { status: 200, body }, name: NAME_OK(`${DR} ${F4}`) }));
    assert.equal(res.status, 'invalid', label);
    assert.equal(res.identity, undefined, label);
    const r = rig({ access: { status: 200, body } });
    const m = await r.pump();
    assert.equal(m.status, 'invalid', label);
    assert.equal(m.identity, null, label);
    await r.beat();
    const evs = r.events();
    assert.ok(!names(evs).includes('login'), label + ': login emitted');
    assert.ok(evs.length >= 1, label + ': went silent instead of loud');
    for (const e of evs) {
      assert.equal(e.doctor_uid, null, label);
      assert.equal(e.display_name, null, label);
      assert.equal(e.reason, 'invalid_no_doctor', label + ': breakage not flagged in reason');
    }
  }
});

test('contract change AFTER a good login: no logout, last-known kept, but every subsequent event is flagged identity_unreadable with null uid', async () => {
  for (const [label, body] of CONTRACT_BREAKS) {
    const r = rig();
    await r.pump();
    r.api.accessSpec = { status: 200, body };
    await r.pump();
    await r.beat();
    const evs = r.events();
    assert.deepEqual(names(evs).filter((n) => n !== 'heartbeat'), ['login'], label);
    const after = evs.slice(1);
    assert.ok(after.length >= 1, label);
    for (const e of after) {
      assert.equal(e.doctor_uid, null, label);
      assert.equal(e.reason, 'invalid_no_doctor', label);
    }
    // recovery: contract restored -> flags clear, doctor visible again with no duplicate login
    r.api.accessSpec = ACCESS_OK(UID);
    await r.pump();
    await r.beat();
    const tail = r.events().slice(-1)[0];
    assert.equal(tail.doctor_uid, UID, label + ': did not recover');
    assert.equal(tail.reason, null, label);
    assert.equal(names(r.events()).filter((n) => n === 'login').length, 1, label + ': duplicate login on recovery');
  }
});

test('forged / mangled content-script messages: present without a valid doctor_uid degrades to invalid', () => {
  const base = { type: 'pulse_state', impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true };
  const bad = [undefined, null, {}, { display_name: lit('x') }, { doctor_uid: '' }, { doctor_uid: 5 }, { doctor_uid: 'a b' }, { doctor_uid: 'x'.repeat(129) }, { uid: UID }];
  for (const identity of bad) {
    const s = sanitizeMessage({ ...base, status: 'present', identity });
    assert.equal(s.status, 'invalid', JSON.stringify(identity));
    assert.equal(s.identity, null, JSON.stringify(identity));
  }
  assert.equal(sanitizeMessage({ ...base, status: 'bogus', identity: { doctor_uid: UID } }).status, 'invalid');
  assert.equal(sanitizeMessage(null), null);
  assert.equal(sanitizeMessage({ type: 'other' }), null);
});

// ---------- 6. seeded mutation fuzz with an independent oracle ----------
function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const JUNK = [null, 0, 1, -1, '', ' ', 'x', 'a b', '../', true, false, [], {}, [1], { a: 1 }, 1e308, 'é', 'x'.repeat(300), UID + '!', { uid: UID }];
function mutate(rand, v, depth = 0) {
  const o = clone(v);
  const walk = (node) => {
    if (node && typeof node === 'object') {
      const ks = Object.keys(node);
      if (!ks.length || rand() < 0.25) return node;
      const k = ks[Math.floor(rand() * ks.length)];
      const roll = rand();
      if (roll < 0.25) delete node[k];
      else if (roll < 0.5) node[k] = JUNK[Math.floor(rand() * JUNK.length)];
      else if (roll < 0.62) { node[k + '_x'] = node[k]; delete node[k]; }
      else if (roll < 0.72) node[k] = { data: node[k] };
      else walk(node[k]);
    }
    return node;
  };
  let out = o;
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) out = walk(out);
  return out;
}
test('mutation fuzz (3000 seeded mutations): present iff data.doctor.uid is a valid string at exactly that path; never throws', async () => {
  const rand = prng(0xC0FFEE);
  let present = 0;
  let invalid = 0;
  for (let i = 0; i < 3000; i++) {
    const body = mutate(rand, okBody());
    let res;
    await assert.doesNotReject(async () => { res = await readPulseIdentity(makeApiFetch({ access: { status: 200, body }, name: NAME_OK(`${DR} ${F4}`) })); }, JSON.stringify(body));
    const d = body && body.data;
    const u = d && typeof d === 'object' && !Array.isArray(d) && d.doctor && typeof d.doctor === 'object' ? d.doctor.uid : undefined;
    const valid = typeof u === 'string' && UID_RE.test(u);
    if (valid) {
      assert.equal(res.status, 'present', JSON.stringify(body));
      assert.equal(res.identity.doctor_uid, u, JSON.stringify(body));
      assert.ok(res.identity.doctor_uid, 'null/empty uid on a present row');
      present++;
    } else {
      assert.equal(res.status, 'invalid', JSON.stringify(body));
      assert.equal(res.identity, undefined, JSON.stringify(body));
      invalid++;
    }
  }
  assert.ok(present > 100 && invalid > 100, 'fuzzer should exercise both branches (present=' + present + ' invalid=' + invalid + ')');
});
