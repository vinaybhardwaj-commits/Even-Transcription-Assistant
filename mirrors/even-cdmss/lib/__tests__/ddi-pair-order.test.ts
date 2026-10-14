// DDI pair-order canonicalisation (G-1 fix, 1 Aug 2026) — the same two drugs in EITHER input
// order must produce an IDENTICAL finding_ref (and stable_ref). That identity is the triage
// instance address: before this fix, an EMR that reordered medication lines changed
// "Interaction (major): A + B" to "… B + A" and orphaned the note's triage rows on re-audit
// (metamorphic relation G-1, surfaced by the suite at f816f34).
//
// Scope guard: ONLY the order of the two names may change. Which pairs fire, severity, mechanism,
// recommendation, verdict, confidence, rationale, source and provenance must be byte-identical
// between input orders — asserted below by deep-comparing whole findings, not just refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curatedInteractions, classInteractions, mergeRank, type DrugClass } from '../ddi';
import { tagInteractions, orderPair, normDrugName } from '../ddi-tags';
import { ddiFindings } from '../opd-note-audit';
import { stampFindingIdentity } from '../opd-note-audit-core';
import type { OpdMed } from '../opd-ingest-core';

const med = (generic: string, over: Partial<OpdMed> = {}): OpdMed => ({
  generic, resolvedGeneric: generic, formularyMatch: 'source-generic',
  strength: '10 mg', dose: '1 tablet', frequency: 'OD', duration: '5 days', route: 'oral', ...over,
});
const dc = (name: string, major = ''): DrugClass => ({ name, major, minor: '' });

test('orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey', () => {
  assert.deepEqual(orderPair('Warfarin', 'Ibuprofen'), { drug_a: 'Ibuprofen', drug_b: 'Warfarin' });
  assert.deepEqual(orderPair('Ibuprofen', 'Warfarin'), { drug_a: 'Ibuprofen', drug_b: 'Warfarin' });
  // case-insensitive ordering, original casing kept
  assert.deepEqual(orderPair('warfarin', 'IBUPROFEN'), { drug_a: 'IBUPROFEN', drug_b: 'warfarin' });
  // whitespace collapses in the SORT KEY only — the emitted name is untouched
  assert.deepEqual(orderPair('  Zinc  Sulphate ', 'Aspirin'), { drug_a: 'Aspirin', drug_b: '  Zinc  Sulphate ' });
  assert.equal(normDrugName('  Two   Words '), 'two words');
});

test('all three construction sites emit the canonical order regardless of input order', () => {
  // site 1 — curatedInteractions (named pairs)
  const cur1 = curatedInteractions(['Warfarin', 'Ketorolac']);
  const cur2 = curatedInteractions(['Ketorolac', 'Warfarin']);
  assert.deepEqual(cur1, cur2);
  assert.equal(cur1[0].drug_a, 'Ketorolac');
  // site 2 — classInteractions (formulary class rules)
  const cls1 = classInteractions([dc('Rivaroxaban', 'Anticoagulant'), dc('Enoxaparin', 'Anticoagulant')]);
  const cls2 = classInteractions([dc('Enoxaparin', 'Anticoagulant'), dc('Rivaroxaban', 'Anticoagulant')]);
  assert.deepEqual(cls1, cls2);
  assert.equal(cls1[0].drug_a, 'Enoxaparin');
  // site 3 — tagInteractions (mechanism tag rules)
  const tag1 = tagInteractions([dc('Telmisartan'), dc('Ibuprofen', 'NSAID')]);
  const tag2 = tagInteractions([dc('Ibuprofen', 'NSAID'), dc('Telmisartan')]);
  assert.deepEqual(tag1, tag2);
  assert.equal(tag1[0].drug_a, 'Ibuprofen');
  // and mergeRank keeps them identical after dedupe/ranking
  assert.deepEqual(mergeRank([...cls1, ...cur1]), mergeRank([...cls2, ...cur2]));
});

// ── THE POINT OF THE BUILD (§8.3): identical finding_ref in either input order ──
test('ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref', () => {
  const a = med('Warfarin', { therapeuticClass: 'Anticoagulant' });
  const b = med('Ibuprofen', { strength: '400 mg', therapeuticClass: 'NSAID' });
  const fwd = stampFindingIdentity(ddiFindings([a, b]));
  const rev = stampFindingIdentity(ddiFindings([b, a]));
  assert.ok(fwd.length >= 1, 'the pair must fire');
  assert.deepEqual(fwd, rev);   // whole findings byte-identical: subject, refs, verdict, confidence, rationale, provenance
  assert.equal(fwd[0].finding_ref, rev[0].finding_ref);
  assert.equal(fwd[0].stable_ref, rev[0].stable_ref);
  assert.match(fwd[0].subject, /^Interaction \((major|moderate)\): Ibuprofen \+ Warfarin$/);
});

test('ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)', () => {
  const meds = [
    med('Ibuprofen', { strength: '400 mg', frequency: 'TDS', therapeuticClass: 'NSAID' }),
    med('Warfarin', { strength: '5 mg', therapeuticClass: 'Anticoagulant' }),
    med('Diclofenac', { strength: '75 mg', frequency: 'TDS', therapeuticClass: 'NSAID' }),
  ];
  const fwd = stampFindingIdentity(ddiFindings(meds)).map((f) => f.finding_ref).sort();
  const rev = stampFindingIdentity(ddiFindings([...meds].reverse())).map((f) => f.finding_ref).sort();
  assert.ok(fwd.length >= 3, `expected ≥3 interaction findings, got ${fwd.length}`);
  assert.deepEqual(fwd, rev);
});

// ── §8.3: the two order-reading checks at opd-note-audit.ts:134 and :181-182 ──
test('involvesTopical (ddiToFinding): topical de-escalation identical in either order', () => {
  // topical diclofenac GEL + oral warfarin — anticoagulant+NSAID fires, de-escalated by the
  // topical route (context-dependent, 0.5) — must behave identically however meds[] is ordered.
  const gel = med('Diclofenac', { brand: 'PainRelief Gel', route: 'topical', therapeuticClass: 'NSAID' });
  const war = med('Warfarin', { therapeuticClass: 'Anticoagulant' });
  const fwd = ddiFindings([gel, war]);
  const rev = ddiFindings([war, gel]);
  assert.deepEqual(fwd, rev);
  assert.equal(fwd.length, 1);
  assert.equal(fwd[0].verdict, 'context-dependent');
  assert.equal(fwd[0].confidence, 0.5);
  assert.match(fwd[0].rationale, /topically-applied NSAID/);
});

test('bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order', () => {
  const gel = med('Diclofenac', { brand: 'PainRelief Gel', route: 'topical', therapeuticClass: 'NSAID' });
  const oral = med('Ibuprofen', { strength: '400 mg', therapeuticClass: 'NSAID' });
  assert.deepEqual(ddiFindings([gel, oral]), []);
  assert.deepEqual(ddiFindings([oral, gel]), []);
});

test('scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere', () => {
  // A mixed script exercising tag rules + curated rules + the NSAID filter simultaneously.
  const meds = [
    med('Sertraline', { therapeuticClass: 'SSRI' }),
    med('Tramadol', { therapeuticClass: 'Opioid analgesic' }),
    med('Atorvastatin', { therapeuticClass: 'Statin' }),
    med('Clarithromycin', { therapeuticClass: 'Macrolide antibiotic' }),
  ];
  // The ARRAY position of two DIFFERENT findings still follows pair-enumeration order (stable
  // sort at equal severity) — that was input-dependent before this fix too and is not identity:
  // refs are content hashes and different pairs never collide, so compare as a multiset.
  const bySubject = (a: { subject: string }, b: { subject: string }) => a.subject.localeCompare(b.subject);
  const fwd = ddiFindings(meds).sort(bySubject);
  const rev = ddiFindings([...meds].reverse()).sort(bySubject);
  assert.deepEqual(fwd, rev);
  assert.equal(fwd.length, 2);   // serotonergic×2 + statin×macrolide
  for (const f of fwd) {
    assert.equal(f.source, 'deterministic');
    assert.ok(f.rationale.length > 0);
  }
});
