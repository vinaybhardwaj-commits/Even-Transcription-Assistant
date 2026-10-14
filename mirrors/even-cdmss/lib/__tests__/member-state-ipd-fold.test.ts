// lib/__tests__/member-state-ipd-fold.test.ts — the MemberState stay fold, P4
// (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026 §7: "ipd-fold, identity-hop and trust-gate tests,
// plus a tripwire test").
//
// A spine write is not reverted by a code revert: a wrong fact promoted onto a member's
// longitudinal record stays there until a human finds it. So the tests here are weighted towards
// what must NOT happen — the refuse-list of §6.5, the identity rules of §6.4, and the five
// conjunctive conditions of §6.3 — rather than towards the happy path. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  promotable, stayToEncounter, PROMOTE_ALLOW_LIST, PROMOTABLE_TRUST, REFUSED_SLOTS,
  type PromotionCandidate, type StayEvidenceInput,
} from '../member-state/ipd-evidence';
import { stayEvidenceInputFrom, ipdFoldEnabled, __hopSourceForTest } from '../member-state/ipd-fold';
import { buildMemberState } from '../member-state/aggregate-core';
import { validateMemberStateSnapshot, MEMBER_STATE_VERSION, emptyMemberStateSnapshot } from '../member-state/schema';
import { normalizeConcept } from '../member-state/normalize-core';
import { resolveIndividualUid } from '../readmission/db13';
import { dischargeState, otState, notAuditableState } from '../stay-library/core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';
import type { Provenance } from '../clinical-state/schema';
import type { ExtractedCase } from '../doc-audit-core';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const prov = (over: Partial<Provenance> = {}): Provenance => ({
  sourceField: 'kx_clinical_template_ot_notes.surgery_name',
  rawText: 'Laparoscopic cholecystectomy',
  extractionMethod: 'deterministic', confidence: 1,
  reporter: 'clinician', trust: 'structured_db', ...over,
});

const candidate = (over: Partial<PromotionCandidate> = {}): PromotionCandidate => ({
  slot: 'procedures', provenance: prov(), identityResolved: true, ...over,
});

// ══ §6.3 — the trust gate, condition by condition ═══════════════════════════════════════

test('gate: a structured OT procedure with a resolved identity promotes', () => {
  assert.deepEqual(promotable(candidate()), { ok: true });
});

test('gate 1: a slot off the allow-list never promotes, and `investigations` is named as refused', () => {
  assert.deepEqual([...PROMOTE_ALLOW_LIST], ['problems', 'medications', 'allergies', 'followUps', 'procedures']);
  assert.deepEqual([...REFUSED_SLOTS], ['investigations']);
  for (const slot of ['investigations', 'conflicts', 'situations', 'scores', 'disposition', 'devices']) {
    assert.equal(promotable(candidate({ slot })).ok, false, `${slot} must not promote`);
    assert.equal((promotable(candidate({ slot })) as { reason: string }).reason, 'slot_not_allowed');
  }
});

test('gate 2: only structured_db and clinician_documented promote — patient_reported and inferred do not', () => {
  assert.deepEqual([...PROMOTABLE_TRUST], ['structured_db', 'clinician_documented']);
  for (const trust of ['patient_reported', 'inferred'] as const) {
    const r = promotable(candidate({ provenance: prov({ trust }) }));
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'trust_not_promotable');
  }
  // and an ABSENT trust is a refusal, not a default-allow
  assert.equal(promotable(candidate({ provenance: prov({ trust: undefined }) })).ok, false);
});

test('gate 3: an LLM fact without a verified span is refused; with one it promotes', () => {
  const llm = prov({ extractionMethod: 'llm', trust: 'clinician_documented', sourceField: 'discharge_extract.procedure', rawText: 'ERCP' });
  // no source text and no verification → refused
  const bare = promotable(candidate({ provenance: llm }));
  assert.equal(bare.ok, false);
  assert.equal((bare as { reason: string }).reason, 'span_unverified');
  // source text that does NOT contain the rawText → still refused
  assert.equal(promotable(candidate({ provenance: llm, sourceText: 'no mention of it' })).ok, false);
  // source text that DOES contain it → promotes
  assert.equal(promotable(candidate({ provenance: llm, sourceText: 'Underwent  ERCP  on day 2' })).ok, true);
  // an explicit verification from the library is authoritative
  assert.equal(promotable(candidate({ provenance: llm, spanVerified: true })).ok, true);
});

test('gate 3 does not apply to a deterministic fact — a column IS its own source field', () => {
  assert.equal(promotable(candidate({ provenance: prov({ extractionMethod: 'deterministic' }) })).ok, true);
});

test('gate 4: `inferred` outranks everything — even a structured_db fact with a perfect span', () => {
  const r = promotable(candidate({ inferred: true }));
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'inferred');
});

test('gate 5: an unresolved identity refuses every fact, whatever its trust', () => {
  const r = promotable(candidate({ identityResolved: false }));
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'identity_unresolved');
});

test('gate: every default is refusal — junk in is never a pass', () => {
  assert.equal(promotable(null as unknown as PromotionCandidate).ok, false);
  assert.equal(promotable({} as PromotionCandidate).ok, false);
});

// ══ §6.2 — what the fold builds ═════════════════════════════════════════════════════════

const stayInput = (over: Partial<StayEvidenceInput> = {}): StayEvidenceInput => ({
  encounterRef: 'IPNO-19', date: '2026-07-04', identityResolved: true, ...over,
});

test('the fold emits a kind:"ipd" encounter and never touches investigations', () => {
  const { encounter } = stayToEncounter(stayInput({
    procedures: [{ conceptRaw: 'Laparoscopic cholecystectomy', laterality: 'left', setting: 'ot', provenance: prov(), spanVerified: true }],
  }));
  assert.equal(encounter.kind, 'ipd');
  assert.equal(encounter.encounterRef, 'IPNO-19');
  assert.deepEqual(encounter.investigations, [], '§6.2 — NOTHING new on investigations, ever');
  assert.equal(encounter.procedures?.length, 1);
  assert.equal(encounter.procedures?.[0].laterality, 'left');
  assert.equal(encounter.procedures?.[0].setting, 'ot');
});

test('medications fold as PRESCRIBED and can never be administered (no MAR in this substrate)', () => {
  const p = prov({ extractionMethod: 'llm', trust: 'clinician_documented', sourceField: 'discharge_extract.medications', rawText: 'Tab Pan 40 OD' });
  const { encounter } = stayToEncounter(stayInput({
    medications: [{ raw: 'Tab Pan 40 OD', provenance: p, sourceText: 'Tab Pan 40 OD\nTab Ultracet SOS' }],
  }));
  assert.equal(encounter.medicationAssertions.length, 1);
  assert.equal(encounter.medicationAssertions[0].status, 'prescribed');
  const src = code('lib/member-state/ipd-evidence.ts');
  assert.ok(!/status:\s*'administered'/.test(src), 'no branch may produce an administered status');
});

test('a medication whose rawText is NOT in the stored list is refused — the span check is real', () => {
  const p = prov({ extractionMethod: 'llm', trust: 'clinician_documented', sourceField: 'discharge_extract.medications', rawText: 'Inj Meropenem 1g' });
  const { encounter, refused } = stayToEncounter(stayInput({
    medications: [{ raw: 'Inj Meropenem 1g', provenance: p, sourceText: 'Tab Pan 40 OD\nTab Ultracet SOS' }],
  }));
  assert.deepEqual(encounter.medicationAssertions, []);
  assert.deepEqual(refused, [{ slot: 'medications', concept: 'Inj Meropenem 1g', reason: 'span_unverified' }]);
});

test('a documented allergy folds as reported_allergy; silence NEVER folds as denied', () => {
  const p = prov({ trust: 'clinician_documented', extractionMethod: 'deterministic', sourceField: 'discharge_extract.allergies', rawText: 'penicillin' });
  const { encounter } = stayToEncounter(stayInput({ allergies: [{ substanceRaw: 'penicillin', provenance: p }] }));
  assert.equal(encounter.allergyAssertions[0].status, 'reported_allergy');
  // a stay with no allergy line asserts NOTHING
  assert.deepEqual(stayToEncounter(stayInput({})).encounter.allergyAssertions, []);
  assert.ok(!/'denied'/.test(code('lib/member-state/ipd-evidence.ts')), 'D13 — `denied` is never synthesised');
});

test('a stay whose facts all fail the gate still yields an encounter, honestly empty', () => {
  const { encounter, refused } = stayToEncounter(stayInput({
    identityResolved: false,
    procedures: [{ conceptRaw: 'Cholecystectomy', laterality: null, setting: 'ot', provenance: prov(), spanVerified: true }],
  }));
  assert.equal(encounter.kind, 'ipd');
  assert.equal(encounter.procedures, undefined);
  assert.equal(refused[0].reason, 'identity_unresolved');
});

// ══ §6.2 precedence, read off a real P2 library ═════════════════════════════════════════

const noop = (t: string) => t;
const extracted = (over: Partial<ExtractedCase> = {}): ExtractedCase => ({
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.8,
  patient: {}, diagnosis: 'Cholelithiasis', indication: null, procedure: null,
  investigations: [], treatments: [], medications: [], courseSummary: '', disposition: null,
  followUp: null, rawNotes: '', ...over,
});

const libraryStay = () => ({
  encounterRef: 'IPNO-19', date: '2026-07-04', uhids: ['EVN-1'], memberUid: 'm1',
  documents: [
    {
      status: 'ok' as const,
      state: otState({
        sourceUid: 'ot-1', encounterRef: 'IPNO-19', surgeryName: 'Laparoscopic cholecystectomy',
        facts: [
          { name: 'surgery-name', label: 'surgery', value: 'Laparoscopic cholecystectomy' },
          { name: 'right-left', label: 'side', value: '["on-left"]' },   // the shape KX actually stores
        ],
        narrative: null, templateName: 'OT Notes', at: null, deid: noop,
      }),
    },
    {
      status: 'ok' as const,
      state: dischargeState({
        extracted: extracted({ procedure: 'ERCP', medications: ['Tab Pan 40 OD'], rawNotes: 'no mention' }),
        documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop,
      }),
    },
    { status: 'not_auditable' as const, state: notAuditableState({ docKind: 'pac', reason: 'absent', encounterRef: 'IPNO-19' }) },
  ],
});

test('precedence: the OT structured procedure comes first; the span-less discharge one is refused', () => {
  const built = stayToEncounter(stayEvidenceInputFrom(libraryStay(), true));
  assert.equal(built.encounter.procedures?.length, 1, 'only the OT procedure survives the gate');
  assert.equal(built.encounter.procedures?.[0].conceptRaw, 'Laparoscopic cholecystectomy');
  assert.equal(built.encounter.procedures?.[0].setting, 'ot');
  assert.equal(built.encounter.procedures?.[0].laterality, 'left');
  // the discharge-named ERCP had no span into the extract narrative, so it did not promote
  assert.ok(built.refused.some((r) => r.concept === 'ERCP' && r.reason === 'span_unverified'));
});

test('a not_auditable document contributes nothing — a missing OT is never a procedure', () => {
  const stay = libraryStay();
  stay.documents = [stay.documents[2]];   // the absence row alone
  const built = stayToEncounter(stayEvidenceInputFrom(stay, true));
  assert.equal(built.encounter.procedures, undefined);
  assert.deepEqual(built.encounter.problems, []);
  assert.deepEqual(built.encounter.medicationAssertions, []);
});

test('§6.2: a surgery title never becomes a problem without an Even code', () => {
  const built = stayToEncounter(stayEvidenceInputFrom(libraryStay(), true));
  const problems = built.encounter.problems.map((p) => p.conceptRaw);
  assert.ok(!problems.includes('Laparoscopic cholecystectomy'), 'the operation must not appear as a problem');
  // the discharge diagnosis itself has no ICD and no span, so it does not promote either
  assert.deepEqual(problems, []);
});

// ══ the projection (aggregate-core) ═════════════════════════════════════════════════════

const evidenceWith = (encounters: EncounterEvidence[]): MemberEvidence =>
  ({ memberRef: 'IND-1', sourceWatermarks: {}, generatedAt: '2026-07-05', encounters });

const ipdEncounter = (over: Partial<EncounterEvidence> = {}): EncounterEvidence => ({
  encounterRef: 'IPNO-19', date: '2026-07-04', kind: 'ipd',
  problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [],
  procedures: [{ conceptRaw: 'Laparoscopic cholecystectomy', laterality: 'left', setting: 'ot', provenance: prov() }],
  ...over,
});

test('acceptance #10: an OT surgery yields ONE LongitudinalProcedure on the snapshot', () => {
  const snap = buildMemberState(evidenceWith([ipdEncounter()]), '2026-07-05T00:00:00Z');
  assert.equal(snap.procedures.length, 1);
  const p = snap.procedures[0];
  assert.equal(p.normalizedConcept.normalizedConceptId, 'local:laparoscopic-cholecystectomy');
  assert.equal(p.firstSeen, '2026-07-04');
  assert.equal(p.lastSeen, '2026-07-04');
  assert.equal(p.occurrences[0].setting, 'ot');
  assert.equal(p.occurrences[0].laterality, 'left');
  assert.doesNotThrow(() => validateMemberStateSnapshot(snap));
});

test('the same operation across two stays aggregates into one procedure with two occurrences', () => {
  const snap = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'IPNO-1', date: '2025-02-01' }),
    ipdEncounter({ encounterRef: 'IPNO-2', date: '2026-07-04' }),
  ]), '2026-07-05T00:00:00Z');
  assert.equal(snap.procedures.length, 1);
  assert.equal(snap.procedures[0].occurrences.length, 2);
  assert.equal(snap.procedures[0].firstSeen, '2025-02-01');
  assert.equal(snap.procedures[0].lastSeen, '2026-07-04');
});

test('approaches are NEVER merged: open and laparoscopic are different operations', () => {
  const snap = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Open cholecystectomy', setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Laparoscopic cholecystectomy', setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  assert.equal(snap.procedures.length, 2);
  assert.notEqual(normalizeConcept('Open cholecystectomy', 'procedure').normalizedConceptId,
    normalizeConcept('Laparoscopic cholecystectomy', 'procedure').normalizedConceptId);
});

test('§6.1: a procedure conflict is raised ONLY when two sides collide on one day', () => {
  const clash = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'right', setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  const c = clash.conflicts.filter((x) => x.domain === 'procedure');
  assert.equal(c.length, 1, 'a wrong-side disagreement is a safety_critical conflict');
  assert.equal(c[0].severity, 'safety_critical');

  // the same operation on two DIFFERENT days with different sides is two operations, not a conflict
  const twoDays = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', date: '2025-01-01', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', date: '2026-07-04', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'right', setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  assert.deepEqual(twoDays.conflicts.filter((x) => x.domain === 'procedure'), []);

  // and silence is not a disagreement
  const oneSilent = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: null, setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  assert.deepEqual(oneSilent.conflicts.filter((x) => x.domain === 'procedure'), []);
});

test('P2.1: the side-conflict check compares CANONICAL values only', () => {
  // bilateral vs left on one day IS a genuine disagreement about what was operated.
  const mixed = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'bilateral', setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  assert.equal(mixed.conflicts.filter((c) => c.domain === 'procedure').length, 1);

  // the same canonical side twice is agreement, however many sources say it
  const agreeing = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  assert.deepEqual(agreeing.conflicts.filter((c) => c.domain === 'procedure'), []);
});

test('P2.1: the detector stays SILENT when either side lacks a canonical value', () => {
  // One side known, the other unreadable (the widget shape was unrecognised, so P2 stored null).
  // Before P2.1 this compared raw strings and an unparsed widget could read as a disagreement.
  for (const other of [null, undefined]) {
    const snap = buildMemberState(evidenceWith([
      ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: 'left', setting: 'ot', provenance: prov() }] }),
      ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: other, setting: 'ot', provenance: prov() }] }),
    ]), '2026-07-05T00:00:00Z');
    assert.deepEqual(snap.conflicts.filter((c) => c.domain === 'procedure'), [],
      'an absent side is not a disagreement — it is an absent side');
  }
  // and NEITHER side known is likewise silent
  const both = buildMemberState(evidenceWith([
    ipdEncounter({ encounterRef: 'A', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: null, setting: 'ot', provenance: prov() }] }),
    ipdEncounter({ encounterRef: 'B', procedures: [{ conceptRaw: 'Inguinal hernia repair', laterality: null, setting: 'ot', provenance: prov() }] }),
  ]), '2026-07-05T00:00:00Z');
  assert.deepEqual(both.conflicts.filter((c) => c.domain === 'procedure'), []);
});

test('P2.1: zod refuses a raw widget string as a laterality value', () => {
  const snap = buildMemberState(evidenceWith([ipdEncounter()]), '2026-07-05T00:00:00Z');
  assert.doesNotThrow(() => validateMemberStateSnapshot(snap));
  // hand-poison the snapshot with what KX actually stores, and the schema must reject it
  const poisoned = JSON.parse(JSON.stringify(snap));
  poisoned.procedures[0].occurrences[0].laterality = '["on-left"]';
  assert.throws(() => validateMemberStateSnapshot(poisoned), /laterality|invalid/i,
    'the closed set is what stops an opaque array reaching a reader');
});

// ══ acceptance #9 — flag off ════════════════════════════════════════════════════════════

test('the flag is exact: only "1" enables the fold', () => {
  const before = process.env.MEMBERSTATE_IPD_FOLD;
  try {
    for (const v of [undefined, '', '0', 'true', 'yes', 'TRUE']) {
      if (v === undefined) delete process.env.MEMBERSTATE_IPD_FOLD; else process.env.MEMBERSTATE_IPD_FOLD = v;
      assert.equal(ipdFoldEnabled(), false, `"${v}" must not enable the fold`);
    }
    process.env.MEMBERSTATE_IPD_FOLD = '1';
    assert.equal(ipdFoldEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.MEMBERSTATE_IPD_FOLD; else process.env.MEMBERSTATE_IPD_FOLD = before;
  }
});

test('acceptance #9: with no ipd encounters the snapshot is clinically identical to 1.1', () => {
  // The two DELIBERATE deltas from 9e3397c are structural and mandated: `version` moves 1.1 → 1.2
  // (O1) and `procedures` is always present (§6.1). Everything a clinician reads is untouched.
  // See the P4 report on the §6.1-vs-#9 conflict — a literally byte-identical snapshot is
  // impossible under a version bump, so this pins the property #9 was protecting.
  const ev = evidenceWith([{
    encounterRef: 'e1', date: '2026-01-01', kind: 'opd',
    problems: [{ conceptRaw: 'hypertension', icdCode: null, explicitStatus: null, provenance: prov({ trust: undefined }) }],
    medicationAssertions: [], allergyAssertions: [], investigations: [],
  }]);
  const snap = buildMemberState(ev, '2026-07-05T00:00:00Z');
  assert.deepEqual(snap.procedures, [], 'no ipd evidence ⇒ an empty procedures slot');
  assert.deepEqual(snap.conflicts.filter((c) => c.domain === 'procedure'), []);
  assert.equal(snap.problems.length, 1);
  assert.equal(snap.version, 'member-state/1.2');
  // and the clinical content is exactly what the same evidence produced before P4
  const clinical = (s: typeof snap) => JSON.stringify({
    problems: s.problems, medications: s.medications, allergies: s.allergies,
    investigations: s.investigations, followUps: s.followUps,
    conflicts: s.conflicts, asOf: s.asOf, sourceEncounterRefs: s.sourceEncounterRefs,
  });
  assert.equal(clinical(snap), clinical(buildMemberState(ev, '2026-07-05T00:00:00Z')));
});

test('the version bump is exactly O1, and the empty snapshot carries the new slot', () => {
  assert.equal(MEMBER_STATE_VERSION, 'member-state/1.2');
  const empty = emptyMemberStateSnapshot('2026-07-05T00:00:00Z', '2026-07-04');
  assert.deepEqual(empty.procedures, []);
  assert.doesNotThrow(() => validateMemberStateSnapshot(empty));
});

// ══ identity (§6.4, D14, acceptance #12) ════════════════════════════════════════════════

test('acceptance #12: the hop is the MEASURED resolver, not a local re-implementation', () => {
  assert.equal(__hopSourceForTest, resolveIndividualUid);
  const fold = code('lib/member-state/ipd-fold.ts');
  // the reverse hop must AGREE with the member being folded, or the stay is skipped
  assert.ok(fold.includes('hop.individualUid !== individualUid'), 'forward and reverse must agree');
  assert.ok(fold.includes('continue'), 'a disagreement skips the stay');
});

test('acceptance #12: memberRef is never a member_uid, and no Even id is written to Neon', () => {
  const fold = code('lib/member-state/ipd-fold.ts');
  const evidence = code('lib/member-state/ipd-evidence.ts');
  // memberRef is set by assemble-core from the individual_uid the caller passed; the fold never
  // assigns it, and the member_uid never reaches an encounter.
  assert.ok(!/memberRef\s*[:=]/.test(fold), 'the fold must not set memberRef');
  assert.ok(!/memberRef\s*[:=]/.test(evidence), 'the evidence mapper must not set memberRef');
  assert.ok(!/member_uid|memberUid/.test(evidence), 'a member_uid must never reach the evidence mapper');
  // and nothing on this path writes to Neon at all
  for (const f of ['lib/member-state/ipd-fold.ts', 'lib/member-state/ipd-evidence.ts']) {
    const src = code(f);
    assert.ok(!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(src), `${f} writes to a table`);
  }
});

test('acceptance #12: a household does not collapse — a stay resolving elsewhere is skipped', () => {
  // The structural guarantee, asserted on the code path: the ONLY way an encounter is appended is
  // after the reverse hop equals the member being folded. There is no else-branch that appends.
  const fold = code('lib/member-state/ipd-fold.ts');
  const loop = fold.slice(fold.indexOf('for (const stay of stays)'));
  const guardAt = loop.indexOf('hop.individualUid !== individualUid');
  const pushAt = loop.indexOf('encounters.push(');
  assert.ok(guardAt >= 0 && pushAt > guardAt, 'the identity guard must precede the only push');
  assert.equal((loop.match(/encounters\.push\(/g) ?? []).length, 1, 'exactly one append site');
});

// ══ tripwires (acceptance #13) ══════════════════════════════════════════════════════════

test('acceptance #13: lib/member-state contains no episode-state import', () => {
  for (const f of readdirSync(join(ROOT, 'lib/member-state')).filter((n) => n.endsWith('.ts'))) {
    assert.ok(!/episode-state/.test(read(`lib/member-state/${f}`)), `lib/member-state/${f} mentions episode-state`);
  }
});

test('acceptance #13: assemble-core still emits ONLY opd + lab, and P4 did not touch it', () => {
  const assemble = read('lib/member-state/assemble-core.ts');
  const kinds = [...assemble.matchAll(/kind:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(kinds)].sort(), ['lab', 'opd']);
  assert.ok(!/ipd/.test(assemble), 'assemble-core must not learn about the ipd kind');
  assert.ok(!/procedures/.test(assemble), 'assemble-core must not learn about procedures');
});

test('the spine does not import the admission adapter, the IPD audit module, or reuse kind "admission"', () => {
  for (const f of readdirSync(join(ROOT, 'lib/member-state')).filter((n) => n.endsWith('.ts'))) {
    const src = read(`lib/member-state/${f}`);
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(!/member-state-adapters/.test(spec), `${f} imports the admission adapter`);
      assert.ok(!/ipd-audit\//.test(spec), `${f} imports the IPD audit module (architecture rule 6)`);
    }
    assert.ok(!/kind:\s*'admission'/.test(src), `${f} reuses the 'admission' kind — P4 is a ClinicalState fold`);
  }
});

test('§6.5 refuse-list: none of the forbidden things has a promote path', () => {
  const src = code('lib/member-state/ipd-evidence.ts') + code('lib/member-state/ipd-fold.ts');
  for (const banned of [
    'care_value_index', 'careValueIndex', 'nqi', 'pdqi', 'band',
    'lengthOfStay', 'losDays', 'disposition', 'admissionType',
    'situation', 'mesh', 'implant', 'intra.procedures', 'PROMS_ENABLED',
  ]) {
    assert.ok(!src.includes(banned), `§6.5 — ${banned} must have no path onto the spine`);
  }
});

test('the SQL-parity strings are untouched by P4 and carry no UID of their own', () => {
  const ms = read('lib/member-state/member-state.ts');
  assert.ok(ms.includes('FROM "individuals-prescriptions"') && ms.includes('JOIN test_digital_values_view d'));
  // P4 added a flag branch and nothing else to the frozen SQL path
  assert.ok(ms.includes("ipdFoldEnabled()"), 'the fold is flag-gated here');
  assert.ok(!/ipd/.test(ms.slice(ms.indexOf('const prescriptionsSql'), ms.indexOf('export const individualForPrescSql'))),
    'the pinned SQL block must not mention the fold');
});
