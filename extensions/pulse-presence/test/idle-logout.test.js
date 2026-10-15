// Source-side ghost-session guard: the extension itself emits logout when the doctor is gone
// (sustained idle/locked) or when the last Pulse tab closes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../src/agent.js');
const E = require('../src/lib/events.js');
const { makeChrome, makeFetch, DR, F4, lit } = require('./fakes.js');

const CFG = { machine_id: 'MAC-7', room: 'OPD-3', ingest_url: 'https://ingest.example/v1/events', token: 'TOKEN-XYZ' };
const FROM = { id: 'ext-id', url: 'https://pulse.even.in/' };
const DOC_A = { doctor_uid: 'DOC-A', display_name: lit(`${DR} ${F4}`), email: 'dr@example.test' };
const PULSE = { id: 1, url: 'https://pulse.even.in/prescription?prescription_uid=RX1' };
const OTHER = { id: 2, url: 'https://example.com/' };
const MIN = 60000;

function setup() {
  const chrome = makeChrome({ managed: CFG });
  const fetch = makeFetch();
  const clock = { t: Date.parse('2026-10-04T08:00:00Z') };
  const agent = createAgent(chrome, { fetch, now: () => clock.t });
  const msg = (over = {}) => ({
    type: 'pulse_state', status: 'present', identity: { ...DOC_A },
    impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true, ...over,
  });
  const send = async (m) => { chrome.runtime.onMessage.fire(m, FROM); await agent.settled(); };
  const idle = async (s) => { chrome.idle.onStateChanged.fire(s); await agent.settled(); };
  const beat = async () => { chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled(); };
  const closeTab = async () => { chrome.tabs.onRemoved.fire(99, { isWindowClosing: false }); await agent.settled(); };
  const events = () => fetch.calls.flatMap((c) => c.body.events);
  const logouts = () => events().filter((e) => e.event === 'logout');
  const advance = (m) => { clock.t += m * MIN; };
  return { chrome, clock, agent, msg, send, idle, beat, closeTab, events, logouts, advance };
}

test('idle then active before 45 min: no logout', async () => {
  const s = setup();
  await s.send(s.msg());
  await s.idle('idle');
  s.advance(44);
  await s.beat();
  await s.idle('active');
  s.advance(5);
  await s.beat();
  assert.equal(s.logouts().length, 0);
});

test('idle past 45 min: exactly one idle_timeout logout, identity cleared, no second logout', async () => {
  const s = setup();
  await s.send(s.msg());
  await s.idle('idle');
  s.advance(46);
  await s.beat();
  const lo = s.logouts();
  assert.equal(lo.length, 1);
  assert.equal(lo[0].reason, 'idle_timeout');
  assert.equal(lo[0].doctor_uid, 'DOC-A');
  assert.deepEqual(E.validateEvent(lo[0]), []);
  const st = (await s.chrome.storage.local.get('state')).state;
  assert.equal(st.identity, null);
  assert.equal(st.identityStatus, 'absent');
  assert.equal(st.awaySince, null);
  // the heartbeat that follows the logout carries no doctor
  const hbs = s.events().filter((e) => e.event === 'heartbeat');
  assert.equal(hbs[hbs.length - 1].doctor_uid, null);
  s.advance(5); await s.beat();
  s.advance(5); await s.beat();
  assert.equal(s.logouts().length, 1, 'later heartbeats must not re-emit');
});

test('locked behaves like idle', async () => {
  const s = setup();
  await s.send(s.msg());
  await s.idle('locked');
  s.advance(45);
  await s.beat();
  assert.deepEqual(s.logouts().map((e) => e.reason), ['idle_timeout']);
});

test('idle to locked does not restart the away timer', async () => {
  const s = setup();
  await s.send(s.msg());
  await s.idle('idle');
  s.advance(30);
  await s.idle('locked');
  s.advance(16);
  await s.beat();
  assert.equal(s.logouts().length, 1);
});

test('active resets the timer: idle 30 min, active, idle 30 min gives no logout', async () => {
  const s = setup();
  await s.send(s.msg());
  await s.idle('idle');
  s.advance(30); await s.beat();
  await s.idle('active');
  await s.idle('idle');
  s.advance(30); await s.beat();
  assert.equal(s.logouts().length, 0);
});

test('tab close while another Pulse tab remains: no logout', async () => {
  const s = setup();
  await s.send(s.msg());
  s.chrome.tabs.open = [OTHER, PULSE];
  await s.closeTab();
  assert.equal(s.logouts().length, 0);
});

test('tab close with no Pulse tab remaining: tab_closed logout, identity cleared, not repeated', async () => {
  const s = setup();
  await s.send(s.msg());
  s.chrome.tabs.open = [OTHER];
  await s.closeTab();
  const lo = s.logouts();
  assert.equal(lo.length, 1);
  assert.equal(lo[0].reason, 'tab_closed');
  assert.equal(lo[0].doctor_uid, 'DOC-A');
  assert.deepEqual(E.validateEvent(lo[0]), []);
  const st = (await s.chrome.storage.local.get('state')).state;
  assert.equal(st.identity, null);
  await s.closeTab();
  assert.equal(s.logouts().length, 1);
});

test('tab close when chrome.tabs.query is absent or throws: no logout, no crash', async () => {
  const s = setup();
  await s.send(s.msg());
  s.chrome.tabs.query = async () => { throw new Error('boom'); };
  await s.closeTab();
  s.chrome.tabs.query = undefined;
  await s.closeTab();
  assert.equal(s.logouts().length, 0);
});

test('no identity: idle timeout and tab close emit no logout', async () => {
  const s = setup();
  await s.idle('idle');
  s.advance(60); await s.beat();
  s.chrome.tabs.open = [];
  await s.closeTab();
  assert.equal(s.logouts().length, 0);
});

test('impersonation: idle timeout and tab close emit no logout', async () => {
  const s = setup();
  await s.send(s.msg({ impersonating: true, status: 'absent', identity: null }));
  await s.idle('idle');
  s.advance(60); await s.beat();
  s.chrome.tabs.open = [];
  await s.closeTab();
  assert.equal(s.logouts().length, 0);
});

test('idle timeout does not touch the open encounter', async () => {
  const s = setup();
  await s.send(s.msg({ route: { type: 'prescription', prescription_ref: 'RX1' } }));
  await s.idle('idle');
  s.advance(46); await s.beat();
  const st = (await s.chrome.storage.local.get('state')).state;
  assert.equal(st.openRef, 'RX1');
  assert.equal(s.events().filter((e) => e.event === 'encounter_close').length, 0);
});
