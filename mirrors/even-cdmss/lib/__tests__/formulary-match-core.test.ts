/**
 *   node --experimental-strip-types --test lib/__tests__/formulary-match-core.test.ts
 * Pure brand→generic+class resolver (formulary-match-core).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDrugName, buildFormularyMatcher, classifyUnmatched, normalizeDosageForm, type FormularyRow,
} from '../formulary-match-core.ts';

// ── Dosage-form normaliser (0.81.11, Matcher-Scoping Audit Stage 1) ──
test('normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary', () => {
  assert.equal(normalizeDosageForm('Tablet 10 MG'), 'tablet');
  assert.equal(normalizeDosageForm('Capsule .'), 'capsule');
  assert.equal(normalizeDosageForm('Syrup 100 ML'), 'syrup');
  assert.equal(normalizeDosageForm('Suspension'), 'syrup');
  assert.equal(normalizeDosageForm('Injection'), 'injection');
  assert.equal(normalizeDosageForm('Vial 1 GM'), 'injection');
  assert.equal(normalizeDosageForm('Cream 20 GM'), 'topical');
  assert.equal(normalizeDosageForm('Ointment'), 'topical');
  assert.equal(normalizeDosageForm('Eye Drops'), 'drops');
  assert.equal(normalizeDosageForm('Ear/Eye Drop'), 'drops');
  assert.equal(normalizeDosageForm('Drops 10 ML'), 'drops');   // plural, no eye/ear keyword (Stage-1 fix)
  assert.equal(normalizeDosageForm('Infusion 500 ML'), 'injection');   // IV infusion → injection (Stage-1 fix)
  // most-specific rule wins: a rotacap is an inhaler, not a capsule
  assert.equal(normalizeDosageForm('Rotacaps 250 MCG'), 'inhaler');
  assert.equal(normalizeDosageForm('Respule'), 'inhaler');
  assert.equal(normalizeDosageForm('Inhaler'), 'inhaler');
  // junk / unmapped → other (never throws)
  assert.equal(normalizeDosageForm('.'), 'other');
  assert.equal(normalizeDosageForm(''), 'other');
  assert.equal(normalizeDosageForm(undefined), 'other');
  assert.equal(normalizeDosageForm('Sachet'), 'other');
  assert.equal(normalizeDosageForm('Kit'), 'other');
});

const ROWS: FormularyRow[] = [
  { brand: 'ECOSPRIN', generic: 'Aspirin', generic_canon: 'Aspirin', major: 'Antiplatelet', schedule_dc: 'H', lasa: 'Clopidogrel', ved: 'E' },
  { brand: 'ECOSPRIN AV', generic: 'Atorvastatin+Aspirin', generic_canon: 'Atorvastatin+Aspirin', major: 'Antihyperlipidemic', schedule_dc: 'H' },
  { brand: 'GLYCOMET', generic: 'Metformin', generic_canon: 'Metformin', major: 'Antidiabetic', schedule_dc: 'H' },
  { brand: 'GLYCOMET GP1', generic: 'Metformin+Glimepiride', generic_canon: 'Metformin+Glimepiride', major: 'Antidiabetic', schedule_dc: 'H' },
  { brand: 'WYSOLONE DT 10MG TAB', generic: 'Prednisolone', generic_canon: 'Prednisolone', major: 'Corticosteroid', schedule_dc: 'H' },
  { brand: 'LONOPIN 20MG INJ', generic: 'Enoxaparin', generic_canon: 'Enoxaparin', major: 'Anticoagulant', schedule_dc: 'H1', high_risk: true, lasa: 'Heparin', ved: 'V' },
  { brand: 'PARACIP', generic: 'Paracetamol', generic_canon: 'Paracetamol', major: 'Analgesic / Antipyretic', schedule_dc: 'OTC' },
  { brand: 'ZERODOL P', generic: 'Aceclofenac+Paracetamol', generic_canon: 'Aceclofenac+Paracetamol', major: 'NSAID', schedule_dc: 'OTC' },
  { brand: 'MORPHINE 10MG INJ', generic: 'Morphine', generic_canon: 'Morphine', major: 'Opioid analgesic', schedule_dc: 'X', high_risk: true, ved: 'V' },
];
const M = buildFormularyMatcher(ROWS);

test('normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix', () => {
  assert.equal(normalizeDrugName('Ecosprin Tab 150mg'), 'ecosprin');
  assert.equal(normalizeDrugName('Glycomet 500mg'), 'glycomet');
  assert.equal(normalizeDrugName('Pantocid DSR Tab'), 'pantocid dsr');           // DSR kept
  assert.equal(normalizeDrugName('UV Doux Sunscreen Gel SPF 50 | Oil-Free'), 'uv doux sunscreen'); // | tail + gel + spf dropped
});

test('brand-exact resolves the molecule + class + schedule (confident)', () => {
  const r = M.resolve({ brand: 'Ecosprin 75mg' })!;
  assert.equal(r.generic, 'Aspirin');
  assert.equal(r.matchType, 'brand-exact');
  assert.equal(r.confident, true);
  assert.equal(r.major, 'Antiplatelet');
  assert.equal(r.schedule, 'H');
  assert.deepEqual(r.lasa, ['Clopidogrel']);
});

test('brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)', () => {
  const r = M.resolve({ brand: 'Wysolone Tab 10mg' })!;
  assert.equal(r.generic, 'Prednisolone');
  assert.equal(r.matchType, 'brand-token');
  assert.equal(r.confident, true);
});

test('embedded-generic recovers a molecule named verbatim — and NOT a combination canon', () => {
  const r = M.resolve({ brand: 'Paracetamol Syrup 250mg Calpol' })!;
  assert.equal(r.generic, 'Paracetamol');           // not "Aceclofenac+Paracetamol"
  assert.equal(r.matchType, 'embedded-generic');
  assert.equal(r.confident, true);
});

test('brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule', () => {
  const r = M.resolve({ brand: 'Ecosprin Gold 10' })!;
  assert.equal(r.generic, 'Aspirin');               // prefixed by ECOSPRIN
  assert.equal(r.matchType, 'brand-prefix');
  assert.equal(r.confident, false);
});

test('an ambiguous brand family (different canons) does NOT brand-token; exact still wins', () => {
  const r = M.resolve({ brand: 'Glycomet 500mg' })!;     // exact → Metformin (GLYCOMET / GLYCOMET GP1 diverge)
  assert.equal(r.generic, 'Metformin');
  assert.equal(r.matchType, 'brand-exact');
});

test('source-generic is trusted as-is (confident)', () => {
  const r = M.resolve({ generic: 'Amlodipine' })!;
  assert.equal(r.generic, 'Amlodipine');
  assert.equal(r.matchType, 'source-generic');
  assert.equal(r.confident, true);
});

test('high-alert + schedule X carried through', () => {
  const lono = M.resolve({ brand: 'Lonopin 20mg inj' })!;
  assert.equal(lono.generic, 'Enoxaparin');
  assert.equal(lono.highAlert, true);
  assert.equal(lono.schedule, 'H1');
  const morph = M.resolve({ brand: 'Morphine 10mg Inj' })!;
  assert.equal(morph.schedule, 'X');
  assert.equal(morph.highAlert, true);
});

test('unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary', () => {
  assert.equal(M.resolve({ brand: 'UV Doux Sunscreen Gel SPF 50' }), null);
  assert.equal(classifyUnmatched('UV Doux Sunscreen Gel SPF 50'), 'nutraceutical-cosmetic');
  assert.equal(classifyUnmatched('Zoxan TZ'), 'non-formulary');
  assert.equal(M.resolve({}), null);
});

test('BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)', () => {
  // The antibiotic COMBO appears BEFORE the mono row (worst case for first-write-wins).
  const rows: FormularyRow[] = [
    { brand: 'PANTOCID HP KIT', generic_canon: 'Amoxycillin+Pantoprazole+Clarithromycin', major: 'Antibiotic', minor: 'Macrolide', schedule_dc: 'H' },
    { brand: 'ETOVA MR', generic_canon: 'Etodolac+Thiocolchicoside', major: 'Muscle relaxant', minor: 'GABA-mimetic', schedule_dc: 'H' },
    { brand: 'PAN 40', generic_canon: 'Pantoprazole', major: 'Antisecretory', minor: 'PPI', schedule_dc: 'H' },
    { brand: 'ETOVA 400', generic_canon: 'Etodolac', major: 'NSAID', minor: 'Acetic acid', schedule_dc: 'H' },
  ];
  const M = buildFormularyMatcher(rows);
  // mono molecules resolve to their OWN class, not the combo's
  assert.equal(M.resolve({ generic: 'Pantoprazole' })!.major, 'Antisecretory');
  assert.equal(M.resolve({ generic: 'Etodolac' })!.major, 'NSAID');
  // the actual combination still resolves to the combo row
  assert.equal(M.resolve({ generic: 'Amoxycillin+Pantoprazole+Clarithromycin' })!.major, 'Antibiotic');
});
