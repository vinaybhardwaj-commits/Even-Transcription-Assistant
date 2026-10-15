// Stale-cookie detection (greeting vs cookie identity), reason mapping for non-2xx, per-install instance_id.
// Pulse never clears its Google cookie and OTP logins run under an auth the extension cannot see, so the cookie
// read can name the PREVIOUS doctor. The page greeting ("Hello, <first name>") is the only independent witness.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGreeting, firstName, isStale, readPulseIdentity } = require('../src/lib/identity.js');
const { validateEvent } = require('../src/lib/events.js');
const { createContent } = require('../src/content.js');
const { createAgent, sanitizeMessage } = require('../src/agent.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeChrome, makeFetch, makeApiFetch, ACCESS_OK, NAME_OK, bytes } = require('./fakes.js');

const CFG = { machine_id: 'MAC-S', room: 'OPD-S', ingest_url: 'https://ingest.example/v1/events', token: 'TOKEN-S' };
const UID_A = 'UID-PRERANA';
const UID_B = 'UID-MANOJ';
const FROM = { id: 'ext-id', url: 'https://pulse.even.in/' };

// ---- greeting parser ----
test('parseGreeting: real-looking greetings give the first name; honorifics, emoji and punctuation are dropped', () => {
  const cases = [
    ['Hello, Dr Manoj 👋', 'Manoj'],
    ['Hello, Prerana', 'Prerana'],
    ['Hello, Prerana 👋', 'Prerana'],
    ['Hello, Dr. Vinay 👋', 'Vinay'],
    ['  Hello,   Anjali!  ', 'Anjali'],
    ['hello, dr sandhya', 'sandhya'],
    ['Hello, Mary-Ann 👋', 'Mary-Ann'],
    ["Hello, D'Souza", "D'Souza"],
    ['Hello,\n  Kush 👋', 'Kush'],
    ['Hello Dr Manoj', 'Manoj'],
    ['Hello, Dr Manoj Kumar 👋', 'Manoj'],
  ];
  for (const [text, want] of cases) assert.equal(parseGreeting(text), want, text);
});

test('parseGreeting: anything that is not a greeting with a name gives null', () => {
  for (const t of ['Hello, Doctor 👋', 'Hello, doctor', 'Hello, DOCTOR!', 'Hello,  👋', 'Hello, Dr 👋', 'Hello, Dr. 👋', 'Hello, 👋', 'Hello,', 'Welcome back', 'Helloween', '', '   ', null, undefined, 42, {}, 'Good morning, Manoj', 'Hello, ' + 'x'.repeat(500)]) {
    assert.equal(parseGreeting(t), null, String(t));
  }
});

// ---- stale decision ----
test('isStale: match, mismatch, case and Dr prefix', () => {
  assert.equal(isStale('Dr Manoj Kumar', 'Manoj'), false, 'first token matches');
  assert.equal(isStale('Dr Manoj Kumar', 'manoj'), false, 'case-insensitive');
  assert.equal(isStale('DR. MANOJ', 'Manoj'), false, 'Dr. prefix ignored');
  assert.equal(isStale('Dr.Manoj', 'Manoj'), false, 'attached Dr. prefix ignored');
  assert.equal(isStale('  Manoj  ', 'Dr Manoj'), false, 'Dr on the page side ignored too');
  assert.equal(isStale('Dr Prerana K', 'Manoj'), true, 'different first name is stale');
  assert.equal(isStale('Drake Ramsay', 'drake'), false, '"Drake" is a name, not an honorific');
  assert.equal(isStale('Drake Ramsay', 'Ramsay'), true, 'only the first token is compared');
  assert.equal(isStale('Dr Vinay Bhardwaj', 'Vinay'), false);
});

test('isStale: no evidence of a mismatch is not a mismatch (either side unknown)', () => {
  for (const [c, p] of [[null, 'Manoj'], ['Dr Manoj', null], [null, null], ['', 'Manoj'], ['Dr', 'Manoj'], ['Dr Manoj', '']]) {
    assert.equal(isStale(c, p), false, JSON.stringify([c, p]));
  }
  assert.equal(firstName('Dr'), null);
  assert.equal(firstName('Dr Manoj'), 'Manoj');
});

// ---- reason mapping ----
test('readPulseIdentity reasons: 401/403/500/network/2xx-without-doctor', async () => {
  const run = (access, name) => readPulseIdentity(makeApiFetch({ access, name }));
  assert.deepEqual(await run({ status: 401, body: {} }), { status: 'absent', reason: 'absent_401' });
  assert.deepEqual(await run({ status: 403, body: {} }), { status: 'absent', reason: 'absent_403' });
  assert.deepEqual(await run({ status: 500, body: {} }), { status: 'invalid', reason: 'absent_500' });
  assert.deepEqual(await run({ status: 404, body: {} }), { status: 'invalid', reason: 'absent_404' });
  assert.deepEqual(await run({ throws: true }), { status: 'invalid', reason: null }, 'network error: last-known kept, worker reports identity_unreadable');
  assert.deepEqual(await run({ status: 200, body: { data: { has_access: true } } }), { status: 'invalid', impersonating: false, reason: 'invalid_no_doctor' });
});

test('readPulseIdentity reasons for getName: identity stays present, display_name null, reason name_*', async () => {
  const cases = [
    [{ status: 401, body: {} }, 'name_absent_401'],
    [{ status: 500, body: {} }, 'name_absent_500'],
    [{ throws: true }, 'name_unreadable'],
    [{ badJson: true }, 'name_unreadable'],
    [{ status: 200, body: { data: 42 } }, 'name_invalid'],
    [{ status: 200, body: {} }, 'name_invalid'],
  ];
  for (const [name, reason] of cases) {
    const r = await readPulseIdentity(makeApiFetch({ access: ACCESS_OK(UID_A), name }));
    assert.equal(r.status, 'present', JSON.stringify(name));
    assert.equal(r.identity.display_name, null);
    assert.equal(r.reason, reason, JSON.stringify(name));
  }
  const ok = await readPulseIdentity(makeApiFetch({ access: ACCESS_OK(UID_A), name: NAME_OK('Dr Prerana') }));
  assert.equal(ok.reason, null);
});

test('events.validateEvent accepts the new reason codes (sorted sets) and rejects invented ones', () => {
  const base = { machine_id: null, room: null, doctor_uid: null, email: null, display_name: null, event: 'heartbeat', encounter_id: null, prescription_ref: null, ts: '2026-10-05T10:00:00.000+05:30', tab_focus: false, impersonating: false, ext_version: '1', reason: null, page_name: null, instance_id: null, cookie_uid: null, cookie_name: null };
  for (const r of ['absent_401', 'absent_403', 'absent_500', 'stale_cookie', 'invalid_no_doctor', 'name_absent_401', 'body_unavailable,stale_cookie', 'absent_500,body_unavailable', 'body_json_no_key', 'body_raw_file_only,identity_unreadable']) {
    assert.deepEqual(validateEvent({ ...base, reason: r }), [], r);
  }
  for (const r of ['absent_4', 'absent_4010', 'absent_', 'stale', 'stale_cookie,body_unavailable', 'a,a', '', 'body_', 'body_bogus']) {
    assert.ok(validateEvent({ ...base, reason: r }).length, r);
  }
  assert.deepEqual(validateEvent({ ...base, event: 'identity_stale', cookie_uid: 'U', cookie_name: 'Dr X' }), []);
});

// ---- agent: stale decision ----
function agentRig(chromeOpts = {}, agentOpts = {}) {
  const chrome = makeChrome({ managed: CFG, ...chromeOpts });
  const sink = makeFetch();
  const agent = createAgent(chrome, { fetch: sink, ...agentOpts });
  const msg = (o = {}) => ({
    type: 'pulse_state', status: 'present', identity: { doctor_uid: UID_A, display_name: 'Dr Prerana K', email: null },
    reason: null, page_name: null, impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true, ...o,
  });
  const send = async (o) => { chrome.runtime.onMessage.fire(msg(o), FROM); await agent.settled(); };
  const events = () => sink.calls.flatMap((c) => c.body.events);
  const beat = async () => { chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled(); };
  const consult = async (kind, uid, ok = true) => {
    const url = 'https://pulse.even.in/api/emr/' + (kind === 'start' ? 'startConsult' : 'endConsult');
    chrome.webRequest.onBeforeRequest.fire({ requestId: kind + uid, method: 'POST', url, requestBody: ok ? bytes({ consult_uid: uid }) : undefined });
    chrome.webRequest.onCompleted.fire({ requestId: kind + uid, statusCode: 200 });
    await agent.settled();
  };
  return { chrome, agent, sink, msg, send, events, beat, consult };
}

test('stale: greeting names a different doctor -> one identity_stale, no login, then null doctor with reason stale_cookie', async () => {
  const r = agentRig();
  await r.send({ page_name: 'Manoj' });
  let evs = r.events();
  assert.deepEqual(evs.map((e) => e.event), ['identity_stale']);
  const st = evs[0];
  assert.equal(st.cookie_uid, UID_A);
  assert.equal(st.cookie_name, 'Dr Prerana K');
  assert.equal(st.page_name, 'Manoj');
  assert.equal(st.doctor_uid, null);
  assert.equal(st.display_name, null);
  assert.equal(st.reason, 'stale_cookie');
  await r.beat();
  await r.send({ page_name: 'Manoj' }); // a re-report does not repeat identity_stale
  await r.beat();
  evs = r.events();
  assert.equal(evs.filter((e) => e.event === 'identity_stale').length, 1, 'exactly one identity_stale');
  assert.ok(!evs.some((e) => e.event === 'login'), 'no login asserted for the stale doctor');
  const hb = evs.filter((e) => e.event === 'heartbeat');
  assert.equal(hb.length, 2);
  for (const e of hb) {
    assert.equal(e.doctor_uid, null);
    assert.equal(e.display_name, null);
    assert.equal(e.email, null);
    assert.equal(e.reason, 'stale_cookie');
    assert.equal(e.page_name, 'Manoj');
    assert.equal(e.cookie_uid, null, 'cookie_* fields appear only on identity_stale');
  }
  for (const e of evs) assert.deepEqual(validateEvent(e), []);
  assert.ok(!JSON.stringify(evs.filter((e) => e.event !== 'identity_stale')).includes(UID_A), 'stale uid is not asserted anywhere else');
  assert.ok(!JSON.stringify(evs).includes(UID_B), 'page_name is never promoted to a doctor_uid');
});

test('stale: encounter_open/close under a stale identity keep consult_uid/prescription_ref with doctor null', async () => {
  const r = agentRig();
  await r.send({ page_name: 'Manoj', route: { type: 'prescription', prescription_ref: 'RX9' } });
  await r.consult('start', 'C-1');
  await r.consult('end', 'C-1', false); // body not readable
  await r.send({ page_name: 'Manoj', route: { type: 'home', prescription_ref: null } });
  const evs = r.events();
  const enc = evs.filter((e) => e.event.startsWith('encounter_'));
  assert.deepEqual(enc.map((e) => [e.event, e.encounter_id, e.prescription_ref, e.reason]), [
    ['encounter_open', null, 'RX9', 'stale_cookie'], // route-driven open (no consult id)
    ['encounter_open', 'C-1', 'RX9', 'stale_cookie'],
    ['encounter_close', null, 'RX9', 'body_no_body,stale_cookie'],
    ['encounter_close', null, 'RX9', 'stale_cookie'], // route-driven close on leaving the prescription
  ]);
  for (const e of enc) {
    assert.equal(e.doctor_uid, null);
    assert.equal(e.display_name, null);
    assert.equal(e.page_name, 'Manoj');
  }
});

test('stale ends with a fresh read whose greeting matches: login for the cookie doctor; later greeting-less reads stay clean', async () => {
  const r = agentRig();
  await r.send({ page_name: 'Manoj' });
  await r.send({ identity: { doctor_uid: UID_B, display_name: 'Dr Manoj Kumar', email: null }, page_name: 'Manoj' });
  await r.beat();
  const evs = r.events();
  assert.deepEqual(evs.map((e) => e.event), ['identity_stale', 'login', 'heartbeat']);
  assert.equal(evs[1].doctor_uid, UID_B, 'login after a real cookie switch; no logout of the withheld stale doctor');
  assert.equal(evs[1].reason, null);
  assert.equal(evs[2].doctor_uid, UID_B);
  assert.equal(evs[2].page_name, 'Manoj');
  // same cookie, greeting corrected (page re-rendered for the cookie doctor): also ends the stale state
  const r2 = agentRig();
  await r2.send({ page_name: 'Manoj' });
  await r2.send({ page_name: 'Prerana' });
  assert.deepEqual(r2.events().map((e) => e.event), ['identity_stale', 'login']);
  assert.equal(r2.events()[1].doctor_uid, UID_A);
});

test('match (case, Dr prefix) is not stale: normal login with page_name attached', async () => {
  const r = agentRig();
  await r.send({ page_name: 'PRERANA' });
  await r.beat();
  const evs = r.events();
  assert.deepEqual(evs.map((e) => e.event), ['login', 'heartbeat']);
  for (const e of evs) { assert.equal(e.doctor_uid, UID_A); assert.equal(e.reason, null); assert.equal(e.page_name, 'PRERANA'); }
});

test('stale: a visible logout, idle_timeout and tab close never assert the stale doctor logout', async () => {
  const r = agentRig();
  await r.send({ page_name: 'Manoj' });
  await r.send({ status: 'absent', identity: null, reason: 'absent_401', page_name: 'Manoj' });
  assert.ok(!r.events().some((e) => e.event === 'logout'), 'no logout for a doctor whose login was never asserted');
  // after the cookie vanished the page still greets Manoj: absent_401 + page_name, doctor null
  await r.beat();
  const hb = r.events().filter((e) => e.event === 'heartbeat').pop();
  assert.equal(hb.doctor_uid, null);
  assert.equal(hb.reason, 'absent_401');
  assert.equal(hb.page_name, 'Manoj');
  // idle_timeout while stale
  let t = Date.parse('2026-10-05T08:00:00Z');
  const r3 = agentRig({}, { now: () => t });
  await r3.send({ page_name: 'Manoj' });
  r3.chrome.idle.onStateChanged.fire('idle'); await r3.agent.settled();
  t += 46 * 60000;
  await r3.beat();
  assert.ok(!r3.events().some((e) => e.event === 'logout'));
  // last Pulse tab closed while stale
  const r4 = agentRig();
  await r4.send({ page_name: 'Manoj' });
  r4.chrome.tabs.open = [];
  r4.chrome.tabs.onRemoved.fire(1); await r4.agent.settled();
  assert.ok(!r4.events().some((e) => e.event === 'logout'));
});

test('a doctor asserted BEFORE the greeting rendered: staleness found later emits identity_stale (login already out), then nulls', async () => {
  const r = agentRig();
  await r.send({ page_name: null });
  await r.send({ page_name: 'Manoj' });
  await r.beat();
  assert.deepEqual(r.events().map((e) => [e.event, e.doctor_uid]), [['login', UID_A], ['identity_stale', null], ['heartbeat', null]]);
  assert.equal(r.events()[1].cookie_uid, UID_A, 'the sink can close out the doctor asserted by the earlier login');
});

test('absent cookie + greeting: identity rows carry doctor null, reason absent_<status>, page_name (never promoted to uid)', async () => {
  for (const [status, reason] of [['absent', 'absent_401'], ['absent', 'absent_403']]) {
    const r = agentRig();
    await r.send({ status, identity: null, reason, page_name: 'Manoj' });
    await r.beat();
    const evs = r.events();
    assert.ok(evs.length >= 1);
    for (const e of evs) {
      assert.equal(e.doctor_uid, null);
      assert.equal(e.display_name, null);
      assert.equal(e.reason, reason);
      assert.equal(e.page_name, 'Manoj');
    }
  }
  // 500 on verify: fail closed, reason carries the status instead of identity_unreadable
  const r5 = agentRig();
  await r5.send({ status: 'invalid', identity: null, reason: 'absent_500', page_name: 'Manoj' });
  await r5.beat();
  for (const e of r5.events()) { assert.equal(e.doctor_uid, null); assert.equal(e.reason, 'absent_500'); assert.equal(e.page_name, 'Manoj'); }
  // network error: reason stays identity_unreadable
  const rn = agentRig();
  await rn.send({ status: 'invalid', identity: null, reason: null, page_name: 'Manoj' });
  await rn.beat();
  for (const e of rn.events()) assert.equal(e.reason, 'identity_unreadable');
});

test('page_name is reset by the login route, ignored during impersonation, and sanitized from forged messages', async () => {
  const r = agentRig();
  await r.send({ page_name: 'Prerana' });
  await r.send({ status: 'absent', identity: null, page_name: null, page_reset: true, visible: true, route: { type: 'login', prescription_ref: null } });
  await r.beat();
  assert.equal(r.events().pop().page_name, null);
  const ri = agentRig();
  await ri.send({ impersonating: true, status: 'absent', identity: null, page_name: 'Zed' });
  await ri.beat();
  for (const e of ri.events()) assert.equal(e.page_name, null, 'impersonated greeting is not reported');
  for (const bad of ['Manoj 👋', '<b>x</b>', 'a b', '', 'x'.repeat(60), 5, {}, ['Manoj']]) {
    const s = sanitizeMessage({ type: 'pulse_state', status: 'absent', page_name: bad, route: {}, visible: true });
    assert.equal(s.page_name, null, JSON.stringify(bad));
  }
  assert.equal(sanitizeMessage({ type: 'pulse_state', status: 'absent', page_name: 'Mary-Ann', route: {} }).page_name, 'Mary-Ann');
  assert.equal(sanitizeMessage({ type: 'pulse_state', status: 'absent', reason: 'absent_401; drop table', route: {} }).reason, null);
  assert.equal(sanitizeMessage({ type: 'pulse_state', status: 'absent', reason: 'absent_401', route: {} }).reason, 'absent_401');
});

// ---- instance_id ----
test('instance_id: generated once, random hex, persists across worker restarts, on every event', async () => {
  const chrome = makeChrome({ managed: CFG });
  const sink = makeFetch();
  let minted = 0;
  const mint = () => { minted++; return 'ab'.repeat(16); };
  const a1 = createAgent(chrome, { fetch: sink, newInstanceId: mint });
  const from = FROM;
  const m = { type: 'pulse_state', status: 'present', identity: { doctor_uid: UID_A, display_name: 'Dr Prerana', email: null }, impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true };
  a1.onState(m); await a1.settled();
  assert.equal(chrome.storage.local.data.instance_id, 'ab'.repeat(16));
  // worker restart: a new agent over the same storage reuses the id
  const a2 = createAgent(chrome, { fetch: sink, newInstanceId: mint });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await a2.settled();
  assert.equal(minted, 1, 'minted exactly once');
  const evs = sink.calls.flatMap((c) => c.body.events);
  assert.ok(evs.length >= 2);
  for (const e of evs) assert.equal(e.instance_id, 'ab'.repeat(16));
  void from;
});

test('instance_id: default generator gives 32 random hex chars, distinct per install, nothing personal in the stored value', async () => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const chrome = makeChrome({ managed: CFG });
    const sink = makeFetch();
    const a = createAgent(chrome, { fetch: sink });
    chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await a.settled();
    const id = chrome.storage.local.data.instance_id;
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(!id.includes('MAC-S') && !id.includes('OPD-S'));
    ids.push(id);
    assert.equal(sink.calls[0].body.events[0].instance_id, id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('instance_id: a malformed stored value is replaced; a storage failure degrades to null, never blocks events', async () => {
  const chrome = makeChrome({ managed: CFG, local: { instance_id: 'not-hex' } });
  const sink = makeFetch();
  const a = createAgent(chrome, { fetch: sink });
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await a.settled();
  assert.match(chrome.storage.local.data.instance_id, /^[0-9a-f]{32}$/);
  assert.notEqual(chrome.storage.local.data.instance_id, 'not-hex');
});

// ---- content script: greeting read ----
function contentRig({ href = 'https://pulse.even.in/', greeting, fetch } = {}) {
  const sent = [];
  const api = fetch || makeApiFetch({ access: ACCESS_OK(UID_A), name: NAME_OK('Dr Prerana K') });
  const queries = [];
  const doc = {
    visibilityState: 'visible',
    querySelector(sel) { queries.push(sel); return greeting === undefined ? null : { textContent: greeting }; },
  };
  const chrome = { runtime: { id: 'ext-id', sendMessage: async (m) => { sent.push(m); } } };
  const e = { chrome, location: { href }, fetch: api, sessionStorage: { getItem: () => null }, document: doc, setInterval: () => 0, addEventListener: () => {} };
  return { sent, e, queries, content: createContent(e) };
}

test('content: reads the greeting only on the home route and reports the first name as page_name', async () => {
  const home = contentRig({ greeting: 'Hello, Dr Manoj 👋' });
  await home.content.check();
  assert.equal(home.sent[0].page_name, 'Manoj');
  assert.deepEqual(home.queries, ['h1[class*="greeting"]']);
  assert.equal(home.sent[0].identity.doctor_uid, UID_A, 'cookie identity is reported unchanged next to the greeting');
  const rx = contentRig({ href: 'https://pulse.even.in/prescription?prescription_uid=RX1', greeting: 'Hello, Dr Manoj 👋' });
  await rx.content.check();
  assert.equal(rx.sent[0].page_name, null);
  assert.equal(rx.queries.length, 0, 'no DOM read off the home route');
  const none = contentRig({});
  await none.content.check();
  assert.equal(none.sent[0].page_name, null, 'greeting not rendered yet');
  const junk = contentRig({ greeting: 'Welcome' });
  await junk.content.check();
  assert.equal(junk.sent[0].page_name, null);
  const login = contentRig({ href: 'https://pulse.even.in/login', greeting: 'Hello, Dr Manoj 👋' });
  await login.content.check();
  assert.equal(login.sent[0].page_reset, true);
  assert.equal(login.sent[0].page_name, null);
});

test('content: carries the HTTP-status reason from the identity read', async () => {
  for (const [spec, status, reason] of [
    [{ status: 401, body: {} }, 'absent', 'absent_401'],
    [{ status: 403, body: {} }, 'absent', 'absent_403'],
    [{ status: 500, body: {} }, 'invalid', 'absent_500'],
    [{ throws: true }, 'invalid', null],
    [{ status: 200, body: { data: {} } }, 'invalid', 'invalid_no_doctor'],
  ]) {
    const c = contentRig({ greeting: 'Hello, Manoj', fetch: makeApiFetch({ access: spec }) });
    await c.content.check();
    assert.equal(c.sent[0].status, status, JSON.stringify(spec));
    assert.equal(c.sent[0].reason, reason, JSON.stringify(spec));
    assert.equal(c.sent[0].page_name, 'Manoj');
  }
});

test('end to end: content + worker, stale cookie then a corrected page', async () => {
  const api = makeApiFetch({ access: ACCESS_OK(UID_A), name: NAME_OK('Dr Prerana K') });
  const chrome = makeChrome({ managed: CFG });
  const sink = makeFetch();
  const agent = createAgent(chrome, { fetch: sink });
  let greeting = 'Hello, Dr Manoj 👋';
  const cc = { runtime: { id: 'ext-id', sendMessage: async (m) => { await agent.onState(m); } } };
  const doc = { visibilityState: 'visible', querySelector: () => ({ textContent: greeting }) };
  const content = createContent({ chrome: cc, location: { href: 'https://pulse.even.in/' }, fetch: api, sessionStorage: { getItem: () => null }, document: doc, setInterval: () => 0, addEventListener: () => {} });
  await content.check();
  await agent.settled();
  chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled();
  const evs = sink.calls.flatMap((c) => c.body.events);
  assert.deepEqual(evs.map((e) => e.event), ['identity_stale', 'heartbeat']);
  assert.ok(evs.every((e) => e.doctor_uid === null && e.page_name === 'Manoj' && e.reason === 'stale_cookie'));
  greeting = 'Hello, Prerana 👋';
  await content.check();
  await agent.settled();
  const evs2 = sink.calls.flatMap((c) => c.body.events);
  assert.equal(evs2.pop().event, 'login');
});

test('service worker script list loads identity.js before agent.js: the real background.js reaches isStale in a worker-like scope', async () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const ctx = { chrome: makeChrome({ managed: CFG }), fetch: makeFetch(), console, setTimeout, clearTimeout, URL, TextDecoder, Uint8Array, AbortController, crypto: globalThis.crypto };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(srcDir, f), 'utf8'), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(srcDir, 'background.js'), 'utf8').replace('globalThis.PulseLib.createAgent(chrome);', 'globalThis.AGENT = globalThis.PulseLib.createAgent(chrome, { fetch: (...a) => globalThis.fetch(...a) });'), ctx, { filename: 'background.js' });
  const chrome = ctx.chrome;
  chrome.runtime.onMessage.fire({ type: 'pulse_state', status: 'present', identity: { doctor_uid: UID_A, display_name: 'Dr Prerana K', email: null }, reason: null, page_name: 'Manoj', impersonating: false, route: { type: 'home', prescription_ref: null }, visible: true }, FROM);
  await ctx.AGENT.settled();
  const evs = ctx.fetch.calls.flatMap((c) => c.body.events);
  assert.deepEqual(evs.map((e) => e.event), ['identity_stale']);
  assert.match(evs[0].instance_id, /^[0-9a-f]{32}$/);
});

test('Hello, Doctor placeholder (name still loading) is never a name: no stale verdict against it', async () => {
  assert.equal(parseGreeting('Hello, Doctor 👋'), null);
  assert.equal(parseGreeting('Hello,  👋'), null);
  assert.equal(parseGreeting('Hello, Doctor Strange'), null, 'first token Doctor is the placeholder');
  assert.equal(parseGreeting('Hello, Doctora'), 'Doctora', 'a real name that merely starts with Doctor');
  const c = contentRig({ greeting: 'Hello, Doctor 👋' });
  await c.content.check();
  assert.equal(c.sent[0].page_name, null);
  const r = agentRig();
  await r.send({ page_name: parseGreeting('Hello, Doctor 👋') });
  assert.deepEqual(r.events().map((e) => e.event), ['login'], 'placeholder greeting does not make the cookie doctor stale');
});

test('departIdentity clears pageName: after idle_timeout / tab close the next cookie identity is not compared with the old greeting', async () => {
  for (const how of ['idle_timeout', 'tab_closed']) {
    let t = Date.parse('2026-10-05T08:00:00Z');
    const r = agentRig({}, { now: () => t });
    await r.send({ page_name: 'Prerana' }); // matches cookie A: login
    if (how === 'idle_timeout') {
      r.chrome.idle.onStateChanged.fire('idle'); await r.agent.settled();
      t += 46 * 60000;
      await r.beat();
    } else {
      r.chrome.tabs.open = [];
      r.chrome.tabs.onRemoved.fire(1); await r.agent.settled();
    }
    assert.equal(r.events().filter((e) => e.event === 'logout').pop().reason, how);
    assert.equal(r.chrome.storage.local.data.state.pageName, null, how + ': persisted pageName cleared');
    // a different doctor signs in; the greeting has not rendered yet (no page_name): must not be judged against 'Prerana'
    await r.send({ identity: { doctor_uid: UID_B, display_name: 'Dr Manoj Kumar', email: null }, page_name: null });
    const evs = r.events();
    assert.ok(!evs.some((e) => e.event === 'identity_stale'), how + ': stale verdict against the old greeting');
    const last = evs[evs.length - 1];
    assert.equal(last.event, 'login');
    assert.equal(last.doctor_uid, UID_B);
    assert.equal(last.page_name, null);
  }
});

test('expired-token read (invalid, stale_token) on a visible tab: no logout, last-known doctor kept, reason carried', async () => {
  const r = agentRig();
  await r.send();
  assert.deepEqual(r.events().map((e) => e.event), ['login']);
  await r.send({ status: 'invalid', identity: null, reason: 'stale_token' });
  await r.beat();
  const evs = r.events();
  assert.ok(!evs.some((e) => e.event === 'logout'), 'no logout from an expired token');
  assert.equal(evs.filter((e) => e.event === 'login').length, 1);
  const hb = evs.filter((e) => e.event === 'heartbeat').pop();
  assert.equal(hb.doctor_uid, null, 'fail closed: no doctor asserted while unknown');
  assert.ok(/stale_token/.test(hb.reason || ''), 'reason carries stale_token: ' + hb.reason);
  await r.send(); // token refreshed, same doctor reads again: no second login, still no logout
  const after = r.events();
  assert.equal(after.filter((e) => e.event === 'login').length, 1, 'last-known identity was kept');
  assert.ok(!after.some((e) => e.event === 'logout'));
});
