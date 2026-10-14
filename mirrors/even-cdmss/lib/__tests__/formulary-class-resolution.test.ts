/**
 *   node --test --import tsx lib/__tests__/formulary-class-resolution.test.ts
 *
 * FORMULARY-CLASS-RESOLUTION PRD v1.0 (2 Aug 2026, V ruled §6(b)) — per-molecule class fallback.
 *
 * The whole-string generic lookup could not see a molecule inside a combination the formulary
 * lacks as a composition row: 'Cefpodoxime Proxetil+Clavulanic Acid' resolved (source-generic,
 * trusted) with NO class — 181/744 antibiotic lines a month — and the engine proceeded as though
 * no antibiotic was on the note. The fallback splits on '+', normalises each fragment and keeps
 * EVERY class found. data/formulary-2026.json gains no rows; the defect was in the matcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichOpdMeds } from '../formulary.ts';
import { noAntibioticClassOnNote, OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core.ts';
import type { OpdMed, DeidOpdCase } from '../opd-ingest-core.ts';

function enrich(generic: string): OpdMed {
  const meds: OpdMed[] = [{ generic }];
  enrichOpdMeds(meds);
  return meds[0];
}
const mkCase = (meds: OpdMed[]): DeidOpdCase => ({
  consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
  impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: meds,
  investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · MEASURED TARGETS — previously class-less lines now resolve to a class containing Antibiotic
// ═════════════════════════════════════════════════════════════════════════════════════════════

const NEW_TARGETS = [
  'Cefpodoxime Proxetil+Clavulanic Acid',                    // 60 lines/mo — the case that started this
  'Azithromycin 500 Mg',                                     // 21
  'Rifaximin 550 Mg',                                        // 22
  'Fluconazole+Azithromycin+Secnidazole',                    // 29
  'Norfloxacin+Tinidazole',                                  // 6
  'Cefuroxime Axetil+Potassium Clavulanate (500Mg+125Mg)',   // 2
];

test('every measured target resolves to a class containing Antibiotic, with the [0] invariant', () => {
  for (const generic of NEW_TARGETS) {
    const m = enrich(generic);
    assert.ok(m.therapeuticClasses && m.therapeuticClasses.length > 0, `${generic}: classes attached`);
    assert.ok(m.therapeuticClasses!.some((c) => /antibiotic/i.test(c)), `${generic}: a class contains Antibiotic`);
    assert.equal(m.therapeuticClass, m.therapeuticClasses![0], `${generic}: therapeuticClass === therapeuticClasses[0]`);
  }
});

test('the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment', () => {
  const m = enrich('Cefpodoxime Proxetil+Clavulanic Acid');
  assert.deepEqual(m.therapeuticClasses, ['Antibiotic', 'Antibiotic'], 'both fragments resolve');
  assert.equal(m.therapeuticClass, 'Antibiotic');
  assert.equal(m.subClass, 'Cephalosporin (3rd gen oral)', 'minor from the FIRST resolving fragment');
});

// ⚠️ PRD DEVIATION, prominent: §"MEASURED TARGETS" expected THREE classes here. Secnidazole has NO
// row in data/formulary-2026.json (it appears only inside LASA confusable lists on Ornidazole
// rows), and the PRD forbids adding rows — the formulary is a hospital artefact. Two classes is
// the only lawful resolution; a third requires the hospital adding Secnidazole to the formulary.
test('the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)', () => {
  const m = enrich('Fluconazole+Azithromycin+Secnidazole');
  assert.deepEqual(m.therapeuticClasses, ['Antifungal', 'Antibiotic']);
  assert.equal(m.therapeuticClass, 'Antifungal', 'first resolving fragment leads');
  assert.ok(m.therapeuticClasses!.includes('Antibiotic'), 'the buried azithromycin is visible');
});

test('a bracketed strength group can never split the line', () => {
  // '(500Mg+125Mg)' contains '+' — brackets are stripped BEFORE the split, so the fragments are
  // the two molecules, never 'Potassium Clavulanate (500Mg' / '125Mg)'.
  const m = enrich('Cefuroxime Axetil+Potassium Clavulanate (500Mg+125Mg)');
  assert.equal(m.therapeuticClass, 'Antibiotic');
  assert.equal(m.subClass, 'Cephalosporin (2nd gen)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · REGRESSION — whole-string resolution is untouched and still wins
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the four regression lines keep resolving exactly as today', () => {
  const expected: [string, string, string][] = [
    ['Azithromycin', 'Antibiotic', 'Macrolide'],
    ['Amoxicillin+Potassium Clavulanate(Clavulanic Acid)', 'Antibiotic', 'Penicillin (Aminopenicillin)'],
    ['Cefuroxime', 'Antibiotic', 'Cephalosporin (2nd gen)'],
    ['Cefixime', 'Antibiotic', 'Cephalosporin (3rd gen oral)'],
  ];
  for (const [generic, major, minor] of expected) {
    const m = enrich(generic);
    assert.equal(m.therapeuticClass, major, generic);
    assert.equal(m.subClass, minor, `${generic}: whole-string minor preserved — proves step 1 ran, not the fallback`);
    assert.deepEqual(m.therapeuticClasses, [major], `${generic}: single-class array mirrors the string`);
  }
});

test('a line resolving to no class anywhere carries neither field', () => {
  const m = enrich('Zzzunknownium Extract');
  assert.equal(m.therapeuticClass, undefined);
  assert.equal(m.therapeuticClasses, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The reader that failed — and the bump
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic', () => {
  const m = enrich('Cefpodoxime Proxetil+Clavulanic Acid');
  assert.equal(noAntibioticClassOnNote(mkCase([m])), false, 'the engine no longer believes no antibiotic is present');
  assert.equal(noAntibioticClassOnNote(mkCase([enrich('Zzzunknownium Extract')])), true, 'still true when nothing resolves');
});

test('this build\'s bump (0.81.20) stays in the read family, and the engine is current', () => {
  // The live version moved on (0.81.21, DETERMINISM-TRIO, 8 Aug 2026); what this build owns is that
  // 0.81.20 was bumped AND appended, so its notes stay readable — decision 21, the classic error.
  const fam = OPD_ENGINE_VERSIONS_CURRENT as readonly string[];
  assert.ok(fam.includes('opd-note-audit/0.81.20'), 'bump without the family append empties the read surfaces (decision 21)');
  assert.ok(fam.includes('opd-note-audit/0.81.19'), 'history stays readable');
  assert.ok(fam.includes(OPD_ENGINE_VERSION), 'whatever the current engine is, the family carries it');
});
