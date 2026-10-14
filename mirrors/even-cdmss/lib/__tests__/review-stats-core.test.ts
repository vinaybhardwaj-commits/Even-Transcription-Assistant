/**
 * Pure-core tests for lib/review-stats-core.ts (REVIEW-GAMIFICATION-PRD §3/§7).
 * Run: node --test --import tsx lib/__tests__/review-stats-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGoal, personalWeeklyTarget, DEFAULT_GOAL, prevDay, istWeekStart,
  countedLabels, computeStreak, agreementByReviewer, computeReviewStats,
  type LabelRow,
} from '../review-stats-core.ts';
import { isOverlap } from '../review-queue-core.ts';

// deterministic overlap / non-overlap finding_refs (hash-driven; discover, don't hardcode)
const OVERLAP: string[] = [];
const NONOVERLAP: string[] = [];
for (let i = 0; OVERLAP.length < 6 || NONOVERLAP.length < 3; i++) {
  const r = `fref-${i}`;
  if (isOverlap(r)) { if (OVERLAP.length < 6) OVERLAP.push(r); } else if (NONOVERLAP.length < 3) NONOVERLAP.push(r);
  if (i > 500) break;
}
const row = (o: Partial<LabelRow> & { author: string; scope: string; day: string }): LabelRow => ({
  audit_id: o.audit_id ?? 'aud1', finding_ref: o.finding_ref ?? null, verdict: o.verdict ?? null, ...o,
});

// ── goal parsing ────────────────────────────────────────────────────────────────
test('parseGoal: valid / missing / garbage → exact defaults; personal ceil', () => {
  assert.deepEqual(parseGoal(JSON.stringify({ target: 1500, label: 'Set 2', weekly_target: 300, streak_min_per_day: 20 })),
    { target: 1500, label: 'Set 2', weekly_target: 300, streak_min_per_day: 20 });
  assert.deepEqual(parseGoal(undefined), DEFAULT_GOAL);
  assert.deepEqual(parseGoal('not json {{{'), DEFAULT_GOAL);
  assert.deepEqual(parseGoal('{"target":"nan","weekly_target":-5}'),
    { target: 1000, label: 'Evaluation set v1', weekly_target: 200, streak_min_per_day: 15 }); // bad fields → defaults
  assert.equal(personalWeeklyTarget(200, 4), 50);
  assert.equal(personalWeeklyTarget(200, 3), 67);   // ceil(66.67)
  assert.equal(personalWeeklyTarget(200, 0), 200);  // guard: /max(1,len)
});

// ── date helpers ─────────────────────────────────────────────────────────────
test('prevDay + istWeekStart (Monday-start)', () => {
  assert.equal(prevDay('2026-07-09'), '2026-07-08');
  assert.equal(prevDay('2026-07-01'), '2026-06-30');
  assert.equal(istWeekStart('2026-07-09'), '2026-07-06'); // Thu → Mon
  assert.equal(istWeekStart('2026-07-06'), '2026-07-06'); // Mon → itself
  assert.equal(istWeekStart('2026-07-12'), '2026-07-06'); // Sun → prior Mon
  assert.equal(istWeekStart('2026-07-13'), '2026-07-13'); // next Mon
});

// ── counting basis ───────────────────────────────────────────────────────────
test('countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)', () => {
  const rows: LabelRow[] = [
    row({ author: 'V', scope: 'finding', finding_ref: 'f1', verdict: 'nitpick', day: '2026-07-08' }),
    row({ author: 'V', scope: 'finding', finding_ref: 'f1', verdict: 'true_positive', day: '2026-07-09' }), // later wins
    row({ author: 'V', scope: 'impact', finding_ref: 'f1', verdict: 'changes_management', day: '2026-07-09' }), // never counts
    row({ author: 'V', scope: 'missed', day: '2026-07-09' }),
    row({ author: 'Ghost', scope: 'finding', finding_ref: 'f2', verdict: 'false', day: '2026-07-09' }), // not in roster
  ];
  const counted = countedLabels(rows, ['V', 'Zaki']);
  assert.equal(counted.length, 2); // one current-state finding + one missed
  const f = counted.find((c) => c.finding_ref === 'f1')!;
  assert.equal(f.verdict, 'true_positive'); assert.equal(f.day, '2026-07-09'); // later row won
  assert.ok(counted.some((c) => c.finding_ref === null)); // the missed flag
  assert.ok(!counted.some((c) => c.author === 'Ghost'));
});

// ── streak ─────────────────────────────────────────────────────────────────────
function daysWithCounts(spec: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [d, n] of Object.entries(spec)) for (let i = 0; i < n; i++) out.push(d);
  return out;
}
test('streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0', () => {
  const today = '2026-07-09';
  // exactly 15 today qualifies; 14 does not
  assert.equal(computeStreak(daysWithCounts({ '2026-07-09': 15 }), today, 15), 1);
  assert.equal(computeStreak(daysWithCounts({ '2026-07-09': 14 }), today, 15), 0);
  // 3 consecutive ending today
  assert.equal(computeStreak(daysWithCounts({ '2026-07-07': 20, '2026-07-08': 16, '2026-07-09': 15 }), today, 15), 3);
  // yesterday-grace: today absent, yesterday qualifies → streak counts up to yesterday
  assert.equal(computeStreak(daysWithCounts({ '2026-07-07': 15, '2026-07-08': 15 }), today, 15), 2);
  // neither today nor yesterday qualifies → 0 (even if older days do)
  assert.equal(computeStreak(daysWithCounts({ '2026-07-06': 30, '2026-07-07': 30 }), today, 15), 0);
  // gap breaks it: today + day-before-yesterday qualify, yesterday doesn't → streak 1 (today only)
  assert.equal(computeStreak(daysWithCounts({ '2026-07-07': 20, '2026-07-09': 20 }), today, 15), 1);
});

// ── pairwise agreement ─────────────────────────────────────────────────────────
test('agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only', () => {
  const roster = ['V', 'Zaki', 'Aravind'];
  const o = OVERLAP[0];
  // one overlap finding, 3 reviewers: V=tp, Zaki=tp, Aravind=false
  const counted = countedLabels([
    row({ author: 'V', scope: 'finding', finding_ref: o, verdict: 'true_positive', day: '2026-07-09' }),
    row({ author: 'Zaki', scope: 'finding', finding_ref: o, verdict: 'true_positive', day: '2026-07-09' }),
    row({ author: 'Aravind', scope: 'finding', finding_ref: o, verdict: 'false', day: '2026-07-09' }),
    // a NON-overlap finding both label — must NOT create a pair
    row({ author: 'V', scope: 'finding', finding_ref: NONOVERLAP[0], verdict: 'nitpick', day: '2026-07-09' }),
    row({ author: 'Zaki', scope: 'finding', finding_ref: NONOVERLAP[0], verdict: 'nitpick', day: '2026-07-09' }),
  ], roster);
  const ag = agreementByReviewer(counted, roster);
  assert.equal(ag.V.pairs, 2); assert.equal(ag.V.matches, 1);   // vs Zaki (match), vs Aravind (miss)
  assert.equal(ag.Zaki.pairs, 2); assert.equal(ag.Zaki.matches, 1);
  assert.equal(ag.Aravind.pairs, 2); assert.equal(ag.Aravind.matches, 0);
  assert.equal(ag.V.agreement_pct, 50);
});

test('agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed', () => {
  const roster = ['V', 'Zaki'];
  const o = OVERLAP[1];
  const counted = countedLabels([
    row({ author: 'V', scope: 'finding', finding_ref: o, verdict: 'false', day: '2026-07-08' }),
    row({ author: 'V', scope: 'finding', finding_ref: o, verdict: 'true_positive', day: '2026-07-09' }), // later wins → tp
    row({ author: 'Zaki', scope: 'finding', finding_ref: o, verdict: 'true_positive', day: '2026-07-09' }),
  ], roster);
  const ag = agreementByReviewer(counted, roster);
  assert.equal(ag.V.pairs, 1); assert.equal(ag.V.matches, 1); // tp vs tp after dedup
});

test('computeReviewStats: ≥20-pair display boundary, week total, badges shape', () => {
  const roster = ['V', 'Zaki'];
  const today = '2026-07-09';
  const rows: LabelRow[] = [];
  // 25 distinct OVERLAP findings both V & Zaki agree on → 25 pairs each (≥20 → agreement shown)
  const refs: string[] = [];
  for (let i = 0; refs.length < 25; i++) { const r = `ov-${i}`; if (isOverlap(r)) refs.push(r); if (i > 5000) break; }
  for (const ref of refs) {
    rows.push(row({ author: 'V', scope: 'finding', finding_ref: ref, verdict: 'true_positive', day: today }));
    rows.push(row({ author: 'Zaki', scope: 'finding', finding_ref: ref, verdict: 'true_positive', day: today }));
  }
  const stats = computeReviewStats({ rows, roster, today, goal: DEFAULT_GOAL });
  assert.equal(stats.team.total, 50);            // 25 findings × 2 authors, all current-state
  assert.equal(stats.team.week, 50);             // all dated this week
  assert.equal(stats.personal_weekly_target, 100); // ceil(200/2)
  const vBadge = stats.badges.find((b) => b.author === 'V')!;
  assert.equal(vBadge.pairs, 25); assert.equal(vBadge.agreement_pct, 100);

  // below 20 pairs → agreement absent (never "0%")
  const few = computeReviewStats({ rows: rows.slice(0, 10), roster, today, goal: DEFAULT_GOAL }); // 5 findings → 5 pairs
  const vFew = few.badges.find((b) => b.author === 'V');
  assert.ok(vFew === undefined || vFew.agreement_pct === undefined, 'no agreement badge below 20 pairs');
});
