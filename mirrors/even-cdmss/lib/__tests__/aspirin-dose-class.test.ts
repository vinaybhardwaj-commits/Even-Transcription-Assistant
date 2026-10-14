// Unit A — dose-aware aspirin class (DETERMINISM-TRIO PRD v1.0 §2, engine opd-note-audit/0.81.21).
//
// THE DEFECT: tagsFor (lib/ddi-tags.ts:45) tagged aspirin `nsaid` BY NAME at any dose, and
// ddiFindings promoted any NSAID-molecule line to major 'NSAID', so aspirin 75 mg — antiplatelet
// therapy, not analgesia — fired `nsaid × ace_arb` beside an ARB and docked the note's score.
// Metamorphic relation D-7 pinned it from 0.81.17 until this build.
//
// THE FIX: aspirinMaxDailyMg sums perUnitMg × units × (scheduled + sosCap) over every
// aspirin-carrying line USING THE ONE DOSE MACHINERY (lib/dose-aggregation-core.ts — no second
// parser exists), ddiFindings marks a line at ≤ 100 mg/day (D-1) or unparseable (D-2)
// `suppressNsaid`, and tagInteractions drops the `nsaid` tag from such an item after tagsFor.
//
// EVERY ROW OF PRD §2.3 IS A TEST BELOW, named for its row. Plus: order invariance (G-1 stays
// green) and a non-aspirin NSAID pair byte-identical to before the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddiFindings, aspirinMaxDailyMg, ASPIRIN_ANTIPLATELET_MAX_MG } from '../opd-note-audit';
import { tagInteractions } from '../ddi-tags';
import type { DrugClass } from '../ddi';
import type { OpdMed } from '../opd-ingest-core';

const med = (generic: string, over: Partial<OpdMed> = {}): OpdMed => ({
  generic, resolvedGeneric: generic, formularyMatch: 'source-generic',
  strength: '10 mg', dose: '1 tablet', frequency: 'OD', duration: '30 days', route: 'oral', ...over,
});
const aspirin = (over: Partial<OpdMed> = {}): OpdMed =>
  med('Aspirin', { strength: '75 mg', frequency: 'OD', therapeuticClass: 'Antiplatelet', ...over });
const telmisartan = med('Telmisartan', { strength: '40 mg', therapeuticClass: 'Antihypertensive' });
const subjects = (fs: { subject: string }[]) => fs.map((f) => f.subject).sort();

// ── the dose helper itself (D-1a: MAXIMUM possible daily mg = scheduled + SOS ceiling) ──────────
test('aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day', () => {
  assert.equal(aspirinMaxDailyMg([aspirin()]), 75);                                        // 75 OD
  assert.equal(aspirinMaxDailyMg([aspirin({ strength: '650 mg', frequency: 'TDS' })]), 1950);
  assert.equal(aspirinMaxDailyMg([aspirin({ strength: '75 mg', dose: '2 tablet' })]), 150);
  assert.equal(aspirinMaxDailyMg([aspirin({ strength: '75 mg', frequency: '1-0-1' })]), 150);
  // D-1a — SOS is a CEILING and is INCLUDED: 650 mg SOS max TDS compares as 1950, analgesic intent.
  assert.equal(aspirinMaxDailyMg([aspirin({ strength: '650 mg', frequency: 'SOS max 3' })]), 1950);
  // summed ACROSS lines (a molecule's daily total is a property of the prescription, not one line)
  assert.equal(aspirinMaxDailyMg([aspirin(), aspirin({ strength: '75 mg' })]), 150);
  // no aspirin on the script at all → null (no dose to compare); no caller can misread it
  assert.equal(aspirinMaxDailyMg([telmisartan]), null);
});

test('aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null', () => {
  assert.equal(aspirinMaxDailyMg([aspirin({ strength: undefined, dose: undefined })]), null);   // no strength
  assert.equal(aspirinMaxDailyMg([aspirin({ frequency: 'as directed' })]), null);               // unknown frequency
  assert.equal(aspirinMaxDailyMg([aspirin({ frequency: undefined })]), null);
  assert.equal(aspirinMaxDailyMg([aspirin({ generic: 'Aspirin syrup', resolvedGeneric: 'Aspirin syrup' })]), null);  // volumetric
  // one bad line poisons the total even when another parses — absence of data never accuses
  assert.equal(aspirinMaxDailyMg([aspirin({ strength: '650 mg', frequency: 'TDS' }), aspirin({ frequency: 'as directed' })]), null);
});

test('acetylsalicylic acid is the same molecule as aspirin', () => {
  const asa = med('Acetylsalicylic Acid', { strength: '75 mg', therapeuticClass: 'Antiplatelet' });
  assert.equal(aspirinMaxDailyMg([asa]), 75);
  assert.deepEqual(ddiFindings([asa, telmisartan]), []);
});

// ── PRD §2.3, row by row ────────────────────────────────────────────────────────────────────────
test('§2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))', () => {
  assert.deepEqual(ddiFindings([aspirin(), telmisartan]), []);
});

test('§2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged', () => {
  const clopidogrel = med('Clopidogrel', { strength: '75 mg', therapeuticClass: 'Antiplatelet' });
  const fs = ddiFindings([aspirin(), clopidogrel]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Interaction (moderate): Aspirin + Clopidogrel');
  assert.match(fs[0].rationale, /Dual antiplatelet therapy/);
});

test('§2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged', () => {
  const enoxaparin = med('Enoxaparin', { strength: '40 mg', therapeuticClass: 'Anticoagulant' });
  const fs = ddiFindings([aspirin(), enoxaparin]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Interaction (major): Aspirin + Enoxaparin');
  assert.equal(fs[0].verdict, 'low-value');
});

test('§2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs', () => {
  const diclofenac = med('Diclofenac', { strength: '50 mg', frequency: 'BD', therapeuticClass: 'NSAID' });
  const fs = ddiFindings([aspirin(), diclofenac]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Interaction (moderate): Aspirin + Diclofenac');
  assert.match(fs[0].rationale, /Antiplatelet \+ NSAID — increased GI bleeding risk\./);
  assert.doesNotMatch(fs[0].rationale, /Two NSAIDs/);
});

test('§2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100', () => {
  const fs = ddiFindings([aspirin({ strength: '650 mg', frequency: 'TDS' }), telmisartan]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Interaction (moderate): Aspirin + Telmisartan');
  assert.match(fs[0].rationale, /NSAID \+ ACE-I\/ARB/);
});

test('§2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)', () => {
  assert.deepEqual(ddiFindings([aspirin({ strength: undefined, dose: undefined }), telmisartan]), []);
  assert.deepEqual(ddiFindings([aspirin({ frequency: 'as directed' }), telmisartan]), []);
});

test('§2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)', () => {
  const fs = ddiFindings([aspirin({ strength: '150 mg' }), telmisartan]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Interaction (moderate): Aspirin + Telmisartan');
});

test('the threshold is INCLUSIVE at 100 mg/day and exclusive above it', () => {
  assert.equal(ASPIRIN_ANTIPLATELET_MAX_MG, 100);
  assert.deepEqual(ddiFindings([aspirin({ strength: '100 mg' }), telmisartan]), []);
  assert.equal(ddiFindings([aspirin({ strength: '101 mg' }), telmisartan]).length, 1);
  // the total is what is compared, not the per-unit strength: 75 mg BD = 150 → still an NSAID
  assert.equal(ddiFindings([aspirin({ frequency: 'BD' }), telmisartan]).length, 1);
});

// ── invariance + scope guard ────────────────────────────────────────────────────────────────────
test('med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)', () => {
  const low = [aspirin(), telmisartan];
  assert.deepEqual(ddiFindings(low), ddiFindings([...low].reverse()));
  const high = [aspirin({ strength: '650 mg', frequency: 'TDS' }), telmisartan];
  assert.deepEqual(ddiFindings(high), ddiFindings([...high].reverse()));
  // three lines, two aspirin products stacking over the cutoff — still order-independent
  const stacked = [aspirin(), aspirin({ strength: '75 mg' }), telmisartan];
  assert.deepEqual(subjects(ddiFindings(stacked)), subjects(ddiFindings([...stacked].reverse())));
});

test('scope guard: a non-aspirin NSAID pair is byte-identical to before the change', () => {
  const ibuprofen = med('Ibuprofen', { strength: '400 mg', frequency: 'TDS', therapeuticClass: 'NSAID' });
  const diclofenac = med('Diclofenac', { strength: '50 mg', frequency: 'BD', therapeuticClass: 'NSAID' });
  const warfarin = med('Warfarin', { strength: '5 mg', therapeuticClass: 'Anticoagulant' });

  const nsaidArb = ddiFindings([ibuprofen, telmisartan]);
  assert.deepEqual(nsaidArb, [{
    subject: 'Interaction (moderate): Ibuprofen + Telmisartan',
    verdict: 'context-dependent', confidence: 0.6, domain: 'prescribing_safety',
    rationale: 'NSAID + ACE-I/ARB — reduced renal perfusion, AKI risk (worse if also on a diuretic — “triple whammy”). Avoid the NSAID; monitor renal function.',
    evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    provenance: { citation: { source: 'pubmed', book: 'Lit-BMJ', chapter: null, section: null, page_start: null, page_end: null }, derivation: 'external' },
  }]);
  assert.equal(ddiFindings([ibuprofen, diclofenac])[0].subject, 'Interaction (moderate): Diclofenac + Ibuprofen');
  assert.match(ddiFindings([ibuprofen, diclofenac])[0].rationale, /Two NSAIDs/);
  assert.equal(ddiFindings([ibuprofen, warfarin])[0].subject, 'Interaction (major): Ibuprofen + Warfarin');
});

test('a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule', () => {
  // Aspirin 75 + Diclofenac 50 in ONE product: the diclofenac makes it an NSAID line whatever the
  // aspirin dose, so the pair with an ARB must still fire (the PRD's subject is aspirin alone).
  const combo = med('Aspirin+Diclofenac', { strength: '75 mg+50 mg', frequency: 'OD' });
  const fs = ddiFindings([combo, telmisartan]);
  assert.equal(fs.length, 1);
  assert.match(fs[0].rationale, /NSAID \+ ACE-I\/ARB/);
});

// ── the tagger contract (step 3): the field is honoured, `antiplatelet` is never removed ────────
test('tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives', () => {
  const asp = (over: Partial<DrugClass> = {}): DrugClass => ({ name: 'Aspirin', major: 'Antiplatelet', minor: '', ...over });
  const arb: DrugClass = { name: 'Telmisartan', major: 'Antihypertensive', minor: '' };
  const enox: DrugClass = { name: 'Enoxaparin', major: 'Anticoagulant', minor: '' };
  // without the field, behaviour is exactly as before (aspirin is `nsaid` by name)
  assert.equal(tagInteractions([asp(), arb]).length, 1);
  // with it, the ARB pair goes silent…
  assert.deepEqual(tagInteractions([asp({ suppressNsaid: true }), arb]), []);
  // …and the anticoagulant pair, which rides `antiplatelet`, is untouched
  const withAnticoag = tagInteractions([asp({ suppressNsaid: true }), enox]);
  assert.equal(withAnticoag.length, 1);
  assert.equal(withAnticoag[0].severity, 'major');
  assert.match(withAnticoag[0].mechanism, /Anticoagulant \+ antiplatelet/);
  // the field also covers the FORMULARY route into the tag, not just the name list
  assert.deepEqual(tagInteractions([{ name: 'Aspirin', major: 'NSAID', minor: '', suppressNsaid: true }, arb]), []);
});
