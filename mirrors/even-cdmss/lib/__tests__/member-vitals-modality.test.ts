/**
 *   node --test --import tsx lib/__tests__/member-vitals-modality.test.ts
 *
 * CHEAP-DEFECT-BATCH Unit 2 (§4.1 D-A, §4.2 D-B, 2 Aug 2026) — the care-manager surface.
 *
 * ⚠️ DORMANT CODE, DELIBERATELY PRESERVED. The PRD's §4 correction withdrew the urgency claim:
 * /care/[uid] redirects to /care/login and the care token is not unlocked, so nobody has read the
 * false statement. Register T-7 keeps this code as the reference implementation of ClinicalState /
 * MemberState — and a reference implementation carrying a wrong join key is a trap for whoever
 * revives it. This is debt hygiene, not patient safety.
 *
 * D-A: vitals were matched to a visit on prescription_uid, populated on 308 of 5,275 rows (5.8%).
 *      consult_uid is populated on 5,253 (99.6%) and is the key lib/metabase.ts:91 already uses.
 * D-B: general_practitioner_prescription__vitals has been EMPTY on all 52,439 prescriptions since
 *      1 April 2026, so every member classified as majority 'remote' and three surfaces stated the
 *      member had only ever had remote or undocumented care. "No data" is not "remote care".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePictureConfidence, buildVitalsView, EMPTY_MODALITY, type ModalityMix } from '../member-state/present-augment.ts';
import { consultForPrescSql } from '../member-state/vitals-read.ts';

const SRC = readFileSync('lib/member-state/vitals-read.ts', 'utf8');
const mix = (o: Partial<ModalityMix> = {}): ModalityMix => ({ ...EMPTY_MODALITY, ...o });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · D-B — summariseModality's three cases
// ═════════════════════════════════════════════════════════════════════════════════════════════
// summariseModality is module-private, so it is exercised through the SQL-shaped rows it consumes
// via the source contract plus its two public consumers. The three cases are asserted on the
// resulting ModalityMix, which is the value every surface actually reads.

test('D-B case 1 — ALL rows documented: the ladder is unchanged', () => {
  // 3 of 3 in-person ⇒ in_person; 1 of 3 ⇒ mixed; 0 of 3 but all documented ⇒ remote.
  assert.equal(mix({ total: 3, documented: 3, inPerson: 3 }).majority, 'unknown',
    'the fixture only carries what the caller sets — the real ladder is asserted below on the source');
  const src = SRC.slice(SRC.indexOf('function summariseModality'), SRC.indexOf('async function fetchRows'));
  assert.ok(src.includes("inPerson > total / 2 ? 'in_person'"), 'in_person branch byte-identical');
  assert.ok(src.includes("inPerson > 0 ? 'mixed'"), 'mixed branch byte-identical');
  assert.ok(src.includes(": 'remote'"), 'remote branch byte-identical — a DOCUMENTED remote member still reads remote');
});

test('D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown', () => {
  const src = SRC.slice(SRC.indexOf('function summariseModality'), SRC.indexOf('async function fetchRows'));
  assert.ok(src.includes("documented === 0 ? 'unknown'"), 'the new branch');
  // it must sit AFTER the total===0 branch and BEFORE the in_person branch, or a real in-person
  // member with a blank field would be misclassified.
  const iTotal = src.indexOf("total === 0 ? 'unknown'");
  const iDoc = src.indexOf("documented === 0 ? 'unknown'");
  const iPerson = src.indexOf("inPerson > total / 2");
  assert.ok(iTotal >= 0 && iTotal < iDoc && iDoc < iPerson, 'ladder order: total, then documented, then the rest');
  // and `documented` counts only rows whose assess_mode is genuinely non-empty
  assert.ok(src.includes('const raw = str(r.assess_mode);') && src.includes('if (raw) documented++;'),
    'documented counts populated rows, not the UNDOCUMENTED fallback');
});

test('D-B case 3 — total === 0 still returns unknown, as it always did', () => {
  assert.equal(EMPTY_MODALITY.total, 0);
  assert.equal(EMPTY_MODALITY.majority, 'unknown');
  assert.equal(EMPTY_MODALITY.documented, 0, 'the new field is on EMPTY_MODALITY with value 0');
  const src = SRC.slice(SRC.indexOf('function summariseModality'), SRC.indexOf('async function fetchRows'));
  assert.ok(src.includes("total === 0 ? 'unknown'"), 'the pre-existing branch is untouched');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · D-B — the three surfaces stop claiming "remote"
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('picture confidence: unknown is AMBER, still counted, with the exact label', () => {
  const f = computePictureConfidence({
    lastContact: '2026-07-01', vitalsEver: false, modalityMix: mix({ total: 8, documented: 0, remoteOrUndocumented: 8 }),
    lastLab: '2026-01-01', problems: [], encounters: { opd: 8, ipd: 0 },
  }, '2026-08-02').factors.find((x) => x.key === 'modality')!;
  assert.equal(f.dot, 'a', 'amber — not knowing is a real limitation, but it is not knowing the care was remote');
  assert.equal(f.counted, true);
  assert.equal(f.label, 'Care modality not recorded');
});

test('picture confidence: in_person, mixed and remote branches are byte-identical', () => {
  const at = (m: Partial<ModalityMix>) => computePictureConfidence({
    lastContact: '2026-07-01', vitalsEver: false, modalityMix: mix(m),
    lastLab: '2026-01-01', problems: [], encounters: { opd: 3, ipd: 0 },
  }, '2026-08-02').factors.find((x) => x.key === 'modality')!;
  const inp = at({ total: 3, documented: 3, inPerson: 3, majority: 'in_person' });
  assert.equal(inp.dot, 'g'); assert.equal(inp.label, 'Care modality in-person exam');
  const mixed = at({ total: 3, documented: 3, inPerson: 1, majority: 'mixed' });
  assert.equal(mixed.dot, 'a'); assert.equal(mixed.label, 'Care modality mixed · some in-person');
  const rem = at({ total: 8, documented: 8, inPerson: 0, majority: 'remote' });
  assert.equal(rem.dot, 'r', 'a DOCUMENTED remote member is still red — that claim is true');
  assert.equal(rem.label, 'Care modality remote / undocumented · 0 in-person exam');
});

test('buildVitalsView: unknown gets the exact note; the other branch is unchanged', () => {
  const unknown = buildVitalsView(null, mix({ total: 8, documented: 0, remoteOrUndocumented: 8 }));
  assert.equal(unknown.modalityNote, 'Assessment modality was not recorded on any of the 8 visits.');
  // the documented-remote branch keeps its original wording, including the NOT_POSSIBLE clause
  const remote = buildVitalsView(null, mix({
    total: 8, documented: 8, remoteOrUndocumented: 8, majority: 'remote',
    counts: { NOT_POSSIBLE_IN_ONLINE_CONSULTATION: 1 },
  }));
  assert.equal(remote.modalityNote,
    'Across 8 visits, care was remote or undocumented — 1 marked “not possible in online consultation.”');
  // and no visits at all still yields no note
  assert.equal(buildVitalsView(null, EMPTY_MODALITY).modalityNote, null);
});

test('the call-context sentence no longer claims remote care when the modality is unknown', () => {
  const tsx = readFileSync('components/care/MemberStateCallContext.tsx', 'utf8');
  assert.ok(tsx.includes("modality.majority === 'unknown'"), 'the branch exists');
  assert.ok(tsx.includes('No vitals or exam findings captured on this note. How this member has been assessed is not recorded, so no exam history can be read from it.'),
    'the exact replacement text');
  assert.ok(tsx.includes('For this member, care has been remote / undocumented throughout'),
    'and the original text survives for every other case');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · D-A — consult_uid wins, prescription_uid still works
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback', () => {
  const fn = SRC.slice(SRC.indexOf('export async function readEncounterVitals'));
  const iConsult = fn.indexOf('consultOf.findIndex');
  const iPresc = fn.indexOf('prescOf.findIndex');
  assert.ok(iConsult >= 0, 'the consult_uid match exists');
  assert.ok(iPresc >= 0, 'and the prescription_uid match is KEPT as a fallback');
  assert.ok(iConsult < iPresc, 'consult_uid is tried first — it is populated on 99.6% of rows vs 5.8%');
  assert.ok(fn.includes('if (!thisVisit) {'), 'the fallback runs only when the consult match found nothing');
});

test('the vitals SELECT now carries consult_uid, and fetchRows exposes it', () => {
  assert.ok(SRC.includes('SELECT created_at, source, prescription_uid, consult_uid,'),
    'the column is selected');
  assert.ok(SRC.includes('consultOf: vitalsRows.map((r) => str(r.consult_uid)),'), 'and shaped per row');
});

test('the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail', () => {
  assert.equal(consultForPrescSql('abcdef123456'),
    `SELECT consult_uid FROM "individuals-prescriptions" WHERE uid = 'abcdef123456' LIMIT 1`);
  // the guard is what keeps an unvalidated string out of a query with no parameter binding
  for (const bad of ["x'; DROP TABLE y; --", '', 'sh', "' OR '1'='1"]) {
    assert.throws(() => consultForPrescSql(bad), /bad presc uid/, bad);
  }
  assert.ok(SRC.includes('.catch(() => [] as Record<string, unknown>[]);'), 'soft-fail on the resolver query');
  assert.ok(SRC.includes('return isUid(u) ? u : null;'), 'and a non-uid result degrades to null');
});

test('readEncounterVitals still never throws, and readMemberVitals is untouched', () => {
  const fn = SRC.slice(SRC.indexOf('export async function readEncounterVitals'));
  assert.ok(/catch\s*\{[\s\S]*EMPTY_MEMBER_VITALS/.test(fn), 'any failure returns EMPTY_MEMBER_VITALS');
  assert.ok(SRC.includes(`export async function readMemberVitals(individualUid: string): Promise<MemberVitals> {
  if (!isUid(individualUid)) return EMPTY_MEMBER_VITALS;
  const { vitals, modality } = await fetchRows(individualUid);
  const trend = vitals.filter(hasAnyVital);
  return { latest: trend[0] ?? null, trend, modality };
}`), 'readMemberVitals is byte-identical');
});
