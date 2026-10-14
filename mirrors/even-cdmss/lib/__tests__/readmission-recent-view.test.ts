/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-recent-view.test.ts
 * READMIT-RECENT-VIEW-BUILDER-BRIEF-17-SEP-2026 (V's ruling, 17 Sep 2026): the page's incomplete tail —
 * the recent-30-days counts block, provisional monthly rates, the freshness line, and Refresh running a
 * detection check before its list reload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FACILITY_EHBR, FACILITY_EHRC, FRESHNESS_NULL, INCOMPLETE_MONTH_LEGEND, RECENT_TILE_CAPTION, RECENT_TILE_TITLE,
  addDays, computeRates, freshnessLine, rateCards, trendBars,
  type DischargeBucket, type RatePair,
} from '../readmission-rates-core.ts';
import { CHECK_COOLDOWN_MS, newDetectedCount, withinCooldown } from '../readmission-check-core.ts';
import { CHECK_TIMEOUT_MS } from '../readmission-load-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const CEILING = '2026-09-17';
const END30 = addDays(CEILING, -30);   // 2026-08-18 — excluded from the recent window
const b = (over: Partial<DischargeBucket>): DischargeBucket => ({ facility: FACILITY_EHRC, day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 1, ...over });
const p = (over: Partial<RatePair>): RatePair => ({ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 5, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned', ...over });

// ── A. the recent-30-days block ─────────────────────────────────────────────────────────────

test('recent block: window is (ceiling − 30, ceiling] — the floor excluded, the ceiling included', () => {
  const discharges: DischargeBucket[] = [
    b({ day: END30, n: 50 }),                 // exactly the floor — EXCLUDED
    b({ day: addDays(END30, 1), n: 5 }),       // first day in — included
    b({ day: CEILING, n: 2 }),                 // the ceiling itself — included
    b({ day: addDays(CEILING, 1), n: 9 }),     // past the ceiling — never in any window
  ];
  const r = computeRates({ pairs: [], discharges, ceilingDay: CEILING });
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  assert.equal(ehrc.recent.windowStart, addDays(END30, 1));
  assert.equal(ehrc.recent.windowEnd, CEILING);
  assert.equal(ehrc.recent.discharges, 7);   // 5 + 2 — the floor day and the day after ceiling both drop out
});

test('recent block: returnsSoFar splits reviewable / held-out (isHeldOutDepartment), and audited / proposed-avoidable / needs-adjudication counts are right', () => {
  const discharges: DischargeBucket[] = [b({ day: addDays(END30, 5), n: 20 })];
  const pairs: RatePair[] = [
    p({ index_encounter_id: 'IP-A', index_day: addDays(END30, 3), gap_days: 4, index_department: 'Orthopedics', audit_status: 'audited', avoidable: 'avoidable' }),
    p({ index_encounter_id: 'IP-B', index_day: addDays(END30, 4), gap_days: 2, index_department: 'Nephrology', audit_status: 'excluded', avoidable: null }),   // held-out
    p({ index_encounter_id: 'IP-C', index_day: addDays(END30, 6), gap_days: 10, index_department: 'Orthopedics', audit_status: 'audited', avoidable: 'needs_adjudication' }),
    p({ index_encounter_id: 'IP-D', index_day: addDays(END30, 7), gap_days: 45, index_department: 'Orthopedics', audit_status: 'audited', avoidable: 'justified' }),   // gap > 30 — not in returnsSoFar
    p({ index_encounter_id: 'IP-E', index_day: END30, gap_days: 1, index_department: 'Orthopedics', audit_status: 'audited', avoidable: 'avoidable' }),   // on the excluded floor day
  ];
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const rec = r.facilities.find((f) => f.facility === FACILITY_EHRC)!.recent;
  assert.equal(rec.returnsSoFar, 3);              // IP-A, IP-B, IP-C — IP-D (gap 45) and IP-E (floor day) excluded
  assert.equal(rec.returnsSoFar_held_out, 1);      // IP-B
  assert.equal(rec.returnsSoFar_reviewable, 2);    // IP-A, IP-C
  assert.equal(rec.audited, 2);                    // IP-A, IP-C audited; IP-B is 'excluded' status
  assert.equal(rec.proposedAvoidable, 1);          // IP-A
  assert.equal(rec.needsAdjudication, 1);          // IP-C
  assert.equal(rec.provisionalRate, Math.round((3 / 20) * 10_000) / 100);
});

test('recent block: an Even-EHRC discharge bucket counts toward the canonical Even facility (READMIT-EHRC-RELABEL, 19 Aug 2026)', () => {
  const discharges: DischargeBucket[] = [
    b({ facility: 'Even-EHRC', day: addDays(END30, 2), n: 4 }),
    b({ facility: FACILITY_EHRC, day: addDays(END30, 3), n: 1 }),
  ];
  const r = computeRates({ pairs: [], discharges, ceilingDay: CEILING });
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  assert.equal(ehrc.recent.discharges, 5);
});

// ── B. provisional monthly rates ────────────────────────────────────────────────────────────

test('provisionalRate30: null for a complete month, equals pct(returns so far, discharges) for an incomplete one; rate30 stays null for the incomplete month (the two never both carry a number)', () => {
  const discharges: DischargeBucket[] = [
    b({ day: '2025-10-05', n: 100 }),                    // complete month
    b({ day: addDays(CEILING, -10), n: 40 }),             // incomplete month (this month)
  ];
  const pairs: RatePair[] = [
    p({ index_encounter_id: 'IP-1', index_day: '2025-10-05', gap_days: 5 }),
    p({ index_encounter_id: 'IP-2', index_day: addDays(CEILING, -10), gap_days: 3 }),
  ];
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const months = r.facilities.find((f) => f.facility === FACILITY_EHRC)!.months;
  const oct = months.find((m) => m.month === '2025-10')!;
  assert.equal(oct.complete, true);
  assert.equal(oct.rate30, Math.round((1 / 100) * 10_000) / 100);
  assert.equal(oct.provisionalRate30, null);
  assert.equal(oct.provisionalRate30_reviewable, null);
  assert.equal(oct.provisionalRate30_held_out, null);
  const thisMonth = months[months.length - 1];
  assert.equal(thisMonth.complete, false);
  assert.equal(thisMonth.rate30, null);
  assert.equal(thisMonth.provisionalRate30, Math.round((1 / 40) * 10_000) / 100);
});

// ── the EHBR gate hides the provisional RATE; counts stay (item 6) ─────────────────────────

test('EHBR gate: provisional values (the tile rate, the trend-bar height) are hidden while the gate is closed; counts (A) render regardless', () => {
  const discharges: DischargeBucket[] = [
    b({ facility: FACILITY_EHBR, day: addDays(CEILING, -20), n: 30 }),   // EHBR's only discharges — gate stays closed
    b({ day: '2025-10-05', n: 50 }),                                      // gives EHRC an OPEN gate
    b({ day: addDays(CEILING, -3), n: 12 }),                              // EHRC discharges in the incomplete "this month"
  ];
  const pairs: RatePair[] = [
    p({ index_encounter_id: 'IPNO-9', index_day: addDays(CEILING, -18), gap_days: 4, avoidable: 'avoidable' }),
    p({ index_encounter_id: 'IP-9', index_day: addDays(CEILING, -3), gap_days: 2 }),
  ];
  const r = computeRates({ pairs, discharges, ceilingDay: CEILING });
  const ehbr = r.facilities.find((f) => f.facility === FACILITY_EHBR)!;
  const ehrc = r.facilities.find((f) => f.facility === FACILITY_EHRC)!;
  assert.equal(ehbr.ratesAllowed, false);
  assert.equal(ehrc.ratesAllowed, true);

  const closedCard = rateCards(ehbr, 'eligible').find((c) => c.key === 'recent')!;
  assert.equal(closedCard.advisory, RECENT_TILE_CAPTION, 'gate closed — no "provisional rate" appended');
  assert.ok(!/provisional rate/.test(closedCard.advisory ?? ''));
  assert.match(closedCard.sub, /^1 of 30 discharged /, 'the COUNT still renders — R7-4 never gates a count');

  const openCard = rateCards(ehrc, 'eligible').find((c) => c.key === 'recent')!;
  assert.match(openCard.advisory ?? '', /provisional rate/);

  const closedBars = trendBars(ehbr);
  assert.ok(closedBars.every((bar) => bar.provisionalPct == null), 'gate closed — every bar stays a plain ghost, no provisional height');
  const openBars = trendBars(ehrc);
  const thisMonthBar = openBars[openBars.length - 1];
  assert.equal(thisMonthBar.complete, false);
  assert.ok(thisMonthBar.provisionalPct != null, 'gate open — the incomplete month gets a provisional height');
  assert.ok(thisMonthBar.soFarLabel != null && /^[0-9,]+\/[0-9,]+$/.test(thisMonthBar.soFarLabel));   // V 17 Sep layout: compact n/N label
});

test('the sixth tile: title, caption, and the "recent" key land after the five (D8 strip order untouched)', () => {
  assert.equal(RECENT_TILE_TITLE, 'Last 30 days · provisional');
  assert.equal(RECENT_TILE_CAPTION, 'follow-up still running — counts can only rise; not a rate for comparison');
  assert.equal(INCOMPLETE_MONTH_LEGEND, '30-day follow-up not complete — provisional, can only rise');
  const module = code('components/care/ReadmissionRatesModule.tsx');
  assert.match(module, /INCOMPLETE_MONTH_LEGEND/);
});

// ── C. the freshness line ───────────────────────────────────────────────────────────────────

test('freshnessLine: every null renders FRESHNESS_NULL ("—"); real values print IST; checkedJustNow appends the "checked just now" clause only when given', () => {
  const empty = freshnessLine({ feedCurrentTo: null, newestReturnAt: null, lastAuditAt: null, lastCheckAt: null });
  assert.equal(empty, `Data feed current to ${FRESHNESS_NULL} · newest return ${FRESHNESS_NULL} · last audit ${FRESHNESS_NULL} · checks every 30 min`);
  const withValues = freshnessLine({ feedCurrentTo: '2026-09-17T05:00:00Z', newestReturnAt: '2026-09-16T20:00:00Z', lastAuditAt: '2026-09-17T04:30:00Z', lastCheckAt: null });
  assert.match(withValues, /Data feed current to 2026-09-17 10:30 IST/);
  assert.match(withValues, /newest return 2026-09-17/);   // 2026-09-16T20:00Z is 2026-09-17 01:30 IST
  assert.match(withValues, /last audit 2026-09-17 10:00 IST/);
  assert.ok(!/checked just now/.test(withValues));
  // Brief item 10: N > 0 adds `— audits run within 30 min` (they are audited at the next cron tick); N = 0 does not.
  assert.match(freshnessLine({ feedCurrentTo: null, newestReturnAt: null, lastAuditAt: null, lastCheckAt: null }, 3), /checked just now: 3 new — audits run within 30 min$/);
  assert.match(freshnessLine({ feedCurrentTo: null, newestReturnAt: null, lastAuditAt: null, lastCheckAt: null }, 0), /checked just now: 0 new$/);
});

// ── D. the check route ──────────────────────────────────────────────────────────────────────

test('the check route source: the SAME auth guard as the list route, verbatim; never imports runReadmissionAudit; never calls the worker route', () => {
  const check = code('app/api/care/readmissions/check/route.ts');
  const list = code('app/api/care/readmissions/list/route.ts');
  const grab = (src: string, marker: string) => {
    const i = src.indexOf(marker);
    assert.ok(i >= 0, `${marker} not found`);
    const j = src.indexOf('\n}', i);
    return src.slice(i, j + 2);
  };
  assert.equal(grab(check, 'function enabled()'), grab(list, 'function enabled()'));
  assert.equal(grab(check, 'async function authed()'), grab(list, 'async function authed()'));
  assert.ok(!/runReadmissionAudit/.test(check), 'the check route must never import the model-audit path');
  assert.ok(!/readmission\/worker/.test(check), 'the check route must never call the worker route');
  assert.match(check, /runDetectionSweep\(\)/);
  assert.match(check, /export async function POST/);
  assert.ok(!/export async function GET/.test(check), 'this route is POST-only');
});

test('the cooldown: withinCooldown is pure and 120 s; the route calls it before running the sweep; a skip answers {ok:true, skipped:"cooldown"}', () => {
  assert.equal(CHECK_COOLDOWN_MS, 120_000);
  assert.equal(withinCooldown(null, 1_000_000), false, 'never run before — no cooldown');
  assert.equal(withinCooldown(1_000, 1_000 + 119_999), true);
  assert.equal(withinCooldown(1_000, 1_000 + 120_000), false, '120 s exactly clears the cooldown');
  assert.equal(newDetectedCount(5, 9), 4);
  assert.equal(newDetectedCount(5, 5), 0);
  const check = code('app/api/care/readmissions/check/route.ts');
  assert.match(check, /withinCooldown\(lastRunAtMs, nowMs\)/);
  assert.match(check, /skipped: 'cooldown'/);
  assert.match(check, /ok: true, skipped: 'cooldown'/);
});

// ── E. the vercel cron ──────────────────────────────────────────────────────────────────────

test('vercel.json: the readmission worker cron is */30 * * * * — every 30 min, around the clock (was 06:30-10:30 IST only)', () => {
  const cfg = JSON.parse(code('vercel.json')) as { crons: { path: string; schedule: string }[] };
  const entry = cfg.crons.find((c) => c.path === '/api/readmission/worker');
  assert.ok(entry, 'the readmission worker cron entry must exist');
  assert.equal(entry!.schedule, '*/30 * * * *');
});

// ── F. the board wiring ─────────────────────────────────────────────────────────────────────

test('ReadmissionsBoard: Refresh POSTs /check before the list reload; a failed /check never blocks the reload; the freshness line renders from data.freshness', () => {
  const board = code('components/care/ReadmissionsBoard.tsx');
  const refreshFn = board.slice(board.indexOf('const refresh = useCallback'), board.indexOf('const flat = useMemo'));
  const checkCallIdx = refreshFn.indexOf("fetch('/api/care/readmissions/check'");
  const loadCallIdx = refreshFn.indexOf('await load();');
  assert.ok(checkCallIdx >= 0, 'the refresh handler POSTs /check');
  assert.match(refreshFn, /fetch\('\/api\/care\/readmissions\/check', \{ method: 'POST', signal: ctrl\.signal \}\)/);
  assert.ok(loadCallIdx > checkCallIdx, 'the list reload runs AFTER the check, not before');
  // the check leg is wrapped in its own try/catch that only ever sets local state — nothing in that
  // block can throw past it and skip the reload below.
  const tryBlock = refreshFn.slice(refreshFn.indexOf('try {'), refreshFn.indexOf('await load();'));
  assert.match(tryBlock, /catch \{/);
  assert.match(board, /onClick=\{\(\) => void refresh\(\)\}/);
  assert.match(board, /freshnessLine\(data\.freshness, checkedJustNow\)/);
  assert.match(board, /CHECK_FAILED_COPY/);
  assert.match(board, /CHECKING_COPY/);
});

// ── ORCHESTRATOR RULING 1 (17 Sep 2026): /check gets its own 45 s timeout; the rates module refetches ──

test('CHECK_TIMEOUT_MS is 45_000', () => {
  assert.equal(CHECK_TIMEOUT_MS, 45_000);
});

test('ReadmissionsBoard: the check fetch runs under its OWN AbortController, aborted at CHECK_TIMEOUT_MS — independent of the list load\'s own controller', () => {
  const board = code('components/care/ReadmissionsBoard.tsx');
  const refreshFn = board.slice(board.indexOf('const refresh = useCallback'), board.indexOf('const flat = useMemo'));
  assert.match(refreshFn, /const ctrl = new AbortController\(\)/);
  assert.match(refreshFn, /setTimeout\(\(\) => ctrl\.abort\(\), CHECK_TIMEOUT_MS\)/);
  assert.match(refreshFn, /signal: ctrl\.signal/);
  assert.match(refreshFn, /clearTimeout\(killer\)/);
  // a second, independent AbortController from the one `load()` already owns (readmission-load-core.test.ts
  // pins that one at LOAD_TIMEOUT_MS) — this file only has to show refresh() builds its own.
  assert.equal((refreshFn.match(/new AbortController\(\)/g) ?? []).length, 1);
});

test('ReadmissionsBoard: an aborted / failed /check still runs the list reload (item 1) — the reload sits OUTSIDE the try/catch/finally, not gated on success', () => {
  const board = code('components/care/ReadmissionsBoard.tsx');
  const refreshFn = board.slice(board.indexOf('const refresh = useCallback'), board.indexOf('const flat = useMemo'));
  // the catch block (abort included — isAbortError is not special-cased here, any thrown error sets
  // checkFailed) never returns and never throws past itself, so control always reaches `await load()`.
  const catchBlock = refreshFn.slice(refreshFn.indexOf('} catch {'), refreshFn.indexOf('} finally {'));
  assert.match(catchBlock, /setCheckFailed\(true\)/);
  assert.ok(!/return/.test(catchBlock), 'the catch block never returns early — load() below still runs');
  const afterFinally = refreshFn.slice(refreshFn.indexOf('} finally {'));
  assert.match(afterFinally, /await load\(\);/);
});

test('ReadmissionsBoard: a successful (non-cooldown) check bumps ratesRefreshKey, and ReadmissionRatesModule re-fetches on refreshKey; a cooldown skip or a failure never bumps it', () => {
  const board = code('components/care/ReadmissionsBoard.tsx');
  const refreshFn = board.slice(board.indexOf('const refresh = useCallback'), board.indexOf('const flat = useMemo'));
  assert.match(refreshFn, /j\.skipped == null.*setRatesRefreshKey\(\(k\) => k \+ 1\)/);
  assert.equal((refreshFn.match(/setRatesRefreshKey/g) ?? []).length, 1, 'only the success path bumps it');
  assert.match(board, /<ReadmissionRatesModule facility=\{applied\.fac\} refreshKey=\{ratesRefreshKey\} \/>/);
  const module = code('components/care/ReadmissionRatesModule.tsx');
  assert.match(module, /refreshKey = 0/, 'a fresh mount (no bump yet) behaves exactly as before');
  assert.match(module, /\}, \[refreshKey\]\);/, 'the rates fetch effect re-runs when refreshKey changes');
});
