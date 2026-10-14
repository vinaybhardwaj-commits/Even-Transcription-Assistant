import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { istToday } from '../metabase';
import {
  OPD_SWEEP_HELD_PAGE_CAP,
  opdCandidateProbeDone,
  opdSourceNoteTimestamp,
  opdSweepDays,
  opdSweepSavedCount,
  runOpdSweep,
  type OpdSweepCandidate,
  type OpdSweepPorts,
  type OpdSweepStall,
} from '../opd-audit-worker-core';

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
  assert.match(worker, /auditedOnDay: \(day: string\) => auditedUidsForDayAnyVersion\(day\)/);
  assert.match(worker, /fetchOpdNotesForDay\(day, excludeUids, limit, exclude\)/);
  assert.ok(!/if \(r\.processed === 0\)/.test(worker), 'a fetched row that saved nothing must not count as progress');
  const core = readFileSync('lib/opd-audit-worker-core.ts', 'utf8');
  const dayFn = core.slice(core.indexOf('export async function processOpdSweepDay'), core.indexOf('export async function runOpdSweep'));
  assert.ok(dayFn.indexOf('heldAtCurrentEngine') < dayFn.indexOf('auditBatch'), 'already-audited uids are dropped before the model');
  assert.match(core, /if \(r\.saved === 0\)/);
});

test('cron retains overnight cadence and adds one 14:00 IST catch-up pass', () => {
  const opd = vercel.crons.filter((cron) => cron.path === '/api/opd-audit/worker');
  assert.ok(opd.some((cron) => cron.schedule === '*/4 18-23,0-2 * * *'));
  assert.ok(opd.some((cron) => cron.schedule === '30 8 * * *'));
});

test('only a row that was inserted or updated counts as sweep progress', () => {
  assert.equal(opdSweepSavedCount([
    { status: 'inserted' },
    { status: 'updated' },
    { status: 'exists' },
    { status: 'skipped' },
    { error: 'boom' },
  ]), 2);
  assert.equal(opdSourceNoteTimestamp({ timestamp: '2026-10-07T02:04:00+05:30' }, '2026-10-07'), '2026-10-07T02:04:00+05:30');
  assert.equal(opdSourceNoteTimestamp({ timestamp: '2026-10-06T22:00:00+05:30' }, '2026-10-07'), '2026-10-07T12:00:00+05:30');
  assert.equal(opdSourceNoteTimestamp({}, '2026-10-07'), '2026-10-07T12:00:00+05:30');
});

const STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');

test('the cross-day hold is the write-target engine version and is not filtered by note_date', () => {
  const fn = STORE.slice(STORE.indexOf('export async function currentEngineHeldUids'), STORE.indexOf('export async function alignOpdAuditNoteDate'));
  const sql = fn.slice(fn.indexOf('SELECT uid'));
  assert.match(sql, /engine_version = \$2/);
  assert.match(sql, /excluded_reason IS DISTINCT FROM 'llm_leg_failed'/);
  assert.ok(!sql.includes('note_date'), 'a uid stored under a different day must still be held');
  assert.ok(!/\.catch\(/.test(fn), 'a failed lookup must abort the batch, not look like nothing is held');
});

test('aligning a moved source day writes note_date only, and does not touch a failed row', () => {
  const fn = STORE.slice(STORE.indexOf('export async function alignOpdAuditNoteDate'), STORE.indexOf('export async function deleteOpdAuditsForUid'));
  const sql = fn.slice(fn.indexOf('UPDATE opd_note_audits'));
  assert.match(sql, /SET note_date = \$2::timestamptz/);
  assert.ok(!sql.includes('audited_at'), 'the date correction must not look like a new audit');
  assert.match(sql, /excluded_reason IS DISTINCT FROM 'llm_leg_failed'/);
  assert.match(fn, /assertOpdProductionWrite\('opd_note_audits\.alignNoteDate'\)/);
});

const D = '2026-10-06';
const D1 = '2026-10-07';
const D2 = '2026-10-08';
const D3 = '2026-10-09';
const STUCK = 'fwgDH27BJXwxNAXtHhO8';

type Note = { uid: string; timestamp: string };
type Stored = { uid: string; noteDay: string; failed?: boolean };
type SweepResult = { uid: string; status?: string; error?: string };

function sweepWorld(init: {
  source: Record<string, Note[]>;
  audits: Stored[];
  countForDay?: (day: string, sourceCount: number) => number;
  alignThrows?: boolean;
  hold?: boolean;
  onAudit?: (uid: string) => { status?: string; error?: string };
}) {
  const llm: string[] = [];
  const aligns: Array<{ uid: string; noteTimestamp: string }> = [];
  const stalled: OpdSweepStall[] = [];
  const audits = init.audits;
  const dayOf = (uid: string): string => {
    for (const [day, notes] of Object.entries(init.source)) {
      if (notes.some((n) => n.uid === uid)) return day;
    }
    return '';
  };
  const ports: OpdSweepPorts<SweepResult> & { onStall(mark: OpdSweepStall): Promise<void> } = {
    async countForDay(day) {
      const n = init.source[day]?.length ?? 0;
      return init.countForDay ? init.countForDay(day, n) : n;
    },
    async auditedOnDay(day) {
      return audits.filter((a) => a.noteDay === day && !a.failed).map((a) => a.uid);
    },
    async heldAtCurrentEngine(uids) {
      if (init.hold === false) return [];
      const want = new Set(uids);
      return audits.filter((a) => want.has(a.uid) && !a.failed).map((a) => a.uid);
    },
    async alignNoteDate(uid, noteTimestamp) {
      aligns.push({ uid, noteTimestamp });
      if (init.alignThrows) throw new Error('align failed');
      const row = audits.find((a) => a.uid === uid && !a.failed);
      const ist = noteTimestamp.slice(0, 10);
      if (row && /^\d{4}-\d{2}-\d{2}$/.test(ist)) row.noteDay = ist;
    },
    async fetchPage(day, excludeUids, limit) {
      const ex = new Set(excludeUids);
      return (init.source[day] ?? []).filter((n) => !ex.has(n.uid)).slice(0, limit);
    },
    async auditBatch(rows: OpdSweepCandidate[]) {
      return rows.map((row) => {
        const uid = String(row.uid ?? '');
        llm.push(uid);
        const decided = init.onAudit ? init.onAudit(uid) : null;
        const status = decided?.status;
        const existing = audits.find((a) => a.uid === uid && !a.failed);
        if (decided) {
          if ((status === 'inserted' || status === 'updated') && !existing) audits.push({ uid, noteDay: dayOf(uid) });
          return { uid, ...decided };
        }
        if (existing) return { uid, status: 'exists' };
        audits.push({ uid, noteDay: dayOf(uid) });
        return { uid, status: 'inserted' };
      });
    },
    async onStall(mark) { stalled.push(mark); },
  };
  return { llm, aligns, stalled, audits, ports };
}

test('a uid stored under day D whose source timestamp is now D+1 never blocks later days and is not sent to the model again', async () => {
  const fresh1 = 'freshNoteD1aaaaaaaa';
  const fresh2 = 'freshNoteD2bbbbbbbb';
  const fresh3 = 'freshNoteD3cccccccc';
  const w = sweepWorld({
    source: {
      [D]: [],
      [D1]: [
        { uid: STUCK, timestamp: '2026-10-07T02:04:00+05:30' },
        { uid: fresh1, timestamp: '2026-10-07T09:00:00+05:30' },
      ],
      [D2]: [{ uid: fresh2, timestamp: '2026-10-08T09:00:00+05:30' }],
      [D3]: [{ uid: fresh3, timestamp: '2026-10-09T09:00:00+05:30' }],
    },
    audits: [{ uid: STUCK, noteDay: D }],
  });
  const days = [D, D1, D2, D3];
  const first = await runOpdSweep(days, 8, w.ports);
  assert.equal(first.stopped, null, 'the shifted uid must not end the tick before D+2 and later');
  assert.deepEqual(w.llm, [fresh1, fresh2, fresh3]);
  assert.ok(!w.llm.includes(STUCK));
  assert.equal(w.audits.find((a) => a.uid === STUCK)?.noteDay, D1);
  assert.deepEqual(w.aligns, [{ uid: STUCK, noteTimestamp: '2026-10-07T02:04:00+05:30' }]);

  const calls = w.llm.length;
  const second = await runOpdSweep(days, 8, w.ports);
  assert.equal(second.stopped, null);
  assert.equal(w.llm.length, calls, 'the next cron tick must not call the model again for that uid');
  assert.ok(!w.llm.includes(STUCK));
});

test('the same uid is still not re-audited when the date correction fails', async () => {
  const fresh2 = 'freshNoteD2bbbbbbbb';
  const w = sweepWorld({
    source: {
      [D1]: [{ uid: STUCK, timestamp: '2026-10-07T02:04:00+05:30' }],
      [D2]: [{ uid: fresh2, timestamp: '2026-10-08T09:00:00+05:30' }],
    },
    audits: [{ uid: STUCK, noteDay: D }],
    alignThrows: true,
  });
  await runOpdSweep([D1, D2], 8, w.ports);
  await runOpdSweep([D1, D2], 8, w.ports);
  assert.deepEqual(w.llm, [fresh2]);
  assert.equal(w.audits.find((a) => a.uid === STUCK)?.noteDay, D);
});

test('a full page of already-audited uids does not hide a fresh note behind them', async () => {
  const heldA = 'heldUidAaaaaaaaaaaa';
  const heldB = 'heldUidBbbbbbbbbbbb';
  const fresh = 'freshBehindHeldcccc';
  const w = sweepWorld({
    source: {
      [D1]: [
        { uid: heldA, timestamp: '2026-10-07T01:00:00+05:30' },
        { uid: heldB, timestamp: '2026-10-07T02:00:00+05:30' },
        { uid: fresh, timestamp: '2026-10-07T03:00:00+05:30' },
      ],
    },
    audits: [{ uid: heldA, noteDay: D }, { uid: heldB, noteDay: D }],
  });
  const outcome = await runOpdSweep([D1], 2, w.ports);
  assert.deepEqual(w.llm, [fresh]);
  assert.equal(outcome.stopped, null);
});

test('an exists save is not progress, so a missed hold still lets the next day run', async () => {
  const later = 'laterDayNoteeeeeeee';
  const w = sweepWorld({
    source: {
      [D1]: [{ uid: STUCK, timestamp: '2026-10-07T02:00:00+05:30' }],
      [D2]: [{ uid: later, timestamp: '2026-10-08T09:00:00+05:30' }],
    },
    audits: [{ uid: STUCK, noteDay: D }],
    hold: false,
    onAudit: (uid) => (uid === STUCK ? { status: 'exists' } : { status: 'inserted' }),
  });
  const outcome = await runOpdSweep([D1, D2], 8, w.ports);
  assert.deepEqual(w.llm, [STUCK, later]);
  assert.deepEqual(w.stalled.map((s) => s.day), [D1]);
  assert.equal(outcome.stopped, null);
  assert.equal(w.audits.some((a) => a.uid === STUCK && a.noteDay === D1), false, 'exists must not invent a row on the new day');
});

test('a day that did save a row stays in front of newer days', async () => {
  const older = 'olderFresh1dddddddd';
  const older2 = 'olderFresh2eeeeeeee';
  const newer = 'newerFreshfffffffff';
  const w = sweepWorld({
    source: {
      [D1]: [
        { uid: older, timestamp: '2026-10-07T01:00:00+05:30' },
        { uid: older2, timestamp: '2026-10-07T02:00:00+05:30' },
      ],
      [D2]: [{ uid: newer, timestamp: '2026-10-08T09:00:00+05:30' }],
    },
    audits: [],
  });
  const outcome = await runOpdSweep([D1, D2], 1, w.ports);
  assert.deepEqual(w.llm, [older]);
  assert.equal(outcome.stopped?.day, D1);
  assert.equal(outcome.stopped?.saved, 1);
});

test('a stuck day whose count still disagrees does not starve the next day', async () => {
  const later = 'nextDayNotegggggggg';
  const w = sweepWorld({
    source: {
      [D1]: [{ uid: STUCK, timestamp: '2026-10-07T02:00:00+05:30' }],
      [D2]: [{ uid: later, timestamp: '2026-10-08T09:00:00+05:30' }],
    },
    audits: [{ uid: STUCK, noteDay: D }],
    countForDay: (day, n) => (day === D1 ? n + 4 : n),
  });
  const outcome = await runOpdSweep([D1, D2], 8, w.ports);
  assert.deepEqual(w.llm, [later]);
  assert.deepEqual(w.stalled.map((s) => s.day), [D1]);
  assert.equal(outcome.stopped, null);
});

test('a fetch that keeps returning the same held uid cannot spin the tick', async () => {
  let fetches = 0;
  let audited = false;
  const ports: OpdSweepPorts<SweepResult> & { onStall(mark: OpdSweepStall): Promise<void> } = {
    async countForDay() { return 1; },
    async auditedOnDay() { return []; },
    async heldAtCurrentEngine() { return [STUCK]; },
    async alignNoteDate() {},
    async fetchPage(day) {
      if (day !== D1) return [];
      fetches += 1;
      return [{ uid: STUCK, timestamp: '2026-10-07T02:00:00+05:30' }];
    },
    async auditBatch() { audited = true; return []; },
    async onStall() {},
  };
  await runOpdSweep([D1, D2], 1, ports);
  assert.equal(fetches, OPD_SWEEP_HELD_PAGE_CAP);
  assert.equal(audited, false);
});
