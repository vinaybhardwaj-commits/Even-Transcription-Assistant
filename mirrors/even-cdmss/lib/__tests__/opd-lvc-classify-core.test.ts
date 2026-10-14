/**
 * Pure-core tests for lib/opd-lvc-classify-core.ts (RIGHT-CARE-INDICATOR-PRD §5 / §9).
 * Run: node --experimental-strip-types --test lib/__tests__/opd-lvc-classify-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLvcCategory, isLowValueVerdict, stampLvcMetadata, classifyLvcFinding,
  suppressedRuleRefs, applyGate, LVC_CATEGORIES,
} from '../opd-lvc-classify-core.ts';

test('classifyLvcCategory: antibiotic | imaging | supplement | other', () => {
  assert.equal(classifyLvcCategory('Azithromycin for a viral URI'), 'antibiotic');
  assert.equal(classifyLvcCategory('MRI lumbar spine for acute low back pain'), 'imaging');
  assert.equal(classifyLvcCategory('Multivitamin supplement without indication'), 'supplement_polypharmacy');
  assert.equal(classifyLvcCategory('Cough syrup for self-limiting cough'), 'other');
  assert.equal(classifyLvcCategory(undefined, null), 'other');
});

test('stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved', () => {
  const findings = [
    { subject: 'Azithromycin for viral URI', verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', rationale: 'no bacterial indication' },
    { subject: 'Statin continued', verdict: 'context-dependent', confidence: 0.5, domain: 'appropriateness', rationale: '' },
    { subject: 'Coding gap', verdict: 'low-value', confidence: 0.4, domain: 'appropriateness', rationale: 'uncoded', informational: true },
  ];
  const out = stampLvcMetadata(findings as never[]) as Array<Record<string, unknown>>;
  assert.equal(out[0].rule_ref, null);
  assert.equal(out[0].lvc_category, 'antibiotic');
  // score-relevant fields untouched (invariance)
  assert.equal(out[0].verdict, 'low-value'); assert.equal(out[0].confidence, 0.8); assert.equal(out[0].domain, 'appropriateness');
  // non-low-value → no lvc fields added
  assert.equal(out[1].lvc_category, undefined); assert.equal(out[1].rule_ref, undefined);
  // informational (neutralised) low-value → skipped
  assert.equal(out[2].lvc_category, undefined);
});

test('stampLvcMetadata preserves an existing rule_ref', () => {
  const out = stampLvcMetadata([{ subject: 'X-ray for ankle', verdict: 'low-value', rule_ref: 'cw-42' }] as never[]) as Array<Record<string, unknown>>;
  assert.equal(out[0].rule_ref, 'cw-42');
  assert.equal(out[0].lvc_category, 'imaging');
});

test('classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC', () => {
  assert.equal(classifyLvcFinding({ verdict: 'high-value', subject: 'x' }).is_lvc, false);
  assert.equal(classifyLvcFinding({ verdict: 'low-value', subject: 'x', informational: true }).is_lvc, false);
  assert.ok(isLowValueVerdict('low-value'));
  assert.equal(isLowValueVerdict('context-dependent'), false);
});

test('classifyLvcFinding: stamped row passes its metadata through', () => {
  const c = classifyLvcFinding({ verdict: 'low-value', subject: 'foo', signal_type: 'low_value_care', rule_ref: 'r7', lvc_category: 'imaging' });
  assert.deepEqual(c, { is_lvc: true, rule_ref: 'r7', lvc_category: 'imaging', stamped: true });
  // stamped but bad category → re-derived from text
  const c2 = classifyLvcFinding({ verdict: 'low-value', subject: 'azithromycin course', signal_type: 'low_value_care', rule_ref: null, lvc_category: 'garbage' });
  assert.equal(c2.lvc_category, 'antibiotic');
  assert.equal(c2.stamped, true);
});

test('classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)', () => {
  const rules = [{ id: '17', keywords: ['ppi', 'proton pump'], category: 'other' }, { id: '3', keywords: ['antibiotic', 'uri'], category: 'antibiotic' }];
  const hit = classifyLvcFinding({ verdict: 'low-value', subject: 'Antibiotic for URI' }, rules);
  assert.equal(hit.rule_ref, '3');
  assert.equal(hit.lvc_category, 'antibiotic');
  assert.equal(hit.stamped, false);
  // matches nothing → rule_ref null, category from heuristic (§8: still counts as LVC)
  const miss = classifyLvcFinding({ verdict: 'low-value', subject: 'MRI for headache' }, rules);
  assert.equal(miss.is_lvc, true);
  assert.equal(miss.rule_ref, null);
  assert.equal(miss.lvc_category, 'imaging');
});

test('precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all', () => {
  const suppressed = suppressedRuleRefs([
    { cluster_key: 'lvc:17', decision: 'suppress' },
    { cluster_key: 'lvc:3', decision: 'monitor' },   // not suppress → kept
    { cluster_key: 'other:9', decision: 'suppress' }, // wrong prefix → ignored
  ]);
  assert.deepEqual([...suppressed], ['17']);
  const rows = [{ rule_ref: '17' }, { rule_ref: '3' }, { rule_ref: null }];
  assert.deepEqual(applyGate(rows, suppressed).map((r) => r.rule_ref), ['3', null]);
  // v1 default: nothing suppressed → all pass unchanged
  assert.deepEqual(applyGate(rows, new Set<string>()), rows);
});

test('LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)', () => {
  assert.deepEqual([...LVC_CATEGORIES], [
    'antibiotic', 'imaging', 'supplement_polypharmacy',
    'therapeutic_duplication', 'systemic_steroid', 'gi_ppi_prokinetic', 'antihistamine_allergy',
    'nsaid_analgesic', 'cough_cold_fdc', 'cough_expectorant', 'unindicated_investigation',
    'other',
  ]);
});

// ── engine matcher v3 (decision 25): OR across keyword phrases, AND within a phrase's tokens ──
const lv = (subject: string, rationale = '') => ({ subject, rationale, verdict: 'low-value', confidence: 0.8, domain: 'appropriateness' });
const stampRefs = (findings: unknown[], rules: unknown[]): Array<string | null> =>
  (stampLvcMetadata(findings as never[], rules as never[]) as Array<Record<string, unknown>>).map((f) => (f.rule_ref as string | null) ?? null);

test('matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)', () => {
  // a keyword is a phrase; a rule matches if ANY keyword's tokens are all whole words
  const rules = [{ id: 'cwus-aafp-002', keywords: ['antibiotics uri', 'antibiotic cold'], category: 'antibiotic' }];
  // matches via "antibiotics uri" (both tokens whole words; "URI" satisfies whole-word "uri")
  assert.deepEqual(stampRefs([lv('Antibiotics started for viral URI')], rules), ['cwus-aafp-002']);
  // "URTI" is a different whole word → "uri" not satisfied; and "antibiotic cold" absent → no match (data concern, 26b)
  assert.deepEqual(stampRefs([lv('Antibiotic for viral URTI')], rules), [null]);
});

test('matcher v3: AND within a keyword — every token must be a whole word', () => {
  const rules = [{ id: 'r', keywords: ['antibiotics uri'], category: 'antibiotic' }];
  assert.deepEqual(stampRefs([lv('Antibiotics for a viral URI')], rules), ['r']);   // both tokens present
  assert.deepEqual(stampRefs([lv('Antibiotics for a sore throat')], rules), [null]); // "uri" absent
});

test('matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null', () => {
  const short = { id: 'z-short', keywords: ['ct head'], category: 'imaging' };            // 2 tokens
  const long = { id: 'a-long', keywords: ['ct head child head injury'], category: 'imaging' }; // 5 tokens
  const hay = 'CT head ordered for a child with minor head injury';
  assert.deepEqual(stampRefs([lv(hay)], [short, long]), ['a-long']);   // 5-token phrase beats 2-token
  assert.deepEqual(stampRefs([lv(hay)], [long, short]), ['a-long']);   // order-independent
  // tie on best-matched-token count (both 1) → AMBIGUOUS → null (D1/D2: the lowest-id-ASC tiebreak
  // let one rule win essentially every 1-token tie; a guess a clinician cannot defend is worse than none)
  const tieB = { id: 'b-tie', keywords: ['imaging'], category: 'imaging' };
  const tieA = { id: 'a-tie', keywords: ['imaging'], category: 'imaging' };
  assert.deepEqual(stampRefs([lv('Imaging without indication')], [tieB, tieA]), [null]);
  // ties yield null at HIGHER specificity too — removing the tiebreak is not 1-token-specific (D2)
  const tie2a = { id: 'a-2tok', keywords: ['ct head'], category: 'imaging' };
  const tie2b = { id: 'b-2tok', keywords: ['head ct'], category: 'imaging' };
  assert.deepEqual(stampRefs([lv('CT head without red flags')], [tie2a, tie2b]), [null]);
  // a single rule matching ALONE on a 1-token keyword still wins outright (serratiopeptidase guarantee)
  const lone = { id: 'r-serra', keywords: ['serratiopeptidase'], category: 'other' };
  assert.deepEqual(stampRefs([lv('Serratiopeptidase prescribed post-op')], [lone, tieA]), ['r-serra']);
});

test('matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)', () => {
  // the CBP rule as three 1-token keywords → "blood" alone matches. Not special-cased in code.
  const cbp = [{ id: 'ehrc-cbp', keywords: ['complete', 'blood', 'profile'], category: 'other' }];
  assert.deepEqual(stampRefs([lv('Blood culture sent')], cbp), ['ehrc-cbp']);          // over-matches on "blood"
  // still respects whole-word: "incomplete" never satisfies "complete"
  assert.deepEqual(stampRefs([lv('Incomplete medication reconciliation')], cbp), [null]);
});

test('matcher v3: zero-keyword / empty-token rules never match; category from matched rule', () => {
  const rules = [{ id: 'r-empty', keywords: [], category: 'imaging' }, { id: 'r-img', keywords: ['ultrasound'], category: 'imaging' }];
  const out = stampLvcMetadata([lv('Ultrasound abdomen routine')] as never[], rules as never[]) as Array<Record<string, unknown>>;
  assert.equal(out[0].rule_ref, 'r-img'); assert.equal(out[0].lvc_category, 'imaging');
  assert.deepEqual(stampRefs([lv('anything at all')], [{ id: 'r-blank', keywords: ['', '   '], category: 'other' }]), [null]);
});

test('stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched', () => {
  assert.deepEqual(stampRefs([lv('Azithromycin antibiotic')], []), [null]);
  const rules = [{ id: 'r-abx', keywords: ['azithromycin'], category: 'antibiotic' }];
  const out = stampLvcMetadata([
    { subject: 'Azithromycin', verdict: 'high-value', confidence: 0.5, domain: 'appropriateness' },
    { subject: 'Azithromycin', verdict: 'low-value', confidence: 0.5, domain: 'appropriateness', informational: true },
  ] as never[], rules as never[]) as Array<Record<string, unknown>>;
  assert.equal(out[0].rule_ref, undefined); assert.equal(out[1].rule_ref, undefined);
  const scored = stampLvcMetadata([lv('Azithromycin')] as never[], rules as never[]) as Array<Record<string, unknown>>;
  assert.equal(scored[0].verdict, 'low-value'); assert.equal(scored[0].confidence, 0.8); assert.equal(scored[0].domain, 'appropriateness');
});
