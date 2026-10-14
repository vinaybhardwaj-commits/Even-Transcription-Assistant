// CDSCO banned-FDC check (PRD CDMSS-CDSCO-BANNED-FDC §8) — the C5 exact-set boundary, the C4
// signal-identity amendment + its collapse regression guard, the severity floor (both halves),
// and the §7 fail-safes. Test fixtures use PLACEHOLDER molecule names (mol-a/mol-b/…) on purpose:
// no real banned-drug data may originate from a builder, including in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannedFdcFindings, normalizeMoleculeSet, type BannedFdcTable } from '../cdsco-banned-fdc-core';
import { bannedFdcFindings as loaderFindings, CDSCO_BANNED_FDC_VERSION } from '../cdsco-banned-fdc';
import SEED from '../../data/cdsco-banned-fdc.json';
import { stampFindingIdentity, OPD_SIGNAL_TYPES, type OpdFinding } from '../opd-note-audit-core';
import { applyDemotes, ruleViolatesSeverityFloor, isSafetySignalType, type Suppression } from '../audit-suppression-core';
import type { OpdMed } from '../opd-ingest-core';

const med = (over: Partial<OpdMed> = {}): OpdMed => ({ name: 'BrandX', ...over } as OpdMed);
const TABLE: BannedFdcTable = {
  version: 'cdsco-banned-fdc/test',
  entries: [
    { id: 'test-entry-1', molecules: ['mol-a', 'mol-b'], notification_date: '2026-06-11', gazette_ref: 'S.O. TEST(E)' },
    { id: 'test-entry-2', molecules: ['mol-c', 'mol-d', 'mol-e'], notification_date: '2026-06-11', gazette_ref: 'S.O. TEST2(E)' },
  ],
};

test('exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale', () => {
  const out = bannedFdcFindings([med({ resolvedGeneric: 'Mol-A + Mol-B' })], TABLE);
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.subject, 'Banned fixed-dose combination: mol-a + mol-b');
  assert.equal(f.verdict, 'low-value');
  assert.equal(f.confidence, 1.0);
  assert.equal(f.domain, 'prescribing_safety');
  assert.equal(f.source, 'deterministic');
  assert.deepEqual([f.evidence, f.estimates, f.citation_ids], [[], [], []]);
  assert.match(f.rationale, /Section 26A/);
  assert.match(f.rationale, /S\.O\. TEST\(E\)/);
  assert.match(f.rationale, /2026-06-11/);
});

test('C5 boundary: superset does NOT fire (banned core + one extra molecule)', () => {
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b + mol-z' })], TABLE), []);
  // 4-molecule product containing the banned 3-molecule core
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-c/mol-d/mol-e/mol-f' })], TABLE), []);
});

test('C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)', () => {
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a' })], TABLE), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-c + mol-d' })], TABLE), []);
});

test('order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]', () => {
  for (const g of ['mol-b + mol-a', 'MOL-B/MOL-A', 'mol-b, mol-a', ' mol-b +  mol-a ']) {
    assert.equal(bannedFdcFindings([med({ resolvedGeneric: g })], TABLE).length, 1, g);
  }
  assert.deepEqual(normalizeMoleculeSet(['B', ' a ', '', 'b']), ['a', 'b']);
});

test('unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss', () => {
  assert.deepEqual(bannedFdcFindings([med()], TABLE), []);
  assert.deepEqual(bannedFdcFindings([med({ generic: '' })], TABLE), []);
});

test('empty / malformed table → empty array, never a throw (§7 fail-safe)', () => {
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], { version: 'x', entries: [] }), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], {} as never), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], null as never), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], { version: 'x', entries: [{ id: 'bad', molecules: 'not-an-array' }] } as never), []);
  // a malformed single-molecule "combination" entry can never fire either
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a' })], { version: 'x', entries: [{ id: 'one', molecules: ['mol-a'], notification_date: '', gazette_ref: '' }] }), []);
});

test('same banned combination in two products → ONE finding (per-entry dedupe)', () => {
  const out = bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' }), med({ resolvedGeneric: 'mol-b + mol-a' })], TABLE);
  assert.equal(out.length, 1);
});

// 0.81.14 (Ruling 15, CLINICAL-RULINGS §2.8) — seed advanced to v2.0 (orchestrator-authored, post-f8ad185):
// rebuilt from the primary 07.09.2018 gazette (S.O. 4379(E)–4712(E)) with the 25.09.2018 corrigenda applied,
// S.O. 4616(E) excluded as rescinded by S.O. 697(E), and the 4607→4707 numbering corrected. Four cohorts:
// `entries` (308) is THE ONLY FIRING SET; `withheld_qualified` (28, form/strength-qualified — the exact-set
// schema cannot express route/form/strength), `rescinded` (1), and `not_representable` (112) are inert and
// must NEVER contribute. The loader (lib/cdsco-banned-fdc.ts) reads ONLY `entries`. Molecule names come from
// the V/orchestrator-authored seed (not builder-originated).
//
// ⚠ The two withheld_qualified NEGATIVES below are the load-bearing assertions in this file: encoding either
// as a firing ban would produce ~459 false "you prescribed a banned drug" accusations per 90 days on drugs
// that are legally dispensed in the forms Even prescribes. They must stay in withheld_qualified, never `entries`.
test('0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire', () => {
  assert.equal(CDSCO_BANNED_FDC_VERSION, 'cdsco-banned-fdc/2.0');
  assert.equal((SEED as { entries: unknown[] }).entries.length, 308);

  // ── FIRES (present in `entries`) ──
  // etodolac + paracetamol — S.O. 1855(E), carried from v1.0. v2.0 ALSO carries the 2018 S.O. 4706(E)
  // entry for the same set, and per-finding dedupe is keyed on entry id (not molecule set), so this
  // prescription legitimately matches ≥1 ban entry. (8 such duplicate sets exist in the seed — flagged.)
  assert.ok(loaderFindings([med({ resolvedGeneric: 'Etodolac + Paracetamol' })]).length >= 1);
  // azithromycin + secnidazole + fluconazole combikit — S.O. 4429(E) (unique set → exactly one finding)
  assert.equal(loaderFindings([med({ resolvedGeneric: 'Azithromycin + Secnidazole + Fluconazole' })]).length, 1);
  // paracetamol + prochlorperazine — S.O. 4710(E) (unique set → exactly one finding)
  assert.equal(loaderFindings([med({ resolvedGeneric: 'Paracetamol + Prochlorperazine' })]).length, 1);

  // ── DOES NOT FIRE — the load-bearing negatives ──
  // ofloxacin + ornidazole — withheld_qualified: the gazette bans the SUSPENSION; Even prescribes tablets.
  assert.equal(loaderFindings([med({ resolvedGeneric: 'Ofloxacin + Ornidazole' })]).length, 0);
  // aceclofenac + paracetamol — withheld_qualified: the gazette bans the (SR) form; Even prescribes IR.
  assert.equal(loaderFindings([med({ resolvedGeneric: 'Aceclofenac + Paracetamol' })]).length, 0);
  // paracetamol + caffeine + phenylephrine + chlorpheniramine — S.O. 4616(E), RESCINDED by S.O. 697(E).
  assert.equal(loaderFindings([med({ resolvedGeneric: 'Paracetamol + Caffeine + Phenylephrine + Chlorpheniramine' })]).length, 0);

  // ── Structural proof the loader reads ONLY `entries` ──
  // Every molecule set that lives EXCLUSIVELY in a non-firing cohort must produce no finding. Sets that
  // also appear in `entries` are excluded (those fire legitimately via `entries`, e.g. a combo banned in
  // one form under `entries` and qualified in another under withheld_qualified).
  const seed = SEED as unknown as Record<string, Array<{ molecules?: string[] }>>;
  const canon = (a?: string[]) =>
    Array.from(new Set((a ?? []).map((s) => String(s).toLowerCase().trim()).filter(Boolean))).sort();
  const entryKeys = new Set((seed.entries ?? []).map((e) => canon(e.molecules).join('|')));
  let inertChecked = 0;
  for (const cohort of ['withheld_qualified', 'rescinded', 'not_representable'] as const) {
    for (const e of seed[cohort] ?? []) {
      const set = canon(e.molecules);
      if (set.length < 2 || entryKeys.has(set.join('|'))) continue;   // <2 molecules can't fire; shared sets fire via `entries`
      assert.equal(
        loaderFindings([med({ resolvedGeneric: set.join(' + ') })]).length, 0,
        `${cohort} set [${set.join(' + ')}] must never fire — the loader reads only \`entries\``,
      );
      inertChecked += 1;
    }
  }
  assert.ok(inertChecked > 0, 'expected at least one inert-cohort molecule set to prove isolation');
});

// ── C4 — signal identity ──────────────────────────────────────────────────────
const lv = (subject: string): OpdFinding => ({
  subject, verdict: 'low-value', confidence: 1, domain: 'prescribing_safety',
  rationale: 'r', evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
});

test('stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)', () => {
  const [fdc] = stampFindingIdentity([lv('Banned fixed-dose combination: mol-a + mol-b')]);
  assert.equal(fdc.signal_type, 'banned_fdc');   // banned_fdc is not a generic LVC bucket → retained without a named exception
  assert.equal(OPD_SIGNAL_TYPES.banned_fdc, 'Banned fixed-dose combination');
  // 0.81.10 (SIGNAL-TYPE-COLLAPSE): a GENERIC free-text LLM low-value finding still batches as
  // low_value_care (opdSignalType → `${domain}_low_value`, a generic bucket).
  for (const s of ['Unindicated vitamin D test', 'Perioperative PPI without indication']) {
    const [f] = stampFindingIdentity([lv(s)]);
    assert.equal(f.signal_type, 'low_value_care', s);
  }
  // …but a SPECIFIC deterministic type now RETAINS its own signal_type instead of collapsing — the fix.
  assert.equal(stampFindingIdentity([lv('Interaction (major): a + b')])[0].signal_type, 'drug_interaction');
  assert.equal(stampFindingIdentity([lv('Daily dose exceeds ceiling: x')])[0].signal_type, 'dose_ceiling_exceeded');
  assert.equal(stampFindingIdentity([lv('Duplicate prescription: x')])[0].signal_type, 'duplicate_prescription');
});

// ── C4 — quieting severity floor, both halves ─────────────────────────────────
test('severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule', () => {
  assert.equal(isSafetySignalType('banned_fdc'), true);
  assert.equal(ruleViolatesSeverityFloor({ action: 'demote', signal_type: 'banned_fdc' }), true);
  const hostile: Suppression = {
    id: 'hostile', signal_type: 'banned_fdc', discriminator: 'mol-a', match_kind: 'subject_contains',
    scope: 'all', doctor_uid: null, action: 'demote', active: true, status: 'active',
  };
  const stamped = stampFindingIdentity([lv('Banned fixed-dose combination: mol-a + mol-b')]);
  const { findings, quieted } = applyDemotes(stamped, null, [hostile]);
  assert.equal(quieted.length, 0);
  assert.equal((findings[0] as unknown as Record<string, unknown>).informational, undefined);
  assert.equal((findings[0] as unknown as Record<string, unknown>).quieted_by, undefined);
});
