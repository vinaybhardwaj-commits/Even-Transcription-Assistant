/**
 * lib/__tests__/world-model-walk-o.test.ts — the W0.1 gate.
 *
 * W0.2 (the admin page) ships ONLY after every test in this file passes. The six gate items from the
 * task contract, in order:
 *   (1) the strict prior-day cut still holds THROUGH the walker;
 *   (2) a person with no evidence yields no cuts (or all `no_prior_history`);
 *   (3) throw and null produce DIFFERENT statuses;
 *   (4) fold notes are present when the fold is on;
 *   (5) flag-off IPD is labelled `fold_off`, never "no stays";
 *   (6) the walker calls no even-elo and no portal URL.
 *
 * OFFLINE BY CONSTRUCTION. There is no live db13 and no live Neon in this sandbox, so every test
 * drives the walker through its injected seams (`WalkDeps`). Test (1) is the exception that matters:
 * it does NOT fake the cut — it runs the REAL `getMemberSnapshotAsOf` composition (real
 * `assembleEvidence` → real `applyAsOfCut` → real `buildMemberState`) over inlined db13-shaped rows,
 * so the prior-day guarantee is proved end-to-end rather than asserted about a stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  walkO, enumerateCutDates, resolveWalkSubject, readWalkFlags, ipdFoldLabelFor,
  WORLD_MODEL_WALK_VERSION, GRAIN_LABEL, HONESTY_CHIP,
  type WalkFlags,
} from '../world-model/walk-o';
import { assembleEvidence } from '../member-state/assemble-core';
import { buildMemberState } from '../member-state/aggregate-core';
import { applyAsOfCut } from '../as-of-core';
import { MEMBER_STATE_VERSION, zMemberStateSnapshot, type MemberStateSnapshot } from '../member-state/schema';

const UID = 'ind_walk_0001';
const COMPUTED_AT = '2026-08-31T00:00:00.000Z';

const ALL_OFF: WalkFlags = { MEMBERSTATE_IPD_FOLD: false, CARE_CALL_ENABLED: false, PROMS_ENABLED: false };
const FOLD_ON: WalkFlags = { ...ALL_OFF, MEMBERSTATE_IPD_FOLD: true };

// Inlined real-shape db13 rows. Three distinct clinical days: 2026-01-10 (lab), 2026-02-01 (opd),
// 2026-03-15 (opd). Shapes copied from lib/__tests__/member-state-assemble.test.ts.
const RX_ROWS = [
  {
    uid: 'presc_feb', visit_date: '2026-02-01', age: 55, gender: 'F',
    patient_details__allergies: 'No', diagnosis_icd_codes: ['E11.9'], impression_icd_codes: [],
    medications: [{ brand_name: 'Glycomet', generic_name: 'Metformin', dosage: '500mg', frequency: '1-0-1' }],
  },
  {
    uid: 'presc_mar', visit_date: '2026-03-15', age: 55, gender: 'F',
    patient_details__allergies: 'No', diagnosis_icd_codes: ['I10'], impression_icd_codes: [],
    medications: [{ brand_name: 'Amlong', generic_name: 'Amlodipine', dosage: '5mg', frequency: '1-0-0' }],
  },
];
const LAB_ROWS = [
  { booking_id: 'bk_jan', test_result_uid: 'tr1', test_date: '2026-01-10', investigation_name: 'Creatinine', value: '1.1', investigation_unit: 'mg/dL', investigation_is_abnormal: 'false' },
];

/** A db13 runner that answers the two frozen queries from the inlined rows. */
const fakeQuery = (presc = RX_ROWS as Record<string, unknown>[], labs = LAB_ROWS as Record<string, unknown>[]) =>
  async (sql: string): Promise<Record<string, unknown>[]> =>
    (/individuals-prescriptions/.test(sql) ? presc : labs);

/** The REAL reconstruct composition, over the same inlined rows — no db13, no stubbed cut. */
async function realReconstruct(individualUid: string, asOfDate: string, computedAt: string): Promise<MemberStateSnapshot | null> {
  const base = assembleEvidence({
    memberRef: individualUid, generatedAt: computedAt, sourceWatermarks: { db13: computedAt },
    prescriptionRows: RX_ROWS, labRows: LAB_ROWS,
  });
  const encounters = applyAsOfCut(base.encounters, asOfDate);   // the real strict prior-day cut
  if (!encounters.length) return null;
  return buildMemberState({ ...base, encounters }, computedAt);
}

// ── (1) THE STRICT PRIOR-DAY CUT STILL HOLDS THROUGH THE WALKER ────────────────────────────────
// The guarantee under test: the snapshot at cut D contains evidence dated STRICTLY BEFORE D, and
// day D's own encounter is NOT in it. Proved against the real cut, not a stub.

test('(1) strict prior-day: every cut excludes its own day and everything after it', async () => {
  const walk = await walkO(UID, COMPUTED_AT, { query: fakeQuery(), reconstruct: realReconstruct, flags: ALL_OFF });

  assert.deepEqual(walk.cuts.map((c) => c.date), ['2026-01-10', '2026-02-01', '2026-03-15'], 'one cut per evidence day, oldest first');

  for (const cut of walk.cuts) {
    if (cut.status !== 'ok') continue;
    const snap = cut.snapshot!;
    // Every dated occurrence anywhere in the snapshot must be strictly before the cut day.
    const dates = [
      ...snap.problems.flatMap((p) => p.occurrences.map((o) => o.date)),
      ...snap.medications.flatMap((m) => m.occurrences.map((o) => o.date)),
      ...snap.investigations.flatMap((i) => i.series.map((s) => s.date)),
    ];
    assert.ok(dates.length > 0, `cut ${cut.date} is 'ok' so it must carry evidence`);
    for (const d of dates) {
      assert.ok(d.slice(0, 10) < cut.date, `cut ${cut.date}: evidence dated ${d} is not strictly before the cut`);
    }
    assert.ok(snap.asOf.slice(0, 10) < cut.date, `cut ${cut.date}: asOf ${snap.asOf} must precede the cut day`);
  }
});

test("(1b) the member's FIRST evidence day has nothing before it — no_prior_history, not an error", async () => {
  const walk = await walkO(UID, COMPUTED_AT, { query: fakeQuery(), reconstruct: realReconstruct, flags: ALL_OFF });
  const first = walk.cuts[0];
  assert.equal(first.date, '2026-01-10');
  assert.equal(first.status, 'no_prior_history', 'the earliest day is honestly empty, never context_fetch_failed');
  assert.equal(first.snapshot, undefined, 'no snapshot on a no_prior_history cut');
});

test('(1c) same-day evidence is excluded: the March cut sees Jan + Feb but NOT March', async () => {
  const walk = await walkO(UID, COMPUTED_AT, { query: fakeQuery(), reconstruct: realReconstruct, flags: ALL_OFF });
  const march = walk.cuts.find((c) => c.date === '2026-03-15')!;
  assert.equal(march.status, 'ok');
  const refs = march.snapshot!.sourceEncounterRefs;
  assert.ok(refs.includes('presc_feb'), 'the February note is prior context');
  assert.ok(refs.includes('bk_jan'), 'the January lab is prior context');
  assert.ok(!refs.includes('presc_mar'), "the cut day's OWN note must never appear in its own prior context");
});

test('(1d) the walk WRAPS the frozen snapshot — no key added, version still member-state/1.2', async () => {
  const walk = await walkO(UID, COMPUTED_AT, { query: fakeQuery(), reconstruct: realReconstruct, flags: ALL_OFF });
  const ok = walk.cuts.filter((c) => c.status === 'ok');
  assert.ok(ok.length > 0);
  for (const cut of ok) {
    assert.equal(cut.snapshot!.version, MEMBER_STATE_VERSION, 'no version bump');
    assert.equal(MEMBER_STATE_VERSION, 'member-state/1.2');
    // The strict schema still parses it: the walk added nothing to the snapshot object.
    assert.doesNotThrow(() => zMemberStateSnapshot.parse(cut.snapshot), 'snapshot survives .strict() validation unchanged');
  }
});

// ── (2) A PERSON WITH NO EVIDENCE ──────────────────────────────────────────────────────────────

test('(2) no evidence ⇒ no cuts, and enumeration honestly says it looked and found nothing', async () => {
  const walk = await walkO(UID, COMPUTED_AT, { query: fakeQuery([], []), reconstruct: realReconstruct, flags: ALL_OFF });
  assert.deepEqual(walk.cuts, [], 'no evidence days ⇒ no cuts');
  assert.equal(walk.enumeration.status, 'ok', 'we DID look — this is knowledge, not an outage');
  assert.equal(walk.enumeration.candidateDays, 0);
});

test('(2b) a bad individual_uid yields no cuts and never reaches db13', async () => {
  let called = 0;
  const walk = await walkO('nope', COMPUTED_AT, {
    query: async () => { called++; return []; },
    reconstruct: realReconstruct, flags: ALL_OFF,
  });
  assert.deepEqual(walk.cuts, []);
  assert.equal(called, 0, 'a malformed uid is refused before any read');
});

// ── (3) THROW AND NULL ARE DIFFERENT STATUSES — THE CENTRAL HONESTY TEST ───────────────────────

test('(3) throw ⇒ context_fetch_failed, null ⇒ no_prior_history, and they are never collapsed', async () => {
  const walk = await walkO(UID, COMPUTED_AT, {
    query: fakeQuery(),
    // Feb throws (a real db13 failure); Jan and Mar return null (resolved, but nothing prior).
    reconstruct: async (_u, asOf) => {
      if (asOf === '2026-02-01') throw new Error('db13 connection reset');
      return null;
    },
    flags: ALL_OFF,
  });

  const byDate = Object.fromEntries(walk.cuts.map((c) => [c.date, c.status]));
  assert.equal(byDate['2026-02-01'], 'context_fetch_failed', 'a THROW means we do not know');
  assert.equal(byDate['2026-01-10'], 'no_prior_history', 'a NULL means we know, and it was empty');
  assert.equal(byDate['2026-03-15'], 'no_prior_history');
  assert.notEqual(byDate['2026-02-01'], byDate['2026-01-10'], 'throw and null MUST NOT collapse to one status');
});

test('(3b) a walker throw never escapes — the page gets a labelled cut, never a 500', async () => {
  await assert.doesNotReject(async () => {
    const walk = await walkO(UID, COMPUTED_AT, {
      query: fakeQuery(),
      reconstruct: async () => { throw new Error('everything is on fire'); },
      flags: ALL_OFF,
    });
    assert.ok(walk.cuts.length > 0);
    assert.ok(walk.cuts.every((c) => c.status === 'context_fetch_failed'));
  });
});

test('(3c) an ENUMERATION outage is context_fetch_failed, NOT an empty history', async () => {
  const walk = await walkO(UID, COMPUTED_AT, {
    query: async () => { throw new Error('db13 unavailable'); },
    reconstruct: realReconstruct, flags: ALL_OFF,
  });
  assert.equal(walk.enumeration.status, 'context_fetch_failed', 'an outage during enumeration must be visible');
  assert.deepEqual(walk.cuts, []);
  // The distinction that matters: this must NOT look like the no-evidence member in test (2).
  const empty = await walkO(UID, COMPUTED_AT, { query: fakeQuery([], []), reconstruct: realReconstruct, flags: ALL_OFF });
  assert.notEqual(walk.enumeration.status, empty.enumeration.status, 'an outage and an empty member are different answers');
});

// ── (4) FOLD NOTES PRESENT WHEN THE FOLD IS ON ────────────────────────────────────────────────

test('(4) fold ON: notes and refusals are carried onto every cut', async () => {
  const notes = ['stay stay_77: identity did not resolve back to this member (ambiguous) — skipped, nothing folded'];
  const refused = [{ slot: 'procedures', concept: 'Cholecystectomy', reason: 'no_span' as never }];
  const walk = await walkO(UID, COMPUTED_AT, {
    query: fakeQuery(), reconstruct: realReconstruct, flags: FOLD_ON,
    fold: async () => ({ notes, refused }),
  });
  assert.ok(walk.cuts.length > 0);
  for (const cut of walk.cuts) {
    assert.deepEqual(cut.foldNotes, notes, 'every cut carries the walk-level fold notes');
    assert.deepEqual(cut.foldRefused, refused, 'every cut carries the walk-level refusals');
  }
});

test('(4b) C2 — the fold is called ONCE PER WALK, not once per cut', async () => {
  let folds = 0;
  const walk = await walkO(UID, COMPUTED_AT, {
    query: fakeQuery(), reconstruct: realReconstruct, flags: FOLD_ON,
    fold: async () => { folds++; return { notes: [], refused: [] }; },
  });
  assert.equal(walk.cuts.length, 3, 'three cuts');
  assert.equal(folds, 1, 'but exactly one stay-library read');
});

test('(4c) a fold failure degrades to an honest note, never to silence', async () => {
  const walk = await walkO(UID, COMPUTED_AT, {
    query: fakeQuery(), reconstruct: realReconstruct, flags: FOLD_ON,
    fold: async () => { throw new Error('stay library down'); },
  });
  assert.ok(walk.cuts[0].foldNotes.some((n) => /could not be read/.test(n)), 'the outage is stated, not swallowed');
});

// ── (5) FLAG-OFF IPD IS `fold_off`, NEVER "no stays" ──────────────────────────────────────────

test('(5) fold OFF: labelled fold_off, and the stay library is never touched', async () => {
  let folds = 0;
  const walk = await walkO(UID, COMPUTED_AT, {
    query: fakeQuery(), reconstruct: realReconstruct, flags: ALL_OFF,
    fold: async () => { folds++; return { notes: ['unreachable'], refused: [] }; },
  });
  assert.equal(folds, 0, 'flag off ⇒ not a single stay-library read');
  assert.equal(walk.flags.MEMBERSTATE_IPD_FOLD, false);
  assert.equal(ipdFoldLabelFor(walk.flags), 'fold_off', 'the label is fold_off — "we did not look"');
  assert.notEqual(ipdFoldLabelFor(walk.flags), 'folded');
  for (const cut of walk.cuts) {
    assert.deepEqual(cut.foldNotes, [], 'flag off ⇒ no notes at all, so nothing can read as "no stays"');
    assert.deepEqual(cut.foldRefused, []);
  }
});

test('(5b) fold ON with zero stays is `folded`, which is a DIFFERENT claim from fold_off', async () => {
  const walk = await walkO(UID, COMPUTED_AT, {
    query: fakeQuery(), reconstruct: realReconstruct, flags: FOLD_ON,
    fold: async () => ({ notes: [], refused: [] }),
  });
  assert.equal(ipdFoldLabelFor(walk.flags), 'folded', 'we looked and found none — not the same as not looking');
});

test('(5c) the flags are read at compute time and returned with the walk', async () => {
  const walk = await walkO(UID, COMPUTED_AT, { query: fakeQuery(), reconstruct: realReconstruct, flags: FOLD_ON });
  assert.deepEqual(Object.keys(walk.flags).sort(), ['CARE_CALL_ENABLED', 'MEMBERSTATE_IPD_FOLD', 'PROMS_ENABLED']);
  // readWalkFlags reflects the environment, and 'true' / '0' are BOTH off for the IPD fold.
  const prev = process.env.MEMBERSTATE_IPD_FOLD;
  try {
    process.env.MEMBERSTATE_IPD_FOLD = 'true';
    assert.equal(readWalkFlags().MEMBERSTATE_IPD_FOLD, false, "'true' is not '1' — the fold is off");
    process.env.MEMBERSTATE_IPD_FOLD = '1';
    assert.equal(readWalkFlags().MEMBERSTATE_IPD_FOLD, true);
  } finally {
    if (prev === undefined) delete process.env.MEMBERSTATE_IPD_FOLD; else process.env.MEMBERSTATE_IPD_FOLD = prev;
  }
});

// ── (6) THE WALKER TOUCHES NO EVEN-ELO AND NO PORTAL URL, AND WRITES NO SQL ───────────────────

const SRC = readFileSync(join(process.cwd(), 'lib/world-model/walk-o.ts'), 'utf8');
/** The file with EVERY comment removed — so these assertions test the code, not the prose about it.
 *  (The header comment names `bridgeMemberIdToIndividuals` and `inds[0]` precisely to say they are
 *  never used; matching those mentions would be the test failing to distinguish saying from doing.) */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('(6) the walker calls no even-elo and no portal URL', () => {
  assert.ok(!/even-elo|evenElo|even_elo/i.test(SRC), 'no even-elo reference of any kind, in code or comment');
  assert.ok(!/https?:\/\//.test(CODE), 'no URL in code — no portal fetch');
  assert.ok(!/\bfetch\s*\(/.test(CODE), 'the walker performs no HTTP fetch of its own');
});

test('(6b) the walker writes ZERO new SQL — it reuses the frozen strings only', () => {
  assert.ok(!/\bSELECT\b/i.test(CODE), 'no SELECT in this file');
  // The db13 tables the frozen queries touch — none of them may be named in this file's code.
  for (const table of ['individuals-prescriptions', 'test_values_view', 'test_digital_values_view', 'individuals', 'clinical_states']) {
    assert.ok(!new RegExp(`["'\`]\\s*${table}|FROM\\s+"?${table}`, 'i').test(CODE), `no reference to the ${table} table`);
  }
  assert.ok(/__sqlForTest\.prescriptionsSql/.test(CODE) && /__sqlForTest\.labsSql/.test(CODE), 'the frozen query builders are reused verbatim');
});

test('(6c) the reconstruct import is the frozen one, and NEVER the ccb dossier cache namesake', () => {
  assert.ok(/getMemberSnapshotAsOf/.test(SRC), 'the as-of reconstruct is the walker’s reconstruct');
  assert.ok(!/ccb-dossier-cache/.test(SRC), 'the ccb-dossier-cache getMemberSnapshot namesake is never imported');
  // The soft-catching sibling must not be used: it collapses throw into empty.
  assert.ok(!/\bgetMemberSnapshot\b(?!AsOf)/.test(CODE), 'the soft-failing getMemberSnapshot is never called');
});

test('(6d) identity: uhid resolves ONLY via bridgeUhidToIndividual, never a first-match', () => {
  assert.ok(/bridgeUhidToIndividual/.test(SRC));
  assert.ok(!/bridgeMemberIdToIndividuals/.test(CODE), 'the household-collapsing first-match resolver is never called');
  assert.ok(!/inds\[0\]/.test(CODE), 'no first-match pick');
  assert.ok(!/member_uid/.test(CODE), 'a clinical_states.member_uid is never touched by the walk');
});

test('(6e) resolveWalkSubject: a good uid passes, a bad one refuses, neither guesses', async () => {
  assert.deepEqual(await resolveWalkSubject({ individualUid: UID }), { individualUid: UID, reason: 'resolved' });
  assert.deepEqual(await resolveWalkSubject({ individualUid: 'x' }), { individualUid: null, reason: 'bad_input' });
  assert.deepEqual(await resolveWalkSubject({}), { individualUid: null, reason: 'bad_input' });
});

// ── labels + version (rendered verbatim by W0.2) ──────────────────────────────────────────────

test('the two always-visible labels are exactly the ratified strings', () => {
  assert.equal(GRAIN_LABEL, 'calendar day, same-day excluded');
  assert.equal(HONESTY_CHIP, 'dated by clinical date; result-availability lag not modeled');
  assert.equal(WORLD_MODEL_WALK_VERSION, 'world-model-walk-o/0.1');
});

test('enumerateCutDates: distinct, sorted, malformed dates dropped and never guessed', async () => {
  const dates = await enumerateCutDates(UID, COMPUTED_AT, fakeQuery(
    [{ uid: 'p1', visit_date: '2026-02-01' }, { uid: 'p2', visit_date: '2026-02-01' }, { uid: 'p3', visit_date: '' }],
    [{ booking_id: 'b1', test_date: 'not-a-date', investigation_name: 'X', value: '1' }],
  ));
  assert.deepEqual(dates, ['2026-02-01'], 'deduped, sorted, and the undated evidence is dropped');
});
