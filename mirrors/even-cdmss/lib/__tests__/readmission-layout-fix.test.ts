/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-layout-fix.test.ts
 * READMIT-LAYOUT-FIX-BUILDER-BRIEF-17-SEP-2026 (V ruling 17 Sep 2026 — layout fix): the pure helpers
 * behind the rates module's layout fix — the `D Mon` date-range formatter (same year, crossing years),
 * the provisional strip's 1-decimal rounding and line-1 text, the chart's shared y-scale max (including
 * provisional heights), and every month emitting both fixed-height label rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtPct1, maxTrendPct, recentStripLine, shortDate, shortDateRange, trendLabelRows,
  type RecentBlock, type TrendBar,
} from '../readmission-rates-core.ts';

// ── shortDate / shortDateRange ──────────────────────────────────────────────────────────────

test('shortDate: `D Mon`, no leading zero, no year', () => {
  assert.equal(shortDate('2026-08-19'), '19 Aug');
  assert.equal(shortDate('2026-01-05'), '5 Jan');
  assert.equal(shortDate('2026-09-17'), '17 Sep');
});

test('shortDateRange: same year — bare `D Mon – D Mon`, no year on either end', () => {
  assert.equal(shortDateRange('2026-08-19', '2026-09-17'), '19 Aug – 17 Sep');
});

test('shortDateRange: crossing years — the year appends to BOTH ends', () => {
  assert.equal(shortDateRange('2025-12-20', '2026-01-05'), '20 Dec 2025 – 5 Jan 2026');
});

// ── fmtPct1 — the provisional strip's own 1-decimal rounding ───────────────────────────────

test('fmtPct1: 1 decimal place, "—" for null — the recent tile\'s fixture rate (9.09 = 17/187) rounds to 9.1%', () => {
  assert.equal(fmtPct1(9.09), '9.1%');
  assert.equal(fmtPct1(9.04), '9.0%');
  assert.equal(fmtPct1(0), '0.0%');
  assert.equal(fmtPct1(null), '—');
});

// ── recentStripLine — the provisional strip's line 1 ────────────────────────────────────────

const recent = (over: Partial<RecentBlock> = {}): RecentBlock => ({
  windowStart: '2026-08-19', windowEnd: '2026-09-17',
  discharges: 187, returnsSoFar: 17, returnsSoFar_reviewable: 15, returnsSoFar_held_out: 2,
  audited: 7, proposedAvoidable: 0, needsAdjudication: 2, provisionalRate: 9.09,
  ...over,
});

test('recentStripLine: the live fixture — counts, date range, and the 1dp rate, gate open', () => {
  assert.equal(
    recentStripLine(recent(), true),
    '17 returns of 187 discharges (19 Aug – 17 Sep) · audited 7 · proposed avoidable 0 · needs adjudication 2 · provisional rate 9.1%',
  );
});

test('recentStripLine: gate closed — counts still show, the rate clause is entirely absent (R7-4 unchanged)', () => {
  const line = recentStripLine(recent(), false);
  assert.equal(line, '17 returns of 187 discharges (19 Aug – 17 Sep) · audited 7 · proposed avoidable 0 · needs adjudication 2');
  assert.ok(!/provisional rate/.test(line));
});

// ── maxTrendPct — the chart's one shared y-scale ────────────────────────────────────────────

const bar = (over: Partial<TrendBar>): TrendBar => ({
  month: '2026-01', label: 'Jan 26', complete: true, reviewablePct: 3, heldOutPct: 1, provisionalPct: null,
  soFarLabel: null, discharges: 100, returns30: 4, returns30_reviewable: 3, returns30_held_out: 1, title: '',
  ...over,
});

test('maxTrendPct: the floor (2) wins when every bar is smaller', () => {
  assert.equal(maxTrendPct([bar({ reviewablePct: 0.5, heldOutPct: 0.2 })]), 2);
});

test('maxTrendPct: a complete month\'s STACKED total (reviewable + held-out) can be the max', () => {
  assert.equal(maxTrendPct([bar({ reviewablePct: 6, heldOutPct: 2 }), bar({ reviewablePct: 3, heldOutPct: 1 })]), 8);
});

test('maxTrendPct: an incomplete month\'s PROVISIONAL height can exceed every complete month\'s stack — the Aug 26 overflow bug (21/189 = 11.1%)', () => {
  const bars: TrendBar[] = [
    bar({ month: '2026-07', reviewablePct: 4, heldOutPct: 1 }),
    bar({ month: '2026-08', complete: false, reviewablePct: null, heldOutPct: null, provisionalPct: 11.11, soFarLabel: '21/189' }),
  ];
  assert.equal(maxTrendPct(bars), 11.11);
});

// ── trendLabelRows — every month emits BOTH label rows, row 2 never null ───────────────────

test('trendLabelRows: row 2 is a STRING for every bar — "" for a complete month, the count for a provisional one — so every label block has the same height', () => {
  const bars: TrendBar[] = [
    bar({ month: '2026-07', label: 'Jul 26', complete: true, soFarLabel: null }),
    bar({ month: '2026-08', label: 'Aug 26', complete: false, reviewablePct: null, heldOutPct: null, provisionalPct: 11.11, soFarLabel: '21/189' }),
  ];
  const rows = trendLabelRows(bars);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(typeof r.row1, 'string');
    assert.equal(typeof r.row2, 'string');
  }
  assert.deepEqual(rows[0], { month: '2026-07', row1: 'Jul 26', row2: '' });
  assert.equal(rows[1].row1, 'Aug 26');
  assert.equal(rows[1].row2, '21/189');
});
