import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLastEvt, LAST_EVT_SQL } from './snapshot.mjs';
import { trackerOf } from './tracker.mjs';

// live shape: logout, then a doctor-less heartbeat (reason 'none') 2 ms later, same machine
const NOW = Date.parse('2026-10-15T08:00:00Z');
const at = (ms) => new Date(NOW - 3600e3 + ms).toISOString();
const R = (event, ms, extra = {}) => ({ machine: 'M1', event, ts: at(ms), reason: null, doctor_uid: '', ...extra });
const trk = (rows) => {
  const l = pickLastEvt(rows).get('M1');
  const f = { ver: '0.1.1.41', hbTs: at(-600e3), lastEvt: l?.event ?? null, lastEvtTs: l?.ts ?? null, lastEvtReason: l?.reason ?? null };
  return trackerOf({ machine: 'M1' }, new Map(), new Map([['M1', f]]), { okS: 180, minExt: '0.1.1.40', now: NOW });
};

test('logout then no-doctor heartbeat 2 ms later -> signed out', () => {
  const t = trk([R('logout', 0, { reason: 'tab_closed' }), R('heartbeat', 2, { reason: 'none' })]);
  assert.match(t.text, /^signed out /); assert.equal(t.down, false);
});
test('logout then later login -> no signal', () => {
  const t = trk([R('logout', 0, { reason: 'idle_timeout' }), R('heartbeat', 2, { reason: 'none' }), R('login', 5000, { doctor_uid: 'd1' })]);
  assert.match(t.text, /^no signal/);
});
test('logout then heartbeat with a doctor -> no signal (stale hb)', () => {
  const t = trk([R('logout', 0, { reason: 'tab_closed' }), R('heartbeat', 9000, { doctor_uid: 'd1' })]);
  assert.match(t.text, /^no signal/);
});
test('rows in any order; other machine ignored', () => {
  const rows = [R('heartbeat', 2, { reason: 'none' }), { ...R('login', 99000, { doctor_uid: 'd2' }), machine: 'M2' }, R('logout', 0, { reason: 'tab_closed' })];
  assert.equal(pickLastEvt(rows).get('M1').event, 'logout');
  assert.equal(pickLastEvt(rows).get('M2').event, 'login');
});

test('last-event SQL keeps distinct on (machine), the meaningful-event filter and the ordering', () => {
  assert.match(LAST_EVT_SQL, /distinct on \(machine\)/);
  assert.match(LAST_EVT_SQL, /order by machine, ts desc/);
  assert.match(LAST_EVT_SQL, /event in \('login', 'logout'\)/);
});
