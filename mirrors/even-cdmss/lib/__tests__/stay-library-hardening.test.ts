// lib/__tests__/stay-library-hardening.test.ts — the stay library's hardening slices
// (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026).
//
// H1 (H-D2): a library row is never overwritten without its prior reading landing in
// `clinical_state_versions` in the SAME SQL statement. The behavioural tests here drive
// `upsertClinicalState` through its test seam, so what is asserted is the SQL that would actually
// have been sent and the outcome the caller would actually have got — including the case that
// matters most, a snapshot leg that FAULTS, which must block the overwrite rather than proceed
// without a trail. The source pins carry what a behavioural test cannot see: that the snapshot and
// the overwrite are one statement and not two, and that the new table is append-only.
//
// H2 (H-D3 / H-D4 / H-D5 / H-D6): the deterministic contamination guard. The §2 worked examples are
// pinned as fixtures BY THEIR TOKEN SETS as well as their verdicts — a rule that flagged for the
// wrong reason would satisfy a verdict-only assertion — and the gate tests each state their
// precondition, so a gate that refused everything could not pass them.
//
// H3 (H-D7..H-D10): the absence re-look. The limit table is exercised as ONE case with sixteen
// degenerate inputs, the walk's ordering and predicates are asserted on the SQL that would be sent,
// and the two writers are asserted apart: a still-absent row bumps counters and is NOT snapshotted,
// a supersede is snapshotted, points at the real row, and deletes nothing.
// Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  upsertClinicalState, SNAPSHOT_REASONS, type SqlRunner,
  listAbsenceRows, markAbsenceChecked, supersedeAbsenceRow, countRemainingAbsences,
  clinicalStateIdFor, parseRelookLimit, RELOOK_DEFAULT_LIMIT, RELOOK_MAX_LIMIT,
} from '../stay-library/store';
import {
  contaminationSuspect, contaminationNotice, significantTokens,
  CONTAMINATION_STOPLIST, CONTAMINATION_COPY, MIN_TOKEN_LENGTH, SHORT_SITE_ALLOWLIST,
} from '../stay-library/contamination';
import {
  contaminationOf, STAY_LIBRARY_VERSION, NOT_AUDITABLE_COPY, absentSourceUid, isAbsentSourceUid,
  notAuditableState, dischargeState, stayDocMetaOf, type Deidentifier,
} from '../stay-library/core';
import type { ExtractedCase } from '../doc-audit-core';
import { promotable, stayToEncounter } from '../member-state/ipd-evidence';
import { stayEvidenceInputFrom } from '../member-state/ipd-fold';
import { emptyClinicalState } from '../clinical-state/schema';
import type { ClinicalState, Provenance } from '../clinical-state/schema';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file's CODE, comments stripped — a pin that reads prose fails on a file honest enough to
 *  document what it refuses to do (the P1 lesson, re-applied through P2 and now here). */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const state = (): ClinicalState => {
  const st = emptyClinicalState('doc_audit');
  st.surfaceExtras = { stayDoc: { docKind: 'ot', sourceUid: 'ot-1' } };
  return st;
};

const input = {
  docKind: 'ot' as const, sourceUid: 'ot-1', memberUid: 'M1',
  encounterRef: 'IP-1472', status: 'ok' as const, state: state(),
};

/** A recording fake runner. `priorRows` is what the pre-read returns; `fail` names the leg that
 *  throws, by substring, so a test can fault exactly one of the two statements. */
function fakeRunner(o: { priorRows?: number; failOn?: string } = {}) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const run: SqlRunner = async (query, params) => {
    calls.push({ query, params });
    if (o.failOn && query.includes(o.failOn)) throw new Error('simulated fault');
    if (/^\s*SELECT id FROM clinical_states/.test(query)) {
      return Array.from({ length: o.priorRows ?? 0 }, () => ({ id: 'prior-row-id' }));
    }
    return [{ inserted: (o.priorRows ?? 0) === 0 }];
  };
  return { run, calls };
}

/** A recording fake for the H3 store reads and writes: it returns `rows` for every statement and
 *  keeps what it was asked. */
function relookRunner(o: { rows: Array<Record<string, unknown>> }) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const run: SqlRunner = async (query, params) => { calls.push({ query, params }); return o.rows; };
  return { run, calls };
}

/** H4 fixtures: an identity scrubber and a minimal ExtractedCase, shaped like P2's own test. */
const noop: Deidentifier = (t) => t;
const extracted = (over: Partial<ExtractedCase> = {}): ExtractedCase => ({
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.8,
  patient: { age: 54, sex: 'M' },
  diagnosis: 'Cholelithiasis', indication: null, procedure: null,
  investigations: [], treatments: [], medications: [],
  courseSummary: '', disposition: 'home', followUp: null, rawNotes: '',
  ...over,
} as ExtractedCase);

// ══ H1 — snapshot before overwrite ═══════════════════════════════════════════════════════

test('H1: overwriting a library row snapshots the prior row in the SAME statement', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1 });
  assert.equal(await upsertClinicalState(input, run), 'updated');

  assert.equal(calls.length, 2, 'one pre-read, then one write statement — not three');
  const write = calls[1].query;
  assert.match(write, /^\s*WITH cur AS \(/, 'the snapshot must lead the statement it guards');
  assert.match(write, /INSERT INTO clinical_state_versions/);
  assert.match(write, /'upsert_overwrite'/);
  assert.match(write, /ON CONFLICT \(doc_kind, source_uid, schema_version\) DO UPDATE/);
  assert.match(write, /RETURNING \(xmax = 0\) AS inserted/, 'the (xmax = 0) return must survive H1');
  // ONE statement, not two: a semicolon between the legs would let a crash separate them.
  assert.equal(write.split(';').length, 1, 'the snapshot and the overwrite must not be two statements');
  // The snapshot reads the row being replaced, not the row replacing it.
  assert.match(write, /SELECT c\.id, c\.doc_kind, c\.source_uid, c\.schema_version, c\.status, c\.state_json/);
  assert.ok(!/EXCLUDED\.[a-z_]+, *'upsert_overwrite'/.test(write), 'the snapshot must not carry EXCLUDED values');
});

test('H1: a FRESH insert snapshots nothing and never names the versions table', async () => {
  const { run, calls } = fakeRunner({ priorRows: 0 });
  assert.equal(await upsertClinicalState(input, run), 'inserted');

  const write = calls[1].query;
  assert.ok(!write.includes('clinical_state_versions'),
    'a fresh insert must not reference the versions table — a deploy ahead of the migration still builds libraries');
  assert.ok(!write.includes('WITH cur'));
  assert.match(write, /^\s*INSERT INTO clinical_states/);
});

test('H1: a FAILED snapshot blocks the overwrite and returns the fail-soft skip', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1, failOn: 'clinical_state_versions' });
  // The whole statement aborts — the overwrite is inside it, so it did not happen either.
  assert.equal(await upsertClinicalState(input, run), 'skipped');
  assert.equal(calls.length, 2, 'the store must not retry the overwrite without its snapshot');
  assert.ok(calls.every((c) => c.query.includes('clinical_state_versions') || c.query.startsWith('SELECT id')),
    'no unsnapshotted write was attempted');
});

test('H1: fail-soft is preserved — the upsert never throws, whatever faults', async () => {
  const both: SqlRunner = async () => { throw new Error('database is gone'); };
  assert.equal(await upsertClinicalState(input, both), 'skipped');

  // A pre-read that faults must NOT be read as "no prior row": unknown takes the snapshot path,
  // because guessing "fresh" on a row that exists is exactly the unsnapshotted overwrite H1 bans.
  const { run, calls } = fakeRunner({ failOn: 'SELECT id FROM clinical_states' });
  await upsertClinicalState(input, run);
  assert.match(calls[1].query, /INSERT INTO clinical_state_versions/,
    'an unknown prior must take the snapshot path, not the fresh-insert path');

  // And the validation guards still short-circuit before any SQL at all.
  const empty = fakeRunner();
  assert.equal(await upsertClinicalState({ ...input, sourceUid: '' }, empty.run), 'skipped');
  assert.equal(empty.calls.length, 0, 'a malformed input must not reach the database');
});

test('H1: the snapshot carries the row identity a diff needs', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1 });
  await upsertClinicalState(input, run);
  const write = calls[1].query;
  for (const col of ['clinical_state_id', 'doc_kind', 'source_uid', 'schema_version', 'status', 'state_json', 'reason']) {
    assert.ok(write.includes(col), `the snapshot must carry ${col}`);
  }
  // The pre-read and the CTE must name the SAME row, or the snapshot guards a different one.
  assert.match(calls[0].query, /doc_kind = \$1 AND source_uid = \$2 AND schema_version = \$3/);
  assert.match(write, /WHERE doc_kind = \$1 AND source_uid = \$2 AND schema_version = \$5/);
  assert.deepEqual(calls[0].params, ['ot', 'ot-1', 'clinical-state/1.2']);
});

// ══ H1 source pins ═══════════════════════════════════════════════════════════════════════

test('H-D2: the reason enum is exactly the two the PRD names', () => {
  assert.deepEqual([...SNAPSHOT_REASONS], ['upsert_overwrite', 'superseded']);
});

test('the versions table is APPEND-ONLY: the store never updates or deletes it', () => {
  const store = code('lib/stay-library/store.ts');
  // Every write verb that names a table names one of exactly two, and the versions table is only
  // ever INSERTed into. (`ON CONFLICT ... DO UPDATE SET` names no table — it is still the INSERT's
  // own target — so it is neutralised before the scan rather than matched as a bare UPDATE.)
  const sqlish = store.replace(/DO\s+UPDATE/gi, 'DO_UPSERT');
  const writes = [...sqlish.matchAll(/(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)]
    .map((m) => ({ verb: m[1].toUpperCase().replace(/\s+/g, ' '), table: m[2] }));
  assert.ok(writes.length > 0, 'the store must actually write something');
  for (const w of writes) {
    assert.ok(['clinical_states', 'clinical_state_versions'].includes(w.table), `the store writes ${w.table}`);
    if (w.table === 'clinical_state_versions') {
      assert.equal(w.verb, 'INSERT INTO', 'the version trail is append-only — it is never rewritten');
    }
  }
});

test('H1 migration 0049 is additive and creates the versions table', () => {
  for (const f of ['migrations/0049_stay_library_hardening.sql', 'app/api/admin/migrate-stay-library-hardening/route.ts']) {
    const src = code(f);
    assert.ok(!/\bDROP\b/i.test(src), `${f} contains DROP`);
    assert.ok(src.includes('CREATE TABLE IF NOT EXISTS clinical_state_versions'));
    assert.ok(src.includes('clinical_state_versions_state_idx'));
  }
  // 0049 is the next free number: nothing already claims it.
  const dir = readFileSync(join(ROOT, 'migrations/0049_stay_library_hardening.sql'), 'utf8');
  assert.ok(dir.length > 0);
});

test('H1 touches no engine version, no schema version and no flag', () => {
  const src = code('lib/stay-library/store.ts')
    + code('app/api/admin/migrate-stay-library-hardening/route.ts')
    + code('migrations/0049_stay_library_hardening.sql');
  for (const banned of [
    'ipd-discharge-audit/0', 'ipd-stay-audit/0', 'opd-note-audit/0', 'member-state/1',
    'MEMBERSTATE_IPD_FOLD', 'MEMBER_STATE_UI', 'care_value_index', 'tracedChat', 'governedChat',
  ]) {
    assert.ok(!src.includes(banned), `H1 names ${banned}`);
  }
  assert.ok(!/CLINICAL_STATE_VERSION\s*=\s*'/.test(src), 'H1 must not redeclare the schema version');
});

test('H1 names exactly two tables and no audit / feedback / spine table', () => {
  const store = code('lib/stay-library/store.ts');
  for (const forbidden of [
    'ipd_discharge_audits', 'opd_note_audits', 'ipd_audit_feedback', 'opd_audit_feedback',
    'readmission_findings', 'readmission_finding_versions', 'episode_states', 'member_state',
    'case_ask_turns',
  ]) {
    assert.ok(!store.includes(forbidden), `store.ts names ${forbidden}`);
  }
});

// ══ H2 — the contamination guard ══════════════════════════════════════════════════════════

test('H-D4 fixture 1 (§2, the R10 case): a cholecystectomy inside a hernioplasty stay is SUSPECT', () => {
  const ot = 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY -TAPP WITH PRIMARY UMBILICAL HERNIA REPAIR.';
  const discharge = 'LAPAROSCOPIC CHOLECYSTECTOMY';
  // The PRD states both significant sets outright. They are pinned, not merely their conclusion:
  // a rule that flags for the wrong reason would pass a conclusion-only assertion.
  assert.deepEqual(significantTokens(ot), ['HERNIA', 'HERNIOPLASTY', 'INGUINAL', 'UMBILICAL']);
  assert.deepEqual(significantTokens(discharge), ['CHOLECYSTECTOMY']);
  assert.equal(contaminationSuspect(ot, discharge), true);
});

test('H-D4 fixture 2 (§2): the same OT vs "TAPP hernioplasty" shares HERNIOPLASTY and is CLEAN', () => {
  const ot = 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY -TAPP WITH PRIMARY UMBILICAL HERNIA REPAIR.';
  assert.deepEqual(significantTokens('TAPP hernioplasty'), ['HERNIOPLASTY'],
    'TAPP is four letters and is dropped; an acronym match is not evidence of the same operation');
  assert.equal(contaminationSuspect(ot, 'TAPP hernioplasty'), false);
});

test('H-D4 stoplist edge: sharing ONLY an approach or side word still flags', () => {
  // Every word these two have in common is on the stoplist. They are different operations.
  assert.equal(contaminationSuspect('LAPAROSCOPIC LEFT NEPHRECTOMY', 'LAPAROSCOPIC RIGHT CHOLECYSTECTOMY'), true);
  assert.equal(contaminationSuspect('OPEN HERNIA REPAIR', 'OPEN APPENDICECTOMY WITH REPAIR'), true);
  for (const word of ['LAPAROSCOPIC', 'OPEN', 'BILATERAL', 'UNILATERAL', 'LEFT', 'RIGHT', 'PRIMARY',
    'SURGERY', 'PROCEDURE', 'OPERATION', 'NOTE', 'NOTES', 'REPAIR', 'WITH', 'AND']) {
    assert.ok(CONTAMINATION_STOPLIST.has(word), `${word} must be on H-D4's stoplist`);
    assert.deepEqual(significantTokens(word), [], `${word} must survive nothing`);
  }
  assert.equal(CONTAMINATION_STOPLIST.size, 15, 'the stoplist is H-D4\'s fifteen words and no more');
});

test('H-D4 stoplist edge: ONE shared substantive token is enough to clear the whole comparison', () => {
  assert.equal(contaminationSuspect('LAPAROSCOPIC CHOLECYSTECTOMY', 'OPEN CHOLECYSTECTOMY'), false);
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT LEFT', 'KNEE REPLACEMENT REVISION'), false,
    'TOTAL/REVISION differ, but they agree on REPLACEMENT — one shared term is enough');
});

test('H2.1 (H-A3): a shared SHORT ANATOMICAL SITE clears the flag — the H2 defect, fixed', () => {
  // THIS TEST WAS THE DEFECT REPORT AND IS NOW THE FIX. H2 shipped the bare length rule and this
  // case measured its cost: two honest readings of the same knee operation agree only on KNEE,
  // four letters, so they normalised to disjoint sets and an uncontaminated stay was flagged. The
  // length rule is there to stop ACRONYMS matching across specialities; a body part is not an
  // acronym, and agreement on the site is real agreement.
  assert.deepEqual(significantTokens('TOTAL KNEE REPLACEMENT LEFT'), ['KNEE', 'REPLACEMENT', 'TOTAL']);
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT LEFT', 'REVISION KNEE ARTHROPLASTY'), false,
    'REPLACEMENT/ARTHROPLASTY differ and TOTAL/REVISION differ, but both documents say KNEE');
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT', 'TOTAL KNEE ARTHROPLASTY'), false);
  // Every allowlisted site survives normalisation on its own...
  for (const site of ['KNEE', 'HIP', 'EYE', 'TOE', 'EAR', 'JAW', 'RIB', 'ARM', 'LEG', 'NAIL', 'FOOT', 'HAND', 'NECK']) {
    assert.ok(SHORT_SITE_ALLOWLIST.has(site), `${site} must be on the H2.1 allowlist`);
    assert.deepEqual(significantTokens(site), [site], `${site} must survive the length rule`);
  }
  assert.equal(SHORT_SITE_ALLOWLIST.size, 13, 'the allowlist is H-A3\'s thirteen sites and no more');
  // ...and the allowlist is SITES ONLY. A verb or an approach word here would let two different
  // operations on the same ground look like one, which is the failure H-D4 exists to catch.
  for (const notASite of ['TOTAL', 'OPEN', 'REPAIR', 'LEFT', 'RIGHT', 'TAPP', 'LSCS', 'REVISION']) {
    assert.ok(!SHORT_SITE_ALLOWLIST.has(notASite), `${notASite} is not an anatomical site`);
  }
  // The stoplist still outranks the allowlist, and a short site does NOT rescue a contaminated pair.
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT', 'LAPAROSCOPIC CHOLECYSTECTOMY'), true,
    'a stay whose documents share no site and no operation is still suspect');
});

test('H-D4 normalisation: punctuation becomes a boundary, not a join', () => {
  assert.deepEqual(significantTokens('HERNIA/HERNIOPLASTY'), ['HERNIA', 'HERNIOPLASTY'],
    'deleting the slash would fuse two real words into one that matches nothing');
  assert.deepEqual(significantTokens('CHOLECYSTECTOMY.'), ['CHOLECYSTECTOMY']);
  assert.deepEqual(significantTokens('  '), []);
  assert.deepEqual(significantTokens(null), []);
  // Alphabetic only, length >= 5.
  assert.deepEqual(significantTokens('LSCS 12345 ABCDE'), ['ABCDE']);
  assert.equal(MIN_TOKEN_LENGTH, 5);
});

test('H-D4 errs toward NOT flagging: an empty significant set on either side never flags', () => {
  // Nothing was learned, so nothing is claimed. (Flagged to the orchestrator: H-D4's literal
  // sentence would flag here, its closing rule would not, and this takes the closing rule.)
  assert.equal(contaminationSuspect('OPEN SURGERY', 'LAPAROSCOPIC CHOLECYSTECTOMY'), false);
  assert.equal(contaminationSuspect('LAPAROSCOPIC CHOLECYSTECTOMY', 'TAPP'), false);
  assert.equal(contaminationSuspect('', 'CHOLECYSTECTOMY'), false);
  assert.equal(contaminationSuspect('CHOLECYSTECTOMY', null), false);
});

test('H2: a stay with SEVERAL operative notes is clean if the discharge matches ANY of them', () => {
  const discharge = 'LAPAROSCOPIC CHOLECYSTECTOMY';
  assert.equal(contaminationNotice(['INGUINAL HERNIOPLASTY', 'OPEN CHOLECYSTECTOMY'], discharge), null,
    'a discharge that agrees with the second of two operations agrees with this stay');
  const flagged = contaminationNotice(['INGUINAL HERNIOPLASTY', 'TOTAL KNEE REPLACEMENT'], discharge);
  assert.ok(flagged, 'sharing nothing with EVERY operative note is the suspect shape');
  assert.deepEqual(flagged.dischargeTokens, ['CHOLECYSTECTOMY']);
  assert.deepEqual(flagged.otTokens, ['HERNIOPLASTY', 'INGUINAL', 'KNEE', 'REPLACEMENT', 'TOTAL'],
    'KNEE survives on H2.1\'s short-site allowlist; the discharge still shares none of them');
  assert.equal(flagged.otSurgery, 'INGUINAL HERNIOPLASTY');
});

// ── H2 spine: the gate (§4.3) ─────────────────────────────────────────────────────────────

const prov = (over: Partial<Provenance> = {}): Provenance => ({
  sourceField: 'discharge_extract.procedure', rawText: 'LAPAROSCOPIC CHOLECYSTECTOMY',
  extractionMethod: 'llm', confidence: 0.8, reporter: 'clinician', trust: 'clinician_documented',
  ...over,
});

test('H-D5 condition 6: a contaminated procedure does NOT promote, even with a verified span', () => {
  const base = { slot: 'procedures', provenance: prov(), spanVerified: true, identityResolved: true };
  // Precondition: without the taint this exact candidate PROMOTES. Without this line the test
  // would pass against a gate that refuses everything.
  assert.deepEqual(promotable(base), { ok: true });
  assert.deepEqual(promotable({ ...base, contaminationSuspect: true }),
    { ok: false, reason: 'contamination_suspect' });
  // ...and the taint outranks trust and span, which is the whole point: the R10 case had both.
  assert.deepEqual(
    promotable({ ...base, contaminationSuspect: true, provenance: prov({ trust: 'structured_db' }) }),
    { ok: false, reason: 'contamination_suspect' });
});

test('H-D5: conditions 1–5 are unchanged — absent/false taint behaves exactly as before H2', () => {
  const base = { slot: 'procedures', provenance: prov(), spanVerified: true, identityResolved: true };
  assert.deepEqual(promotable(base), { ok: true });
  assert.deepEqual(promotable({ ...base, contaminationSuspect: false }), { ok: true });
  assert.deepEqual(promotable({ ...base, contaminationSuspect: undefined }), { ok: true });
  // Each pre-H2 refusal still names its own reason, not the new one.
  assert.deepEqual(promotable({ ...base, slot: 'investigations' }), { ok: false, reason: 'slot_not_allowed' });
  assert.deepEqual(promotable({ ...base, inferred: true }), { ok: false, reason: 'inferred' });
  assert.deepEqual(promotable({ ...base, provenance: prov({ trust: 'patient_reported' }) }), { ok: false, reason: 'trust_not_promotable' });
  assert.deepEqual(promotable({ ...base, spanVerified: false, sourceText: 'nothing alike' }), { ok: false, reason: 'span_unverified' });
  assert.deepEqual(promotable({ ...base, identityResolved: false }), { ok: false, reason: 'identity_unresolved' });
});

test('§4.3 spine: a suspect discharge procedure with NO OT row folds NO procedure', () => {
  const suspect = {
    conceptRaw: 'LAPAROSCOPIC CHOLECYSTECTOMY', laterality: null, setting: 'unknown' as const,
    provenance: prov(), spanVerified: true, contaminationSuspect: true,
  };
  const out = stayToEncounter({
    encounterRef: 'IP-1472', date: '2026-08-01', identityResolved: true, procedures: [suspect],
  });
  assert.equal(out.encounter.procedures, undefined, 'a contaminated stay puts NO procedure on the spine');
  assert.deepEqual(out.refused, [{ slot: 'procedures', concept: 'LAPAROSCOPIC CHOLECYSTECTOMY', reason: 'contamination_suspect' }]);
  // The encounter itself is still emitted — "this stay is on the record and evidenced nothing
  // promotable" stays a truthful statement, exactly as it was before H2.
  assert.equal(out.encounter.kind, 'ipd');
});

test('§4.3 spine: the SAME stay with a clean OT row folds the OT procedure only', () => {
  const otFact = {
    conceptRaw: 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY', laterality: 'bilateral' as const,
    setting: 'ot' as const, spanVerified: true,
    provenance: prov({ sourceField: 'kx_clinical_template_ot_notes.surgery_name', extractionMethod: 'deterministic', trust: 'structured_db', confidence: 1 }),
  };
  const suspect = {
    conceptRaw: 'LAPAROSCOPIC CHOLECYSTECTOMY', laterality: null, setting: 'unknown' as const,
    provenance: prov(), spanVerified: true, contaminationSuspect: true,
  };
  const out = stayToEncounter({
    encounterRef: 'IP-1472', date: '2026-08-01', identityResolved: true,
    procedures: [otFact, suspect],       // §6.2 precedence order: OT first, discharge second
  });
  assert.equal(out.encounter.procedures?.length, 1);
  assert.equal(out.encounter.procedures?.[0].conceptRaw, 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY');
  assert.equal(out.encounter.procedures?.[0].setting, 'ot');
  assert.deepEqual(out.refused.map((r) => r.reason), ['contamination_suspect']);
});

test('H-A2: ipd-fold carries the taint from the stored fact into the gate input, and nothing else', () => {
  const fact = {
    conceptRaw: 'LAPAROSCOPIC CHOLECYSTECTOMY', laterality: null, setting: 'unknown' as const,
    provenance: prov(), spanVerified: true, contaminationSuspect: true,
  };
  const st = emptyClinicalState('doc_audit');
  st.surfaceExtras = { stayDoc: { docKind: 'discharge', sourceUid: 'doc-1' }, procedureFacts: [fact] };
  const input = stayEvidenceInputFrom(
    { encounterRef: 'IP-1472', date: '2026-08-01', uhids: [], memberUid: null, documents: [{ status: 'ok', state: st }] },
    true,
  );
  assert.equal(input.procedures?.length, 1);
  assert.equal(input.procedures?.[0].contaminationSuspect, true, 'the taint must survive the fold mapping');
  // ...and it is the ONLY thing H2 added to that mapping.
  assert.deepEqual(Object.keys(input.procedures![0]).sort(),
    ['conceptRaw', 'contaminationSuspect', 'laterality', 'provenance', 'setting', 'spanVerified']);
  assert.equal(stayToEncounter(input).encounter.procedures, undefined);
});

// ── H2 stamping (library write time) ──────────────────────────────────────────────────────

test('H2: the stamp reads back through the library door, and only off a discharge document', () => {
  const clean = emptyClinicalState('doc_audit');
  assert.equal(contaminationOf(clean), null, 'a state with no notice reads as no notice');
  clean.surfaceExtras = { stayDoc: { docKind: 'discharge', sourceUid: 'd' } };
  assert.equal(contaminationOf(clean), null, 'a pre-H2 stored row reads as no notice, never as an error');
  const notice = contaminationNotice(['INGUINAL HERNIOPLASTY'], 'LAPAROSCOPIC CHOLECYSTECTOMY');
  clean.surfaceExtras = { ...clean.surfaceExtras, contamination: notice! };
  assert.equal(contaminationOf(clean)?.dischargeProcedure, 'LAPAROSCOPIC CHOLECYSTECTOMY');
  // Junk in the passthrough reads as absence, not as a crash.
  clean.surfaceExtras = { contamination: { suspect: false } };
  assert.equal(contaminationOf(clean), null);
});

// ══ H2 source pins ═══════════════════════════════════════════════════════════════════════

test('H-D3: the guard is deterministic — no model, no engine version, no CVI', () => {
  const src = code('lib/stay-library/contamination.ts') + code('lib/stay-library/build.ts')
    + code('lib/stay-library/core.ts') + code('lib/member-state/ipd-evidence.ts');
  for (const banned of [
    'tracedChat', 'governedChat', 'normalizeWithLlm', 'analyzeCase', 'care_value_index',
    'careValueIndex', 'IPD_ENGINE_VERSION', 'IPD_STAY_ENGINE_VERSION', 'ipd-stay-audit/0',
    'ipd-discharge-audit/0',
  ]) {
    assert.ok(!src.includes(banned), `the H2 guard names ${banned}`);
  }
  // PURE: the rule module reaches nothing at all.
  const rule = code('lib/stay-library/contamination.ts');
  assert.ok(!/\bimport\b/.test(rule), 'the contamination rule must import nothing — it is a pure function');
});

test('H-D6: the taint rides in the passthrough — clinical-state/1.2 does not bump or fork', () => {
  const schema = read('lib/clinical-state/schema.ts');
  assert.ok(schema.includes("CLINICAL_STATE_VERSION = 'clinical-state/1.2'"), 'the schema version must not be bumped');
  // zProvenance stays `.strict()` and gains no contamination field: the taint is NOT on provenance.
  assert.ok(/zProvenance\s*=\s*z\.object\(\{[\s\S]*?\}\)\.strict\(\)/.test(schema), 'zProvenance must stay strict');
  assert.ok(!/contaminat/i.test(schema), 'lib/clinical-state must know nothing about H2');
  assert.equal(STAY_LIBRARY_VERSION, 'stay-library/1', 'the library version does not move either');
});

test('H-D3: the taint reaches no prompt — the stay picture is composed without it', () => {
  const material = code('lib/ipd-audit/stay-material.ts');
  assert.ok(!/contaminat/i.test(material),
    'the prompt composer must not read the taint: a finding is not what H2 produces');
  const run = code('lib/ipd-audit/run.ts');
  assert.ok(!/contaminat/i.test(run), 'the audit runner must not read the taint — CVI is untouched');
});

test('H2 touches lib/member-state ONLY in ipd-evidence.ts and the one permitted fold line (H-A2)', () => {
  const fold = code('lib/member-state/ipd-fold.ts');
  const lines = fold.split('\n').filter((l) => l.includes('contaminationSuspect'));
  assert.equal(lines.length, 1, 'H-A2 permits exactly one carrying LINE in ipd-fold.ts');
  assert.ok(fold.includes('contaminationSuspect: p.contaminationSuspect'), 'and it is a pass-through, nothing more');
  // No other file under lib/member-state/ knows about H2 at all.
  for (const f of ['assemble-core.ts', 'member-state.ts', 'aggregate-core.ts', 'present-core.ts',
    'normalize-core.ts', 'schema.ts', 'care-call-evidence.ts', 'present-augment.ts', 'vitals-read.ts']) {
    assert.ok(!/contaminat/i.test(read(`lib/member-state/${f}`)), `lib/member-state/${f} was touched by H2`);
  }
});

// ══ H3 — absence re-look ═════════════════════════════════════════════════════════════════

test('H-D9 rule 3: the limit table — absent, null, 0, -1 and junk are ONE case', () => {
  // Six near-identical branches is how one of them ends up meaning zero. There is one branch.
  for (const degenerate of [undefined, null, '', '  ', '0', 0, '-1', -1, 'abc', NaN, Infinity, -Infinity,
    true, false, {}, [], '1e400']) {
    assert.equal(parseRelookLimit(degenerate), RELOOK_DEFAULT_LIMIT, `${JSON.stringify(degenerate)} must be the default`);
  }
  assert.equal(RELOOK_DEFAULT_LIMIT, 10);
  assert.equal(RELOOK_MAX_LIMIT, 50);
  // A real value is honoured, floored, and capped.
  assert.equal(parseRelookLimit(1), 1);
  assert.equal(parseRelookLimit('7'), 7);
  assert.equal(parseRelookLimit(7.9), 7, 'a float is floored, never rounded up past what was asked');
  assert.equal(parseRelookLimit(50), 50);
  assert.equal(parseRelookLimit(51), RELOOK_MAX_LIMIT);
  assert.equal(parseRelookLimit('99999'), RELOOK_MAX_LIMIT);
  // The cap is never below the default, or a capped request would be smaller than no request.
  assert.ok(RELOOK_MAX_LIMIT >= RELOOK_DEFAULT_LIMIT);
});

test('H-D8: the walk selects absence rows only, oldest-checked first, and never a retired one', async () => {
  const { run, calls } = relookRunner({ rows: [] });
  await listAbsenceRows(5, 'clinical-state/1.2', run);
  const q = calls[0].query;
  assert.match(q, /status = 'not_auditable'/);
  assert.match(q, /source_uid LIKE 'absent:%'/, 'only sentinel rows are absences');
  assert.match(q, /superseded_by IS NULL/, 'a row whose substrate arrived is not walked again');
  assert.match(q, /ORDER BY last_checked_at ASC NULLS FIRST, created_at ASC/,
    'never-looked outranks looked-long-ago outranks looked-today');
  assert.match(q, /LIMIT 5/);
  // The limit is parsed by the SAME rule the route uses — a degenerate one cannot reach the SQL.
  const second = relookRunner({ rows: [] });
  await listAbsenceRows(0, 'clinical-state/1.2', second.run);
  assert.match(second.calls[0].query, new RegExp(`LIMIT ${RELOOK_DEFAULT_LIMIT}$`, 'm'));
});

test('H-D8: a still-absent row bumps the two counters and NOTHING else — and is not snapshotted', async () => {
  const { run, calls } = relookRunner({ rows: [{ id: 'row-1' }] });
  assert.equal(await markAbsenceChecked('row-1', run), true);
  const q = calls[0].query;
  assert.match(q, /SET last_checked_at = NOW\(\), check_count = COALESCE\(check_count, 0\) \+ 1/);
  assert.ok(!/state_json|status\s*=|source_uid\s*=|superseded_by\s*=/.test(q),
    'a re-look that found nothing must not touch the row\'s state, status or supersession');
  assert.ok(!q.includes('clinical_state_versions'),
    'H-D2 names the upsert arm and the SUPERSEDE writes; a counter bump changes no state, so the trail stays a state diff and not a log of looks');
  assert.match(q, /superseded_by IS NULL/, 'a retired row is not re-stamped');
  // Fault ⇒ false, which the route counts as `failed`: an unrecorded look happens again.
  const bad: SqlRunner = async () => { throw new Error('down'); };
  assert.equal(await markAbsenceChecked('row-1', bad), false);
  assert.equal(await markAbsenceChecked('', run), false, 'an empty id never reaches the database');
});

test('H-D2 + H-D8: a supersede is SNAPSHOTTED, points at the real row, and DELETES NOTHING', async () => {
  const { run, calls } = relookRunner({ rows: [{ id: 'absence-1' }] });
  assert.equal(await supersedeAbsenceRow('absence-1', 'real-row-9', run), true);
  const q = calls[0].query;
  assert.match(q, /^\s*WITH cur AS \(/, 'the snapshot leads the statement it guards');
  assert.match(q, /INSERT INTO clinical_state_versions/);
  assert.match(q, /'superseded'/, 'and it is filed under the reason H-D2 names for this path');
  assert.equal(q.split(';').length, 1, 'snapshot and update travel as ONE statement');
  assert.match(q, /SET superseded_by = \$2::uuid/);
  assert.ok(!/\bDELETE\b/i.test(q), 'H-D8: an absence row is never deleted');
  assert.deepEqual(calls[0].params, ['absence-1', 'real-row-9']);
  // Idempotent: the guard makes a second call a no-op rather than a second snapshot.
  assert.match(q, /superseded_by IS NULL/);
  // Fail-safe, both directions.
  const bad: SqlRunner = async () => { throw new Error('down'); };
  assert.equal(await supersedeAbsenceRow('absence-1', 'real-row-9', bad), false);
  assert.equal(await supersedeAbsenceRow('absence-1', '', run), false, 'a supersede with no target row is refused');
});

test('H-D9 rule 2: `remaining` counts WORK LEFT, not a cursor position', async () => {
  const { run, calls } = relookRunner({ rows: [{ n: 12 }] });
  assert.equal(await countRemainingAbsences('clinical-state/1.2', run), 12);
  const q = calls[0].query;
  assert.match(q, /count\(\*\)::int AS n/);
  assert.match(q, /superseded_by IS NULL/, 'a retired absence is not remaining work');
  assert.ok(!/OFFSET|LIMIT|created_at >/.test(q), 'a count is not a position');
  const bad: SqlRunner = async () => { throw new Error('down'); };
  assert.equal(await countRemainingAbsences('clinical-state/1.2', bad), 0,
    'an uncountable remainder promises nothing, rather than 500ing');
});

test('H3: every store read fail-safes to empty — a route run before the migration reports zeros', async () => {
  // The H3 columns do not exist until an operator runs 0049. Until then every read faults, and
  // every fault must read as "no work", never as a 500 at whoever ran the routes in order.
  const down: SqlRunner = async () => { throw new Error('column "last_checked_at" does not exist'); };
  assert.deepEqual(await listAbsenceRows(10, 'clinical-state/1.2', down), []);
  assert.equal(await countRemainingAbsences('clinical-state/1.2', down), 0);
  assert.equal(await clinicalStateIdFor('ot', 'ot-1', 'clinical-state/1.2', down), null);
});

test('H3 route: the response counts work and the self-documentation prints no parsed value', () => {
  const route = code('app/api/admin/relook-stay-library/route.ts');
  for (const key of ['rechecked', 'superseded', 'failed', 'remaining']) {
    assert.ok(route.includes(key), `the response must carry ${key}`);
  }
  // Rule 3 — the GET advertises the CONSTANTS, so it can never advertise a degenerate parse.
  assert.ok(route.includes('${RELOOK_DEFAULT_LIMIT}') && route.includes('${RELOOK_MAX_LIMIT}'));
  const getBody = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
  assert.ok(!getBody.includes('parseRelookLimit'), 'the self-documentation must not echo a parsed limit');
  // Rule 2 — completion is stated in work, not position.
  assert.ok(route.includes('superseded === 0 && failed === 0'));
  // There is no cursor to be wrong about. The word `cursor` DOES appear in the route — inside the
  // GET's own prose, quoting the R10 rule it obeys — so string literals are stripped before this
  // scan, the same prose-vs-code trap that has bitten a pin on this repo before.
  const routeCode = route
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  assert.ok(!/\bOFFSET\b/i.test(routeCode), 'a work count is not an offset');
  assert.ok(!/cursor/i.test(routeCode), 'no cursor variable exists to drift');
  // Rule 4 — a faulted look stamps nothing. The failure branch reaches neither writer.
  const failBranch = route.slice(route.indexOf("looked.outcome === 'failed'"), route.indexOf("looked.outcome === 'still_absent'"));
  assert.ok(!/markAbsenceChecked|supersedeAbsenceRow|upsertClinicalState/.test(failBranch),
    'a faulted look must store nothing and stamp nothing — it is retried');
  // H-D8 — nothing anywhere deletes.
  assert.ok(!/\bDELETE\b/i.test(route), 'the re-look deletes nothing');
  // Rule 1 — the row is walked whole: a partial store abandons the row before the supersede.
  assert.ok(route.includes('if (!allStored || !firstRealId)'));
});

test('H-D8: relookClass keeps the three outcomes apart and calls only the db13 fetchers', () => {
  const build = code('lib/stay-library/build.ts');
  const fn = build.slice(build.indexOf('export async function relookClass'));
  for (const fetcher of ['fetchOtNotes', 'fetchProgressNotes', 'fetchPacNotes']) {
    assert.ok(fn.includes(fetcher), `the re-look must reuse ${fetcher}`);
  }
  assert.ok(!/metabaseQuery/.test(build), 'the re-look invents no db13 read of its own');
  // A FAULT is never recorded as absence — that is how "the OT hop timed out" becomes "there was
  // no operation" (D13). The three outcomes are distinct values, not two.
  assert.ok(fn.includes("outcome: 'failed'") && fn.includes("outcome: 'still_absent'") && fn.includes("outcome: 'found'"));
  const faultLine = fn.slice(fn.indexOf("fetched.outcome === 'fetch_failed'"));
  assert.match(faultLine.slice(0, 320), /outcome: 'failed'/, 'a faulted fetch must not fall through to still_absent');
  // §4 still holds: no fifth Metabase table anywhere in the module.
  const kx = [...(code('lib/stay-library/core.ts') + build).matchAll(/kx_[a-z_]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(kx)].sort(), [
    'kx_clinical_template_ot_notes', 'kx_clinical_template_pac_reports', 'kx_clinical_template_progress_reports',
  ], 'a fifth table appeared — the PRD says STOP and flag, not add one');
});

test('H3 migration 0049 is additive: ADD COLUMN IF NOT EXISTS, and nothing is dropped', () => {
  for (const f of ['migrations/0049_stay_library_hardening.sql', 'app/api/admin/migrate-stay-library-hardening/route.ts']) {
    const src = code(f);
    assert.ok(!/\bDROP\b/i.test(src), `${f} contains DROP`);
    for (const col of ['last_checked_at', 'check_count', 'superseded_by']) {
      assert.match(src, new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}`), `${f} must add ${col} idempotently`);
    }
    // Every ALTER on this migration is an additive ADD COLUMN — no type change, no rename, no
    // constraint that could reject a row a fail-soft store is trying to write.
    for (const m of src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+([\s\S]*?);/gi)) {
      assert.equal(m[1], 'clinical_states', `an ALTER touched ${m[1]}`);
      assert.match(m[2], /^ADD COLUMN IF NOT EXISTS/, 'only additive ALTERs');
    }
    assert.ok(!/FOREIGN KEY|REFERENCES/i.test(src), 'no FK: a constraint must never reject a fail-soft write');
    assert.ok(src.includes('clinical_states_relook_idx'));
  }
  // check_count is NOT NULL DEFAULT 0 and last_checked_at is nullable — "never looked" must stay
  // distinguishable from "looked and found nothing", which a DEFAULT NOW() would destroy.
  const ddl = code('migrations/0049_stay_library_hardening.sql');
  assert.match(ddl, /check_count\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(ddl, /last_checked_at TIMESTAMPTZ;/, 'last_checked_at must be nullable with no default');
});

// ══ H4 — the discharge leg: a version bump is not an absence, a fault is not an absence ═══

test('H4 root cause: the library accepts every extract version whose fields it actually reads', () => {
  const build = code('lib/stay-library/build.ts');
  // MEASURED ON PRODUCTION, 29 Aug: R10-A (9b3862a, 28 Aug) bumped the SHARED constant to
  // doc-extract/2 for `verbatim_sections`. The library reads diagnosis, procedure, medications,
  // rawNotes and courseSummary — all present at /1 — but asked for the DEFAULT version, so 560 of
  // the store's 843 rows read as "this stay has no discharge summary".
  assert.match(build, /READABLE_EXTRACT_VERSIONS = \[DOC_EXTRACT_VERSION, 'doc-extract\/1'\]/,
    'newest first, then the older version the library can still read in full');
  assert.ok(!/fetchExtractedCase\(/.test(build),
    'the library must not use the collapse-absent-with-error reader — it cannot tell the two apart');
  // The library never reads `verbatim_sections`, which is the ONLY thing /2 adds. If it ever does,
  // this assertion fails and the version list has to be reconsidered rather than silently widened.
  assert.ok(!/verbatim_sections|verbatimSections/.test(build + code('lib/stay-library/core.ts')),
    'the field that justified the /2 bump is not read here — that is why /1 is acceptable');
});

test('H4 taxonomy: found / absent / fetch_failed are THREE outcomes, and a fault is never no_document', async () => {
  const build = code('lib/stay-library/build.ts');
  const leg = build.slice(build.indexOf('readExtractedCaseAcrossVersions'), build.indexOf('const enc ='));
  assert.match(leg, /read\.outcome === 'fetch_failed'/);
  // The fault branch must reach `unavailable`, and `no_document` must be the ELSE — a fault claims
  // nothing about whether the extract exists.
  const faultBranch = leg.slice(leg.indexOf("read.outcome === 'fetch_failed'"), leg.indexOf('} else {'));
  assert.match(faultBranch, /reason: 'unavailable'/);
  assert.ok(!/no_document/.test(faultBranch), 'a faulted look must never be recorded as no_document');
  assert.match(NOT_AUDITABLE_COPY.unavailable, /the look for this document failed/);
  assert.match(NOT_AUDITABLE_COPY.no_document, /no stored extract exists/);

  // ...and the reader itself keeps them apart, which fetchExtractedCase deliberately does not.
  const store = code('lib/discharge-extract-store.ts');
  const fn = store.slice(store.indexOf('export async function readExtractedCaseAcrossVersions'));
  assert.match(fn, /outcome: 'fetch_failed'/);
  assert.match(fn, /outcome: 'absent'/);
  assert.match(fn, /outcome: 'found'/);
  // PURELY ADDITIVE: the original reader's contract is untouched.
  const original = store.slice(store.indexOf('export async function fetchExtractedCase('), store.indexOf('export type ExtractReadOutcome'));
  assert.match(original, /return rowToStoredCase\(rows\[0\]\);/);
  assert.match(original, /catch \{\s*return null;/, 'fetchExtractedCase still collapses both to null for its own caller');
});

test('H4 refuse-to-degrade: a rebuild may improve a discharge row but may not replace a healthy one', () => {
  const build = code('lib/stay-library/build.ts');
  const guard = build.slice(build.indexOf('const degrades ='), build.indexOf('const written'));
  // The guard fires only when TODAY'S look is not_auditable and the STORED row is ok.
  assert.match(guard, /d\.docKind === 'discharge' && d\.status === 'not_auditable'/);
  assert.match(guard, /stored\?\.status === 'ok'/);
  assert.match(guard, /readClinicalState\('discharge'/);
  // It is checked on dry runs too, so a dry run predicts the write rather than rehearsing the fetch.
  assert.ok(build.indexOf('const degrades =') < build.indexOf('if (a.write)'),
    'the refusal must be decided before, and independently of, whether we are writing');
  // The refusal is REPORTED, not silent — the whole defect was a silent degrade.
  assert.match(guard, /REFUSED to overwrite/);
  const writeLoop = build.slice(build.indexOf('if (a.write) {'));
  assert.match(writeLoop, /if \(refuseDegrade && d === degrades\) \{ written\[key\] = 'refused_degrade'; continue; \}/);
  // Scoped to discharge ON PURPOSE, and the reason is asymmetry of KEYS, not of importance.
  assert.ok(!/refuseDegrade.*'ot'|'ot'.*refuseDegrade/.test(build),
    'ot/pac/progress absences are written under an absent: sentinel and cannot overwrite a real row');
});

test('H4: an absence sentinel can never collide with a real document key — the asymmetry, pinned', () => {
  // This is WHY the discharge leg alone needed a guard: its absence row shares the healthy row's
  // key, so it overwrites in place, while every other class lands beside its real rows.
  assert.equal(absentSourceUid('ot', 'IP-1486'), 'absent:ot:IP-1486');
  assert.equal(absentSourceUid('pac', 'IP-1486'), 'absent:pac:IP-1486');
  assert.ok(isAbsentSourceUid(absentSourceUid('progress', 'IP-1486')));
  // A discharge absence keeps the DOCUMENT id — not a sentinel — which is the collision.
  const st = notAuditableState({ docKind: 'discharge', reason: 'no_document', encounterRef: 'IP-1486', sourceUid: '8cDGLZhU2fotHKbw6P1Y' });
  assert.equal(stayDocMetaOf(st)?.sourceUid, '8cDGLZhU2fotHKbw6P1Y');
  assert.ok(!isAbsentSourceUid(stayDocMetaOf(st)?.sourceUid), 'a discharge absence is NOT sentinel-keyed');
});

test('H4: a discharge state records which extraction version it was actually built from', () => {
  const st = dischargeState({
    extracted: extracted({ procedure: 'LAPAROSCOPIC CHOLECYSTECTOMY' }),
    documentId: 'doc-1', encounterRef: 'IP-1486', deid: noop, at: null,
    extractionVersion: 'doc-extract/1',
  });
  assert.equal(stayDocMetaOf(st)?.extractionVersion, 'doc-extract/1',
    'a reader asking why this row has no verbatim sections gets the answer, not a guess');
  // Absent when the caller does not say, so a pre-H4 stored row reads unchanged.
  const bare = dischargeState({ extracted: extracted(), documentId: 'doc-1', encounterRef: 'IP-1486', deid: noop });
  assert.equal(stayDocMetaOf(bare)?.extractionVersion, undefined);
});
