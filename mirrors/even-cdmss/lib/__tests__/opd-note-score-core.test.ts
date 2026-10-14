/**
 * Pure-core tests for lib/opd-note-score-core.ts.
 *   node --experimental-strip-types --test lib/__tests__/opd-note-score-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOpdScore, OPD_DEFAULT_WEIGHTS, documentationAdequacyFlag, type OpdScoreInput } from '../opd-note-score-core.ts';

const PDQI_ALL = (v: number) => ({
  up_to_date: v, accurate: v, thorough: v, useful: v, organized: v,
  comprehensible: v, succinct: v, synthesized: v, internally_consistent: v,
});

test('a complete, high-quality note scores in band A', () => {
  const sc = computeOpdScore({
    findings: [],
    completenessCoverage: 1,
    pdqi9: PDQI_ALL(5),
    patientCentred: { present: 3, total: 3 },
  });
  assert.equal(sc.headline, 100);
  assert.equal(sc.band, 'A');
  // 0 findings + a PDQI read → signal 2 → 'moderate' (confidence scales with signal found)
  assert.equal(sc.confidence, 'moderate');
});

// ── CANARY (0.81.10, PRD CDMSS-SIGNAL-TYPE-COLLAPSE S3) — PERMANENT regression guard ──
// The triple-QT note 8e2e997d (domperidone + fluconazole + ofloxacin, all QT-prolongers) must keep
// its prescribing-safety penalty. If a future change makes major interactions stop penalising, this
// fails. S1 (0.81.15) re-pinned 26 → 17 under quantization; 0.81.16 (audit-integrity phase 0)
// REVERTED quantization per the 28 Jul ruling, restoring 45 × 1.0 × 0.8 = 36 per finding and
// 100 × 0.64³ = 26. Same intent throughout — a major interaction must never wash out.
test('CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100', () => {
  const interaction = { verdict: 'low-value' as const, confidence: 0.8, domain: 'prescribing_safety' as const };
  const sc = computeOpdScore({
    findings: [interaction, interaction, interaction],
    completenessCoverage: 1, pdqi9: PDQI_ALL(5), patientCentred: { present: 3, total: 3 },
  });
  const presc = sc.domains.find((d) => d.domain === 'prescribing_safety')!.score;
  assert.equal(presc, 26, 'the QT-prolongation cluster must remain penalised — a major interaction is a real safety signal');
  assert.notEqual(presc, 100);
});

test('0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score', () => {
  // the engine feeds computeOpdScore `findings.filter(f => !f.informational)`; this pins that an
  // informational appropriateness finding leaves the appropriateness domain unpenalised.
  const scored = [{ subject: 'x', verdict: 'context-dependent', confidence: 0.5, domain: 'appropriateness', informational: true }]
    .filter((f) => !f.informational)
    .map((f) => ({ verdict: f.verdict as 'context-dependent', confidence: f.confidence, domain: f.domain as 'appropriateness' }));
  const sc = computeOpdScore({ findings: scored, completenessCoverage: 1, pdqi9: PDQI_ALL(5), patientCentred: { present: 3, total: 3 } });
  assert.equal(sc.domains.find((d) => d.domain === 'appropriateness')!.score, 100); // nothing scored → no penalty
});

test('a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low', () => {
  const input: OpdScoreInput = {
    findings: [
      { verdict: 'low-value', confidence: 0.9, domain: 'appropriateness' },
      { verdict: 'low-value', confidence: 0.8, domain: 'prescribing_safety' },
    ],
    completenessCoverage: 0.4,
    pdqi9: PDQI_ALL(2),
    patientCentred: { present: 0, total: 3 },
  };
  const sc = computeOpdScore(input);
  assert.ok(sc.headline < 55, `expected low headline, got ${sc.headline}`);
  assert.ok(['D', 'E'].includes(sc.band));
  // documentation reflects coverage exactly
  assert.equal(sc.domains.find((d) => d.domain === 'documentation')!.score, 40);
  // PDQI all-2 → (2-1)/4*100 = 25
  assert.equal(sc.domains.find((d) => d.domain === 'note_quality')!.score, 25);
});

test('PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)', () => {
  const sc = computeOpdScore({
    findings: [],
    completenessCoverage: 1,
    pdqi9: null,
    patientCentred: { present: 2, total: 2 },
  });
  const nq = sc.domains.find((d) => d.domain === 'note_quality')!;
  assert.equal(nq.weight, 0);
  assert.equal(nq.basis, 'PDQI-9 not assessed');
  // headline = weighted mean over the other four, all 100 → 100
  assert.equal(sc.headline, 100);
});

test('PDQI-9 partial ratings average only the provided attributes', () => {
  const sc = computeOpdScore({
    findings: [],
    completenessCoverage: 1,
    pdqi9: { accurate: 5, thorough: 1 }, // mean 3 → (3-1)/4*100 = 50
    patientCentred: { present: 1, total: 1 },
  });
  assert.equal(sc.domains.find((d) => d.domain === 'note_quality')!.score, 50);
  assert.equal(sc.pdqi9.length, 2);
});

test('weights are sane', () => {
  const sum = Object.values(OPD_DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights should sum to 1, got ${sum}`);
});

// B3 — documentation "fields present but content thin" flag
test('documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low', () => {
  const thin = [{ attr: 'thorough', value: 1 }, { attr: 'synthesized', value: 2 }, { attr: 'accurate', value: 4 }];
  const rich = [{ attr: 'thorough', value: 4 }, { attr: 'synthesized', value: 4 }];
  assert.ok(documentationAdequacyFlag(100, thin));          // doc complete + thin content → flag
  assert.equal(documentationAdequacyFlag(100, rich), null); // doc complete + rich content → no flag
  assert.equal(documentationAdequacyFlag(80, thin), null);  // fields not complete → no flag
  assert.equal(documentationAdequacyFlag(100, []), null);   // no PDQI → can't judge thin → no flag
  const f = documentationAdequacyFlag(100, thin)!;
  assert.equal(f.key, 'thin_documentation');
  assert.equal(f.severity, 'warn');
});

test('computeOpdScore surfaces the thin-documentation flag without changing scores', () => {
  const input = {
    findings: [], completenessCoverage: 1, patientCentred: { present: 2, total: 2 },
    pdqi9: { thorough: 1, synthesized: 2, accurate: 4, up_to_date: 4, useful: 2, organized: 3, comprehensible: 3, succinct: 4, internally_consistent: 3 },
  };
  const sc = computeOpdScore(input as Parameters<typeof computeOpdScore>[0]);
  assert.equal(sc.domains.find((d) => d.domain === 'documentation')!.score, 100); // score unchanged
  assert.equal(sc.flags.length, 1);
  assert.equal(sc.flags[0].key, 'thin_documentation');
});
