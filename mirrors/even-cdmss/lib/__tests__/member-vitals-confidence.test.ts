/**
 *   node --test --import tsx lib/__tests__/member-vitals-confidence.test.ts
 *
 * The VITALS factor of computePictureConfidence — follow-up to 56b42b0.
 *
 * THE DEFECT: the factor read `vitalsEver ? 'g' : inPerson > 0 ? 'a' : 'r'`. The amber branch
 * became UNREACHABLE when the modality source (general_practitioner_prescription__vitals) went
 * empty on 1 April 2026 — inPerson is 0 for every member — so every member without structured
 * vitals rendered RED. Red asserts we know there was no exam; with the modality unrecorded we do
 * not know. Same reasoning as D-B on the modality factor.
 *
 * A GENUINE remote-majority member (documented modality, inPerson 0) MUST STILL RENDER RED. That
 * case is known, not unknown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePictureConfidence, EMPTY_MODALITY, type ModalityMix } from '../member-state/present-augment.ts';

const NOW = '2026-08-02';

// Three fixtures. The first two mirror lib/__tests__/member-present.test.ts (documented === total);
// UNKNOWN_MODALITY is the NEW third case — added rather than editing either existing one, because
// neither of those is the unknown case and both must keep their current results.
const REMOTE_MODALITY: ModalityMix = {
  total: 8, counts: { NOT_POSSIBLE_IN_ONLINE_CONSULTATION: 1 }, documented: 8,
  inPerson: 0, remoteOrUndocumented: 8, majority: 'remote',
  lastAssessMode: 'NOT_POSSIBLE_IN_ONLINE_CONSULTATION', lastAssessAt: '2026-02-01',
};
const INPERSON_MODALITY: ModalityMix = {
  total: 3, counts: { IN_PERSON: 3 }, documented: 3,
  inPerson: 3, remoteOrUndocumented: 0, majority: 'in_person',
  lastAssessMode: 'IN_PERSON', lastAssessAt: '2026-07-12',
};
/** NEW: visits exist, but nothing recorded HOW they were assessed — the post-April reality. */
const UNKNOWN_MODALITY: ModalityMix = {
  total: 8, counts: { UNDOCUMENTED: 8 }, documented: 0,
  inPerson: 0, remoteOrUndocumented: 8, majority: 'unknown',
  lastAssessMode: 'UNDOCUMENTED', lastAssessAt: '2026-07-20',
};

const run = (vitalsEver: boolean, modalityMix: ModalityMix, opd = 8) => computePictureConfidence({
  lastContact: '2026-07-01', vitalsEver, modalityMix,
  lastLab: '2026-01-01', problems: [], encounters: { opd, ipd: 0 },
}, NOW);
const vitalsOf = (vitalsEver: boolean, m: ModalityMix, opd?: number) =>
  run(vitalsEver, m, opd).factors.find((f) => f.key === 'vitals')!;
const modalityOf = (vitalsEver: boolean, m: ModalityMix) =>
  run(vitalsEver, m).factors.find((f) => f.key === 'modality')!;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The four states of the vitals dot
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('vitalsEver true → GREEN with the unchanged label, whatever the modality', () => {
  for (const [name, m] of [['remote', REMOTE_MODALITY], ['in-person', INPERSON_MODALITY], ['unknown', UNKNOWN_MODALITY], ['empty', EMPTY_MODALITY]] as const) {
    const f = vitalsOf(true, m);
    assert.equal(f.dot, 'g', `green with ${name} modality`);
    assert.equal(f.label, 'Vitals measured (structured record)', `label unchanged with ${name} modality`);
  }
});

test('vitalsEver false + majority unknown → AMBER, with the new label', () => {
  const f = vitalsOf(false, UNKNOWN_MODALITY);
  assert.equal(f.dot, 'a', 'not knowing is not the same as knowing there was no exam');
  assert.equal(f.label, 'No structured vitals · how the member was assessed is not recorded');
  // the label must NOT state the certainty the amber is denying
  assert.ok(!/never measured/.test(f.label), 'an amber dot may not claim vitals were never measured');
});

test('vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today', () => {
  const f = vitalsOf(false, REMOTE_MODALITY);
  assert.equal(f.dot, 'r', 'a documented remote member is KNOWN, not unknown — it must not move');
  assert.equal(f.label, 'Vitals never measured (8 visits)');
});

test('vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today', () => {
  const f = vitalsOf(false, INPERSON_MODALITY, 3);
  assert.equal(f.dot, 'a');
  assert.equal(f.label, 'Vitals never measured (3 visits)');
});

test('the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)', () => {
  const f = vitalsOf(false, REMOTE_MODALITY, 0);
  assert.equal(f.dot, 'r');
  assert.equal(f.label, 'Vitals never measured', 'no parenthetical when there are no OPD visits');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · What must not move
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the vitals factor stays counted: true in every case', () => {
  for (const ever of [true, false]) {
    for (const m of [REMOTE_MODALITY, INPERSON_MODALITY, UNKNOWN_MODALITY, EMPTY_MODALITY]) {
      assert.equal(vitalsOf(ever, m).counted, true);
    }
  }
});

test('the MODALITY factor is unaffected in all four cases — this build did not touch it', () => {
  const expect: [ModalityMix, string, string][] = [
    [REMOTE_MODALITY, 'r', 'Care modality remote / undocumented · 0 in-person exam'],
    [INPERSON_MODALITY, 'g', 'Care modality in-person exam'],
    [UNKNOWN_MODALITY, 'a', 'Care modality not recorded'],
    [EMPTY_MODALITY, 'a', 'Care modality not recorded'],
  ];
  for (const [m, dot, label] of expect) {
    for (const ever of [true, false]) {
      const f = modalityOf(ever, m);
      assert.equal(f.dot, dot, `${m.majority} dot`);
      assert.equal(f.label, label, `${m.majority} label`);
      assert.equal(f.counted, true);
    }
  }
});

test('the contact and labs factors are unaffected', () => {
  const before = run(false, REMOTE_MODALITY);
  const after = run(false, UNKNOWN_MODALITY);
  for (const key of ['contact', 'labs'] as const) {
    const b = before.factors.find((f) => f.key === key)!;
    const a = after.factors.find((f) => f.key === key)!;
    assert.deepEqual({ dot: a.dot, label: a.label, counted: a.counted },
                     { dot: b.dot, label: b.label, counted: b.counted },
                     `${key} must not depend on the modality`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The source contract
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the unknown case is reachable through the OR, and remote is not', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('lib/member-state/present-augment.ts', 'utf8');
  assert.ok(src.includes("(input.modalityMix.inPerson > 0 || input.modalityMix.majority === 'unknown') ? 'a'"),
    'both amber routes, in one predicate');
  // the previously-unreachable branch is retained, not replaced — a member with a real in-person
  // exam and no structured vitals must still be amber if the modality source ever returns.
  assert.ok(src.includes('input.modalityMix.inPerson > 0'), 'the original amber route survives');
});
