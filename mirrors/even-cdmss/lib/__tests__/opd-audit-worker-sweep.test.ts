import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { istToday } from '../metabase';
import { opdCandidateProbeDone, opdSweepDays } from '../opd-audit-worker-core';

const worker = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  crons: Array<{ path: string; schedule: string }>;
};

test('overnight sweep ends at today IST and includes the current note day', () => {
  assert.equal(istToday(new Date('2026-09-21T18:29:59.999Z')), '2026-09-21');
  assert.equal(istToday(new Date('2026-09-21T18:30:00.000Z')), '2026-09-22');
  assert.deepEqual(
    opdSweepDays('2026-09-22', 4, '2026-09-19'),
    ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'],
  );
  assert.deepEqual(opdSweepDays('2026-09-22', 4, '2026-09-21'), ['2026-09-21', '2026-09-22']);
});

test('upstream candidates reopen a count-matched day until the candidate page drains', () => {
  assert.equal(opdCandidateProbeDone(0, 8, 0, 0), true, 'an empty upstream probe is drained');
  assert.equal(opdCandidateProbeDone(0, 8, 0, 1), false, 'a count/fetch disagreement stays open');
  assert.equal(opdCandidateProbeDone(1, 8, 0, 1), false, 'a newly arrived uid reopens the day');
  assert.equal(opdCandidateProbeDone(1, 8, 1, 0), true, 'a short successful page finishes catch-up');
  assert.equal(opdCandidateProbeDone(8, 8, 8, 0), false, 'a full page may have another page behind it');
  assert.equal(opdCandidateProbeDone(3, 8, 2, 1), false, 'a failed uid keeps the day open');

  assert.ok(!worker.includes('auditedCountForDayAnyVersion'), 'sweep must not skip on Neon/upstream count equality');
  assert.ok(!worker.includes('already.length >= total'), 'processDay must probe upstream before declaring completion');
  assert.match(worker, /const already = await auditedUidsForDayAnyVersion\(day\);[\s\S]*const rows = await fetchOpdNotesForDay\(day, already, max, exclude\);/);
});

test('cron retains overnight cadence and adds one 14:00 IST catch-up pass', () => {
  const opd = vercel.crons.filter((cron) => cron.path === '/api/opd-audit/worker');
  assert.ok(opd.some((cron) => cron.schedule === '*/4 18-23,0-2 * * *'));
  assert.ok(opd.some((cron) => cron.schedule === '30 8 * * *'));
});
