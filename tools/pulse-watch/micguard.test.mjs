import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, applyToMic, fetchMicGuard, STALE_AFTER_S } from './micguard.mjs';

const NOW = Date.parse('2026-10-16T06:30:00Z');   // 12:00 IST
const row = (payload, ageS = 30) => ({ ts: new Date(NOW - ageS * 1000).toISOString(), payload });

test('no row or not_installed: no change', () => {
  assert.equal(classify(undefined, NOW), null);
  assert.equal(classify(row({ state: 'not_installed' }), NOW), null);
  assert.equal(classify(row({ state: 'not_installed' }, 5000), NOW), null);   // old not_installed is still no change
});
test('ok: no change', () => {
  assert.equal(classify(row({ state: 'ok', restored_today: 0 }), NOW), null);
});
test('each alert state gives PERM <state> and a problem line', () => {
  for (const s of ['read_error', 'missing', 'write_failed', 'db_missing', 'stale']) {
    const v = classify(row({ state: s, reason: 'r1' }), NOW);
    assert.equal(v.alert, true); assert.equal(v.text, 'PERM ' + s); assert.match(v.problem, new RegExp(s));
  }
});
test('restored shows HH:MM in IST', () => {
  const v = classify(row({ state: 'restored', last_restored_at: '2026-10-16T05:55:00Z' }), NOW);
  assert.equal(v.text, 'PERM restored 11:25');
  assert.match(v.problem, /restored at 11:25 — check the recorder is capturing/);
});
test('poller_silent: newest row older than 600 s', () => {
  assert.equal(classify(row({ state: 'ok' }, STALE_AFTER_S), NOW), null);
  const v = classify(row({ state: 'ok' }, STALE_AFTER_S + 1), NOW);
  assert.equal(v.state, 'stale'); assert.equal(v.reason, 'poller_silent'); assert.equal(v.text, 'PERM stale');
});
test('restored_today > 0 on an ok row stays an alert until IST midnight', () => {
  const v = classify(row({ state: 'ok', restored_today: 1, last_restored_at: '2026-10-16T04:00:00Z' }), NOW);
  assert.equal(v.text, 'PERM restored 09:30');
});
test('IST midnight edge', () => {
  // 18:29:59Z = 23:59:59 IST on 16 Oct; 18:30:01Z = 00:00:01 IST on 17 Oct
  const before = Date.parse('2026-10-16T18:29:59Z'), after = Date.parse('2026-10-16T18:30:01Z');
  const p = { state: 'ok', restored_today: 2, last_restored_at: '2026-10-16T10:00:00Z' };
  const mk = (now) => ({ ts: new Date(now - 5000).toISOString(), payload: p });
  assert.equal(classify(mk(before), before).text, 'PERM restored 15:30');
  assert.equal(classify(mk(after), after), null);
  // missing last_restored_at falls back to the row time
  const q = { state: 'ok', restored_today: 1 };
  assert.ok(classify({ ts: new Date(before - 5000).toISOString(), payload: q }, before));
  assert.equal(classify({ ts: new Date(after - 5000).toISOString(), payload: q }, after), null);
});
test('UNPLUGGED and SILENT keep priority but the PERM problem is still pushed', () => {
  const v = classify(row({ state: 'read_error' }), NOW);
  for (const t of ['UNPLUGGED', 'SILENT 1 min+']) {
    const problems = ['mic unplugged — replug the USB mic.'];
    const mic = applyToMic({ text: t, color: 'red' }, problems, v);
    assert.equal(mic.text, t); assert.equal(problems.length, 2); assert.match(problems[1], /read_error/);
  }
});
test('alert replaces live / dash text in red; no verdict leaves the cell alone', () => {
  const v = classify(row({ state: 'missing' }), NOW);
  for (const t of ['live ▃ .05', 'speech ▅ .20', '—']) {
    const problems = [];
    assert.deepEqual(applyToMic({ text: t, color: 'green' }, problems, v), { text: 'PERM missing', color: 'red' });
    assert.equal(problems.length, 1);
  }
  const m = { text: 'live ▃ .05', color: 'green' }, pr = [];
  assert.equal(applyToMic(m, pr, null), m); assert.equal(pr.length, 0);
});
test('fetchMicGuard: rows map by room; no rows and errors give an empty map', async () => {
  const m = await fetchMicGuard(async () => [{ room_id: 'room_a', ts: 't', payload: {} }]);
  assert.equal(m.size, 1); assert.ok(m.get('room_a'));
  assert.equal((await fetchMicGuard(async () => [])).size, 0);
  assert.equal((await fetchMicGuard(async () => { throw new Error('relation does not exist'); })).size, 0);
  assert.equal((await fetchMicGuard(() => { throw new Error('sync'); })).size, 0);
  assert.equal(classify(new Map().get('room_a'), NOW), null);   // empty map => old render
});
