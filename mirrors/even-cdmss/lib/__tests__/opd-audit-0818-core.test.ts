import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prescribingChecks, neutralizeMetadataFindings, neutralizeScreeningContext, isHealthCheckEncounter,
  OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT, type OpdFinding,
} from '@/lib/opd-note-audit-core';
import type { DeidOpdCase, OpdMed } from '@/lib/opd-ingest-core';
import { classifyLvcCategory, LVC_CATEGORIES, LVC_CATEGORY_LABELS } from '@/lib/opd-lvc-classify-core';
import { tagsFor } from '@/lib/ddi-tags';
import { frequentFlierCmp } from '@/lib/opd-audit-context-sort';

function mkCase(p: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
    impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: [],
    investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false, ...p,
  };
}
const subj = (fs: OpdFinding[], re: RegExp) => fs.find((f) => re.test(f.subject));

// ── version bump ─────────────────────────────────────────────────────────────
test('engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17', () => {
  assert.equal(OPD_ENGINE_VERSION, 'opd-note-audit/0.81.21');   // 0.81.21 — DETERMINISM-TRIO, 8 Aug 2026
  assert.ok(OPD_ENGINE_VERSIONS_CURRENT.includes('opd-note-audit/0.81.8'));   // history stays in the read family
  assert.ok(OPD_ENGINE_VERSIONS_CURRENT.includes('opd-note-audit/0.81.13'));
  assert.ok(OPD_ENGINE_VERSIONS_CURRENT.includes('opd-note-audit/0.81.14'));
  assert.ok(OPD_ENGINE_VERSIONS_CURRENT.includes('opd-note-audit/0.81.15'));
  assert.ok(OPD_ENGINE_VERSIONS_CURRENT.includes('opd-note-audit/0.81.16'));
  assert.ok(OPD_ENGINE_VERSIONS_CURRENT.includes('opd-note-audit/0.81.17'));  // the new version must be added or the index empties (decision 21)
});

// ── bug 9 — unverified_brand is informational (non-scoring) ───────────────────
test('bug 9: an unresolved brand is surfaced but informational (never scores)', () => {
  const fs = prescribingChecks(mkCase({ medications: [{ brand: 'ZZZOTONIC' } as OpdMed] }));
  const uv = subj(fs, /^Unverified brand:/);
  assert.ok(uv, 'unverified brand finding present');
  assert.equal(uv!.informational, true);
});

// ── bugs 6/7 — incomplete_dosing exemptions + consolidation ───────────────────
test('bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)', () => {
  const fs = prescribingChecks(mkCase({ medications: [{ brand: 'ZZZOTONIC' } as OpdMed] }));
  assert.ok(subj(fs, /^Unverified brand:/), 'unverified present');
  assert.equal(subj(fs, /^Incomplete dosing:/), undefined, 'no incomplete-dosing stack on the same unresolved line');
});
test('bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing', () => {
  const fs = prescribingChecks(mkCase({ medications: [{ generic: 'Cetaphil Moisturiser', brand: 'CETAPHIL', frequency: 'BD' } as OpdMed] }));
  assert.equal(subj(fs, /^Incomplete dosing:/), undefined);
});
test('a RESOLVED real drug missing its dose STILL scores incomplete dosing', () => {
  const fs = prescribingChecks(mkCase({ medications: [{ generic: 'Amlodipine', frequency: 'OD' } as OpdMed] }));
  const inc = subj(fs, /^Incomplete dosing:/);
  assert.ok(inc, 'incomplete dosing fires for a resolved drug missing its dose');
  assert.notEqual(inc!.informational, true);
});

// ── bug 2 — institutional health-check screening context ──────────────────────
test('bug 2: a health-check package encounter is recognised and neutralises screening critiques', () => {
  assert.equal(isHealthCheckEncounter(mkCase({ reasonForConsult: 'Master Health Checkup package' })), true);
  assert.equal(isHealthCheckEncounter(mkCase({ presentingComplaints: ['fever'] })), false);
  const f: OpdFinding = { subject: 'Routine lipid panel unindicated', verdict: 'low-value', confidence: 0.5, domain: 'appropriateness', rationale: 'screening test not indicated', evidence: [], estimates: [], citation_ids: [], source: 'llm' };
  assert.equal(neutralizeScreeningContext([f], true)[0].informational, true);
  assert.notEqual(neutralizeScreeningContext([f], false)[0].informational, true);   // untouched outside a package
});

// ── bug 10 — niche pre-analytic omission → informational ──────────────────────
test('bug 10: a biotin-before-thyroid over-flag is neutralised to informational', () => {
  const f: OpdFinding = { subject: 'Did not advise holding biotin before the thyroid panel', verdict: 'low-value', confidence: 0.4, domain: 'appropriateness', rationale: 'biotin can interfere with the TSH immunoassay', evidence: [], estimates: [], citation_ids: [], source: 'llm' };
  const out = neutralizeMetadataFindings([f]);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, 'pretest_niche');
  // a genuine prescribing finding mentioning biotin is untouched (only appropriateness over-flags)
  const g: OpdFinding = { ...f, domain: 'prescribing_safety' };
  assert.notEqual(neutralizeMetadataFindings([g])[0].informational, true);
});

// ── bug 5 — DDI invariance of the hyoscine/dicyclomine reclass ────────────────
test('bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags', () => {
  // reclassed molecules carry no interaction tag under EITHER the old GI class or the new one
  assert.deepEqual([...tagsFor('Hyoscine Butylbromide', 'Antispasmodic', 'Anticholinergic')],
                   [...tagsFor('Hyoscine Butylbromide', 'Gastrointestinal', 'Antispasmodic')]);
  assert.deepEqual([...tagsFor('Dicyclomine', 'Antispasmodic', 'Anticholinergic')],
                   [...tagsFor('Dicyclomine', 'Gastrointestinal', 'Antispasmodic')]);
  // a co-prescribed NSAID still tags nsaid by NAME regardless of the formulary major
  assert.ok(tagsFor('Dicyclomine+Mefenamic Acid', 'Antispasmodic', 'Anticholinergic').has('nsaid'));
  assert.ok(tagsFor('Dicyclomine+Mefenamic Acid', 'Gastrointestinal', 'Antispasmodic').has('nsaid'));
});

// ── Part B — LVC sub-categorisation ───────────────────────────────────────────
test('Part B: the 3 base categories are unchanged', () => {
  assert.equal(classifyLvcCategory('Azithromycin for a viral URTI'), 'antibiotic');
  assert.equal(classifyLvcCategory('Routine chest X-ray'), 'imaging');
  assert.equal(classifyLvcCategory('Multivitamin supplement, no indication'), 'supplement_polypharmacy');
});
test('Part B: residual other splits into overuse sub-tags by priority', () => {
  assert.equal(classifyLvcCategory('Systemic steroid (prednisolone) for a simple URTI'), 'systemic_steroid');
  assert.equal(classifyLvcCategory('Pantoprazole with no acid-related indication'), 'gi_ppi_prokinetic');
  assert.equal(classifyLvcCategory('Levocetirizine added without an allergic indication'), 'antihistamine_allergy');
  assert.equal(classifyLvcCategory('Ambroxol expectorant syrup for a dry cough'), 'cough_expectorant');
  assert.equal(classifyLvcCategory('Phenylephrine cough and cold combination'), 'cough_cold_fdc');
  assert.equal(classifyLvcCategory('Aceclofenac analgesic, no clear indication'), 'nsaid_analgesic');
  assert.equal(classifyLvcCategory('Unnecessary serology panel ordered'), 'unindicated_investigation');
});
test('Part B: the omission guard keeps missing-safety-net / mismatch findings in other', () => {
  assert.equal(classifyLvcCategory('Missing safety-net advice for the steroid course'), 'other');
  assert.equal(classifyLvcCategory('No follow-up documented despite the PPI'), 'other');
  assert.equal(classifyLvcCategory('Diagnosis–complaint mismatch'), 'other');
});
test('Part B: priority order — therapeutic_duplication wins over a steroid mention', () => {
  assert.equal(classifyLvcCategory('Therapeutic duplication of two systemic steroids'), 'therapeutic_duplication');
});
test('Part B: every category has a shared human label (no raw slug can render)', () => {
  for (const c of LVC_CATEGORIES) assert.ok(LVC_CATEGORY_LABELS[c], `label for ${c}`);
});

// ── Part C — frequent-flier comparator (Decision 12) ──────────────────────────
test('Part C: frequentFlierCmp orders per Decision 12', () => {
  const rows = [
    { context: null, encounters: null, longFindings: null, index: 10 },          // no-block → last
    { context: 'none', encounters: 0, longFindings: 0, index: 20 },              // block, 0 enc
    { context: 'thin', encounters: 2, longFindings: 0, index: 30 },              // block, no findings, 2 enc
    { context: 'established', encounters: 5, longFindings: 3, index: 40 },        // has findings (loudest)
    { context: 'established', encounters: 9, longFindings: 3, index: 5 },         // same findings, more enc
  ];
  const order = [...rows].sort(frequentFlierCmp);
  assert.deepEqual(order.map((r) => r.index), [5, 40, 30, 20, 10]);
});
test('Part C: default (index) order is untouched by the comparator module', () => {
  // sanity — the comparator only reorders; worst-first tiebreak is index ASC within a tier
  const a = { context: 'thin', encounters: 1, longFindings: 0, index: 88 };
  const b = { context: 'thin', encounters: 1, longFindings: 0, index: 12 };
  assert.ok(frequentFlierCmp(a, b) > 0);   // b (lower index = worse) first
});
