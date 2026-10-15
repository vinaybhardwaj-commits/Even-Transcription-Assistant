const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../src/agent.js');
const E = require('../src/lib/events.js');
const { makeChrome, makeFetch } = require('./fakes.js');

const CFG = { machine_id: 'MAC-7', room: 'OPD-3', ingest_url: 'https://ingest.example/v1/events', token: 'TOKEN-XYZ' };
const FROM = { id: 'ext-id', url: 'https://pulse.even.in/' };
const DOC_A = { doctor_uid: 'DOC-A', display_name: 'Dr X', email: 'dr@example.test' };

function setup() {
  const chrome = makeChrome({ managed: CFG });
  const fetch = makeFetch();
  const clock = { t: Date.parse('2026-10-12T08:00:00Z') };
  const agent = createAgent(chrome, { fetch, now: () => clock.t });
  const msg = (over = {}) => ({
    type: 'pulse_state', status: 'present', identity: { ...DOC_A },
    impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true, ...over,
  });
  const send = async (m) => { chrome.runtime.onMessage.fire(m, FROM); await agent.settled(); };
  const beat = async () => { chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled(); };
  const events = () => fetch.calls.flatMap((c) => c.body.events);
  return { chrome, clock, agent, msg, send, beat, events };
}
const PRESENCE = ['heartbeat', 'idle', 'active', 'locked'];

test('heartbeat and idle/active/locked carry doctor_uid and identity_age_s 0 right after a read', async () => {
  const { chrome, agent, send, msg, beat, events } = setup();
  await send(msg());
  await beat();
  for (const s of ['idle', 'active', 'locked']) chrome.idle.onStateChanged.fire(s);
  await agent.settled();
  const evs = events().filter((e) => PRESENCE.includes(e.event));
  assert.ok(evs.length >= 4);
  for (const e of evs) {
    assert.equal(e.doctor_uid, 'DOC-A', e.event);
    assert.equal(e.identity_age_s, 0, e.event);
    assert.equal(e.reason, null, e.event);
    assert.deepEqual(E.validateEvent(e), []);
  }
});

test('identity_age_s counts whole seconds since the last confirming read', async () => {
  const { clock, send, msg, beat, events } = setup();
  await send(msg());
  clock.t += 91400;
  await beat();
  assert.equal(events().filter((e) => e.event === 'heartbeat').pop().identity_age_s, 91);
  clock.t += 30000;
  await send(msg()); // re-confirmed
  clock.t += 5000;
  await beat();
  const hb = events().filter((e) => e.event === 'heartbeat').pop();
  assert.equal(hb.identity_age_s, 5);
  assert.equal(hb.doctor_uid, 'DOC-A');
});

test('no identity ever read: doctor_uid null, identity_age_s null, reason none', async () => {
  const { chrome, beat, events, agent } = setup();
  await agent.settled();
  await beat();
  for (const s of ['idle', 'active', 'locked']) chrome.idle.onStateChanged.fire(s);
  await agent.settled();
  const evs = events().filter((e) => PRESENCE.includes(e.event));
  assert.ok(evs.length >= 4);
  for (const e of evs) {
    assert.equal(e.doctor_uid, null, e.event);
    assert.equal(e.identity_age_s, null, e.event);
    assert.equal(e.reason, 'none', e.event);
    assert.equal(e.display_name, null);
    assert.deepEqual(E.validateEvent(e), []);
  }
});

test('stale identity after logout: heartbeat has no doctor, no age, reason none', async () => {
  const { clock, send, msg, beat, events } = setup();
  await send(msg());
  clock.t += 20000;
  await send(msg({ status: 'absent', identity: null }));
  clock.t += 30000;
  await beat();
  const evs = events();
  const logout = evs.find((e) => e.event === 'logout');
  assert.equal(logout.doctor_uid, 'DOC-A');
  assert.equal(logout.identity_age_s, 20); // the departing doctor, age at logout
  const hb = evs.filter((e) => e.event === 'heartbeat').pop();
  assert.equal(hb.doctor_uid, null);
  assert.equal(hb.identity_age_s, null);
  assert.equal(hb.reason, 'none');
});

test('a real read-failure reason is kept and not joined with none', async () => {
  const { send, msg, beat, events } = setup();
  await send(msg({ status: 'absent', identity: null, reason: 'absent_401' }));
  await beat();
  const hb = events().filter((e) => e.event === 'heartbeat').pop();
  assert.equal(hb.doctor_uid, null);
  assert.equal(hb.reason, 'absent_401');
  assert.equal(hb.identity_age_s, null);
});

test('idle-timeout departure: the logout names the doctor, the heartbeat after says none', async () => {
  const { chrome, clock, agent, send, msg, beat, events } = setup();
  await send(msg());
  chrome.idle.onStateChanged.fire('idle');
  await agent.settled();
  clock.t += 46 * 60000;
  await beat();
  const evs = events();
  assert.equal(evs.find((e) => e.event === 'logout').reason, 'idle_timeout');
  const hb = evs.filter((e) => e.event === 'heartbeat').pop();
  assert.equal(hb.doctor_uid, null);
  assert.equal(hb.identity_age_s, null);
  assert.equal(hb.reason, 'none');
});

test('validateEvent: identity_age_s optional, integer >= 0, never without a doctor_uid', () => {
  const base = E.buildEvent({ machine_id: 'M', room: 'R', doctor_uid: 'D', identity_age_s: 12, event: 'heartbeat', ts: '2026-10-12T10:00:00.000+05:30', tab_focus: false, impersonating: false, ext_version: '0.1.3' });
  assert.equal(base.identity_age_s, 12);
  assert.deepEqual(E.validateEvent(base), []);
  const old = { ...base };
  delete old.identity_age_s;
  assert.deepEqual(E.validateEvent(old), []);
  assert.ok(E.validateEvent({ ...base, identity_age_s: -1 }).length);
  assert.ok(E.validateEvent({ ...base, identity_age_s: 1.5 }).length);
  assert.ok(E.validateEvent({ ...base, identity_age_s: '3' }).length);
  assert.ok(E.validateEvent({ ...base, doctor_uid: null }).length);
  assert.equal(E.buildEvent({ ...base, doctor_uid: null }).identity_age_s, null);
});

// last_doctor_uid / last_doctor_age_s: placement hint only, not identity.
const DOC_B = { doctor_uid: 'DOC-B', display_name: 'Dr Y', email: null };
const hbs = (events) => events().filter((e) => e.event === 'heartbeat');

test('last_doctor_uid is set by an attributed event and its age grows', async () => {
  const { clock, send, msg, beat, events } = setup();
  await send(msg());
  await beat();
  assert.equal(hbs(events).pop().last_doctor_uid, 'DOC-A');
  assert.equal(hbs(events).pop().last_doctor_age_s, 0);
  clock.t += 40000;
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.last_doctor_uid, 'DOC-A');
  assert.equal(h.last_doctor_age_s, 40);
  assert.deepEqual(E.validateEvent(h), []);
});

test('last_doctor_uid survives stale and absent_401 while doctor_uid stays null', async () => {
  const { clock, send, msg, beat, events } = setup();
  await send(msg());
  clock.t += 10000;
  await send(msg({ page_name: 'Zed' })); // page greets someone else: stale
  await beat();
  let h = hbs(events).pop();
  assert.equal(h.doctor_uid, null);
  assert.equal(h.reason, 'stale_cookie');
  assert.equal(h.last_doctor_uid, 'DOC-A');
  assert.equal(h.last_doctor_age_s, 10);
  await send(msg({ status: 'absent', identity: null, reason: 'absent_401', page_name: null, page_reset: true }));
  clock.t += 5000;
  await beat();
  h = hbs(events).pop();
  assert.equal(h.doctor_uid, null);
  assert.equal(h.reason, 'absent_401');
  assert.equal(h.last_doctor_uid, 'DOC-A');
  assert.equal(h.last_doctor_age_s, 15);
});

test('last_doctor_uid is cleared on an explicit logout and on idle-timeout departure', async () => {
  const a = setup();
  await a.send(a.msg());
  await a.send(a.msg({ status: 'absent', identity: null }));
  await a.beat();
  assert.equal(hbs(a.events).pop().last_doctor_uid, null);
  assert.equal(hbs(a.events).pop().last_doctor_age_s, null);
  const b = setup();
  await b.send(b.msg());
  b.chrome.idle.onStateChanged.fire('idle');
  await b.agent.settled();
  b.clock.t += 46 * 60000;
  await b.beat();
  assert.equal(hbs(b.events).pop().last_doctor_uid, null);
});

test('last_doctor_uid is replaced on a different doctor login', async () => {
  const { clock, send, msg, beat, events } = setup();
  await send(msg());
  clock.t += 30000;
  await send(msg({ identity: { ...DOC_B } }));
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.doctor_uid, 'DOC-B');
  assert.equal(h.last_doctor_uid, 'DOC-B');
  assert.equal(h.last_doctor_age_s, 0);
});

test('a different doctor whose login is stale clears the old hint', async () => {
  const { send, msg, beat, events } = setup();
  await send(msg());
  await send(msg({ identity: { ...DOC_B }, page_name: 'Zed' }));
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.doctor_uid, null);
  assert.equal(h.last_doctor_uid, null);
});

test('last_doctor fields are absent (null) during impersonation and return after it', async () => {
  const { send, msg, beat, events } = setup();
  await send(msg());
  await send(msg({ impersonating: true, status: 'absent', identity: null }));
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.impersonating, true);
  assert.equal(h.last_doctor_uid, null);
  assert.equal(h.last_doctor_age_s, null);
  await send(msg());
  await beat();
  assert.equal(hbs(events).pop().last_doctor_uid, 'DOC-A');
});

test('validateEvent: last_doctor_age_s is an integer >= 0 and needs last_doctor_uid', () => {
  const base = E.buildEvent({ machine_id: 'M', room: 'R', doctor_uid: null, last_doctor_uid: 'D', last_doctor_age_s: 7, event: 'heartbeat', ts: '2026-10-12T10:00:00.000+05:30', tab_focus: false, impersonating: false, ext_version: '0.1.3', reason: 'none' });
  assert.deepEqual(E.validateEvent(base), []);
  assert.ok(E.validateEvent({ ...base, last_doctor_age_s: -1 }).length);
  assert.ok(E.validateEvent({ ...base, last_doctor_uid: null }).length);
  assert.equal(E.buildEvent({ ...base, last_doctor_uid: null }).last_doctor_age_s, null);
});

// Refuter probes (F1-F3): the hint ends even when absent_401 already dropped the held identity.
test('F1: last Pulse tab closing clears the hint when no identity is held', async () => {
  const { chrome, agent, send, msg, beat, events } = setup();
  await send(msg());
  await send(msg({ status: 'absent', identity: null, reason: 'absent_401' }));
  chrome.tabs.open = [];
  chrome.tabs.onRemoved.fire(1, { isWindowClosing: false });
  await agent.settled();
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.last_doctor_uid, null);
  assert.equal(h.last_doctor_age_s, null);
});

test('F2: idle timeout clears the hint when no identity is held, and it stays cleared after a worker restart', async () => {
  const { chrome, clock, agent, send, msg, beat, events } = setup();
  await send(msg());
  await send(msg({ status: 'absent', identity: null, reason: 'absent_401' }));
  chrome.idle.onStateChanged.fire('locked');
  await agent.settled();
  clock.t += 46 * 60000;
  await beat();
  assert.equal(hbs(events).pop().last_doctor_uid, null);
  // new worker over the same storage
  const fetch2 = makeFetch();
  const agent2 = createAgent(chrome, { fetch: fetch2, now: () => clock.t });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' });
  await agent2.settled();
  const h2 = fetch2.calls.flatMap((c) => c.body.events).filter((e) => e.event === 'heartbeat').pop();
  assert.equal(h2.last_doctor_uid, null);
});

test('F3: a stale login by a different doctor clears and does not inherit the hint (nobody held)', async () => {
  const { send, msg, beat, events } = setup();
  await send(msg());
  await send(msg({ status: 'absent', identity: null, reason: 'absent_401' }));
  await send(msg({ identity: { ...DOC_B }, page_name: 'Zed' }));
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.doctor_uid, null);
  assert.equal(h.last_doctor_uid, null);
});

test('F3: an attributed login by a different doctor after absent_401 replaces the hint', async () => {
  const { send, msg, beat, events } = setup();
  await send(msg());
  await send(msg({ status: 'absent', identity: null, reason: 'absent_401' }));
  await send(msg({ identity: { ...DOC_B } }));
  await beat();
  const h = hbs(events).pop();
  assert.equal(h.doctor_uid, 'DOC-B');
  assert.equal(h.last_doctor_uid, 'DOC-B');
});
