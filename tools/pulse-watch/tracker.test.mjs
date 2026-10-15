import test from 'node:test';
import assert from 'node:assert/strict';
import { trackerOf } from './tracker.mjs';

const NOW = Date.parse('2026-10-15T08:00:00Z');   // 13:30 IST
const opt = { okS: 180, minExt: '0.1.1.40', now: NOW };
const room = { machine: 'M1' };
const iso = (secsAgo) => new Date(NOW - secsAgo * 1000).toISOString();
const run = (f, r, rm = room) => trackerOf(rm, new Map(r ? [['M1', r]] : []), new Map(f ? [['M1', f]] : []), opt);
const logout = (reason, secsAgo = 3600) => ({ ver: '0.1.1.41', hbTs: iso(secsAgo + 60), lastEvt: 'logout', lastEvtTs: iso(secsAgo), lastEvtReason: reason });

test('logout tab_closed -> signed out HH:MM (IST), not down', () => {
  assert.deepEqual(run(logout('tab_closed', 7200)), { text: 'signed out 11:30', color: 'dim', down: false });
});
test('logout idle_timeout -> signed out, not down', () => {
  const t = run(logout('idle_timeout'));
  assert.equal(t.text, 'signed out 12:30'); assert.equal(t.down, false);
});
test('heartbeat after the logout, stale -> no signal', () => {
  const f = { ver: '0.1.1.41', hbTs: iso(600), lastEvt: 'heartbeat', lastEvtTs: iso(600), lastEvtReason: null };
  const t = run(f); assert.match(t.text, /^no signal /); assert.equal(t.down, true);
});
test('heartbeat after the logout, fresh -> ok', () => {
  const f = { ver: '0.1.1.41', hbTs: iso(30), lastEvt: 'heartbeat', lastEvtTs: iso(30), lastEvtReason: null };
  assert.equal(run(f).text, 'ok');
});
test('no logout, stale -> no signal', () => {
  const t = run({ ver: '0.1.1.41', hbTs: iso(900), lastEvt: null, lastEvtTs: null, lastEvtReason: null });
  assert.match(t.text, /^no signal /); assert.equal(t.down, true);
});
test('no facts at all -> no signal', () => { assert.deepEqual(run(null, null).text, 'no signal'); });
test('logout with another reason -> no signal', () => {
  assert.equal(run(logout('manual')).down, true);
});
test('fresh signal wins over an old logout; old version kept', () => {
  assert.equal(run({ ...logout('tab_closed'), hbTs: iso(10) }).text, 'ok');
  assert.equal(run({ ...logout('tab_closed'), ver: '0.1.1.39', hbTs: iso(10) }).text, 'old version');
});
test('noTracker -> n/a', () => { assert.equal(run(logout('tab_closed'), null, { machine: 'M1', noTracker: true }).text, 'n/a'); });

test('after-hours rule comes before signed out, after fresh', () => {
  const rm = { machine: 'M1', trackerHours: [570, 1020] };
  const closed = { ...opt, inTrackerHours: () => false };
  const call = (f) => trackerOf(rm, new Map(), new Map([['M1', f]]), closed);
  assert.equal(call(logout('tab_closed')).text, 'after hours');
  assert.equal(call({ ...logout('tab_closed'), hbTs: iso(10) }).text, 'ok');
  assert.match(trackerOf(rm, new Map(), new Map([['M1', logout('tab_closed')]]), { ...opt, inTrackerHours: () => true }).text, /^signed out/);
});
