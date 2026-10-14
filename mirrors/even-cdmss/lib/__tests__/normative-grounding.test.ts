// lib/__tests__/normative-grounding.test.ts — deterministic post-hoc normative grounding.
// Fixtures only (no DB): CW category gate, τ gate, attach-both/dedupe, matcher wiring, and the
// SCORE-INVARIANCE golden (verdict/score/band/lvc_category byte-identical with grounding on vs off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cwCategoryFor, cwCandidateAccepted, guidelineCandidateAccepted, evenCandidateAccepted,
  hitToSource, mergeNormativeCitations, citationTierRank,
  attachNormativeCitations, isGroundableFinding, citationKey,
  NORMATIVE_TAU, EVEN_SOURCE, CW_ID_CATEGORY, CW_STATEMENTS, type NormativeHit, type EvenCategoryLookup,
} from '../normative-grounding-core.ts';
import { groundFinding } from '../normative-grounding.ts';
import type { RetrieveResult, RetrieveOptions } from '../retrieve.ts';
import { computeOpdScore } from '../opd-note-score-core.ts';
import type { NetValue } from '../lvc-value-core.ts';

type Dom = 'appropriateness' | 'prescribing_safety';

const cwHit = (item: string, sim: number): NormativeHit => ({ id: 1, source: 'choosing-wisely', book: 'CW-AAFP', item_number: item, similarity: sim, text: `Don't do X. — statement ${item}` });
const glHit = (sim: number): NormativeHit => ({ id: 2, source: 'lab:guidelines-icmr-amr-2019', book: 'ICMR Treatment Guidelines for Antimicrobial Use 2019 — Guidelines', item_number: 'icmr-amr-2019#p45', similarity: sim, text: 'ICMR empirical therapy table.' });

// ── CW category gate ──
test('CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ', () => {
  // cwus-aafp-001 is an imaging statement (per CDMSS-CW-CATEGORY-MAP)
  assert.equal(cwCategoryFor('cwus-aafp-001'), 'imaging');
  assert.equal(cwCandidateAccepted('imaging', cwHit('cwus-aafp-001', 0.82)), true, 'same category + above τ ⇒ accept');
  assert.equal(cwCandidateAccepted('imaging', cwHit('cwus-aafp-001', 0.60)), false, 'below τ ⇒ reject');
  assert.equal(cwCandidateAccepted('antibiotic', cwHit('cwus-aafp-001', 0.90)), false, 'cross-category ⇒ reject even at high cosine');
  // the Indian-gap category: no CW statement maps to supplement_polypharmacy, so a topically-adjacent
  // hit (e.g. a vitamin-D TESTING statement, category unindicated_investigation) is correctly rejected
  assert.equal(cwCategoryFor('cwus-aace-003'), 'unindicated_investigation');
  assert.equal(cwCandidateAccepted('supplement_polypharmacy', cwHit('cwus-aace-003', 0.88)), false, 'gap category is NOT force-grounded off-category');
  assert.equal(cwCandidateAccepted('imaging', cwHit('unknown-id', 0.99)), false, 'unknown id ⇒ no category ⇒ reject');
});

// ── guideline τ gate ──
test('guideline gate: accept iff cosine ≥ τ (no category constraint)', () => {
  assert.equal(guidelineCandidateAccepted(glHit(0.71)), true);
  assert.equal(guidelineCandidateAccepted(glHit(NORMATIVE_TAU)), true, 'exactly τ ⇒ accept');
  assert.equal(guidelineCandidateAccepted(glHit(0.69)), false);
  assert.equal(guidelineCandidateAccepted({ ...glHit(0.9), similarity: null }), false, 'non-finite ⇒ reject');
});

// ── attach both + dedupe ──
test('mergeNormativeCitations attaches both accepted legs and dedupes against existing', () => {
  const cw = hitToSource(cwHit('cwus-aafp-001', 0.82), 0);
  const gl = hitToSource(glHit(0.80), 0);
  assert.deepEqual(mergeNormativeCitations([cw, gl]).map(citationKey), ['choosing-wisely#cwus-aafp-001', 'lab:guidelines-icmr-amr-2019#icmr-amr-2019#p45']);
  // already-present CW citation is not duplicated
  const existing = [{ ...cw, n: 3 }];
  assert.deepEqual(mergeNormativeCitations([cw, gl], existing).map(citationKey), ['lab:guidelines-icmr-amr-2019#icmr-amr-2019#p45']);
  assert.deepEqual(mergeNormativeCitations([null, null]), []);
});

test('hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item', () => {
  const gl = hitToSource(glHit(0.8), 5);
  assert.equal(gl.url, null);
  assert.equal(gl.item_number, 'icmr-amr-2019#p45');
  assert.equal(gl.n, 5);
});

// ── the SCORE-INVARIANCE golden ──
test('SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical', () => {
  const findings = [
    { subject: 'Antibiotic for viral URI', verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', lvc_category: 'antibiotic', citation_ids: [] as number[] },
    { subject: 'MRI for acute LBP', verdict: 'low-value', confidence: 0.7, domain: 'appropriateness', lvc_category: 'imaging', citation_ids: [2] },
    { subject: 'Major interaction', verdict: 'high-value', confidence: 0.9, domain: 'prescribing_safety', lvc_category: undefined, citation_ids: [] },
  ];
  const sources = [{ n: 1, id: 100, source: 'statpearls', book: 'StatPearls', chapter: null, page_start: null, page_end: null, item_number: null, similarity: 0.5, url: null, preview: '' },
                   { n: 2, id: 101, source: 'pubmed', book: 'PubMed', chapter: null, page_start: null, page_end: null, item_number: '12345678', similarity: 0.6, url: null, preview: '' }];
  const scoreOf = (fs: typeof findings) => computeOpdScore({
    findings: fs.map((f) => ({ verdict: f.verdict as NetValue, confidence: f.confidence, domain: f.domain as Dom })),
    completenessCoverage: 0.8, pdqi9: null, patientCentred: { present: 1, total: 2 },
  });
  const before = scoreOf(findings);

  // attach a CW + guideline citation to the two low-value findings
  const cw = hitToSource(cwHit('cwus-aafp-002', 0.85), 0);   // antibiotic
  const gl = hitToSource(glHit(0.78), 0);
  const perFinding = [ [cw, gl], [hitToSource(cwHit('cwus-aafp-001', 0.83), 0)], [] ];
  const attached = attachNormativeCitations(findings as unknown as Record<string, unknown>[], sources, perFinding as never);
  const after = scoreOf(attached.findings as unknown as typeof findings);

  assert.deepEqual(after, before, 'note_quality_index/band/sub-scores must be byte-identical');
  // per-finding: verdict/confidence/domain/lvc_category unchanged; ONLY citation_ids + sources grew
  for (let i = 0; i < findings.length; i++) {
    for (const k of ['verdict', 'confidence', 'domain', 'lvc_category', 'subject']) {
      assert.deepEqual((attached.findings[i] as Record<string, unknown>)[k], (findings[i] as Record<string, unknown>)[k], `${k} unchanged on finding ${i}`);
    }
  }
  assert.ok(attached.added >= 1, 'new citations were appended');
  assert.ok(attached.sources.length > sources.length, 'sources array grew (additive)');
});

test('attachNormativeCitations is IDEMPOTENT — a re-run adds nothing', () => {
  const findings = [{ verdict: 'low-value', citation_ids: [] as number[] }];
  const sources: never[] = [];
  const cw = hitToSource(cwHit('cwus-aafp-002', 0.85), 0);
  const first = attachNormativeCitations(findings, sources, [[cw]]);
  assert.equal(first.added, 1);
  const second = attachNormativeCitations(first.findings, first.sources, [[cw]]);
  assert.equal(second.added, 0, 're-run finds the source present ⇒ adds nothing');
  assert.deepEqual(second.findings[0].citation_ids, first.findings[0].citation_ids);
});

// ── matcher wiring (injected retrieveFn) ──
const asResult = (hits: NormativeHit[]): RetrieveResult => ({ hits: hits as never, expandedQuery: '' } as unknown as RetrieveResult);

test('groundFinding attaches CW+guideline when both legs return accepted hits', async () => {
  const g = await groundFinding(
    { subject: 'Antibiotic for viral URI', rationale: 'no bacterial indication', lvc_category: 'antibiotic', verdict: 'low-value' },
    { retrieveFn: (async (_q: string, opts: RetrieveOptions) => asResult(opts.source === 'choosing-wisely' ? [cwHit('cwus-aafp-002', 0.86)] : [glHit(0.79)])) as never },
  );
  assert.equal(g.cw?.item_number, 'cwus-aafp-002');
  assert.equal(g.guideline?.source, 'lab:guidelines-icmr-amr-2019');
  assert.equal(g.citations.length, 2);
});

test('groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw', async () => {
  // CW hit is imaging but the finding is antibiotic ⇒ rejected; guideline below τ ⇒ rejected
  const none = await groundFinding(
    { subject: 'x', rationale: 'y', lvc_category: 'antibiotic', verdict: 'low-value' },
    { retrieveFn: (async (_q: string, opts: RetrieveOptions) => asResult(opts.source === 'choosing-wisely' ? [cwHit('cwus-aafp-001', 0.95)] : [glHit(0.5)])) as never },
  );
  assert.deepEqual(none.citations, []);
  // a retrieve throw ⇒ empty, never throws
  const soft = await groundFinding({ subject: 'x', lvc_category: 'antibiotic', verdict: 'low-value' }, { retrieveFn: (async () => { throw new Error('db down'); }) as never });
  assert.deepEqual(soft.citations, []);
});

// ── the EVEN leg (CDMSS-EVEN-LVC-ADJUDICATION §4) ──
const evenHit = (item: string, sim: number): NormativeHit => ({ id: 3, source: EVEN_SOURCE, book: 'Even Adjudicated LVC', item_number: item, similarity: sim, text: `Even assertion ${item}` });
// a lookup for an ACTIVE library: elv-antibiotic-001 → antibiotic
const evenLookup: EvenCategoryLookup = (it) => (String(it) === 'elv-antibiotic-001' ? 'antibiotic' : null);

test('even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category', () => {
  assert.equal(evenCandidateAccepted('antibiotic', evenHit('elv-antibiotic-001', 0.82), evenLookup), true);
  assert.equal(evenCandidateAccepted('antibiotic', evenHit('elv-antibiotic-001', 0.60), evenLookup), false, 'below τ ⇒ reject');
  assert.equal(evenCandidateAccepted('imaging', evenHit('elv-antibiotic-001', 0.95), evenLookup), false, 'cross-category ⇒ reject');
  assert.equal(evenCandidateAccepted('antibiotic', evenHit('elv-antibiotic-999', 0.95), evenLookup), false, 'unknown id (retired/absent) ⇒ null ⇒ reject');
});

test('citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)', () => {
  const cw = hitToSource(cwHit('cwus-aafp-002', 0.85), 0);
  const gl = hitToSource(glHit(0.80), 0);
  const ev = hitToSource(evenHit('elv-antibiotic-001', 0.83), 0);
  // pass even FIRST — the stable tier sort must still push it last
  assert.deepEqual(mergeNormativeCitations([ev, cw, gl]).map(citationKey),
    ['choosing-wisely#cwus-aafp-002', 'lab:guidelines-icmr-amr-2019#icmr-amr-2019#p45', 'even-lvc#elv-antibiotic-001']);
  assert.equal(citationTierRank(EVEN_SOURCE), 1);
  assert.equal(citationTierRank('choosing-wisely'), 0);
  // same (source,item_number) twice ⇒ collapses (the nit)
  assert.deepEqual(mergeNormativeCitations([ev, { ...ev, n: 9 }]).length, 1);
});

test('groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup', async () => {
  const rf = (async (_q: string, opts: RetrieveOptions) => asResult(
    opts.source === 'choosing-wisely' ? [cwHit('cwus-aafp-002', 0.86)]
      : opts.source === EVEN_SOURCE ? [evenHit('elv-antibiotic-001', 0.84)]
        : [glHit(0.79)])) as never;
  // with a lookup ⇒ all three legs; even is last in citations
  const g = await groundFinding(antibioticF, { retrieveFn: rf, evenCategoryLookup: evenLookup });
  assert.equal(g.even?.item_number, 'elv-antibiotic-001');
  assert.equal(g.citations.length, 3);
  assert.equal(citationKey(g.citations[2]), 'even-lvc#elv-antibiotic-001', 'even-lvc renders last');
  // NO lookup ⇒ even leg inert (no retrieve, no citation), default byte-identical to cw+guideline
  const seen: string[] = [];
  const rf2 = (async (_q: string, opts: RetrieveOptions) => { seen.push(String(opts.source ?? 'restrict')); return asResult(opts.source === 'choosing-wisely' ? [cwHit('cwus-aafp-002', 0.86)] : [glHit(0.79)]); }) as never;
  const g2 = await groundFinding(antibioticF, { retrieveFn: rf2 });   // default legs='all' but no lookup
  assert.equal(g2.even, null, 'no lookup ⇒ even leg inert');
  assert.equal(g2.citations.length, 2);
  assert.ok(!seen.includes(EVEN_SOURCE), 'the even retrieve was NOT invoked without a lookup');
});

// ── selection controls (legs / categories / tau) — must NOT change the match/gate math ──
// a retrieveFn where BOTH legs would pass by default (antibiotic finding), recording which legs it ran
const bothPass = (seen: string[]) => (async (_q: string, opts: RetrieveOptions) => {
  if (opts.source === 'choosing-wisely') { seen.push('cw'); return asResult([cwHit('cwus-aafp-002', 0.86)]); }
  seen.push('guideline'); return asResult([glHit(0.79)]);
}) as never;
const antibioticF = { subject: 'Antibiotic for viral URI', rationale: 'no bacterial indication', lvc_category: 'antibiotic', verdict: 'low-value' };

test('--legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)', async () => {
  const seen: string[] = [];
  const g = await groundFinding(antibioticF, { retrieveFn: bothPass(seen) }, { legs: 'cw' });
  assert.equal(g.cw?.item_number, 'cwus-aafp-002');
  assert.equal(g.guideline, null, 'no guideline citation');
  assert.deepEqual(seen, ['cw'], 'the guideline retrieve was not invoked');
});

test('--legs guideline runs ONLY the guideline leg (CW omitted)', async () => {
  const seen: string[] = [];
  const g = await groundFinding(antibioticF, { retrieveFn: bothPass(seen) }, { legs: 'guideline' });
  assert.equal(g.cw, null, 'no CW citation');
  assert.equal(g.guideline?.source, 'lab:guidelines-icmr-amr-2019');
  assert.deepEqual(seen, ['guideline']);
});

test('--categories filters eligibility: a finding whose lvc_category is not listed grounds nothing', async () => {
  const seen: string[] = [];
  // finding is antibiotic but categories = [imaging] ⇒ skipped entirely (no retrieve at all)
  const g = await groundFinding(antibioticF, { retrieveFn: bothPass(seen) }, { categories: ['imaging'] });
  assert.deepEqual(g.citations, []);
  assert.deepEqual(seen, [], 'ineligible category ⇒ no retrieve invoked');
  // listed category ⇒ grounds normally
  const g2 = await groundFinding(antibioticF, { retrieveFn: bothPass([]) }, { categories: ['antibiotic', 'imaging'] });
  assert.equal(g2.citations.length, 2);
});

test('--tau raises/lowers acceptance (same match math, different threshold)', async () => {
  const rf = (async (_q: string, opts: RetrieveOptions) => asResult(opts.source === 'choosing-wisely' ? [cwHit('cwus-aafp-002', 0.72)] : [glHit(0.72)])) as never;
  const loose = await groundFinding(antibioticF, { retrieveFn: rf }, { tau: 0.70 });
  assert.equal(loose.citations.length, 2, '0.72 ≥ 0.70 ⇒ both accepted');
  const strict = await groundFinding(antibioticF, { retrieveFn: rf }, { tau: 0.80 });
  assert.deepEqual(strict.citations, [], '0.72 < 0.80 ⇒ both rejected');
});

test('DEFAULT options reproduce today\'s behaviour byte-identically (regression guard)', async () => {
  const rf = () => (async (_q: string, opts: RetrieveOptions) => asResult(opts.source === 'choosing-wisely' ? [cwHit('cwus-aafp-002', 0.86)] : [glHit(0.79)])) as never;
  const bare = await groundFinding(antibioticF, { retrieveFn: rf() });                                   // no options arg
  const empty = await groundFinding(antibioticF, { retrieveFn: rf() }, {});                              // {} options
  const explicit = await groundFinding(antibioticF, { retrieveFn: rf() }, { legs: 'both', tau: NORMATIVE_TAU, categories: undefined });
  assert.deepEqual(bare, empty);
  assert.deepEqual(bare, explicit);
  assert.equal(bare.citations.length, 2);
});

// ── map integrity ──
test('CW category map: every id maps to a known lvc_category; the strong categories are covered', () => {
  assert.ok(CW_STATEMENTS.length >= 44, `expected ~55 statements, got ${CW_STATEMENTS.length}`);
  assert.equal(CW_ID_CATEGORY.size, CW_STATEMENTS.length, 'no duplicate ids');
  const byCat = (c: string) => CW_STATEMENTS.filter((s) => s.category === c).length;
  assert.equal(byCat('antibiotic'), 7);
  assert.equal(byCat('imaging'), 14);
  assert.equal(byCat('unindicated_investigation'), 11);
  assert.equal(byCat('gi_ppi_prokinetic'), 1);
});

test('isGroundableFinding: only non-informational low-value findings', () => {
  assert.equal(isGroundableFinding({ verdict: 'low-value' }), true);
  assert.equal(isGroundableFinding({ verdict: 'low-value', informational: true }), false);
  assert.equal(isGroundableFinding({ verdict: 'high-value' }), false);
});
