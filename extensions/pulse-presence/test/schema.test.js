const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/lib/events.js');
const { createAgent } = require('../src/agent.js');
const { makeChrome, makeFetch, bytes } = require('./fakes.js');

const R6 = ['machine_id', 'room', 'email', 'display_name', 'event', 'encounter_id', 'prescription_ref', 'ts', 'tab_focus', 'impersonating', 'ext_version', 'reason'];
const CFG = { machine_id: 'M', room: 'R', ingest_url: 'https://ingest.example/e', token: 'T' };

test('field list is exactly R6', () => {
  assert.deepEqual([...E.EVENT_FIELDS].sort(), [...R6].sort());
  assert.deepEqual([...E.EVENT_TYPES], ['login', 'logout', 'encounter_open', 'encounter_close', 'idle', 'active', 'locked', 'heartbeat']);
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

test('buildEvent cannot carry a stray field', () => {
  const ev = E.buildEvent({ event: 'login', ts: '2026-09-30T10:00:00.000Z', ext_version: '1', stsTokenManager: 'x', uid: 'u', individual_uid: 'i' });
  assert.deepEqual(Object.keys(ev).sort(), [...R6].sort());
});

test('every outbound event over a full session matches R6 exactly', async () => {
  const chrome = makeChrome({ managed: CFG });
  const fetch = makeFetch();
  const agent = createAgent(chrome, { fetch });
  const from = { id: 'ext-id', url: 'https://pulse.even.in/' };
  const m = (o) => ({ type: 'pulse_state', status: 'present', identity: { email: 'a@b.c', display_name: 'A' }, impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true, ...o });
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
  await agent.settled();
  const evs = fetch.calls.flatMap((c) => c.body.events);
  const seen = new Set(evs.map((e) => e.event));
  for (const t of E.EVENT_TYPES) assert.ok(seen.has(t), 'session did not exercise ' + t);
  for (const e of evs) {
    assert.deepEqual(Object.keys(e).sort(), [...R6].sort());
    assert.deepEqual(E.validateEvent(e), []);
  }
  assert.ok(!JSON.stringify(evs).includes('individual_uid'));
});

test('a field outside R6 in the queue is never sent (test fails if the guard is removed)', async () => {
  const stale = { machine_id: 'M', room: 'R', email: null, display_name: null, event: 'heartbeat', encounter_id: null, prescription_ref: null, ts: '2026-09-30T10:00:00.000+05:30', tab_focus: false, impersonating: false, ext_version: '0.1.0', reason: null };
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
  for (const e of evs) assert.deepEqual(Object.keys(e).sort(), [...R6].sort());
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
    for (const bad of ['chrome.cookies', 'chrome.scripting', "world: 'MAIN'", 'stsTokenManager', 'innerText', 'querySelector', 'innerHTML']) {
      assert.ok(!s.includes(bad), f + ' contains ' + bad);
    }
  }
});
