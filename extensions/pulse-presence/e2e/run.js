#!/usr/bin/env node
// One-command E2E: `node e2e/run.js`  (exit 0 = every step passed; documented gaps are reported but do not fail).
//
// PATH USED: SIMULATION, not real headless Chrome. The real, unmodified src/content.js, src/agent.js and
// src/lib/*.js run against (a) a fake chrome.* (test/fakes.js) and (b) REAL local HTTP mock servers for Pulse
// and the ETA sink. https://pulse.even.in and the baked ingest URL are rewritten to the mock listeners.
// Why not real Chrome: no Playwright/Chromium installed on the Mini; branded Chrome ignores --load-extension;
// the manifest only matches https://pulse.even.in (needs a host-resolver + trusted cert to mock); and the brief
// forbids touching/restarting Chrome. What this does NOT exercise: real MV3 worker lifecycle/eviction, real
// chrome.idle/alarms scheduling, content-script injection, Chrome's webRequest. Those are UNVERIFIED here.
const fs = require('node:fs');
const path = require('node:path');
const { startPulse, startSink } = require('./mock-servers.js');
const { createContent } = require('../src/content.js');
const { createAgent } = require('../src/agent.js');
const E = require('../src/lib/events.js');
const { makeChrome, makeIndexedDB } = require('../test/fakes.js');

const LOG = path.join(__dirname, 'last-run.log');
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const T0 = Date.parse('2026-10-03T04:00:00.000Z');
const VERSION = '0.1.0';
const TOKEN = 'E2E-TOKEN';
const MACHINE = 'MAC-E2E';
const ROOM = 'OPD-E2E';
const DOC1 = { uid: 'DOC-E2E-1', name: 'Dr E2E One' };
const DOC2 = { uid: 'DOC-E2E-2', name: 'Dr E2E Two' };

async function main() {
  const pulse = await startPulse();
  const sink = await startSink(TOKEN);
  const realFetch = globalThis.fetch;
  // The only place the production URLs are touched: rewrite to the mocks.
  const fetchRewrite = (url, init) => {
    const u = String(url)
      .replace('https://pulse.even.in', pulse.base)
      .replace('https://ingest.mock.test', sink.base);
    return realFetch(u, init);
  };

  const clock = { t: T0 };
  const chrome = makeChrome({ managed: { machine_id: MACHINE, room: ROOM, ingest_url: 'https://ingest.mock.test/v1/presence', token: TOKEN }, version: VERSION });
  const agent = createAgent(chrome, { fetch: fetchRewrite, now: () => clock.t });
  await agent.settled();

  // ---- tab model: one content script per tab, messages delivered the way Chrome delivers them ----
  function openTab(href, visible = true) {
    const tab = { href, closed: false, vis: { visibilityState: visible ? 'visible' : 'hidden' } };
    const tabChrome = {
      runtime: {
        sendMessage: async (m) => {
          if (tab.closed) throw new Error('tab closed');
          chrome.runtime.onMessage.fire(JSON.parse(JSON.stringify(m)), { id: chrome.runtime.id, url: tab.href });
        },
      },
    };
    tab.content = createContent({
      chrome: tabChrome, indexedDB: makeIndexedDB(null), location: { get href() { return tab.href; } },
      sessionStorage: { getItem: () => null }, document: tab.vis, fetch: fetchRewrite,
    });
    tab.check = async () => { await tab.content.check(); await agent.settled(); };
    tab.close = () => { tab.closed = true; };
    return tab;
  }
  const advance = (sec) => { clock.t += sec * 1000; };
  const beat = async () => { chrome.alarms.onAlarm.fire({ name: 'pulse-heartbeat' }); await agent.settled(); };
  const idle = async (s) => { chrome.idle.onStateChanged.fire(s); await agent.settled(); };

  // ---- assertion plumbing ----
  const results = [];
  let cursor = 0;
  const fresh = () => { const out = sink.accepted.slice(cursor).map((a) => a.event); cursor = sink.accepted.length; return out; };
  function compare(evs, want) {
    const bad = [];
    if (evs.length !== want.length) bad.push(`expected ${want.length} events, sink got ${evs.length}: [${evs.map((e) => e.event).join(',')}]`);
    for (let i = 0; i < Math.min(evs.length, want.length); i++) {
      const e = evs[i];
      const w = want[i];
      const tag = `#${i + 1} ${w.event}`;
      const problems = E.validateEvent(e);
      if (problems.length) bad.push(tag + ' schema: ' + problems.join(';'));
      if (e.event !== w.event) bad.push(`${tag}: got event ${e.event}`);
      if (Date.parse(e.ts) - T0 !== w.at * 1000) bad.push(`${tag}: ts offset ${(Date.parse(e.ts) - T0) / 1000}s, want ${w.at}s`);
      if (e.machine_id !== MACHINE || e.room !== ROOM || e.ext_version !== VERSION) bad.push(`${tag}: machine/room/version wrong`);
      for (const k of ['doctor_uid', 'display_name', 'reason', 'impersonating']) {
        if (k in w && e[k] !== w[k]) bad.push(`${tag}: ${k}=${JSON.stringify(e[k])}, want ${JSON.stringify(w[k])}`);
      }
    }
    return bad;
  }
  async function step(name, fn, want, extraCheck) {
    const t = clock.t;
    let bad = [];
    let kind = 'pass';
    let note = '';
    try {
      await fn();
      bad = compare(fresh(), want);
      if (extraCheck) { const r = extraCheck(); if (r && r.bad) bad.push(...r.bad); if (r && r.gap) { kind = 'gap'; note = r.gap; } }
    } catch (e) {
      bad.push('threw: ' + (e && e.stack || e));
    }
    if (bad.length) kind = 'fail';
    results.push({ name, kind, note, bad, virtualSec: (clock.t - T0) / 1000, started: (t - T0) / 1000 });
  }

  // ===== lifecycle =====
  // 1. login
  pulse.state.mode = 'doctor'; Object.assign(pulse.state, { uid: DOC1.uid, name: DOC1.name });
  let tab = openTab('https://pulse.even.in/');
  await step('1 login (then 30s heartbeat)', async () => { await tab.check(); advance(30); await beat(); },
    [{ event: 'login', at: 0, doctor_uid: DOC1.uid, display_name: DOC1.name, reason: null, impersonating: false },
     { event: 'heartbeat', at: 30, doctor_uid: DOC1.uid, display_name: DOC1.name }]);

  // 2. idle
  await step('2 idle -> active', async () => { advance(120); await idle('idle'); advance(60); await idle('active'); },
    [{ event: 'idle', at: 150, doctor_uid: DOC1.uid }, { event: 'active', at: 210, doctor_uid: DOC1.uid }]);

  // 3. lock
  await step('3 lock (heartbeat while locked) -> unlock', async () => { advance(60); await idle('locked'); advance(30); await beat(); advance(30); await idle('active'); },
    [{ event: 'locked', at: 270, doctor_uid: DOC1.uid }, { event: 'heartbeat', at: 300, doctor_uid: DOC1.uid }, { event: 'active', at: 330, doctor_uid: DOC1.uid }]);

  // 4. explicit logout: SPA navigates to /login. Identity must not be read there.
  const reqsBefore = pulse.state.requests.length;
  await step('4 explicit logout (/login route, no identity read)', async () => {
    tab.href = 'https://pulse.even.in/login'; advance(10); await tab.check(); advance(30); await beat();
  }, [{ event: 'logout', at: 340, doctor_uid: DOC1.uid, display_name: DOC1.name }, { event: 'heartbeat', at: 370, doctor_uid: null, display_name: null, reason: null }],
  () => {
    const extra = pulse.state.requests.slice(reqsBefore).filter((r) => r.includes('/api/auth/'));
    return extra.length ? { bad: ['identity endpoints hit on /login: ' + extra.join(', ')] } : null;
  });

  // 5. re-login, then session expiry: cookie dies (401) while the SPA is still on '/'
  await step('5 re-login, then session expiry (verify 401)', async () => {
    tab.href = 'https://pulse.even.in/'; advance(10); await tab.check();
    advance(600); pulse.state.mode = 'expired'; await tab.check();
  }, [{ event: 'login', at: 380, doctor_uid: DOC1.uid }, { event: 'logout', at: 980, doctor_uid: DOC1.uid, display_name: DOC1.name }]);

  // 6. tab close: observe what the sink sees when the only Pulse tab disappears with a doctor logged in
  pulse.state.mode = 'doctor'; Object.assign(pulse.state, { uid: DOC2.uid, name: DOC2.name });
  tab = openTab('https://pulse.even.in/');
  const want6 = [{ event: 'login', at: 985, doctor_uid: DOC2.uid, display_name: DOC2.name }];
  // heartbeats land on the 30s grid we drive: 1015, 1045, ... 1285
  for (let i = 1; i <= 10; i++) want6.push({ event: 'heartbeat', at: 985 + 30 * i, doctor_uid: DOC2.uid });
  await step('6 tab close in this harness (tab.close does not fire chrome.tabs.onRemoved, so no logout here)', async () => {
    advance(5); await tab.check(); tab.close();
    for (let i = 0; i < 10; i++) { advance(30); await beat(); }
  }, want6, () => ({ gap: 'HARNESS LIMIT: this fake tab.close never fires chrome.tabs.onRemoved, so the worker sees no tab event and keeps heartbeating. The worker does emit logout(tab_closed) on onRemoved; that path is covered by test/idle-logout.test.js.' }));

  // 7. Pulse contract break while logged in: loud, not silent
  tab = openTab('https://pulse.even.in/');
  pulse.state.mode = 'broken';
  await step('7 Pulse contract change (data->result): flagged, no fake login/logout', async () => {
    advance(5); await tab.check(); advance(30); await beat();
    pulse.state.mode = 'doctor'; advance(5); await tab.check(); advance(25); await beat();
  }, [{ event: 'heartbeat', at: 1320, doctor_uid: null, display_name: null, reason: 'invalid_no_doctor' },
      { event: 'heartbeat', at: 1350, doctor_uid: DOC2.uid, reason: null }]);

  // 8. sink outage: 500 then recovery; order preserved, nothing lost, nothing duplicated
  await step('8 sink outage (500) then recovery: queued, ordered, no dupes', async () => {
    sink.failNext = 1; advance(30); await beat(); advance(30); await beat();
  }, [{ event: 'heartbeat', at: 1380, doctor_uid: DOC2.uid }, { event: 'heartbeat', at: 1410, doctor_uid: DOC2.uid }],
  () => (sink.rejected === 1 ? null : { bad: ['sink did not see exactly one rejected POST, saw ' + sink.rejected] }));

  // 9. impersonation: identity suppressed on the wire
  pulse.state.mode = 'impersonating';
  await step('9 impersonation: no uid/name on the wire, no login/logout', async () => {
    advance(5); await tab.check(); advance(25); await beat();
  }, [{ event: 'heartbeat', at: 1440, doctor_uid: null, display_name: null, impersonating: true }]);

  // ---- cross-cutting wire checks ----
  const all = sink.accepted.map((a) => a.event);
  const xs = [];
  if (sink.badAuth) xs.push('sink saw ' + sink.badAuth + ' POSTs with bad auth');
  if (sink.posts.some((p) => p.keys.join() !== 'events')) xs.push('POST body keys are not exactly ["events"]');
  const tsMs = all.map((e) => Date.parse(e.ts));
  for (let i = 1; i < tsMs.length; i++) if (tsMs[i] < tsMs[i - 1]) { xs.push('ts went backwards at event ' + (i + 1)); break; }
  const recv = sink.accepted.map((a) => a.receivedAt);
  for (let i = 1; i < recv.length; i++) if (recv[i] < recv[i - 1]) { xs.push('sink receive order not monotonic'); break; }
  results.push({ name: 'X wire invariants (auth, body shape, ts monotonic, receive order)', kind: xs.length ? 'fail' : 'pass', note: '', bad: xs, virtualSec: (clock.t - T0) / 1000 });

  await pulse.close(); await sink.close();

  // ---- report ----
  say('ETA Pulse Presence E2E — path: SIMULATION (real src + real HTTP mocks; fake chrome.*, no real Chrome)');
  say('virtual clock start ' + new Date(T0).toISOString() + ', events delivered to sink: ' + all.length + ', POSTs: ' + sink.posts.length + ', rejected POSTs: ' + sink.rejected);
  say('');
  let failed = 0;
  for (const r of results) {
    const label = r.kind === 'pass' ? 'PASS' : r.kind === 'gap' ? 'PASS+GAP' : 'FAIL';
    if (r.kind === 'fail') failed++;
    say(`${label.padEnd(9)} ${r.name}`);
    if (r.note) say('          ' + r.note);
    for (const b of r.bad || []) say('          - ' + b);
  }
  say('');
  say(failed ? `RESULT: ${failed} step(s) FAILED` : 'RESULT: all steps passed (gaps, if any, are documented above)');
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
