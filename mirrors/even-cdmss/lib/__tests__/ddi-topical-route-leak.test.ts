/**
 *   node --test --import tsx lib/__tests__/ddi-topical-route-leak.test.ts
 *
 * DDI-TOPICAL-ROUTE-LEAK PRD v1.0 (2 Aug 2026, V ruled DEC-1…DEC-4).
 *
 * THE DEFECT: an oral NSAID beside a rub-on pain gel raised "Two NSAIDs — additive GI and renal
 * toxicity". Ten clinician reviews of that pairing returned ZERO true positives. A suppression for
 * exactly it shipped at engine 0.81.14 (Ruling 1) and did not fire, because the topical set was
 * built from resolveMedRoute alone — which INFERS the route from the drug NAME and INSTRUCTION and
 * therefore returns null for a topical product whose name carries no dosage-form word.
 * `Diclofenac + Linseed Oil + Menthol + Methyl Salicylate` is exactly that product.
 *
 * 62 findings leaked between 0.81.14 and 0.81.18. m.dosageForm, which comes from the formulary's
 * own `form` column rather than clinician text, closes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddiFindings } from '../opd-note-audit.ts';
import { resolveMedRoute } from '../opd-note-audit-core.ts';
import type { OpdMed } from '../opd-ingest-core.ts';

/** A confidently formulary-matched line. Fields omitted are genuinely absent. */
const med = (o: Partial<OpdMed> & { resolvedGeneric: string }): OpdMed => ({
  formularyMatch: 'source-generic', ...o,
} as OpdMed);

const ddi = (meds: OpdMed[]) => ddiFindings(meds).filter((f) => /^Interaction \(/.test(f.subject));

// The real product from the ledger — its NAME carries no dosage-form word, which is the whole point.
const REAL_GEL = 'Diclofenac+Linseed Oil+Menthol+Methyl Salicylate';
const oralNsaid = () => med({ resolvedGeneric: 'Aceclofenac', strength: '100 mg', frequency: 'BD', route: 'oral' });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The blind spot itself — the premise the fix rests on
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word', () => {
  const gel = med({ resolvedGeneric: REAL_GEL });
  assert.equal(resolveMedRoute(gel), null,
    'if this ever resolves, the leak closed by another route and this fix needs re-measuring');
  // …and it DOES resolve once a form word appears in the text, which is why the leak was partial.
  assert.equal(resolveMedRoute(med({ resolvedGeneric: REAL_GEL, instruction: 'apply locally' })), 'topical');
});

test('a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set', () => {
  // Observable through the suppression: with the gel in the set, Ruling 1 suppresses the pair.
  const gel = med({ resolvedGeneric: REAL_GEL, dosageForm: 'topical' });
  assert.equal(resolveMedRoute(gel), null, 'route still unresolvable — only dosageForm can see it');
  assert.deepEqual(ddi([oralNsaid(), gel]), [], 'the NSAID–NSAID pair is suppressed');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The real case, and the control that proves the test measures the NEW path
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction', () => {
  const found = ddi([oralNsaid(), med({ resolvedGeneric: REAL_GEL, dosageForm: 'topical' })]);
  assert.deepEqual(found, [], 'ten clinician reviews, zero true positives — this must not fire');
});

test('THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path', () => {
  // This is the pre-fix behaviour, preserved deliberately as the control. If this ever returns [],
  // the suppression is firing for some other reason and the test above proves nothing.
  const leaked = ddi([oralNsaid(), med({ resolvedGeneric: REAL_GEL })]);
  assert.equal(leaked.length, 1, 'without dosageForm there is no way to know the gel is topical');
  assert.match(leaked[0].subject, /Interaction \(/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · What must NOT change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('two ORAL NSAIDs still produce the finding, unchanged', () => {
  const found = ddi([
    oralNsaid(),
    med({ resolvedGeneric: 'Ibuprofen', strength: '400 mg', frequency: 'TDS', route: 'oral' }),
  ]);
  assert.equal(found.length, 1, 'a genuine oral-oral NSAID overlap is a real interaction');
  assert.ok(!/low systemic absorption/.test(found[0].rationale), 'and it is NOT de-escalated as topical');
});

test('drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)', () => {
  for (const form of ['drops', 'inhaler', 'injection', 'tablet', 'capsule', 'syrup', 'other'] as const) {
    const found = ddi([oralNsaid(), med({ resolvedGeneric: REAL_GEL, dosageForm: form })]);
    assert.equal(found.length, 1, `dosageForm '${form}' must NOT suppress — only 'topical' does`);
  }
});

test('resolveMedRoute === topical still qualifies on its own — the original path is intact', () => {
  // No dosageForm at all; the route comes from the EMR field, as it always did.
  assert.deepEqual(ddi([oralNsaid(), med({ resolvedGeneric: 'Diclofenac', route: 'topical' })]), []);
  // …and from an inferred form word, the other original path. NOTE the word must sit in
  // brand/generic/dose/instruction: resolveMedRoute's haystack is those four fields and does NOT
  // include resolvedGeneric — one more way the inference misses a topical it should catch.
  assert.deepEqual(ddi([oralNsaid(), med({ resolvedGeneric: 'Diclofenac', generic: 'Diclofenac Gel' })]), []);
  assert.deepEqual(ddi([oralNsaid(), med({ resolvedGeneric: 'Diclofenac', instruction: 'apply to the knee' })]), []);
  // The haystack gap itself, pinned: the SAME form word in resolvedGeneric alone does not resolve.
  assert.equal(resolveMedRoute(med({ resolvedGeneric: 'Diclofenac Gel' })), null,
    'resolvedGeneric is not part of the route haystack');
});

test('the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires', () => {
  // Ruling 1 is deliberately restricted. A topical NSAID with an anticoagulant is a real
  // interaction and must survive — widening the set must not have widened the suppression.
  const found = ddi([
    med({ resolvedGeneric: 'Warfarin', strength: '5 mg', frequency: 'OD', route: 'oral', therapeuticClass: 'Anticoagulant' }),
    med({ resolvedGeneric: 'Diclofenac', dosageForm: 'topical' }),
  ]);
  assert.equal(found.length, 1, 'NSAID + anticoagulant is not an NSAID–NSAID pair — it still fires');
});

test('a non-NSAID pair is unaffected — the QT rule still fires', () => {
  const found = ddi([
    med({ resolvedGeneric: 'Amiodarone', route: 'oral', therapeuticClass: 'Antiarrhythmic' }),
    med({ resolvedGeneric: 'Ondansetron', route: 'oral', therapeuticClass: 'Antiemetic' }),
  ]);
  assert.ok(found.length >= 1, 'a QT-prolongation pair has nothing to do with topical NSAIDs');
  // and it is untouched by the topical set even if an unrelated topical is on the script
  const withGel = ddi([
    med({ resolvedGeneric: 'Amiodarone', route: 'oral', therapeuticClass: 'Antiarrhythmic' }),
    med({ resolvedGeneric: 'Ondansetron', route: 'oral', therapeuticClass: 'Antiemetic' }),
    med({ resolvedGeneric: REAL_GEL, dosageForm: 'topical' }),
  ]);
  assert.ok(withGel.some((f) => /Amiodarone|Ondansetron/i.test(f.subject)), 'the QT pair survives');
});

test('fewer than two eligible meds still returns nothing', () => {
  assert.deepEqual(ddi([]), []);
  assert.deepEqual(ddi([med({ resolvedGeneric: REAL_GEL, dosageForm: 'topical' })]), []);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The change is exactly one predicate — no other behaviour moved
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the topical set reads BOTH sources, and Ruling 1 is byte-identical', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes("(resolveMedRoute(m) === 'topical' || m.dosageForm === 'topical')"),
    'the widened membership test');
  assert.ok(!/dosageForm === '(drops|inhaler|injection)'/.test(src), 'only topical was added');
  // Ruling 1's own predicate and its NSAID–NSAID restriction, unchanged:
  assert.ok(src.includes('return !(involvesTopical && bothNsaid);'), "Ruling 1's suppression is untouched");
  assert.ok(src.includes("const nsaidNames = new Set(items.filter((i) => i.major === 'NSAID').map((i) => i.name.toLowerCase()));"),
    'the NSAID–NSAID restriction is untouched');
});
