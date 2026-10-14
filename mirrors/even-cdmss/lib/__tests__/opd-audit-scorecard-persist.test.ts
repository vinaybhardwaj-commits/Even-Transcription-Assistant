// NQI coverage metric — PHASE 1. Persisting the scorecard (PRD 27 Jul 2026).
//
// These are SOURCE-LEVEL assertions over lib/opd-audit-store.ts and migrations/0025, not runtime
// tests. That is deliberate: the risk in this build is not logic, it is SQL parameter alignment and
// column-list drift across three write paths — the class of fault that a type system cannot see and
// that has produced seven schema defects on this project this week. A misnumbered $n writes the
// right value into the wrong column, silently.
//
// lib/opd-audit-store.ts imports ./db, so it cannot be imported here without breaking the
// strip-types contract; reading its source is the way to assert against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeOpdScore } from '../opd-note-score-core.ts';

const STORE = readFileSync(new URL('../opd-audit-store.ts', import.meta.url), 'utf8');
const MIGRATION = readFileSync(new URL('../../migrations/0025_opd_note_audits_scorecard.sql', import.meta.url), 'utf8');

test('migration 0025 is exactly one additive, idempotent statement', () => {
  const stmts = MIGRATION.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts.length, 1, 'PRD §4: nothing but the ALTER');
  assert.equal(stmts[0], 'ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS scorecard jsonb');
  // no index, no NOT NULL, no default, and nothing destructive
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /CREATE INDEX/i);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /NOT NULL/i);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /DEFAULT/i);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
});

// ── A.1 (0027): a THIRD conditional column, `completeness_items`, joined `quieting_gen`. These
// assertions were extended from the two withGen branches to the full 2×2 matrix rather than
// relaxed — the alignment risk they guard grows with each conditional column, it does not shrink.
// Both new columns are appended AFTER the existing ones so no established placeholder index moved.
const GEN_COLS = "${withGen ? ', quieting_gen' : ''}";
const ITEM_COLS = "${withItems ? ', completeness_items' : ''}";
// S0 (invalid-marking, 28 Jul) appended the FIXED column excluded_reason as $33 (INSERT) / $21
// (UPDATE), so the conditional tail shifted by one. Fixed columns before it did not move.
const GEN_VALS = "${withGen ? ', $34' : ''}";
const ITEM_VALS = '${withItems ? `, $${withGen ? 35 : 34}::jsonb` : \'\'}';
// S1 (0029) — a THIRD conditional column, displayed_band, appended after the other two. Its
// placeholder is arithmetic over the two flags before it.
const BAND_COLS = "${withBand ? ', displayed_band' : ''}";
const BAND_VALS = '${withBand ? `, $${34 + (withGen ? 1 : 0) + (withItems ? 1 : 0)}` : \'\'}';
// PROVIDER-SWITCH Unit B (§5, 2 Aug 2026) — a FOURTH conditional column, `provider`, appended after
// the other three. Its placeholder is arithmetic over the three flags before it, and the matrix
// below grows from 8 branches to 16 rather than being relaxed: the alignment risk these assertions
// guard grows with each conditional column, it does not shrink.
const PROV_COLS = "${withProvider ? ', provider' : ''}";
const PROV_VALS = '${withProvider ? `, $${34 + (withGen ? 1 : 0) + (withItems ? 1 : 0) + (withBand ? 1 : 0)}` : \'\'}';

/** Expand the four conditional template segments into the concrete SQL for one branch tuple. */
function expand(src: string, withGen: boolean, withItems: boolean, withBand = false, withProvider = false): string {
  return src
    .split(GEN_COLS).join(withGen ? ', quieting_gen' : '')
    .split(ITEM_COLS).join(withItems ? ', completeness_items' : '')
    .split(BAND_COLS).join(withBand ? ', displayed_band' : '')
    .split(PROV_COLS).join(withProvider ? ', provider' : '')
    .split(GEN_VALS).join(withGen ? ', $34' : '')
    .split(ITEM_VALS).join(withItems ? `, $${withGen ? 35 : 34}::jsonb` : '')
    .split(BAND_VALS).join(withBand ? `, $${34 + (withGen ? 1 : 0) + (withItems ? 1 : 0)}` : '')
    .split(PROV_VALS).join(withProvider ? `, $${34 + (withGen ? 1 : 0) + (withItems ? 1 : 0) + (withBand ? 1 : 0)}` : '');
}

const BRANCHES: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]];
const BAND_BRANCHES: boolean[] = [false, true];
const PROV_BRANCHES: boolean[] = [false, true];

test('ALL THREE write paths carry the scorecard — a row written without one is a bug', () => {
  // 1. ON CONFLICT DO UPDATE (force mode)
  assert.match(STORE, /scorecard = EXCLUDED\.scorecard,/);
  // 2. INSERT column list + placeholder — now with both conditional tails
  assert.ok(STORE.includes(`complexity_band, complexity_inputs, scorecard, excluded_reason${GEN_COLS}${ITEM_COLS}${BAND_COLS}${PROV_COLS})`));
  assert.ok(STORE.includes(`$30, $31::jsonb, $32::jsonb, $33${GEN_VALS}${ITEM_VALS}${BAND_VALS}${PROV_VALS})`));
  // 3. force-overwrite UPDATE
  assert.match(STORE, /scorecard = \$20::jsonb,/);
});

test('the A.1 column is APPENDED — no established placeholder index moved', () => {
  // scorecard stays $32 and engine_version stays $19 in every branch. This is the assertion that
  // would have caught a mid-list insertion, which writes right values into wrong columns silently.
  assert.match(STORE, /\$30, \$31::jsonb, \$32::jsonb/);
  assert.match(STORE, /WHERE uid = \$1 AND engine_version = \$19/);
  assert.match(STORE, /scorecard = \$20::jsonb/);
});

test('INSERT: columns and arguments align in ALL SIXTEEN branches', () => {
  const colBlock = STORE.slice(STORE.indexOf('(uid, consult_uid, doctor_uid'), STORE.indexOf('VALUES ($1'));
  const vStart = STORE.indexOf('VALUES ($1');
  const valBlock = STORE.slice(vStart, STORE.indexOf('ON CONFLICT (uid, engine_version)', vStart));

  for (const [withGen, withItems] of BRANCHES) for (const withBand of BAND_BRANCHES) for (const withProvider of PROV_BRANCHES) {
    const label = `withGen=${withGen} withItems=${withItems} withBand=${withBand} withProvider=${withProvider}`;
    const cols = expand(colBlock, withGen, withItems, withBand, withProvider)
      .replace(/[()\n]/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
    const expected = 33 + (withGen ? 1 : 0) + (withItems ? 1 : 0) + (withBand ? 1 : 0) + (withProvider ? 1 : 0);
    assert.equal(cols.length, expected, label);
    // scorecard is the 32nd column in EVERY branch; S0's excluded_reason is the 33rd, FIXED (the
    // column exists in every deployment — 167 house_account rows), so the conditional tail follows it.
    assert.equal(cols[31], 'scorecard', `${label}: scorecard must be column 32`);
    assert.equal(cols[32], 'excluded_reason', `${label}: excluded_reason must be column 33`);
    assert.equal(cols[30], 'complexity_inputs', label);
    if (withGen) assert.equal(cols[33], 'quieting_gen', label);
    if (withItems) assert.equal(cols[withGen ? 34 : 33], 'completeness_items', label);
    // S1 — displayed_band sits after the first two conditionals; Unit B's provider is always LAST.
    if (withBand) assert.equal(cols[33 + (withGen ? 1 : 0) + (withItems ? 1 : 0)], 'displayed_band', label);
    if (withProvider) assert.equal(cols[expected - 1], 'provider', label);

    // …and the placeholder count must equal the column count, in the same branch.
    const ph = [...expand(valBlock, withGen, withItems, withBand, withProvider).matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(new Set(ph).size, ph.length, `${label}: no placeholder may be reused`);
    assert.deepEqual(
      ph.slice().sort((a, b) => a - b),
      Array.from({ length: expected }, (_, i) => i + 1),
      `${label}: placeholders must be 1..${expected}, no gap`,
    );
    assert.equal(cols.length, ph.length, `${label}: COLUMN/ARGUMENT COUNT MISMATCH`);
  }
});

test('INSERT: every jsonb column is cast, including the A.1 one', () => {
  const vStart = STORE.indexOf('VALUES ($1');
  const vals = STORE.slice(vStart, STORE.indexOf('ON CONFLICT (uid, engine_version)', vStart));
  assert.ok(vals.length > 50, 'slice must be non-empty or the assertions below are vacuous');
  assert.match(vals, /\$32::jsonb/, 'scorecard');
  assert.ok(vals.includes('::jsonb` : \'\'}'), 'completeness_items is cast in its conditional branch');
});

test('UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22', () => {
  const up = STORE.slice(STORE.indexOf('UPDATE opd_note_audits SET'), STORE.indexOf('WHERE uid = $1 AND engine_version = $19'));
  assert.match(up, /scorecard = \$20::jsonb/);
  // S0 — excluded_reason takes the fixed $21 with the mark/clear/preserve semantics inline
  assert.match(up, /excluded_reason = COALESCE\(\$21,/);
  assert.match(up, /CASE WHEN excluded_reason = 'llm_leg_failed' THEN NULL ELSE excluded_reason END\)/);
  assert.match(up, /quieting_gen = \$22/);
  // $19 stays the engine_version predicate — neither new column may displace it
  assert.match(STORE, /WHERE uid = \$1 AND engine_version = \$19/);
  // completeness_items takes 23 when quieting_gen is present, else 22 — asserted literally
  assert.ok(up.includes("${withItems ? `, completeness_items = $${withGen ? 23 : 22}::jsonb` : ''}"),
    'the A.1 UPDATE placeholder must be conditional on withGen');
});

test('serialisation is FAIL-SAFE: a scorecard fault must never cost an audit', () => {
  assert.match(STORE, /function scorecardJson\(sc: unknown\): string \| null \{/);
  assert.match(STORE, /catch \{ return null; \}/);
  // null in ⇒ null out, so a missing scorecard writes SQL NULL rather than the string "null"
  assert.match(STORE, /if \(sc == null\) return null;/);
});

test('the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed', () => {
  // the argument is the whole object already in scope, the same `sc` headline/band are read from
  assert.match(STORE, /\n      scorecardJson\(sc\),\n/);
  // no field-picking on the way to the column
  assert.doesNotMatch(STORE, /scorecardJson\(\{/);
  assert.doesNotMatch(STORE, /scorecardJson\(sc\.\w/);
});

test('THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis', () => {
  // Reproduce the unassessed case through the REAL scorer, then assert the shape that gets stored.
  const sc = computeOpdScore({
    findings: [], completenessCoverage: 1, pdqi9: null,
    patientCentred: { present: 2, total: 2 },
  });
  const nq = sc.domains.find((d) => d.domain === 'note_quality');
  assert.ok(nq, 'note_quality is always emitted, even unassessed');
  assert.equal(nq.weight, 0, 'weight 0 is the contradicting field this build persists');
  assert.match(nq.basis, /not assessed/i);
  // …and the headline is high BECAUSE the zero-weight domain dropped out of the normalised mean.
  // Phase 1 does NOT change this — it makes it visible. Asserted so a later "fix" here is deliberate.
  assert.ok(sc.headline >= 90, `unassessed notes still score high (got ${sc.headline}) — Phase 2/3 problem`);
  // the serialised form retains the weight
  const round = JSON.parse(JSON.stringify(sc)) as typeof sc;
  assert.equal(round.domains.find((d) => d.domain === 'note_quality')?.weight, 0);
});

test('an ASSESSED note keeps a non-zero note_quality weight — the control', () => {
  const sc = computeOpdScore({
    findings: [], completenessCoverage: 1,
    pdqi9: { thorough: 3, accurate: 3 } as never,
    patientCentred: { present: 2, total: 2 },
  });
  const nq = sc.domains.find((d) => d.domain === 'note_quality');
  assert.ok(nq && nq.weight > 0, 'an assessed note must carry a real weight');
  assert.doesNotMatch(nq.basis, /not assessed/i);
});
