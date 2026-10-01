const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../src/agent.js');
const T = require('../src/lib/transport.js');
const E = require('../src/lib/events.js');
const { makeChrome, makeFetch, bytes } = require('./fakes.js');

const CFG = { machine_id: 'MAC-7', room: 'OPD-3', ingest_url: 'https://ingest.example/v1/events', token: 'TOKEN-XYZ' };
const PULSE_TAB = { focused: true, tabs: [{ active: true, url: 'https://pulse.even.in/prescription?prescription_uid=RX1' }] };
const FROM = { id: 'ext-id', url: 'https://pulse.even.in/' };

function setup({ statuses = [], managed = CFG, local = {}, t0 = Date.parse('2026-09-30T08:00:00Z') } = {}) {
  const chrome = makeChrome({ managed, local });
  const fetch = makeFetch(statuses);
  const clock = { t: t0 };
  const agent = createAgent(chrome, { fetch, now: () => clock.t });
  const msg = (over = {}) => ({
    type: 'pulse_state', status: 'present', identity: { email: 'dr@even.in', display_name: 'Dr X' },
    impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true, ...over,
  });
  const send = async (m) => { chrome.runtime.onMessage.fire(m, FROM); await agent.settled(); };
  const events = () => fetch.calls.flatMap((c) => c.body.events);
  return { chrome, fetch, clock, agent, msg, send, events };
}
const names = (evs) => evs.map((e) => e.event);

test('startup registers idle interval 120 s and a 30 s heartbeat alarm', async () => {
  const { chrome, agent } = setup();
  await agent.settled();
  assert.equal(chrome.idle.interval, 120);
  assert.equal(chrome.alarms._map.get('pulse-heartbeat').periodInMinutes, 0.5);
});

test('login, then logout when the record disappears', async () => {
  const { send, msg, events } = setup();
  await send(msg());
  await send(msg()); // no change, no event
  await send(msg({ status: 'absent', identity: null }));
  const evs = events();
  assert.deepEqual(names(evs), ['login', 'logout']);
  assert.equal(evs[0].email, 'dr@even.in');
  assert.equal(evs[0].display_name, 'Dr X');
  assert.equal(evs[1].email, 'dr@even.in'); // logout names who left
});

test('a changed email closes the previous doctor and opens the next', async () => {
  const { send, msg, events } = setup();
  await send(msg());
  await send(msg({ identity: { email: 'other@even.in', display_name: 'Other' } }));
  const evs = events();
  assert.deepEqual(names(evs), ['login', 'logout', 'login']);
  assert.equal(evs[1].email, 'dr@even.in');
  assert.equal(evs[2].email, 'other@even.in');
});

test('impersonation: doctor null, impersonating true, no login/logout churn', async () => {
  const { send, msg, events, chrome, agent } = setup();
  await send(msg());
  await send(msg({ impersonating: true, status: 'absent', identity: null }));
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  const evs = events();
  assert.deepEqual(names(evs), ['login', 'heartbeat']);
  assert.equal(evs[1].email, null);
  assert.equal(evs[1].display_name, null);
  assert.equal(evs[1].impersonating, true);
});

test('invalid identity record fails closed: doctor null, reason identity_unreadable on heartbeat', async () => {
  const { send, msg, events, chrome, agent } = setup();
  await send(msg({ status: 'invalid', identity: null }));
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  const evs = events();
  assert.deepEqual(names(evs), ['heartbeat']);
  assert.equal(evs[0].email, null);
  assert.equal(evs[0].reason, 'identity_unreadable');
});

test('route: entering and leaving a prescription route opens and closes an encounter by opaque ref', async () => {
  const { send, msg, events } = setup();
  await send(msg({ route: { type: 'prescription', prescription_ref: 'RX1' } }));
  await send(msg({ route: { type: 'prescription', prescription_ref: 'RX1' } }));
  await send(msg({ route: { type: 'home', prescription_ref: null } }));
  await send(msg({ route: { type: 'prescription', prescription_ref: 'RX2' }, visible: false })); // hidden tab ignored
  const evs = events().filter((e) => e.event.startsWith('encounter'));
  assert.deepEqual(names(evs), ['encounter_open', 'encounter_close']);
  assert.equal(evs[0].prescription_ref, 'RX1');
  assert.equal(evs[0].encounter_id, null);
});

test('idle, active, locked events', async () => {
  const { chrome, agent, events } = setup();
  for (const s of ['idle', 'locked', 'active', 'bogus']) chrome.idle.onStateChanged.fire(s);
  await agent.settled();
  assert.deepEqual(names(events()), ['idle', 'locked', 'active']);
});

test('tab focus follows windows and tabs events and is reported on the next event', async () => {
  const { chrome, agent, events } = setup();
  chrome.windows.focused = PULSE_TAB;
  chrome.tabs.onActivated.fire({});
  await agent.settled();
  chrome.windows.focused = { focused: false, tabs: [] };
  chrome.windows.onFocusChanged.fire(5);
  await agent.settled();
  chrome.windows.focused = PULSE_TAB;
  chrome.windows.onFocusChanged.fire(-1); // WINDOW_ID_NONE
  await agent.settled();
  assert.deepEqual(events().map((e) => [e.event, e.tab_focus]), [['heartbeat', true], ['heartbeat', false]]);
});

test('encounter from webRequest: consult_uid from the body, confirmed by onCompleted 2xx', async () => {
  const { chrome, agent, events } = setup();
  const body = { consult_uid: 'CONSULT-1', individual_uid: 'IND-SECRET', notes: 'clinical text' };
  chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/startConsult', requestBody: bytes(body) });
  await agent.settled();
  assert.equal(events().length, 0, 'nothing before completion');
  chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 200 });
  await agent.settled();
  chrome.webRequest.onBeforeRequest.fire({ requestId: '2', method: 'POST', url: 'https://pulse.even.in/api/emr/endConsult', requestBody: bytes(body) });
  chrome.webRequest.onCompleted.fire({ requestId: '2', statusCode: 204 });
  await agent.settled();
  const evs = events();
  assert.deepEqual(names(evs), ['encounter_open', 'encounter_close']);
  assert.equal(evs[0].encounter_id, 'CONSULT-1');
  assert.equal(evs[0].reason, null);
  assert.ok(!JSON.stringify(evs).includes('IND-SECRET') && !JSON.stringify(evs).includes('clinical'));
});

test('non-2xx and errored Start/End emit nothing', async () => {
  const { chrome, agent, events } = setup();
  const b = bytes({ consult_uid: 'C' });
  chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/startConsult', requestBody: b });
  chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 500 });
  chrome.webRequest.onBeforeRequest.fire({ requestId: '2', method: 'POST', url: 'https://pulse.even.in/api/emr/endConsult', requestBody: b });
  chrome.webRequest.onErrorOccurred.fire({ requestId: '2' });
  chrome.webRequest.onCompleted.fire({ requestId: '2', statusCode: 200 });
  await agent.settled();
  assert.equal(events().length, 0);
});

test('body unavailable: event still emitted with consult_uid null and reason body_unavailable', async () => {
  const { chrome, agent, events } = setup();
  chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/startConsult' });
  chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 200 });
  chrome.webRequest.onBeforeRequest.fire({ requestId: '2', method: 'POST', url: 'https://pulse.even.in/api/emr/endConsult', requestBody: { error: 'Unknown error' } });
  chrome.webRequest.onCompleted.fire({ requestId: '2', statusCode: 200 });
  await agent.settled();
  const evs = events();
  assert.deepEqual(names(evs), ['encounter_open', 'encounter_close']);
  for (const e of evs) { assert.equal(e.encounter_id, null); assert.equal(e.reason, 'body_unavailable'); }
});

test('messages from other senders are ignored', async () => {
  const { chrome, agent, msg, events } = setup();
  chrome.runtime.onMessage.fire(msg(), { id: 'someone-else', url: 'https://pulse.even.in/' });
  chrome.runtime.onMessage.fire(msg(), { id: 'ext-id', url: 'https://evil.example/' });
  await agent.settled();
  assert.equal(events().length, 0);
});

test('heartbeat alarm posts a batched JSON POST with a bearer token from managed storage', async () => {
  const { chrome, agent, fetch } = setup();
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  assert.equal(fetch.calls.length, 1);
  const c = fetch.calls[0];
  assert.equal(c.url, CFG.ingest_url);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer TOKEN-XYZ');
  assert.equal(c.body.events[0].event, 'heartbeat');
  assert.equal(c.body.events[0].machine_id, 'MAC-7');
  assert.equal(c.body.events[0].room, 'OPD-3');
  assert.ok(!JSON.stringify(c.body).includes('TOKEN-XYZ'));
});

test('config falls back to storage.local when managed is empty', async () => {
  const { chrome, agent, fetch } = setup({ managed: {}, local: CFG });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  assert.equal(fetch.calls.length, 1);
});

test('unconfigured: events stay queued, nothing is sent', async () => {
  const { chrome, agent, fetch } = setup({ managed: {} });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  assert.equal(fetch.calls.length, 0);
  assert.equal(chrome.storage.local.data.queue.length, 1);
});

test('backoff: failures double the wait, heartbeats inside the window do not post, success drains', async () => {
  const { chrome, agent, fetch, clock } = setup({ statuses: [500, 500] });
  const beat = async () => { chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled(); };
  await beat();
  assert.equal(fetch.calls.length, 1);
  assert.equal(chrome.storage.local.data.transport.failures, 1);
  assert.equal(chrome.storage.local.data.transport.nextAttemptAt - clock.t, T.backoffDelay(1));
  clock.t += 5000; await beat(); // inside the 10 s window
  assert.equal(fetch.calls.length, 1);
  clock.t += 10000; await beat(); // window over, second failure
  assert.equal(fetch.calls.length, 2);
  assert.equal(chrome.storage.local.data.transport.failures, 2);
  assert.equal(chrome.storage.local.data.transport.nextAttemptAt - clock.t, T.backoffDelay(2));
  clock.t += 60000; await beat();
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].body.events.length, 4, 'all queued events delivered together');
  assert.equal(chrome.storage.local.data.queue.length, 0);
  assert.equal(chrome.storage.local.data.transport.failures, 0);
});

test('backoff delay doubles and is capped', () => {
  assert.equal(T.backoffDelay(0), 0);
  assert.equal(T.backoffDelay(1), 10000);
  assert.equal(T.backoffDelay(2), 20000);
  assert.equal(T.backoffDelay(3), 40000);
  assert.equal(T.backoffDelay(30), 15 * 60 * 1000);
});

test('queue entries expire after 24 h and are never sent', async () => {
  const { chrome, agent, fetch, clock } = setup({ statuses: [500] });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled(); // fails, stays queued
  assert.equal(chrome.storage.local.data.queue.length, 1);
  clock.t += T.EXPIRY_MS - 1000;
  assert.equal(T.prune(chrome.storage.local.data.queue, clock.t).length, 1);
  clock.t += 2000 + T.backoffDelay(1);
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  const sent = fetch.calls.slice(1).flatMap((c) => c.body.events);
  assert.equal(sent.length, 1, 'only the fresh heartbeat; the 24 h old one expired');
  assert.equal(chrome.storage.local.data.queue.length, 0);
});

test('a batch the server rejects as malformed (400) is dropped, not retried forever; 401 is retried', async () => {
  const a = setup({ statuses: [400] });
  a.chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await a.agent.settled();
  assert.equal(a.chrome.storage.local.data.queue.length, 0);
  const b = setup({ statuses: [401] });
  b.chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await b.agent.settled();
  assert.equal(b.chrome.storage.local.data.queue.length, 1);
});

test('batches are capped at 50 events', async () => {
  const { chrome, agent, fetch } = setup();
  for (let i = 0; i < 120; i++) chrome.idle.onStateChanged.fire(i % 2 ? 'active' : 'idle');
  await agent.settled();
  const total = fetch.calls.flatMap((c) => c.body.events).length;
  assert.equal(total, 120);
  assert.ok(fetch.calls.every((c) => c.body.events.length <= T.BATCH_SIZE));
});

test('every timestamp is ISO with an offset', async () => {
  const { chrome, agent, events } = setup();
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  assert.match(events()[0].ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  assert.equal(E.validateEvent(events()[0]).length, 0);
});

// ---- R10: reason is the sorted comma-joined set of active status codes ----
test('R10: identity invalid, not impersonating: every event type carries identity_unreadable with email null', async () => {
  const { chrome, agent, send, msg, events } = setup();
  await send(msg({ status: 'invalid', identity: null }));
  for (const s of ['idle', 'active', 'locked']) chrome.idle.onStateChanged.fire(s);
  await agent.settled();
  await send(msg({ status: 'invalid', identity: null, route: { type: 'prescription', prescription_ref: 'RX1' } }));
  const evs = events();
  assert.deepEqual(names(evs), ['idle', 'active', 'locked', 'encounter_open']);
  for (const e of evs) { assert.equal(e.reason, 'identity_unreadable'); assert.equal(e.email, null); assert.equal(e.display_name, null); }
});

test('R10: impersonation heartbeat after an invalid record has reason null', async () => {
  const { chrome, agent, send, msg, events } = setup();
  await send(msg({ status: 'invalid', identity: null }));
  await send(msg({ impersonating: true, status: 'absent', identity: null }));
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  const hb = events().filter((e) => e.event === 'heartbeat');
  assert.equal(hb.length, 1);
  assert.equal(hb[0].reason, null);
  assert.equal(hb[0].impersonating, true);
  assert.equal(hb[0].email, null);
});

test('R10: invalid identity and body unavailable give the sorted two-code set', async () => {
  const { chrome, agent, send, msg, events } = setup();
  await send(msg({ status: 'invalid', identity: null }));
  chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/startConsult' });
  chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 200 });
  await agent.settled();
  assert.equal(events()[0].reason, 'body_unavailable,identity_unreadable');
});

test('R10: body_unavailable alone during impersonation; logout of a known doctor is not identity_unreadable', async () => {
  const a = setup();
  await a.send(a.msg({ status: 'invalid', identity: null }));
  await a.send(a.msg({ impersonating: true, status: 'absent', identity: null }));
  a.chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/endConsult' });
  a.chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 200 });
  await a.agent.settled();
  assert.equal(a.events()[0].reason, 'body_unavailable');
  const b = setup();
  await b.send(b.msg());
  await b.send(b.msg({ status: 'invalid', identity: null }));
  await b.send(b.msg({ status: 'absent', identity: null }));
  const lo = b.events().find((e) => e.event === 'logout');
  assert.equal(lo.email, 'dr@even.in');
  assert.equal(lo.reason, null);
});

test('R10: valid present state has reason null on every event and exactly 12 keys', async () => {
  const { chrome, agent, send, msg, events } = setup();
  await send(msg({ route: { type: 'prescription', prescription_ref: 'RX1' } }));
  for (const s of ['idle', 'active', 'locked']) chrome.idle.onStateChanged.fire(s);
  chrome.webRequest.onBeforeRequest.fire({ requestId: '1', method: 'POST', url: 'https://pulse.even.in/api/emr/endConsult', requestBody: bytes({ consult_uid: 'C1' }) });
  chrome.webRequest.onCompleted.fire({ requestId: '1', statusCode: 200 });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  await send(msg({ route: { type: 'home', prescription_ref: null } }));
  const evs = events();
  assert.ok(evs.length >= 8);
  for (const e of evs) { assert.equal(e.reason, null, e.event); assert.equal(Object.keys(e).length, 12); }
});

test('config: managed beats local beats baked manifest.eta_config, per key', async () => {
  const baked = { ingest_url: 'https://baked.example/e', token: 'BAKED', machine_id: 'BAKED-M', room: '' };
  const only = createAgent(makeChrome({ eta_config: baked }), { fetch: makeFetch() });
  assert.deepEqual(await only.transport.getConfig(), { machine_id: 'BAKED-M', room: null, ingest_url: 'https://baked.example/e', token: 'BAKED' });
  const mixed = createAgent(makeChrome({ eta_config: baked, local: { machine_id: 'LOCAL-M', room: 'LOCAL-R' }, managed: { machine_id: 'MANAGED-M' } }), { fetch: makeFetch() });
  assert.deepEqual(await mixed.transport.getConfig(), { machine_id: 'MANAGED-M', room: 'LOCAL-R', ingest_url: 'https://baked.example/e', token: 'BAKED' });
  const none = createAgent(makeChrome(), { fetch: makeFetch() });
  assert.deepEqual(await none.transport.getConfig(), { machine_id: null, room: null, ingest_url: null, token: null });
});

test('baked config alone is enough to deliver a batch', async () => {
  const chrome = makeChrome({ eta_config: { ingest_url: 'https://baked.example/e', token: 'BAKED', machine_id: 'BAKED-M', room: '' } });
  const fetch = makeFetch();
  const agent = createAgent(chrome, { fetch });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent.settled();
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer BAKED');
  assert.equal(fetch.calls[0].body.events[0].machine_id, 'BAKED-M');
});
