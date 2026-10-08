import test from 'node:test';
import assert from 'node:assert/strict';
import { labelOf, colorOf, hmm, asOfClock, buildRoomMachineMap, pickForMachine, cellFor, isStale, createAudioMonitor, LATEST_SQL, MAP_SQL } from './audioState.mjs';

test('state -> label', () => {
  assert.deepEqual(['recorder_off', 'muted', 'zero_all_day', 'audio_present', 'audio_gated', 'withheld'].map(labelOf), ['OFF', 'MUTED', 'ZERO', 'OK', 'GATED', 'WITHHELD']);
  assert.equal(labelOf('some_future_state'), 'some_fut');
  assert.equal(labelOf(null), '?');
});
test('RED / AMBER rule needs an open consult', () => {
  for (const s of ['muted', 'zero_all_day', 'recorder_off']) { assert.equal(colorOf(s, true), 'red'); assert.equal(colorOf(s, false), 'neutral'); }
  assert.equal(colorOf('audio_gated', true), 'amber');
  assert.equal(colorOf('audio_gated', false), 'neutral');
  for (const s of ['audio_present', 'withheld', 'future', 'speech', 'consult', 'room_quiet']) assert.equal(colorOf(s, true), 'neutral');
});
test('h:mm formatting', () => {
  const now = Date.parse('2026-10-06T17:02:00Z');
  assert.equal(hmm('2026-10-06T15:24:04Z', now), '1:37');
  assert.equal(hmm('2026-10-06T16:57:00Z', now), '0:05');
  assert.equal(hmm('2026-10-06T07:00:00Z', now), '10:02');
  assert.equal(hmm('2026-10-06T18:00:00Z', now), '0:00');   // future start clamps
  assert.equal(hmm('garbage', now), '?:??');
});
test('as-of uses max(written_at) in IST', () => {
  assert.equal(asOfClock([{ written_at: '2026-10-06T16:03:03Z' }, { written_at: '2026-10-06T15:03:03Z' }]), '21:33');
  assert.equal(asOfClock([]), '—');
});
const rows = [
  { room_id: 'room_a', machine: 'M-A', state: 'muted', ts_start: '2026-10-06T10:00:00Z', ts_end: '2026-10-06T12:00:00Z', written_at: '2026-10-06T12:20:00Z' },
  { room_id: 'room_b', machine: null, state: 'audio_present', ts_start: '2026-10-06T10:00:00Z', ts_end: '2026-10-06T12:00:00Z', written_at: '2026-10-06T12:20:00Z' },
  { room_id: 'room_c', machine: null, state: 'withheld', ts_start: '2026-10-06T10:00:00Z', ts_end: '2026-10-06T12:00:00Z', written_at: '2026-10-06T12:20:00Z' },
];
test('mapping: row machine, then unique encounter-window machine, else ?', () => {
  const map = buildRoomMachineMap([{ room_id: 'room_b', machine: 'M-B' }, { room_id: 'room_b', machine: 'M-B' }, { room_id: 'room_x', machine: 'M-1' }, { room_id: 'room_x', machine: 'M-2' }]);
  assert.equal(map.get('room_b'), 'M-B');
  assert.equal(map.has('room_x'), false);                    // ambiguous: not guessed
  assert.equal(pickForMachine('M-A', rows, map).room_id, 'room_a');
  assert.equal(pickForMachine('M-B', rows, map).room_id, 'room_b');
  assert.equal(pickForMachine('M-C', rows, map), null);
  const snap = { loaded: true, rows, roomMachine: map, okAt: Date.now() };
  assert.equal(cellFor('M-C', snap, true).text, '?');
  assert.equal(cellFor('M-A', snap, true, Date.parse('2026-10-06T11:30:00Z')).text, 'MUTED 1:30');
  assert.equal(cellFor('M-A', snap, true).color, 'red');
  assert.equal(cellFor('M-A', snap, false).color, 'neutral');
});
test('newest interval wins when two rooms share a machine', () => {
  const two = [{ room_id: 'r1', machine: 'M', state: 'muted', ts_end: '2026-10-06T10:00:00Z', written_at: '2026-10-06T10:20:00Z' }, { room_id: 'r2', machine: 'M', state: 'audio_present', ts_end: '2026-10-06T12:00:00Z', written_at: '2026-10-06T12:20:00Z' }];
  assert.equal(pickForMachine('M', two).state, 'audio_present');
});
test('failure -> dash, not-yet-loaded -> ellipsis, never throws, honours cache', async () => {
  assert.equal(cellFor('M', { loaded: false, error: 'x', rows: [] }, true).text, '—');
  assert.equal(cellFor('M', { loaded: false, error: null, rows: [] }, true).text, '…');
  let calls = 0;
  const bad = createAudioMonitor(() => { calls++; throw new Error('boom'); }, { timeoutMs: 50 });
  await bad.refreshIfDue();
  assert.equal(bad.snapshot().loaded, false); assert.match(bad.snapshot().error, /boom/);
  await bad.refreshIfDue(); assert.equal(calls, 1, 'the sync throw aborts the first query; a second call inside the cache window must not re-query');
  const hang = createAudioMonitor(() => new Promise(() => {}), { timeoutMs: 40 });
  const t0 = Date.now(); await hang.refreshIfDue(); assert.ok(Date.now() - t0 < 500); assert.match(hang.snapshot().error, /timeout/);
  let n = 0;
  const ok = createAudioMonitor(async () => { n++; return []; }, { cacheMs: 60000 });
  await ok.refreshIfDue(); await ok.refreshIfDue(); await ok.refreshIfDue();
  assert.equal(n, 2, 'one refresh = 2 queries, then cached');
});

test('F5 states: MISSING/DEAD red during consult, speech/consult/room_quiet = OK, unknown raw 8 chars never coloured', () => {
  assert.equal(labelOf('device_missing'), 'MISSING'); assert.equal(labelOf('device_dead'), 'DEAD');
  for (const st of ['device_missing', 'device_dead']) { assert.equal(colorOf(st, true), 'red'); assert.equal(colorOf(st, false), 'neutral'); }
  for (const st of ['speech', 'consult', 'room_quiet']) { assert.equal(labelOf(st), 'OK'); assert.equal(colorOf(st, true), 'neutral'); }
  assert.equal(labelOf('brand_new_state'), 'brand_ne'); assert.equal(colorOf('brand_new_state', true), 'neutral');
});
test('F1: an error after a good refresh dashes every cell; a stale last success dashes too', async () => {
  let clock = 1_000_000, fail = false;
  const q = async (text) => { if (fail) throw new Error('boom'); return text === LATEST_SQL ? rows : []; };
  const m = createAudioMonitor(q, { cacheMs: 1000, now: () => clock });
  await m.refreshIfDue();
  let snap = m.snapshot();
  assert.equal(cellFor('M-A', snap, true, clock).color, 'red');           // good refresh: RED possible
  fail = true; clock += 2000; await m.refreshIfDue(); snap = m.snapshot();
  assert.match(snap.error, /boom/);
  assert.deepEqual(cellFor('M-A', snap, true, clock), { text: '—', color: 'dim' });   // error: cached rows never shown
  assert.equal(isStale(snap, clock), true);
  fail = false; clock += 2000; await m.refreshIfDue(); snap = m.snapshot();
  assert.equal(cellFor('M-A', snap, true, clock).color, 'red');           // recovered
  assert.equal(cellFor('M-A', snap, true, clock + 10 * 60_000).color, 'red');            // exactly 10 min: still fresh
  assert.deepEqual(cellFor('M-A', snap, true, clock + 10 * 60_000 + 1), { text: '—', color: 'dim' });   // > 10 min since last success
});
test('F2: a normal refresh is one query; the map is re-read every 10 min', async () => {
  let clock = 0; const seen = [];
  const q = async (text) => { seen.push(text); return []; };
  const m = createAudioMonitor(q, { now: () => clock });
  clock = 5; await m.refreshIfDue(); assert.deepEqual(seen, [LATEST_SQL, MAP_SQL]);   // first load: both
  seen.length = 0; clock += 61_000; await m.refreshIfDue(); assert.deepEqual(seen, [LATEST_SQL]);
  seen.length = 0; clock += 61_000; await m.refreshIfDue(); assert.deepEqual(seen, [LATEST_SQL]);
  seen.length = 0; clock += 10 * 60_000; await m.refreshIfDue(); assert.deepEqual(seen, [LATEST_SQL, MAP_SQL]);
});
test('F3: timeout aborts the request when the driver takes a signal', async () => {
  const signals = [];
  const sql = { query: (text, params, opts) => new Promise((_, rej) => { const sig = opts && opts.fetchOptions && opts.fetchOptions.signal; signals.push(sig); sig.addEventListener('abort', () => rej(new Error('aborted'))); }) };
  const m = createAudioMonitor(sql, { timeoutMs: 30 });
  await m.refreshIfDue();
  assert.ok(signals.length >= 1 && signals.every((x) => x && x.aborted), 'every request signal aborted on timeout');
  assert.match(m.snapshot().error, /timeout/);
});
test('F3: without cancellation, no new refresh while the old requests are still open', async () => {
  let calls = 0, clock = 0;
  const sql = () => { calls++; return new Promise(() => {}); };           // plain function driver: no .query, no signal, never settles
  const m = createAudioMonitor(sql, { timeoutMs: 20, cacheMs: 10, now: () => clock });
  clock = 1; await m.refreshIfDue(); const first = calls;
  clock += 1000; await m.refreshIfDue(); clock += 1000; await m.refreshIfDue();
  assert.equal(calls, first, 'busy: nothing new started while the first requests are open');
});
