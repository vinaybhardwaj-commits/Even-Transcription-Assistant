/**
 *   node --test --import tsx lib/__tests__/vitals-coverage-core.test.ts
 *
 * U4-B C7 v2.0 — the vitals-coverage panel's pure core.
 *
 * THE ONE FAILURE MODE (PRD §3.3, and §8.3 of the verification list): the vitals source begins
 * 2026-05-28. A window reaching before it reports 100% missing, which is a data-availability
 * artefact and not a documentation gap. "A figure near 100% means the 28 May floor is missing."
 * These tests exist mainly to make that impossible.
 *
 * Second concern: metabaseQuery takes ONE SQL STRING WITH NO PARAMETER BINDING, so the date
 * validation is the only thing between a caller and the query text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VITALS_SOURCE_START, WINDOW_DAYS, isDay, addDays, istDay,
  coverageWindow, buildVitalsCoverageSql, shapeCoverage,
} from '../vitals-coverage-core.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The 28 May floor — the failure mode
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the floor holds: a window reaching before the vitals source is CLAMPED, and says so', () => {
  // 30 days back from 10 Jun 2026 would start 12 May — before the source existed.
  const w = coverageWindow('2026-06-10', 30)!;
  assert.equal(w.start, VITALS_SOURCE_START, 'the window must start at the source, never earlier');
  assert.equal(w.clamped, true, 'and the page must be told, so it can say so');
  assert.equal(w.days, 14, '28 May → 10 Jun inclusive');
});

test('an unclamped window is exactly WINDOW_DAYS long and is not flagged', () => {
  const w = coverageWindow('2026-08-02', 30)!;
  assert.equal(w.start, '2026-07-04', '30 days inclusive of today');
  assert.equal(w.lastDay, '2026-08-02');
  assert.equal(w.end, '2026-08-03', 'end is EXCLUSIVE, so today is included');
  assert.equal(w.clamped, false);
  assert.equal(w.days, 30);
});

test('the boundary day itself: a window starting exactly on the source is not clamped', () => {
  const w = coverageWindow(addDays(VITALS_SOURCE_START, WINDOW_DAYS - 1), WINDOW_DAYS)!;
  assert.equal(w.start, VITALS_SOURCE_START);
  assert.equal(w.clamped, false, 'reaching the source exactly is not a clamp');
  assert.equal(w.days, WINDOW_DAYS);
});

test('a window entirely before the source returns null — nothing honest to show', () => {
  assert.equal(coverageWindow('2026-05-01', 30), null);
  assert.equal(coverageWindow('2020-01-01', 30), null);
});

test('a malformed or absurd window returns null rather than guessing', () => {
  for (const bad of ['', 'yesterday', '2026-13-99', '02-08-2026', null, undefined, 42]) {
    assert.equal(coverageWindow(bad as unknown as string, 30), null, String(bad));
  }
  assert.equal(coverageWindow('2026-08-02', 0), null);
  assert.equal(coverageWindow('2026-08-02', -5), null);
  assert.equal(coverageWindow('2026-08-02', NaN), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The SQL — no binding, so validation IS the guard
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only', () => {
  const sql = buildVitalsCoverageSql('2026-07-04', '2026-08-03');
  // the measured shape (a LEFT JOIN onto the whole vitals table returned HTTP 504)
  assert.match(sql, /NOT IN \(\s*\n\s*SELECT consult_uid FROM "individuals-individual_vitals_records" WHERE consult_uid IS NOT NULL/);
  assert.ok(!/LEFT JOIN/i.test(sql), 'the LEFT JOIN form times out — it must not come back');
  // bounded on both sides — the bound is what makes the NOT IN affordable
  assert.ok(sql.includes("ip.uploaded_at >= '2026-07-04' AND ip.uploaded_at < '2026-08-03'"));
  // scope
  assert.ok(sql.includes("ip.type_of_prescription = 'HOSPITAL_GP'"), 'DEC-1: one template');
  assert.ok(sql.includes('ip.is_draft = false'));
  assert.ok(!/HOSPITAL_PAEDIATRIC|GYNAECOLOGY|GENERAL_PRACTITIONER|INVESTIGATION_REFERRAL/.test(sql),
    'no other template may appear');
  // grouping is by the IST calendar day
  assert.ok(sql.includes("(ip.uploaded_at AT TIME ZONE 'Asia/Kolkata')::date AS d"));
  assert.ok(sql.trimEnd().endsWith('GROUP BY 1 ORDER BY 1 DESC'));
});

test('the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID', () => {
  // NULL NOT IN (…) is NULL, not true — an unguarded FILTER silently counted a null-ID note as
  // COVERED. '' NOT IN (…) is true, so a blank-string ID counted as no-vitals. Both asserted
  // something unknowable. The guard makes the question only reachable for a real ID.
  const sql = buildVitalsCoverageSql('2026-07-04', '2026-08-03');
  assert.ok(sql.includes("COUNT(*) FILTER (WHERE ip.consult_uid IS NULL OR btrim(ip.consult_uid) = '') AS no_consult_id"),
    'the unknowable visits are counted in their own column');
  assert.ok(sql.includes("COUNT(*) FILTER (WHERE ip.consult_uid IS NOT NULL AND btrim(ip.consult_uid) <> ''"),
    'and the NOT IN filter is guarded by the same test');
  // the guard must sit INSIDE the no_vitals filter, before the subquery
  const noVitalsFilter = sql.slice(sql.indexOf('AS no_consult_id'), sql.indexOf('AS no_vitals'));
  assert.ok(noVitalsFilter.includes("btrim(ip.consult_uid) <> ''") && noVitalsFilter.includes('NOT IN ('),
    'guard then subquery, in that order');
});

test('THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated', () => {
  const attacks = [
    "2026-07-04'; DROP TABLE x; --",
    "' OR '1'='1",
    '2026-7-4', '26-07-04', '2026/07/04', '', 'now()', null, undefined, 42, {},
  ];
  for (const bad of attacks) {
    assert.throws(() => buildVitalsCoverageSql(bad as unknown as string, '2026-08-03'), /refusing to build SQL/, `start=${String(bad)}`);
    assert.throws(() => buildVitalsCoverageSql('2026-07-04', bad as unknown as string), /refusing to build SQL/, `end=${String(bad)}`);
  }
});

test('isDay accepts only the exact shape — the same guard lib/metabase.ts uses', () => {
  assert.equal(isDay('2026-05-28'), true);
  for (const bad of ['2026-5-28', '2026-05-28T00:00:00Z', ' 2026-05-28', '2026-05-28 ', 20260528, null]) {
    assert.equal(isDay(bad as unknown), false, String(bad));
  }
});

test('addDays is UTC-stable across a month boundary and returns "" on junk', () => {
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-08-01', -1), '2026-07-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('nonsense', 1), '');
});

test('istDay reads the Asia/Kolkata calendar day, not UTC', () => {
  // 2026-08-02 19:00 UTC is 2026-08-03 00:30 IST — the boundary that makes a UTC day wrong.
  assert.equal(istDay(new Date('2026-08-02T19:00:00Z')), '2026-08-03');
  assert.equal(istDay(new Date('2026-08-02T18:00:00Z')), '2026-08-02');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Row shaping — and the measured numbers
// ═════════════════════════════════════════════════════════════════════════════════════════════

const WIN = { start: '2026-07-27', lastDay: '2026-08-01' };

test('a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals', () => {
  // 5 visits: 1 has no ID, 2 have no vitals, 2 are covered.
  const r = shapeCoverage([{ d: '2026-07-28', gp_notes: 5, no_consult_id: 1, no_vitals: 2 }], WIN);
  const d0 = r.days[0];
  assert.equal(d0.gpNotes, 5);
  assert.equal(d0.noConsultId, 1, 'counted in its own category');
  assert.equal(d0.noVitals, 2, 'and NOT rolled into the gap count');
  assert.equal(d0.gpNotes - d0.noConsultId - d0.noVitals, 2, 'the remainder is covered');
  assert.equal(d0.pct, 50, '2 of the 4 answerable visits — the unknowable one is out of the denominator');
});

test('THE HEADLINE DENOMINATOR EXCLUDES what we cannot know', () => {
  const r = shapeCoverage([
    { d: '2026-07-28', gp_notes: 100, no_consult_id: 20, no_vitals: 20 },
  ], WIN);
  assert.equal(r.totalGpNotes, 100);
  assert.equal(r.totalNoConsultId, 20);
  assert.equal(r.answerable, 80, 'GP visits minus the ones with no ID');
  assert.equal(r.pct, 25, '20/80, NOT 20/100 — folding them in either direction would misstate it');
});

test('empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)', () => {
  // The core sees only the counts, so this pins the CONTRACT: whatever the SQL classifies as
  // no_consult_id lands in that column and leaves the denominator. The btrim is asserted above.
  const sql = buildVitalsCoverageSql('2026-07-04', '2026-08-03');
  assert.ok(sql.includes("btrim(ip.consult_uid) = ''"), 'whitespace-only trims to empty and counts as no-ID');
  assert.ok(sql.includes("btrim(ip.consult_uid) <> ''"), 'and is excluded from the vitals lookup');
  const r = shapeCoverage([{ d: '2026-07-28', gp_notes: 3, no_consult_id: 3, no_vitals: 0 }], WIN);
  assert.equal(r.answerable, 0);
  assert.equal(r.pct, 0, 'nothing answerable ⇒ 0%, never a divide-by-zero');
});

test('a note with an ID absent from the vitals table is still no-vitals; one present is still covered', () => {
  const r = shapeCoverage([{ d: '2026-07-28', gp_notes: 10, no_consult_id: 0, no_vitals: 4 }], WIN);
  assert.equal(r.days[0].noVitals, 4, 'absent from the table ⇒ no-vitals, unchanged');
  assert.equal(r.days[0].gpNotes - r.days[0].noVitals, 6, 'present ⇒ covered, unchanged');
  assert.equal(r.pct, 40, 'and with no unknowable visits the headline is unchanged from before');
});

test('the MEASURED window reproduces: 160 of 561 = 28.5%', () => {
  // PRD §3.1, measured 2 Aug against db13.
  const rows = [
    { d: '2026-07-27', gp_notes: 136, no_consult_id: 0, no_vitals: 36 },
    { d: '2026-07-28', gp_notes: 79, no_consult_id: 0, no_vitals: 28 },
    { d: '2026-07-29', gp_notes: 96, no_consult_id: 0, no_vitals: 26 },
    { d: '2026-07-30', gp_notes: 89, no_consult_id: 0, no_vitals: 30 },
    { d: '2026-07-31', gp_notes: 71, no_consult_id: 0, no_vitals: 18 },
    { d: '2026-08-01', gp_notes: 90, no_consult_id: 0, no_vitals: 22 },
  ];
  const r = shapeCoverage(rows, WIN);
  assert.equal(r.totalGpNotes, 561);
  assert.equal(r.totalNoVitals, 160);
  assert.equal(r.answerable, 561, 'no unknowable visits in this fixture');
  assert.equal(r.pct, 28.5, 'the PRD says "roughly 28%" — a figure near 100% means the floor is gone');
  assert.equal(r.days.length, 6);
  assert.equal(r.days[0].date, '2026-08-01', 'newest first');
  assert.equal(r.days[0].pct, 24.4);
});

test('rows outside the window are DROPPED — a boundary sliver is not a day', () => {
  // The SQL bounds uploaded_at in UTC but groups by IST date, so the range can admit a few hours
  // of the following day. Rendering that as a day would overstate a partial count.
  const r = shapeCoverage([
    { d: '2026-07-26', gp_notes: 50, no_vitals: 10 },   // before start
    { d: '2026-08-02', gp_notes: 3, no_vitals: 3 },     // the sliver after lastDay
    { d: '2026-07-28', gp_notes: 79, no_vitals: 28 },
  ], WIN);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-07-28']);
  assert.equal(r.totalGpNotes, 79);
});

test('Metabase type wobble is absorbed: string counts and ISO timestamps', () => {
  const r = shapeCoverage([
    { d: '2026-07-28T00:00:00Z', gp_notes: '79', no_vitals: '28' },
  ], WIN);
  assert.equal(r.days[0].date, '2026-07-28');
  assert.equal(r.days[0].gpNotes, 79);
  assert.equal(r.days[0].noVitals, 28);
});

test('junk never produces a number that looks real', () => {
  assert.deepEqual(shapeCoverage([], WIN),
    { days: [], totalGpNotes: 0, totalNoConsultId: 0, totalNoVitals: 0, answerable: 0, pct: 0 });
  assert.deepEqual(shapeCoverage(null as unknown as unknown[], WIN).days, []);
  const r = shapeCoverage([{ d: 'nope', gp_notes: 5, no_vitals: 1 }, null, 7, { }], WIN);
  assert.deepEqual(r.days, [], 'a row with no usable date is dropped, not defaulted');
  // a subset can never exceed its whole
  const clamp = shapeCoverage([{ d: '2026-07-28', gp_notes: 10, no_vitals: 99 }], WIN);
  assert.equal(clamp.days[0].noVitals, 10);
  assert.equal(clamp.days[0].pct, 100);
  // the three categories stay disjoint even when the counts disagree
  const both = shapeCoverage([{ d: '2026-07-28', gp_notes: 10, no_consult_id: 99, no_vitals: 99 }], WIN);
  assert.equal(both.days[0].noConsultId, 10, 'cannot exceed the whole');
  assert.equal(both.days[0].noVitals, 0, 'and cannot exceed what is answerable');
  // negatives and NaN read as zero rather than propagating
  const neg = shapeCoverage([{ d: '2026-07-28', gp_notes: -5, no_vitals: 'abc' }], WIN);
  assert.equal(neg.days[0].gpNotes, 0);
  assert.equal(neg.days[0].pct, 0, 'zero visits ⇒ 0%, never a divide-by-zero');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The build contract — no engine change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the core is PURE and dependency-free — it must not reach the engine or any score', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('lib/vitals-coverage-core.ts', 'utf8');
  // Comments are stripped first: the header deliberately EXPLAINS why v1.0's finding approach was
  // abandoned, and naming a type in prose is not a dependency on it. This asserts about code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/^\s*import\s/m.test(code), 'no imports at all: no db, no metabase, no engine, no env');
  assert.ok(!/opd-note-audit|score-core|signal_type|OpdFinding|process\.env/.test(code),
    'C7 v2.0 is a panel count, not a finding — no engine reference and no env read in the core');
});
