/**
 *   node --test --import tsx lib/__tests__/resolver-form-gate.test.ts
 *
 * Audit-integrity batch, PHASE 1 (class B, bug 3) — the resolver gate.
 *
 * THE DEFECT (P0, filed twice by Dr. Zaki): "Atarax Cream For Distressed Dry And Itchy Skin"
 * resolved to Hydroxyzine at tier 4 — the family `atarax` holds 3 ORAL hydroxyzine rows and no
 * cream — with confident:true, which licensed a deterministic prescribing-safety finding and an
 * LLM appropriateness finding about topical hydroxyzine. The cream is a pramoxine/zinc-oxide
 * emollient. The engine poisoned its own prompt: the LLM reasoned correctly from a false premise,
 * so no contradiction detector could catch it.
 *
 * TWO LAYERS: the EMR category gate (exact enum, skips the matcher entirely) and the form gate
 * (topical line + no topical row in the matched family ⇒ null, never an approximate match).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFormularyMatcher, classifyUnmatched, lineIsTopical, TOPICAL_ROUTE_RE, TOPICAL_FORM_RE,
  type FormularyRow,
} from '../formulary-match-core.ts';

// A miniature formulary reproducing the measured shapes: the 3 oral ATARAX rows (the bug-3
// family), a genuinely topical family, and a mixed family.
const ROWS: FormularyRow[] = [
  { brand: 'ATARAX 10MG TAB', generic: 'Hydroxyzine', generic_canon: 'hydroxyzine', form: 'Tablet 10 MG' } as FormularyRow,
  { brand: 'ATARAX 25MG TAB', generic: 'Hydroxyzine', generic_canon: 'hydroxyzine', form: 'Tablet 25 MG' } as FormularyRow,
  { brand: 'ATARAX SYRUP', generic: 'Hydroxyzine', generic_canon: 'hydroxyzine', form: 'Syrup 100 ML' } as FormularyRow,
  { brand: 'CANDID CREAM', generic: 'Clotrimazole', generic_canon: 'clotrimazole', form: 'Cream 20 GM' } as FormularyRow,
  { brand: 'ZOLEDERM LOTION', generic: 'Clobetasol', generic_canon: 'clobetasol', form: 'Lotion 30 ML' } as FormularyRow,
];
const M = buildFormularyMatcher(ROWS);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · BUG 3 ITSELF — the exhibit line no longer resolves
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate', () => {
  const r = M.resolve({ brand: 'Atarax Cream For Distressed Dry And Itchy Skin', route: 'Topical' });
  assert.equal(r, null, 'the family holds no topical row — the cream is not the product on the note');
  // …and classifyUnmatched tags it (an unmatched item is tagged, not scored — §4.4).
  assert.equal(classifyUnmatched('Atarax Cream For Distressed Dry And Itchy Skin'), 'non-formulary');
});

test('the gate fires on the TEXT alone too — no route needed', () => {
  // Long marketing strings (the real exhibit shape) miss tiers 1–3 and reach tier 4, where the
  // gate reads the RAW brand text: 'cream'/'lotion' in the string marks the line topical.
  assert.equal(M.resolve({ brand: 'Atarax Cream Soothing Formula' }), null, 'the brand string says cream');
  assert.equal(M.resolve({ brand: 'Atarax Calming Lotion Extra', route: null }), null);
});

test('the ORAL Atarax lines still resolve, confident — the gate is surgical', () => {
  // Short oral lines normalise onto the exact brand (tier 2); a longer oral string exercises the
  // gated tier 4 and still passes, because the gate only bites TOPICAL lines.
  const t2 = M.resolve({ brand: 'Atarax 10', route: 'Oral' });
  assert.equal(t2?.generic.toLowerCase(), 'hydroxyzine');
  assert.equal(t2?.confident, true);
  const t4 = M.resolve({ brand: 'Atarax Forte Extra', route: 'Oral' });
  assert.equal(t4?.matchType, 'brand-token', 'tier 4 still fires for a non-topical line');
  assert.equal(t4?.confident, true);
});

test('a topical line matching a family that HAS a topical row still resolves', () => {
  const r = M.resolve({ brand: 'Candid Cream 20g', route: 'Topical' });
  assert.ok(r, 'clotrimazole cream is really in the formulary');
  assert.equal(r!.generic.toLowerCase(), 'clotrimazole');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The route vocabulary — MEASURED spellings from one real note
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical', () => {
  for (const route of ['Topical', 'topical ', ' TOPICAL', 'local', 'Local ']) {
    assert.equal(lineIsTopical('8X-KT', route), true, `route "${route}" must be topical`);
  }
  for (const route of ['Oral', 'oral', 'IV', '', null, undefined, 'sublingual', 'Per oral', 'PO', 'nasal']) {
    assert.equal(lineIsTopical('Plain Tablet', route as never), false, `route "${route}" is not topical`);
  }
  // Phase 1.1 — widened from the anchored token to a word-boundary phrase match. DEVIATION from
  // the kickoff's literal regex, flagged: \blocal\b cannot match 'apply locally', which test 6
  // requires — local(ly)? is the minimal widening that satisfies the behaviour spec.
  assert.equal(TOPICAL_ROUTE_RE.source, String.raw`\b(topical|local(ly)?)\b`, 'the shipped regex, verbatim');
});

test('phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical', () => {
  for (const route of ['topical application', 'Local application', 'apply locally', 'Intranasal/ topical application', 'topical', 'local']) {
    assert.equal(lineIsTopical('Physiogel Ai', route), true, `route "${route}" must be topical`);
  }
});

test('the topical-form regex is the normative one, and word boundaries hold', () => {
  assert.equal(TOPICAL_FORM_RE.source, 'cream|ointment|lotion|\\bgel\\b|soap|shampoo|serum|face ?wash|dusting powder|\\bbalm\\b');
  for (const s of ['x cream', 'eye ointment', 'calamine lotion', 'aloe gel', 'medicated soap', 'shampoo', 'vitamin c serum', 'face wash', 'facewash', 'dusting powder', 'lip balm']) {
    assert.equal(TOPICAL_FORM_RE.test(s.toLowerCase()), true, `${s} is topical`);
  }
  // \bgel\b must not fire inside e.g. "gelatin"; \bbalm\b not inside "balmoral".
  assert.equal(TOPICAL_FORM_RE.test('gelatin capsule'), false);
  assert.equal(TOPICAL_FORM_RE.test('balmoral'), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Tier 5 is gated the same way; tiers 1–3 are untouched
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match', () => {
  // "ATARAX 10MG TAB PLUS EXTRA" would prefix-match the oral row; topical ⇒ null.
  assert.equal(M.resolve({ brand: 'Atarax 10mg Tab Cream Extra', route: 'Topical' })?.matchType ?? null, null);
});

test('TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate', () => {
  // tier 1 — the EMR gave a generic: trusted even on a topical line (it is not a guess).
  const t1 = M.resolve({ generic: 'Hydroxyzine', brand: 'Atarax Cream', route: 'Topical' });
  assert.equal(t1?.matchType, 'source-generic');
  // tier 2 — exact normalised brand.
  const t2 = M.resolve({ brand: 'Candid Cream', route: 'Topical' });
  assert.ok(t2 && (t2.matchType === 'brand-exact' || t2.matchType === 'brand-token'));
  // tier 3 — embedded molecule name, verbatim.
  const t3 = M.resolve({ brand: 'XYZ Clotrimazole Dusting Powder', route: 'Topical' });
  assert.equal(t3?.matchType, 'embedded-generic');
  // …and the source keeps the tier order: the gate sits after tier 3, before tier 4.
  const src = readFileSync('lib/formulary-match-core.ts', 'utf8');
  const gateIdx = src.indexOf('const topicalLine = lineIsTopical(brand, med.route);');
  const tier3Idx = src.indexOf('embedded-generic', src.indexOf('resolve(med)'));   // the CODE site, not the doctrine comment
  const tier4Idx = src.indexOf('byFirstTok.get(ft)', src.indexOf('resolve(med)'));   // tier 4's read inside resolve, not the map build
  assert.ok(gateIdx > tier3Idx, 'gate is computed after tier 3');
  assert.ok(gateIdx < tier4Idx, '…and before tier 4');
});

test('CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched', () => {
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(audit.includes("const CONFIDENT_MATCH = new Set(['source-generic', 'brand-exact', 'embedded-generic', 'brand-token']);"),
    'the confidence doctrine did not move');
  const core = readFileSync('lib/formulary-match-core.ts', 'utf8');
  assert.ok(core.includes("return NUTRA.test(brand || '') ? 'nutraceutical-cosmetic' : 'non-formulary';"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Layer 1 — the EMR category gate
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely', async () => {
  const { enrichOpdMeds } = await import('../formulary.ts');
  for (const cat of ['ALLOPATHY_NON_MEDICINE', 'COSMETIC_TREATMENTS_CATEGORY', 'NUTRITIONAL_SUPPLIMENTS', ' ALLOPATHY_NON_MEDICINE ']) {
    const med = { brand: 'Atarax Cream For Distressed Dry And Itchy Skin', serviceCategory: cat } as never as import('../opd-ingest-core.ts').OpdMed;
    enrichOpdMeds([med]);
    assert.equal(med.formularyMatch, 'none', `category "${cat}" must skip the matcher`);
    assert.equal(med.nonFormulary, 'nutraceutical-cosmetic');
    assert.equal(med.resolvedGeneric, undefined, 'no molecule may be attached');
  }
});

test('the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher', async () => {
  const { enrichOpdMeds } = await import('../formulary.ts');
  for (const cat of ['allopathy_non_medicine', 'ALLOPATHY_MEDICINES', 'TOPICAL_MEDICINE', undefined, null, '']) {
    const med = { brand: 'Dolo 650', serviceCategory: cat ?? undefined } as never as import('../opd-ingest-core.ts').OpdMed;
    enrichOpdMeds([med]);
    // Dolo resolves in the real formulary; the point here is only that the gate did NOT pre-empt
    // the matcher — formularyMatch reflects a matcher outcome, not the forced 'none' + cosmetic tag.
    assert.ok(!(med.formularyMatch === 'none' && med.nonFormulary === 'nutraceutical-cosmetic' && !med.brand?.match(/cream/i)) || med.resolvedGeneric === undefined);
    assert.ok(med.formularyMatch !== undefined, 'the matcher ran');
  }
});

test('rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence', async () => {
  const src = readFileSync('lib/opd-ingest-core.ts', 'utf8');
  assert.ok(src.includes('serviceCategory: strOrNull(o.default_opd_service_category) || undefined,'),
    'the inferred db13 field name, read fail-safe — null/missing degrades to undefined');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Phase 1.1 — the category gate is ROUTE-AWARE (addendum A-6)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Phase 1's gate fired on category ALONE and silenced ~24,614 ORAL lines (crocin, buscogast,
// limcee, Depura/Vitamin D3…). THE PRINCIPLE: silence requires positive evidence of a topical
// form, never the absence of a route string. A category alone is not evidence.

test('§5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit', async () => {
  const { enrichOpdMeds } = await import('../formulary.ts');
  const med = { brand: 'Atarax Cream For Distressed Dry And Itchy Skin', route: 'Topical', serviceCategory: 'ALLOPATHY_NON_MEDICINE' } as never as import('../opd-ingest-core.ts').OpdMed;
  enrichOpdMeds([med]);
  assert.equal(med.formularyMatch, 'none');
  assert.equal(med.nonFormulary, 'nutraceutical-cosmetic');
  assert.equal(med.resolvedGeneric, undefined, 'no hydroxyzine, ever');
});

test('§5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol', async () => {
  const { enrichOpdMeds } = await import('../formulary.ts');
  const med = { brand: 'Crocin 650mg Tablet', route: 'Per oral', serviceCategory: 'ALLOPATHY_NON_MEDICINE' } as never as import('../opd-ingest-core.ts').OpdMed;
  enrichOpdMeds([med]);
  assert.match(med.resolvedGeneric ?? '', /paracetamol/i, 'the oral molecule is restored');
});

test('§5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3', async () => {
  // 1,166 live lines. Without this, the Ruling 13 vitamin D band rule never fires on Depura and
  // the blind spot looks like correct silence.
  const { enrichOpdMeds } = await import('../formulary.ts');
  const med = { brand: 'Depura 60000 IU Vitamin D3 Oral Solution', route: 'Per oral', serviceCategory: 'NUTRITIONAL_SUPPLIMENTS' } as never as import('../opd-ingest-core.ts').OpdMed;
  enrichOpdMeds([med]);
  assert.match(med.resolvedGeneric ?? '', /vitamin d3/i, 'the phase-3 vitamin D rule needs this molecule visible');
});

test('§5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)', async () => {
  const { enrichOpdMeds } = await import('../formulary.ts');
  const med = { brand: 'Venusia Max Intensive Moisturizing Lotion', serviceCategory: 'ALLOPATHY_NON_MEDICINE' } as never as import('../opd-ingest-core.ts').OpdMed;
  enrichOpdMeds([med]);
  assert.equal(med.formularyMatch, 'none');
  assert.equal(med.nonFormulary, 'nutraceutical-cosmetic');
});

test('§5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet', async () => {
  const { enrichOpdMeds } = await import('../formulary.ts');
  const med = { brand: 'Zincovit Tablet', serviceCategory: 'NUTRITIONAL_SUPPLIMENTS' } as never as import('../opd-ingest-core.ts').OpdMed;
  enrichOpdMeds([med]);
  assert.notEqual(med.nonFormulary === 'nutraceutical-cosmetic' && med.formularyMatch === 'none' && med.resolvedGeneric === undefined
    ? 'gated' : 'ran', 'gated', 'absence of a route string is NOT evidence — the matcher must run');
});

test('§5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines', () => {
  // Same miniature matcher, no category involved: a topical line against the oral-only family.
  assert.equal(M.resolve({ brand: 'Atarax Soothing Emollient', route: 'topical application' }), null,
    'the WIDENED route regex now marks this line topical even with no form word in the text');
  assert.equal(M.resolve({ brand: 'Atarax Forte Extra', route: 'Per oral' })?.matchType, 'brand-token', 'oral still resolves');
});

test('phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one', () => {
  // Any line topical under the OLD anchored regex is topical under the new one (token ⊂ phrase);
  // lineIsTopical appears only in the layer-1 gate (skip) and the tier-4/5 gates (return null) —
  // every consumer uses it to SUPPRESS a match, so widening it cannot mint a new match.
  const core = readFileSync('lib/formulary-match-core.ts', 'utf8');
  const consumers = core.split('\n').filter((l) => l.includes('topicalLine') && !l.trim().startsWith('//'));
  assert.ok(consumers.every((l) => l.includes('lineIsTopical') || l.includes('return null') || l.includes('&&')),
    'every use of the predicate gates a return-null path');
  const form = readFileSync('lib/formulary.ts', 'utf8');
  assert.ok(form.includes("&& lineIsTopical(m.brand, m.route)) {"), 'layer 1 uses it only to skip the matcher');
});
