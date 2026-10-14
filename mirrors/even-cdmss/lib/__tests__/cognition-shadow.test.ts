/**
 * lib/__tests__/cognition-shadow.test.ts — the WM1 gate.
 *
 * OFFLINE BY CONSTRUCTION. There is no live Neon and no live db13 in this sandbox, so the sweep is
 * driven entirely through its injected seams (`SweepDeps`) — WM0's pattern. The policy and the
 * microworld are pure and need no seams at all.
 *
 * What these tests are really defending:
 *   · the budgets actually bind, WITHIN a batch as well as across runs;
 *   · every silence is named, and the names are distinct answers to distinct questions;
 *   · a throw and a null stay different o_statuses (the WM0 honesty contract, inherited);
 *   · the era is COMPUTED, and computed numerically — 0.81.17 beats 0.81.9;
 *   · a read failure stops the sweep cleanly instead of reporting a confident partial result;
 *   · nothing here writes a BeliefUpdate, and nothing is doctor-facing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { microworldOf, auditRowText, MATCH_RULE } from '../cognition/microworld';
import {
  decideBurden, eligibilityOf, BURDEN_PER_ELIGIBLE, PER_DOCTOR_DAILY_CAP,
} from '../cognition/burden-policy';
import {
  runShadowSweep, newestEra, annotateOStatus, SWEEP_BATCH, V0_TRIGGER_KIND,
  ERA_SQL, TRIGGER_SQL, GLOBAL_BUDGET_SQL, DOCTOR_BUDGET_SQL, INSERT_SQL,
} from '../cognition/shadow-sweep';
import { COGNITION_SCHEMA_VERSION, BURDEN_POLICY_VERSION } from '../cognition/schema';

const ERA = 'opd-note-audit/0.81.21';

// ── microworld ────────────────────────────────────────────────────────────────────────────────

test('microworld: the four spellings match, case-insensitively', () => {
  for (const s of ['Headache', 'severe HEADACHE', 'cephalgia', 'Cephalalgia', 'Migraine without aura']) {
    assert.equal(microworldOf(s), 'headache', s);
  }
});

test('microworld: everything else is `none`, and nothing throws', () => {
  for (const s of ['chest pain', '', null, undefined, 42, {}]) {
    assert.equal(microworldOf(s as unknown), 'none');
  }
});

test('microworld: MATCH_RULE is stamped and stable', () => {
  assert.equal(MATCH_RULE, 'headache-strict/1');
});

test('auditRowText: reads TEXT fields only, tolerates junk, never throws', () => {
  const findings = [
    { subject: 'Migraine prophylaxis', rationale: 'r1', evidence: ['e1'], estimates: ['x'], verdict: 'low-value' },
    null, 'garbage', { no_text: 1 },
  ];
  const suggestions = [{ priority: 1, text: 'consider a diary' }, {}];
  const txt = auditRowText(findings, suggestions);
  assert.match(txt, /Migraine prophylaxis/);
  assert.match(txt, /consider a diary/);
  assert.equal(microworldOf(txt), 'headache');
  assert.doesNotThrow(() => auditRowText('nonsense', null));
  assert.equal(auditRowText(null, null), '');
});

test('auditRowText: a verdict enum alone must NOT drag a note into the microworld', () => {
  // The blob-stringify shortcut would match on keys and enum values; this asserts we do not do that.
  const txt = auditRowText([{ verdict: 'low-value', domain: 'appropriateness', subject: 'chest pain' }], []);
  assert.equal(microworldOf(txt), 'none');
  assert.ok(!/verdict|domain/.test(txt), 'keys and enum values are not part of the matched text');
});

// ── eligibility: three refusals, checked most-structural-first ────────────────────────────────

test('eligibility: headache + doctor + current era ⇒ eligible', () => {
  assert.deepEqual(
    eligibilityOf({ microworld: 'headache', doctorUid: 'doc1', engineVersion: ERA, currentEra: ERA }),
    { eligible: true, reason: null });
});

test('eligibility: each refusal is named, and outranks the ones after it', () => {
  assert.equal(eligibilityOf({ microworld: 'none', doctorUid: null, engineVersion: 'old', currentEra: ERA }).reason,
    'not_microworld', 'outside the microworld wins over a missing doctor');
  assert.equal(eligibilityOf({ microworld: 'headache', doctorUid: '  ', engineVersion: 'old', currentEra: ERA }).reason,
    'no_doctor', 'a blank doctor_uid is no doctor');
  assert.equal(eligibilityOf({ microworld: 'headache', doctorUid: 'doc1', engineVersion: 'opd-note-audit/0.81.9', currentEra: ERA }).reason,
    'stale_era');
});

test('eligibility: a NULL current era fails CLOSED — nothing is current when we do not know', () => {
  const r = eligibilityOf({ microworld: 'headache', doctorUid: 'doc1', engineVersion: ERA, currentEra: null });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'stale_era');
});

// ── the burden policy ─────────────────────────────────────────────────────────────────────────

test('policy: asks only at the 10th eligible event, and never before', () => {
  for (let n = 0; n < BURDEN_PER_ELIGIBLE; n++) {
    const d = decideBurden({ eligible: true, globalEligibleSinceLastAsk: n, doctorAsksToday: 0 });
    assert.equal(d.wouldAsk, false, `n=${n} must not ask`);
    assert.equal(d.reason, 'budget_global');
    assert.equal(d.objective, null);
  }
  const d = decideBurden({ eligible: true, globalEligibleSinceLastAsk: BURDEN_PER_ELIGIBLE, doctorAsksToday: 0 });
  assert.equal(d.wouldAsk, true);
  assert.equal(d.objective, 'close_snapshot', 'the only objective reachable in v0');
  assert.equal(d.reason, 'would_ask');
});

test('policy: the per-doctor cap binds even when the global budget is earned', () => {
  const d = decideBurden({ eligible: true, globalEligibleSinceLastAsk: 999, doctorAsksToday: PER_DOCTOR_DAILY_CAP });
  assert.equal(d.wouldAsk, false);
  assert.equal(d.reason, 'budget_doctor', 'named distinctly from budget_global');
});

test('policy: ineligible carries the caller’s named reason through unchanged', () => {
  for (const reason of ['not_microworld', 'no_doctor', 'stale_era'] as const) {
    const d = decideBurden({ eligible: false, globalEligibleSinceLastAsk: 999, doctorAsksToday: 0, ineligibleReason: reason });
    assert.equal(d.wouldAsk, false);
    assert.equal(d.reason, reason);
  }
});

test('policy: EVERY decision carries a non-empty reason — no silent silences', () => {
  const cases = [
    { eligible: false, globalEligibleSinceLastAsk: 0, doctorAsksToday: 0 },
    { eligible: false, globalEligibleSinceLastAsk: 0, doctorAsksToday: 0, ineligibleReason: null },
    { eligible: true, globalEligibleSinceLastAsk: 0, doctorAsksToday: 0 },
    { eligible: true, globalEligibleSinceLastAsk: 99, doctorAsksToday: 9 },
    { eligible: true, globalEligibleSinceLastAsk: 99, doctorAsksToday: 0 },
  ];
  for (const c of cases) {
    const d = decideBurden(c);
    assert.ok(typeof d.reason === 'string' && d.reason.length > 0, JSON.stringify(c));
    assert.equal(d.wouldAsk, d.objective !== null, 'objective is set iff it would ask');
  }
});

// ── the era probe is COMPUTED, and numerically ────────────────────────────────────────────────

test('newestEra: 0.81.17 beats 0.81.9 (a lexicographic max would get this wrong)', () => {
  assert.equal(newestEra(['opd-note-audit/0.81.9', 'opd-note-audit/0.81.17']), 'opd-note-audit/0.81.17');
  assert.equal(newestEra(['opd-note-audit/0.81.21', 'opd-note-audit/0.81.3']), 'opd-note-audit/0.81.21');
});

test('newestEra: an empty or all-blank window is null, not a guess', () => {
  assert.equal(newestEra([]), null);
  assert.equal(newestEra([null, undefined, '  ']), null);
});

// ── the sweep ─────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const headacheFinding = [{ subject: 'Migraine', rationale: 'chronic headache' }];

/** A fake db that answers the sweep's five queries and records inserts. */
function fakeDb(opts: {
  era?: string[];
  triggers?: Row[];
  globalSeed?: number;
  doctorSeed?: Row[];
  failOn?: 'era' | 'trigger' | 'budget' | 'insert';
} = {}) {
  const inserts: unknown[][] = [];
  const query = async (text: string, params?: unknown[]): Promise<Row[]> => {
    if (text === ERA_SQL) {
      if (opts.failOn === 'era') throw new Error('era boom');
      return (opts.era ?? [ERA]).map((v) => ({ engine_version: v }));
    }
    if (text === TRIGGER_SQL) {
      if (opts.failOn === 'trigger') throw new Error('trigger boom');
      return opts.triggers ?? [];
    }
    if (text === GLOBAL_BUDGET_SQL) {
      if (opts.failOn === 'budget') throw new Error('budget boom');
      return [{ n: opts.globalSeed ?? 0 }];
    }
    if (text === DOCTOR_BUDGET_SQL) return opts.doctorSeed ?? [];
    if (text === INSERT_SQL) {
      if (opts.failOn === 'insert') throw new Error('insert boom');
      inserts.push(params ?? []);
      return [];
    }
    throw new Error(`unexpected query: ${text.slice(0, 40)}`);
  };
  return { query, inserts };
}

const trigger = (uid: string, doctor: string | null, findings: unknown = headacheFinding, engine = ERA): Row => ({
  uid, doctor_uid: doctor, engine_version: engine,
  audited_at: '2026-08-30T10:00:00.000Z', note_date: '2026-08-30T00:00:00.000Z',
  findings, suggestions: [],
});

const noAnnotate = {
  resolveIndividual: async () => 'ind_000001',
  reconstruct: async () => ({ version: 'member-state/1.2' }),
};

test('sweep: drained when there is nothing to judge', async () => {
  const db = fakeDb({ triggers: [] });
  const r = await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(r.ok, true);
  assert.equal(r.drained, true);
  assert.equal(r.scanned, 0);
  assert.equal(db.inserts.length, 0, 'a no-op run writes nothing');
});

test('sweep: the 1-in-10 budget binds WITHIN a single batch', async () => {
  // 25 eligible headache events, all distinct doctors so the per-doctor cap never binds.
  const triggers = Array.from({ length: 25 }, (_, i) => trigger(`u${i}`, `doc${i}`));
  const db = fakeDb({ triggers, globalSeed: 0 });
  const r = await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 25);
  assert.equal(r.eligible, 25);
  // Counter starts at 0, increments before the decision: asks at the 10th and the 20th.
  assert.equal(r.wouldAsk, 2, 'two asks in twenty-five eligible events, not twenty-five');
  assert.equal(r.written, 25, 'every event is recorded, asked or not');
});

test('sweep: the per-doctor cap binds within a batch — one doctor is not asked twice', async () => {
  const triggers = Array.from({ length: 25 }, (_, i) => trigger(`u${i}`, 'doc_solo'));
  const db = fakeDb({ triggers, globalSeed: 0 });
  const r = await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(r.wouldAsk, 1, 'the second earned ask is refused by the per-doctor cap');
  const reasons = db.inserts.map((p) => p[11]);
  assert.ok(reasons.includes('budget_doctor'), 'and the refusal is named budget_doctor');
});

test('sweep: the doctor seed from a previous run is respected', async () => {
  const triggers = Array.from({ length: 12 }, (_, i) => trigger(`u${i}`, 'doc_spent'));
  const db = fakeDb({ triggers, globalSeed: 0, doctorSeed: [{ doctor_uid: 'doc_spent', n: 1 }] });
  const r = await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(r.wouldAsk, 0, 'already asked today ⇒ no ask, even though the global budget is earned');
});

test('sweep: ineligible events are recorded with their named reason and never asked', async () => {
  const db = fakeDb({
    triggers: [
      trigger('u_none', 'doc1', [{ subject: 'chest pain' }]),   // not_microworld
      trigger('u_nodoc', null),                                  // no_doctor
      trigger('u_stale', 'doc1', headacheFinding, 'opd-note-audit/0.81.9'), // stale_era
    ],
    globalSeed: 999,
  });
  const r = await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(r.eligible, 0);
  assert.equal(r.wouldAsk, 0, 'a huge global budget cannot make an ineligible event askable');
  assert.deepEqual(db.inserts.map((p) => p[11]), ['not_microworld', 'no_doctor', 'stale_era']);
  assert.deepEqual(db.inserts.map((p) => p[12]), [null, null, null], 'o_status is only annotated on would-ask rows');
});

test('sweep: o_status is annotated on would-ask rows ONLY, and db13 is not touched otherwise', async () => {
  let annotations = 0;
  const triggers = Array.from({ length: 10 }, (_, i) => trigger(`u${i}`, `doc${i}`));
  const db = fakeDb({ triggers, globalSeed: 0 });
  const r = await runShadowSweep({
    query: db.query,
    resolveIndividual: async () => { annotations++; return 'ind_000001'; },
    reconstruct: async () => ({ version: 'member-state/1.2' }),
  });
  assert.equal(r.wouldAsk, 1);
  assert.equal(annotations, 1, 'ten events, one ask, exactly one db13 identity read');
  const asked = db.inserts.find((p) => p[9] === true)!;
  assert.equal(asked[12], 'ok');
  assert.equal(asked[10], 'close_snapshot');
});

// ── o_status: throw and null stay different answers (WM0's contract, inherited) ───────────────

test('annotateOStatus: null ⇒ no_prior_history, throw ⇒ context_fetch_failed — never collapsed', async () => {
  const nullish = await annotateOStatus('p1', '2026-08-30', 'now', {
    resolveIndividual: async () => 'ind_000001', reconstruct: async () => null,
  });
  const thrown = await annotateOStatus('p1', '2026-08-30', 'now', {
    resolveIndividual: async () => 'ind_000001', reconstruct: async () => { throw new Error('db13 down'); },
  });
  assert.equal(nullish, 'no_prior_history');
  assert.equal(thrown, 'context_fetch_failed');
  assert.notEqual(nullish, thrown, 'a fetch failure must never read as an empty history');
});

test('annotateOStatus: an unresolved presc is its OWN status, not a spine failure', async () => {
  assert.equal(await annotateOStatus('p1', '2026-08-30', 'now', {
    resolveIndividual: async () => null, reconstruct: async () => ({}),
  }), 'unresolved_identity');
  assert.equal(await annotateOStatus('p1', '2026-08-30', 'now', {
    resolveIndividual: async () => { throw new Error('bridge down'); }, reconstruct: async () => ({}),
  }), 'unresolved_identity');
});

test('annotateOStatus never throws, whatever the edges do', async () => {
  await assert.doesNotReject(() => annotateOStatus('p1', '2026-08-30', 'now', {
    resolveIndividual: async () => { throw new Error('x'); },
    reconstruct: async () => { throw new Error('y'); },
  }));
});

// ── failure posture: report and stop cleanly, never a partial pretending to be complete ───────

for (const stage of ['era', 'trigger', 'budget'] as const) {
  test(`sweep: a ${stage} read failure stops cleanly with a named error and writes nothing`, async () => {
    const db = fakeDb({ triggers: [trigger('u1', 'doc1')], failOn: stage, globalSeed: 0 });
    const r = await runShadowSweep({ query: db.query, ...noAnnotate });
    assert.equal(r.ok, false);
    assert.match(String(r.error), new RegExp(`^${stage === 'era' ? 'era_probe' : stage === 'trigger' ? 'trigger_read' : 'budget_seed'}_failed`));
    assert.equal(r.written, 0);
    assert.equal(db.inserts.length, 0);
  });
}

test('sweep: an insert failure stops the batch — budgets already spent are not re-decided', async () => {
  const db = fakeDb({ triggers: [trigger('u1', 'doc1')], failOn: 'insert', globalSeed: 999 });
  const r = await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^insert_failed at u1/);
  assert.equal(r.written, 0);
});

test('sweep: never throws, whatever the database does', async () => {
  await assert.doesNotReject(async () => {
    const r = await runShadowSweep({ query: async () => { throw new Error('everything is down'); } });
    assert.equal(r.ok, false);
  });
});

test('sweep: versions and budgets are reported with every run', async () => {
  const r = await runShadowSweep({ query: fakeDb({ triggers: [] }).query });
  assert.equal(r.policyVersion, BURDEN_POLICY_VERSION);
  assert.equal(r.schemaVersion, COGNITION_SCHEMA_VERSION);
  assert.deepEqual(r.budgets, { perEligible: BURDEN_PER_ELIGIBLE, perDoctorDaily: PER_DOCTOR_DAILY_CAP });
  assert.equal(BURDEN_POLICY_VERSION, 'burden-policy/0.1');
  assert.equal(COGNITION_SCHEMA_VERSION, 'cognition/0.1');
});

test('sweep: v0 writes only the opd trigger kind, bounded at 200', async () => {
  assert.equal(V0_TRIGGER_KIND, 'opd_note_audited');
  assert.equal(SWEEP_BATCH, 200);
  const db = fakeDb({ triggers: [trigger('u1', 'doc1')], globalSeed: 999 });
  await runShadowSweep({ query: db.query, ...noAnnotate });
  assert.equal(db.inserts[0][1], 'opd_note_audited');
});

// ── posture: shadow only, no belief writes, no even-elo ───────────────────────────────────────

const SRC = {
  sweep: readFileSync(join(process.cwd(), 'lib/cognition/shadow-sweep.ts'), 'utf8'),
  schema: readFileSync(join(process.cwd(), 'lib/cognition/schema.ts'), 'utf8'),
  page: readFileSync(join(process.cwd(), 'app/admin/observability/world-model/shadow/page.tsx'), 'utf8'),
  route: readFileSync(join(process.cwd(), 'app/api/admin/shadow-sweep/route.ts'), 'utf8'),
};
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('no BeliefUpdate is ever written — the type exists, the table does not', () => {
  assert.match(SRC.schema, /interface BeliefUpdate/, 'the type is declared');
  for (const [name, src] of Object.entries(SRC)) {
    if (name === 'schema') continue;
    assert.ok(!/BeliefUpdate/.test(strip(src)), `${name} must not touch BeliefUpdate`);
  }
  assert.ok(!/belief_updates/i.test(strip(SRC.sweep)), 'no belief table is written');
});

test('nothing here reaches even-elo, and no login-audit line is crossed', () => {
  for (const [name, src] of Object.entries(SRC)) {
    assert.ok(!/even-elo|evenElo|even_elo/i.test(src), `${name} must not mention even-elo`);
  }
});

test('the sweep touches no frozen module and writes to exactly one table', () => {
  const code = strip(SRC.sweep);
  assert.ok(!/INSERT INTO (?!cognition_shadow_events)/.test(code), 'one insert target only');
  assert.ok(!/\b(UPDATE|DELETE|DROP|ALTER)\b/.test(code), 'the sweep updates, deletes and alters nothing');
  assert.ok(/getMemberSnapshotAsOf/.test(code), 'the frozen as-of reconstruct is what annotates o_status');
  assert.ok(!/ccb-dossier-cache/.test(SRC.sweep), 'never the same-name getMemberSnapshot from the dossier cache');
  assert.ok(!/\bgetMemberSnapshot\b(?!AsOf)/.test(code), 'the soft-failing sibling is never called');
});

test('the shadow-only sentence is present, verbatim, on the page and the route', () => {
  const sentence = 'Shadow only — no doctor has seen or will see these.';
  assert.ok(SRC.page.includes(sentence), 'the page states it');
  assert.ok(SRC.route.includes(sentence), 'and so does the API response');
});
