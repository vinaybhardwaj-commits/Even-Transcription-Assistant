
// Gap closed: after an idle_timeout logout the worker clears identity, but content.js dedupes unchanged state,
// so a doctor returning to the SAME tab was never re-reported. content.js now force re-reports on window
// 'focus' and document 'visibilitychange' (visible), and the worker re-emits login (identity was null).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContent } = require('../src/content.js');
const { createAgent } = require('../src/agent.js');
const { makeChrome, makeFetch, makeApiFetch, ACCESS_OK, NAME_OK, DR, F4 } = require('./fakes.js');

const UID = 'FAKEUID000000000001';
const CFG = { machine_id: 'MAC-R', room: 'OPD-R', ingest_url: 'https://ingest.example/v1/events', token: 'TOKEN-R' };
const MIN = 60000;

// Real content.js start() wired to a real agent: listeners captured so tests can fire focus / visibilitychange.
function rig() {
  const api = makeApiFetch({ access: ACCESS_OK(UID), name: NAME_OK(`${DR} ${F4}`) });
  const vis = { visibilityState: 'visible' };
  const winL = {}; const docL = {};
  const doc = { get visibilityState() { return vis.visibilityState; }, addEventListener: (t, f) => { docL[t] = f; } };
  const chrome = makeChrome({ managed: CFG });
  const sink = makeFetch();
  const clock = { t: Date.parse('2026-10-04T08:00:00Z') };
  const agent = createAgent(chrome, { fetch: sink, now: () => clock.t });
  let inflight = Promise.resolve();
  const contentChrome = makeChrome();
  contentChrome.runtime.sendMessage = async (m) => { inflight = inflight.then(() => agent.onState(m)); await inflight; };
  const content = createContent({
    chrome: contentChrome, location: { href: 'https://pulse.even.in/' }, fetch: api, sessionStorage: { getItem: () => null },
    document: doc, setInterval: () => 0, addEventListener: (t, f) => { winL[t] = f; },
  });
  content.start();
  const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); await inflight; await agent.settled(); } };
  return {
    chrome, agent, clock, settle, vis, winL, docL,
    events: () => sink.calls.flatMap((c) => c.body.events),
    idle: async (s) => { chrome.idle.onStateChanged.fire(s); await agent.settled(); },
    beat: async () => { chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled(); },
    advance: (m) => { clock.t += m * MIN; },
  };
}
const seq = (evs) => evs.map((e) => (e.event === 'logout' ? `logout(${e.reason})` : e.event));
const real = (evs) => evs.filter((e) => ['login', 'logout'].includes(e.event));

async function idleTimeout(r) {
  await r.idle('idle');
  r.advance(46);
  await r.beat();
}

test('idle_timeout then window focus on the unchanged tab: content re-reports, exactly one new login, heartbeat carries doctor', async () => {
  const r = rig();
  await r.settle();
  assert.deepEqual(real(r.events()).map((e) => e.event), ['login']);
  await idleTimeout(r);
  assert.deepEqual(seq(real(r.events())), ['login', 'logout(idle_timeout)']);
  // ghost: without a re-report the next heartbeat is doctor-null
  await r.beat();
  assert.equal(r.events().filter((e) => e.event === 'heartbeat').pop().doctor_uid, null);
  await r.idle('active');
  r.winL.focus(); await r.settle();
  assert.deepEqual(seq(real(r.events())), ['login', 'logout(idle_timeout)', 'login']);
  assert.equal(real(r.events()).pop().doctor_uid, UID);
  await r.beat();
  assert.equal(r.events().filter((e) => e.event === 'heartbeat').pop().doctor_uid, UID);
  console.log('EVENT SEQUENCE (focus):', seq(r.events()).join(' > '));
});

test('idle_timeout then visibilitychange to visible: one new login; hidden does not re-report', async () => {
  const r = rig();
  await r.settle();
  await idleTimeout(r);
  r.vis.visibilityState = 'hidden';
  r.docL.visibilitychange(); await r.settle();
  assert.equal(real(r.events()).filter((e) => e.event === 'login').length, 1, 'hidden must not re-report');
  r.vis.visibilityState = 'visible';
  r.docL.visibilitychange(); await r.settle();
  assert.deepEqual(seq(real(r.events())), ['login', 'logout(idle_timeout)', 'login']);
  await r.beat();
  assert.equal(r.events().filter((e) => e.event === 'heartbeat').pop().doctor_uid, UID);
  console.log('EVENT SEQUENCE (visibility):', seq(r.events()).join(' > '));
});

test('plain refocus / visibility while still logged in: no duplicate login, no logout, no encounter events', async () => {
  const r = rig();
  await r.settle();
  const before = seq(r.events());
  for (let i = 0; i < 3; i++) { r.winL.focus(); await r.settle(); r.docL.visibilitychange(); await r.settle(); }
  assert.deepEqual(seq(r.events()), before);
  assert.deepEqual(seq(real(r.events())), ['login']);
});

test('refocus after idle_timeout twice: second refocus adds nothing (identity restored)', async () => {
  const r = rig();
  await r.settle();
  await idleTimeout(r);
  r.winL.focus(); await r.settle();
  r.winL.focus(); await r.settle();
  assert.deepEqual(seq(real(r.events())), ['login', 'logout(idle_timeout)', 'login']);
});
