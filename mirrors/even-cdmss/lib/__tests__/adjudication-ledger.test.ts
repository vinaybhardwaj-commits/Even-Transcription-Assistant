// lib/__tests__/adjudication-ledger.test.ts — Adjudication Ledger (#3).
// Covers: verdict normalization into the two families; the precision rollup convention
// (TP+ValidExtra over TP+ValidExtra+False, Nitpick/Contested + fidelity excluded); the HARD
// GUARDRAIL (no machine/judge store is federated); and the ADVISORY-not-scorecard discipline
// (no rollup keys by reviewer; no per-reviewer accuracy aggregation in the source). Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeVerdict, precisionByEngineVersion, precisionBySurface, verdictDistribution, volumeOverTime,
  fidelityRollup, selectFinding, selectFidelity,
  FEDERATED_STORES, EXCLUDED_MACHINE_STORES, PRECISION_POSITIVE, PRECISION_DENOMINATOR,
  type LedgerRow, type CanonicalVerdict,
} from '../adjudication-ledger/core';

const ROOT = process.cwd();
const row = (over: Partial<LedgerRow>): LedgerRow => ({
  surface: 'ipd-audit', store: 'ipd_audit_feedback', engine_version: 'ipd-discharge-audit/0.1',
  audit_ref: 'a1', finding_ref: 'f1', finding_subject: 'Concurrent Turbinoplasty', engine_verdict: null,
  human_verdict: 'true_positive', verdict_family: 'finding', canonical_verdict: 'TP', note: null,
  adjudicated_at: '2026-07-18T10:00:00.000Z', reviewer: null, link: '/admin/ipd-audit/a1', ...over,
});
const finding = (v: CanonicalVerdict, over: Partial<LedgerRow> = {}) => row({ canonical_verdict: v, verdict_family: 'finding', ...over });

// ── normalization ──
test('verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused', () => {
  // finding family
  assert.equal(normalizeVerdict('finding', 'true_positive'), 'TP');
  assert.equal(normalizeVerdict('finding', 'tp'), 'TP');
  assert.equal(normalizeVerdict('finding', 'agree'), 'TP');          // legacy IPD whole-audit → TP
  assert.equal(normalizeVerdict('finding', 'valid_extra'), 'ValidExtra');
  assert.equal(normalizeVerdict('finding', 'false'), 'False');
  assert.equal(normalizeVerdict('finding', 'disagree'), 'False');
  assert.equal(normalizeVerdict('finding', 'nitpick'), 'Nitpick');
  assert.equal(normalizeVerdict('finding', 'contested'), 'Contested');
  // needs_action is a whole-audit reaction, NOT a finding-precision verdict → dropped
  assert.equal(normalizeVerdict('finding', 'needs_action'), null);
  assert.equal(normalizeVerdict('finding', ''), null);
  // fidelity family — faithful is its OWN thing, never TP
  assert.equal(normalizeVerdict('fidelity', 'faithful'), 'Faithful');
  assert.equal(normalizeVerdict('fidelity', 'missed_material_fact'), 'MissedMaterial');
  assert.equal(normalizeVerdict('fidelity', 'mis_phased'), 'MisPhased');
  assert.equal(normalizeVerdict('fidelity', 'over_included'), 'OverIncluded');
  assert.equal(normalizeVerdict('finding', 'faithful'), null, 'faithful is not a finding verdict');
  assert.equal(normalizeVerdict('fidelity', 'tp'), null, 'tp is not a fidelity verdict');
});

// ── precision convention ──
test('precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator', () => {
  const rows = [
    finding('TP'), finding('TP'), finding('TP'),          // 3 TP
    finding('ValidExtra'),                                 // +1 correct positive
    finding('False'),                                      // 1 FP
    finding('Nitpick'), finding('Contested'),              // excluded from denominator
  ];
  const [p] = precisionByEngineVersion(rows);
  assert.equal(p.tp, 3); assert.equal(p.validExtra, 1); assert.equal(p.falsePos, 1);
  assert.equal(p.nitpick, 1); assert.equal(p.contested, 1);
  assert.equal(p.labeled, 5, 'denominator = TP + ValidExtra + False only');
  assert.equal(p.precision, 4 / 5, 'numerator counts ValidExtra as a confirmed-correct positive');
  // the canonical sets back the convention
  assert.ok(PRECISION_POSITIVE.has('TP') && PRECISION_POSITIVE.has('ValidExtra'));
  assert.ok(!PRECISION_DENOMINATOR.has('Nitpick') && !PRECISION_DENOMINATOR.has('Contested'));
});

test('precision groups by SURFACE (headline); engine version is the drill-in — same convention', () => {
  const rows = [
    finding('TP', { surface: 'opd-audit', engine_version: 'opd-note-audit/0.81.7' }),
    finding('False', { surface: 'opd-audit', engine_version: 'opd-note-audit/0.81.7' }),
    finding('TP', { surface: 'opd-audit', engine_version: 'opd-note-audit/0.81.8' }),
    finding('Nitpick', { surface: 'opd-audit', engine_version: 'opd-note-audit/0.81.8' }),   // excluded from denom
    finding('ValidExtra', { surface: 'ipd-consensus-gold', engine_version: 'ipd-discharge-audit/0.1' }),
  ];
  const bySurface = precisionBySurface(rows);
  // one row PER SURFACE (not per engine version)
  assert.deepEqual(bySurface.map((s) => s.surface), ['ipd-consensus-gold', 'opd-audit']);
  const opd = bySurface.find((s) => s.surface === 'opd-audit')!;
  // surface headline aggregates across its versions: TP 2, False 1 → labeled 3 → 2/3
  assert.equal(opd.tp, 2); assert.equal(opd.falsePos, 1); assert.equal(opd.nitpick, 1);
  assert.equal(opd.labeled, 3); assert.equal(opd.precision, 2 / 3);
  // engine version is the drill-in WITHIN the surface — two versions, each its own precision row
  assert.deepEqual(opd.byVersion.map((v) => v.engine_version), ['opd-note-audit/0.81.7', 'opd-note-audit/0.81.8']);
  assert.equal(opd.byVersion[0].precision, 1 / 2, '0.81.7: 1 TP + 1 False → 50%');
  assert.equal(opd.byVersion[1].precision, 1, '0.81.8: 1 TP, nitpick excluded → 100%');
  // gold's ValidExtra sits on its OWN surface row (definitional ~100%, not blended into OPD)
  const gold = bySurface.find((s) => s.surface === 'ipd-consensus-gold')!;
  assert.equal(gold.precision, 1);
});

test('two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding', () => {
  const mixed = [
    finding('TP'), finding('False'),
    row({ verdict_family: 'fidelity', surface: 'episode-recon', canonical_verdict: 'Faithful', human_verdict: 'faithful' }),
    row({ verdict_family: 'fidelity', surface: 'episode-recon', canonical_verdict: 'MissedMaterial', human_verdict: 'missed_material_fact' }),
  ];
  const ledger = selectFinding(mixed);
  const fid = selectFidelity(mixed);
  // the ledger page carries NO fidelity row
  assert.ok(ledger.every((r) => r.verdict_family === 'finding'), 'ledger page: finding only');
  assert.ok(!ledger.some((r) => r.surface === 'episode-recon'), 'ledger page: no recon rows');
  assert.equal(ledger.length, 2);
  // the fidelity page carries ONLY fidelity rows
  assert.ok(fid.every((r) => r.verdict_family === 'fidelity'), 'fidelity page: fidelity only');
  assert.equal(fid.length, 2);
  // precision on the ledger selection sees no fidelity; fidelity rollup on the fidelity selection sees no finding
  assert.equal(precisionBySurface(fid).length, 0, 'no precision from fidelity rows');
  assert.equal(fidelityRollup(ledger).length, 0, 'no fidelity rollup from finding rows');
});

test('fidelity is NEVER folded into precision — separate rollup, own family', () => {
  const rows = [
    finding('TP'), finding('False'),
    row({ verdict_family: 'fidelity', surface: 'episode-recon', engine_version: 'episode-state/0.2', canonical_verdict: 'Faithful', human_verdict: 'faithful' }),
    row({ verdict_family: 'fidelity', surface: 'episode-recon', engine_version: 'episode-state/0.2', canonical_verdict: 'MissedMaterial', human_verdict: 'missed_material_fact' }),
  ];
  // precision sees ONLY the finding rows
  const prec = precisionByEngineVersion(rows);
  assert.equal(prec.length, 1, 'only the finding (surface,engine) yields a precision row');
  assert.equal(prec[0].labeled, 2);
  // fidelity is its own rollup; faithful is not a TP
  const fid = fidelityRollup(rows);
  assert.equal(fid.length, 1);
  assert.equal(fid[0].faithful, 1); assert.equal(fid[0].missedMaterial, 1);
  assert.equal(fid[0].faithfulRate, 0.5);
  // no fidelity verdict is a precision positive
  assert.ok(!PRECISION_DENOMINATOR.has('Faithful' as CanonicalVerdict));
});

// ── the hard guardrail: human ground-truth only ──
test('GUARDRAIL: no machine/judge verdict store is in the federation set', () => {
  const federated = new Set(FEDERATED_STORES.map((s) => s.store));
  for (const machine of EXCLUDED_MACHINE_STORES) {
    assert.ok(!federated.has(machine), `machine store '${machine}' must NOT be federated`);
  }
  // the federation set is exactly the four verified human stores
  assert.deepEqual([...federated].sort(), ['episode_recon_ratings', 'ipd_audit_feedback', 'ipd_gold_adjudication', 'opd_audit_feedback']);
  // and the read-layer source references NONE of the machine tables
  const federateSrc = readFileSync(join(ROOT, 'lib/adjudication-ledger/federate.ts'), 'utf8');
  for (const machine of EXCLUDED_MACHINE_STORES) {
    assert.ok(!federateSrc.includes(machine), `federate.ts must not query the machine store '${machine}'`);
  }
});

// ── advisory, not a scorecard ──
test('ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse', () => {
  const rows = [
    finding('TP', { reviewer: 'V' }), finding('False', { reviewer: 'Zaki' }),
    finding('TP', { reviewer: 'Zaki' }),
  ];
  // precision + distribution partition by (surface, engine_version) ONLY — reviewer is never a key
  assert.equal(precisionByEngineVersion(rows).length, 1, 'one precision row despite two reviewers');
  assert.equal(verdictDistribution(rows).length, 1, 'one distribution row despite two reviewers');
  assert.equal(volumeOverTime(rows).length, 1, 'volume keys by day+surface, not reviewer');
  // the rollup output shapes expose no reviewer/accuracy field
  const p = precisionByEngineVersion(rows)[0] as unknown as Record<string, unknown>;
  for (const k of Object.keys(p)) assert.ok(!/review|author|clinician|leaderboard|accuracy/i.test(k), `precision row must not carry '${k}'`);
});

test('ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard', () => {
  // Aggregation-shaped tokens a real per-reviewer scorecard would use — deliberately NOT the English
  // disclaimer phrase "per-reviewer scorecard", which the surface legitimately renders to say it is
  // NOT one. This catches a grouping/accuracy-by-reviewer construct, not the prose.
  // `score\b` (not `score`) so the disclaimer word "scorecard" is not itself flagged.
  const LEADERBOARD = /leaderboard|reviewer[-_ ]?(accuracy|precision|score\b|correct|rank)|(accuracy|precision|correct)[-_ ]?(per|by)[-_ ]?reviewer|\bby[A-Za-z]*[Rr]eviewer\b|group\s*by\s*(reviewer|author|clinician)/i;
  for (const f of [
    'lib/adjudication-ledger/core.ts', 'lib/adjudication-ledger/federate.ts',
    'app/admin/observability/adjudications/page.tsx',
    'app/admin/observability/reconstruction-fidelity/page.tsx',
    'app/admin/observability/ledger-ui.tsx',
  ]) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // strip comment lines so the modules' OWN advisory prose ("per-reviewer accuracy rollup", the
    // disclaimer) can't trip the guard — we are asserting on CODE, not documentation.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.equal(LEADERBOARD.test(code), false, `${f} must not aggregate a per-reviewer scorecard`);
  }
});

test('the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision', () => {
  const ledger = readFileSync(join(ROOT, 'app/admin/observability/adjudications/page.tsx'), 'utf8');
  const fidelity = readFileSync(join(ROOT, 'app/admin/observability/reconstruction-fidelity/page.tsx'), 'utf8');
  // the ledger page selects the finding family and never renders the fidelity rollup
  assert.ok(/\bselectFinding\b/.test(ledger), 'ledger page filters to the finding family');
  assert.ok(!/\bfidelityRollup\b/.test(ledger), 'ledger page must not render a fidelity rollup');
  // the fidelity page selects the fidelity family and never renders a precision rollup
  assert.ok(/\bselectFidelity\b/.test(fidelity), 'fidelity page filters to the fidelity family');
  assert.ok(!/\bprecisionBySurface\b|\bprecisionByEngineVersion\b/.test(fidelity), 'fidelity page must not render precision');
});
