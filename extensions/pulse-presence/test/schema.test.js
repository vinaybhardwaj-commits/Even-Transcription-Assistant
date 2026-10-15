
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/lib/events.js');
const { createAgent } = require('../src/agent.js');
const { makeChrome, makeFetch, bytes } = require('./fakes.js');

// The wire schema: 13 base fields (doctor_uid is the primary identity) plus page_name, instance_id, cookie_uid, cookie_name (0.1.1).
const FIELDS = ['machine_id', 'room', 'doctor_uid', 'email', 'display_name', 'event', 'encounter_id', 'prescription_ref', 'ts', 'tab_focus', 'impersonating', 'ext_version', 'reason', 'page_name', 'instance_id', 'cookie_uid', 'cookie_name', 'identity_age_s', 'last_doctor_uid', 'last_doctor_age_s'];
const WIRE_FIELDS = FIELDS.concat(['body_keys']); // body_keys (0.1.4) is optional: present only on a body_json_no_key event
const CFG = { machine_id: 'M', room: 'R', ingest_url: 'https://ingest.example/e', token: 'T' };

test('field list is exactly the 21 wire fields (body_keys optional), including doctor_uid', () => {
  assert.equal(WIRE_FIELDS.length, 21);
  assert.deepEqual([...E.EVENT_FIELDS].sort(), [...WIRE_FIELDS].sort());
  assert.ok(E.EVENT_FIELDS.includes('doctor_uid') && E.EVENT_FIELDS.includes('email'));
  assert.deepEqual([...E.EVENT_TYPES], ['login', 'logout', 'encounter_open', 'encounter_close', 'idle', 'active', 'locked', 'heartbeat', 'identity_stale']);
});

test('validateEvent rejects extra, missing and mistyped fields', () => {
  const ok = E.buildEvent({ event: 'heartbeat', ts: '2026-09-30T10:00:00.000+05:30', ext_version: '0.1.0' });
  assert.deepEqual(E.validateEvent(ok), []);
  assert.ok(E.validateEvent({ ...ok, token: 'x' }).length);
  assert.ok(E.validateEvent({ ...ok, uid: 'x' }).length);
  const { room, ...noRoom } = ok;
  assert.ok(E.validateEvent(noRoom).length);
  assert.ok(E.validateEvent({ ...ok, event: 'idle_locked' }).length);
  assert.ok(E.validateEvent({ ...ok, tab_focus: 'yes' }).length);
  assert.ok(E.validateEvent({ ...ok, ts: 'yesterday' }).length);
  assert.ok(E.validateEvent({ ...ok, reason: 'because' }).length);
  assert.ok(E.validateEvent(null).length);
});

test('doctor_uid: nullable string up to 256; null is valid; the old 12-field shape is no longer valid', () => {
  const base = { event: 'login', ts: '2026-09-30T10:00:00.000+05:30', ext_version: '0.1.0' };
  const nullUid = E.buildEvent({ ...base, doctor_uid: null });
  assert.equal(nullUid.doctor_uid, null);
  assert.deepEqual(E.validateEvent(nullUid), []);
  assert.deepEqual(E.validateEvent(E.buildEvent({ ...base })), [], 'omitted doctor_uid builds as null');
  const withUid = E.buildEvent({ ...base, doctor_uid: 'FAKEUID000000000001', email: null, display_name: 'Dr X' });
  assert.equal(withUid.doctor_uid, 'FAKEUID000000000001');
  assert.equal(withUid.email, null);
  assert.deepEqual(E.validateEvent(withUid), [], 'email null with a doctor_uid is valid');
  assert.ok(E.validateEvent({ ...withUid, doctor_uid: 5 }).length);
  assert.ok(E.validateEvent({ ...withUid, doctor_uid: 'x'.repeat(257) }).length);
  assert.deepEqual(E.validateEvent({ ...withUid, doctor_uid: 'x'.repeat(256) }), []);
  const { doctor_uid, ...legacy } = withUid;
  assert.ok(E.validateEvent(legacy).some((p) => p.includes('doctor_uid')), 'missing doctor_uid is reported');
  assert.ok(E.validateEvent({ ...withUid, extra_field: 'x' }).some((p) => p.includes('extra_field')), 'extra field still rejected');
});

test('buildEvent cannot carry a stray field', () => {
  const ev = E.buildEvent({ event: 'login', ts: '2026-09-30T10:00:00.000Z', ext_version: '1', stsTokenManager: 'x', uid: 'u', individual_uid: 'i' });
  assert.deepEqual(Object.keys(ev).sort(), [...FIELDS].sort());
  assert.equal(ev.doctor_uid, null);
});

test('every outbound event over a full session matches the 17-field schema exactly', async () => {
  const chrome = makeChrome({ managed: CFG });
  const fetch = makeFetch();
  const agent = createAgent(chrome, { fetch });
  const from = { id: 'ext-id', url: 'https://pulse.even.in/' };
  const m = (o) => ({ type: 'pulse_state', status: 'present', identity: { doctor_uid: 'DOC-A', display_name: 'A', email: null }, reason: null, page_name: null, impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true, ...o });
  const go = async (x) => { chrome.runtime.onMessage.fire(x, from); await agent.settled(); };
  await go(m());
  await go(m({ route: { type: 'prescription', prescription_ref: 'RX1' } }));
  chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/endConsult', requestBody: bytes({ consult_uid: 'C1', individual_uid: 'I' }) });
  chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 200 });
  for (const s of ['idle', 'locked', 'active']) chrome.idle.onStateChanged.fire(s);
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await go(m({ impersonating: true }));
  await go(m({ status: 'invalid', identity: null }));
  await go(m({ status: 'absent', identity: null }));
  await go(m({ page_name: 'Zed' })); // cookie says 'A', page greets Zed: identity_stale
  await agent.settled();
  const evs = fetch.calls.flatMap((c) => c.body.events);
  const seen = new Set(evs.map((e) => e.event));
  for (const t of E.EVENT_TYPES) assert.ok(seen.has(t), 'session did not exercise ' + t);
  for (const e of evs) {
    assert.deepEqual(Object.keys(e).sort(), [...FIELDS].sort());
    assert.deepEqual(E.validateEvent(e), []);
  }
  assert.ok(evs.some((e) => e.doctor_uid === 'DOC-A' && e.email === null), 'email-null events carry the doctor_uid');
  assert.ok(!JSON.stringify(evs).includes('individual_uid'));
});

test('a field outside the schema in the queue is never sent (test fails if the guard is removed)', async () => {
  const stale = { machine_id: 'M', room: 'R', doctor_uid: null, email: null, display_name: null, event: 'heartbeat', encounter_id: null, prescription_ref: null, ts: '2026-09-30T10:00:00.000+05:30', tab_focus: false, impersonating: false, ext_version: '0.1.0', reason: null };
  const now = Date.now();
  const chrome = makeChrome({ managed: CFG, local: { queue: [
    { at: now, event: { ...stale, uid: 'leak' } },
    { at: now, event: { ...stale, stsTokenManager: { accessToken: 'leak' } } },
    { at: now, event: stale },
  ] } });
  const fetch = makeFetch();
  const agent = createAgent(chrome, { fetch });
  await agent.transport.flush();
  const evs = fetch.calls.flatMap((c) => c.body.events);
  assert.equal(evs.length, 1);
  assert.ok(!JSON.stringify(fetch.calls).includes('leak'));
  // the surviving event was queued by a pre-0.1.1 build: it ships with its 13 base fields, the four new ones absent
  for (const e of evs) assert.deepEqual(Object.keys(e).sort(), FIELDS.slice(0, 13).sort());
});

test('manifest: MV3, minimal permissions, two hosts, top frame only, no bundler', () => {
  const root = path.join(__dirname, '..');
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(mf.manifest_version, 3);
  assert.deepEqual([...mf.permissions].sort(), ['alarms', 'idle', 'storage', 'tabs', 'webRequest']);
  assert.equal(mf.host_permissions.length, 2);
  assert.equal(mf.host_permissions[0], 'https://pulse.even.in/*');
  assert.ok(mf.host_permissions[1].startsWith('https://') && !mf.host_permissions[1].startsWith('https://*'));
  assert.ok(!mf.host_permissions.includes('<all_urls>'));
  assert.ok(!mf.permissions.includes('cookies') && !mf.permissions.includes('scripting') && !mf.permissions.includes('webRequestBlocking'));
  assert.deepEqual(mf.eta_config, { ingest_url: '', token: '', machine_id: '', room: '' }, 'committed manifest must not carry config');
  assert.equal(mf.content_scripts.length, 1);
  assert.equal(mf.content_scripts[0].all_frames, false);
  assert.deepEqual(mf.content_scripts[0].matches, ['https://pulse.even.in/*']);
  assert.ok(!mf.content_scripts[0].world);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies && !pkg.devDependencies);
});

test('source never touches cookies, scripting, or page-world injection', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : files.push(path.join(d, f.name)); })(dir);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    for (const bad of ['chrome.cookies', 'chrome.scripting', "world: 'MAIN'", 'innerText', 'querySelector', 'innerHTML', 'localStorage', 'sessionStorage.setItem', 'document.cookie']) {
      // content.js alone may read the one greeting element (selector pinned below).
      if (bad === 'querySelector' && path.basename(f) === 'content.js') continue;
      assert.ok(!s.includes(bad), f + ' contains ' + bad);
    }
    if (path.basename(f) === 'content.js') {
      assert.deepEqual(s.match(/querySelector\([^)]*\)/g), ["querySelector('h1[class*=\"greeting\"]')"], 'content.js reads only the greeting element');
    }
  }
});

test('0.1.4: body_keys is optional, names only, sorted, bounded, and only with body_json_no_key', () => {
  const E = require('../src/lib/events.js');
  const base = { machine_id: 'M', room: 'R', doctor_uid: null, event: 'encounter_open', ts: '2026-10-15T10:00:00.000+05:30', tab_focus: false, impersonating: false, ext_version: '0.1.4' };
  const mk = (extra) => E.buildEvent(Object.assign({}, base, extra));
  assert.deepEqual(E.validateEvent(mk({ reason: 'body_json_no_key', body_keys: ['a', 'b'] })), []);
  assert.deepEqual(E.validateEvent(mk({ reason: 'body_json_no_key', body_keys: [] })), []);
  assert.ok(!('body_keys' in mk({ reason: 'body_bad_uid', body_keys: ['a'] })));
  const forced = (k, reason = 'body_json_no_key') => Object.assign(mk({ reason: 'body_json_no_key' }), { body_keys: k, reason });
  assert.ok(E.validateEvent(forced(['b', 'a'])).length);
  assert.ok(E.validateEvent(forced(['a b'])).length);
  assert.ok(E.validateEvent(forced(['Name'])).length);
  assert.ok(E.validateEvent(forced(['a1234'])).length);
  assert.ok(E.validateEvent(forced(['p98_76_54_32_10'])).length);
  assert.ok(E.validateEvent(forced(['a1b2c3d4'])).length);
  assert.ok(E.validateEvent(forced(['abc123'])).length === 0);
  assert.ok(E.validateEvent(forced(['k'.repeat(33)])).length);
  assert.ok(E.validateEvent(forced(Array.from({ length: 13 }, (_, i) => 'k' + String.fromCharCode(97 + i)))).length);
  assert.ok(E.validateEvent(forced([{ v: 1 }])).length);
  assert.ok(E.validateEvent(forced(['a'], 'body_bad_uid')).length);
});
