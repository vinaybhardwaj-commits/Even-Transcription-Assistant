// lib/__tests__/stay-library-core.test.ts — the per-stay ClinicalState library, P2
// (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026 §7: "library writer (per-document, not_auditable
// paths, fail-soft store)").
//
// The behavioural tests carry the rules the PRD makes falsifiable in §8: a stay with three
// documents yields three states with spans (#6); a stay with only a discharge records OT as
// not_auditable and invents no procedure (#6); no stay without a MAR produces an `administered`
// assertion (#7). The source tests carry what a behavioural test cannot see — that this module
// writes exactly one table, invents no Metabase table, and neither bumps nor forks the ClinicalState
// schema. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  absentSourceUid, assertNoAdministered, dischargeState, isAbsentSourceUid, narrativeDocState,
  notAuditableState, otState, procedureFactsOf, stayDocMetaOf,
  DOC_KINDS, DOC_KIND_SOURCE, NOT_AUDITABLE_COPY, STAY_LIBRARY_VERSION,
  canonicalLaterality, LATERALITY_VALUES,
  type Deidentifier,
} from '../stay-library/core';
import { spanReport, type BuiltDoc } from '../stay-library/build';
import { CLINICAL_STATE_VERSION, validateClinicalState } from '../clinical-state/schema';
import type { ExtractedCase } from '../doc-audit-core';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file's CODE, comments stripped — a pin that reads prose fails on a file honest enough to
 *  document what it refuses to do (the P1 lesson, re-applied). */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

/** Identity-preserving scrubber for the cases where de-id is not what is under test. */
const noop: Deidentifier = (t) => t;
/** A real one: the stay's patient is "Ramesh Kumar", UHID "EVN-99812". */
const scrub: Deidentifier = (t) => t
  .replace(/Ramesh Kumar|Ramesh|Kumar/gi, '[PATIENT]')
  .replace(/EVN-99812/gi, '[UHID]');

const extracted = (over: Partial<ExtractedCase> = {}): ExtractedCase => ({
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.8,
  patient: { age: 54, sex: 'M' },
  diagnosis: 'Cholelithiasis', indication: null, procedure: null,
  investigations: ['USG abdomen'], treatments: [], medications: [],
  courseSummary: '', disposition: 'home', followUp: null, rawNotes: '',
  ...over,
});

// ══ discharge ═══════════════════════════════════════════════════════════════════════════

test('discharge: the stored extract maps through the EXISTING to-audit-family path', () => {
  const st = dischargeState({
    extracted: extracted({ medications: ['Tab Pan 40 OD'], procedure: 'Laparoscopic cholecystectomy' }),
    documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop, at: '2026-08-01T00:00:00Z',
  });
  assert.equal(st.version, CLINICAL_STATE_VERSION, 'the schema version is NOT bumped by this ship');
  assert.equal(st.surface, 'doc_audit');
  assert.equal(stayDocMetaOf(st)?.docKind, 'discharge');
  assert.equal(stayDocMetaOf(st)?.sourceUid, 'doc-1');
  assert.equal(stayDocMetaOf(st)?.status, 'ok');
  // the adapter's own extras survive alongside the library header
  assert.equal((st.surfaceExtras as Record<string, unknown>).docType, 'discharge_summary');
  assert.deepEqual(st.positives.map((p) => p.concept), ['Cholelithiasis']);
});

test('discharge: a procedure the extract NAMES but cannot span is recorded unverified, not dropped and not trusted', () => {
  // The extractor keeps no span into the PDF. Recording spanVerified:true here would make P4's
  // trust gate vacuous; dropping the fact would lose a real clinical claim. So: kept, marked false.
  const st = dischargeState({
    extracted: extracted({ procedure: 'Laparoscopic cholecystectomy', rawNotes: 'admitted with biliary colic' }),
    documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop,
  });
  const [p] = procedureFactsOf(st);
  assert.equal(p.conceptRaw, 'Laparoscopic cholecystectomy');
  assert.equal(p.spanVerified, false);
  assert.equal(p.provenance.extractionMethod, 'llm');
  assert.equal(p.provenance.trust, 'clinician_documented');
  assert.equal(p.setting, 'unknown', 'a named procedure is not evidence of a theatre episode');
  assert.equal(p.laterality, null, 'laterality never comes from a discharge summary');
});

test('discharge: a procedure that IS in the extract narrative verifies its span, with offsets', () => {
  const st = dischargeState({
    extracted: extracted({
      procedure: 'Laparoscopic cholecystectomy',
      rawNotes: 'Underwent Laparoscopic cholecystectomy on day 2. Uneventful.',
    }),
    documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop,
  });
  const [p] = procedureFactsOf(st);
  assert.equal(p.spanVerified, true);
  assert.equal(typeof p.provenance.startOffset, 'number');
  assert.ok((p.provenance.endOffset ?? 0) > (p.provenance.startOffset ?? 0));
});

test('discharge: the medication list is PRESCRIBED and can never be administered (§8 #7)', () => {
  const st = dischargeState({
    extracted: extracted({ medications: ['Tab Pan 40 OD', 'Tab Ultracet SOS'] }),
    documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop,
  });
  assert.equal(st.medicationAssertions.length, 2);
  for (const m of st.medicationAssertions) assert.equal(m.status, 'prescribed');
  assert.ok(!st.medicationAssertions.some((m) => m.status === 'administered'));
});

// ══ OT — the deterministic-first class ══════════════════════════════════════════════════

const otRow = (over: Partial<Parameters<typeof otState>[0]> = {}) => otState({
  sourceUid: 'ot-uid-1', encounterRef: 'IPNO-19',
  surgeryName: 'Laparoscopic cholecystectomy',
  facts: [{ name: 'surgery-name', label: 'surgery', value: 'Laparoscopic cholecystectomy' }],
  narrative: 'Port sites closed. Blood loss minimal.',
  templateName: 'OT Notes', at: '2026-08-02T05:00:00Z', deid: noop,
  ...over,
});

test('OT: the structured surgery_name column is the procedure, at structured_db trust', () => {
  const st = otRow();
  assert.deepEqual(st.procedures, ['Laparoscopic cholecystectomy']);
  const [p] = procedureFactsOf(st);
  assert.equal(p.provenance.trust, 'structured_db');
  assert.equal(p.provenance.extractionMethod, 'deterministic');
  assert.equal(p.provenance.sourceField, 'kx_clinical_template_ot_notes.surgery_name');
  assert.equal(p.setting, 'ot');
  assert.equal(p.spanVerified, true, 'a structured column IS the named source field');
});

test('OT: laterality comes ONLY from the row\'s right-left fact — never from the title', () => {
  const guessable = otRow({
    surgeryName: 'Left inguinal hernia repair',
    facts: [{ name: 'surgery-name', label: 'surgery', value: 'Left inguinal hernia repair' }],
  });
  assert.equal(procedureFactsOf(guessable)[0].laterality, null, 'a title that says "left" is a title, not a side');

  const stated = otRow({
    surgeryName: 'Inguinal hernia repair',
    facts: [
      { name: 'surgery-name', label: 'surgery', value: 'Inguinal hernia repair' },
      { name: 'right-left', label: 'side', value: '["on-left"]' },
    ],
  });
  assert.equal(procedureFactsOf(stated)[0].laterality, 'left');
});

// ══ P2.1 (addendum A6) — the laterality widget ══════════════════════════════════════════

test('P2.1: the THREE shapes measured on live db13 canonicalise correctly', () => {
  // Measured 27 Aug on the four orchestrator-picked stays: IP-1486, IPNO-641, IPNO-657.
  assert.equal(canonicalLaterality('["on-left"]'), 'left');
  assert.equal(canonicalLaterality('["on-right"]'), 'right');
  assert.equal(canonicalLaterality('["on-right","on-left"]'), 'bilateral', 'a multi-select with both sides IS bilateral');
  assert.equal(canonicalLaterality('["on-left","on-right"]'), 'bilateral', 'order must not matter');
  assert.equal(canonicalLaterality(null), null);
  assert.equal(canonicalLaterality(''), null);
  assert.equal(canonicalLaterality('[]'), null);
  assert.deepEqual([...LATERALITY_VALUES], ['left', 'right', 'bilateral']);
});

test('P2.1: an UNRECOGNISED shape yields NO side — a new token must never become a wrong one', () => {
  for (const shape of [
    '["on-middle"]',            // a token the allowlist does not know
    '["on-left","on-middle"]',  // one unknown token disqualifies the whole value
    '{"side":"left"}',          // valid JSON, wrong shape
    '["on-left", 3]',           // a non-string element
    '[["on-left"]]',            // nested
    '42',
    'left-ish',
    'both',
  ]) {
    assert.equal(canonicalLaterality(shape), null, `${shape} must not resolve to a side`);
  }
});

test('P2.1: a bare legacy token still reads, because an older row may not be JSON', () => {
  assert.equal(canonicalLaterality('on-left'), 'left');
  assert.equal(canonicalLaterality('ON-RIGHT'), 'right');
});

test('P2.1: the verbatim widget string is KEPT even when the shape is unrecognised', () => {
  const weird = otRow({
    facts: [
      { name: 'surgery-name', label: 'surgery', value: 'Inguinal hernia repair' },
      { name: 'right-left', label: 'side', value: '["on-middle"]' },
    ],
  });
  const [p] = procedureFactsOf(weird);
  assert.equal(p.laterality, null, 'no canonical value survives an unrecognised shape');
  assert.equal(p.lateralityProvenance?.rawText, '["on-middle"]', 'the verbatim string is the only record of what the form held');
  assert.equal(p.lateralityProvenance?.sourceField, 'kx_clinical_template_ot_notes.component_json.right-left');
  assert.equal(p.lateralityProvenance?.trust, 'structured_db', 'parsing a widget is reading a field, not deriving a fact');
  assert.equal(p.lateralityProvenance?.extractionMethod, 'deterministic');
  // and the raw value is still recoverable from the stored facts, as it was before P2.1
  const otFacts = (weird.surfaceExtras as Record<string, unknown>).otFacts as Array<{ name: string; value: string }>;
  assert.ok(otFacts.some((f) => f.name === 'right-left' && f.value === '["on-middle"]'));
});

test('P2.1: a recognised widget carries BOTH the canonical side and its verbatim provenance', () => {
  const [p] = procedureFactsOf(otRow({
    facts: [
      { name: 'surgery-name', label: 'surgery', value: 'Inguinal hernia repair' },
      { name: 'right-left', label: 'side', value: '["on-right","on-left"]' },
    ],
  }));
  assert.equal(p.laterality, 'bilateral');
  assert.equal(p.lateralityProvenance?.rawText, '["on-right","on-left"]');
});

test('P2.1: no raw widget string can reach the stored state as a laterality VALUE', () => {
  const st = otRow({
    surgeryName: 'Inguinal hernia repair',
    facts: [
      { name: 'surgery-name', label: 'surgery', value: 'Inguinal hernia repair' },
      { name: 'right-left', label: 'side', value: '["on-left"]' },
    ],
  });
  const [p] = procedureFactsOf(st);
  assert.ok(!/\[|\]/.test(String(p.laterality)), 'the canonical side must not be an array-shaped string');
  // the finding's display value is the canonical word too
  const finding = st.positives.find((f) => f.concept === 'Inguinal hernia repair');
  assert.equal(finding?.value, 'left');
});

test('OT: operative findings become a finding with a real source field', () => {
  const st = otRow({
    facts: [
      { name: 'surgery-name', label: 'surgery', value: 'Laparoscopic cholecystectomy' },
      { name: 'opfinf', label: 'operative findings', value: 'Distended gallbladder, multiple calculi' },
    ],
  });
  const f = st.positives.find((x) => x.concept.startsWith('Distended'));
  assert.ok(f, 'operative findings must reach the state');
  assert.equal(f!.provenance.sourceField, 'kx_clinical_template_ot_notes.component_json.opfinf');
  assert.equal(f!.provenance.extractionMethod, 'deterministic');
});

test('OT: a row with no structured surgery name yields NO procedure and says so', () => {
  const st = otRow({ surgeryName: null, facts: [] });
  assert.deepEqual(procedureFactsOf(st), []);
  assert.deepEqual(st.procedures ?? [], []);
  assert.ok(st.missingCriticalData.some((m) => /no structured surgery name/i.test(m)));
});

test('OT: every string that becomes state passes through the de-identifier', () => {
  const st = otState({
    sourceUid: 'ot-uid-1', encounterRef: 'IPNO-19',
    surgeryName: 'Cholecystectomy for Ramesh Kumar',
    facts: [{ name: 'opfinf', label: 'operative findings', value: 'EVN-99812 — calculi seen' }],
    narrative: 'Ramesh Kumar tolerated the procedure well.',
    templateName: 'OT Notes', at: null, deid: scrub,
  });
  const blob = JSON.stringify(st);
  assert.ok(!/Ramesh/i.test(blob), 'a patient name reached stored state');
  assert.ok(!/EVN-99812/i.test(blob), 'a UHID reached stored state');
  assert.ok(blob.includes('[PATIENT]') && blob.includes('[UHID]'));
});

// ══ PAC / progress — narrative only, and never a procedure ══════════════════════════════

test('PAC and progress carry narrative and NEVER a procedure, however surgical the text', () => {
  for (const docKind of ['pac', 'progress'] as const) {
    const st = narrativeDocState({
      docKind, sourceUid: `${docKind}-1`, encounterRef: 'IPNO-19',
      narrative: 'Planned for laparoscopic cholecystectomy tomorrow. Fit for GA.',
      templateName: 'PAC', at: '2026-08-01T09:00:00Z', deid: noop,
    });
    assert.deepEqual(procedureFactsOf(st), [], `${docKind} must not evidence a procedure`);
    assert.deepEqual(st.procedures ?? [], []);
    assert.equal(stayDocMetaOf(st)?.docKind, docKind);
    assert.match(String((st.surfaceExtras as Record<string, unknown>).narrative), /cholecystectomy/);
  }
});

// ══ not_auditable — the absence rows ════════════════════════════════════════════════════

test('not_auditable: the four reasons stay APART, and none of them reads as a clean result', () => {
  for (const reason of ['absent', 'unavailable', 'empty', 'no_document'] as const) {
    const st = notAuditableState({ docKind: 'ot', reason, encounterRef: 'IPNO-19' });
    const meta = stayDocMetaOf(st)!;
    assert.equal(meta.status, 'not_auditable');
    assert.equal(meta.reason, reason);
    assert.deepEqual(st.positives, [], 'an absence carries no findings');
    assert.deepEqual(procedureFactsOf(st), [], 'an absence NEVER invents a procedure');
    assert.deepEqual(st.medicationAssertions, []);
    assert.ok(st.missingCriticalData.some((m) => m.includes('operative note')), 'the class must be named as missing');
  }
  // The load-bearing distinction: a faulted look must never read as "the document is not filed".
  assert.match(NOT_AUDITABLE_COPY.unavailable, /not evidence the document is missing/);
  assert.notEqual(NOT_AUDITABLE_COPY.unavailable, NOT_AUDITABLE_COPY.absent);
});

test('not_auditable: the sentinel key is derived from the STAY, so a rebuild replaces it in place', () => {
  const a = absentSourceUid('ot', 'IPNO-19');
  assert.equal(a, absentSourceUid('ot', 'IPNO-19'), 'the sentinel must be stable across runs');
  assert.notEqual(a, absentSourceUid('pac', 'IPNO-19'), 'classes must not collide');
  assert.notEqual(a, absentSourceUid('ot', 'IPNO-20'), 'stays must not collide');
  assert.ok(isAbsentSourceUid(a) && !isAbsentSourceUid('ot-uid-1'));
  assert.equal(absentSourceUid('ot', null), 'absent:ot:unknown-stay');
});

// ══ MAR ═════════════════════════════════════════════════════════════════════════════════

test('§8 #7: an administered assertion is refused loudly, not logged and continued', () => {
  const st = dischargeState({ extracted: extracted({ medications: ['Inj Ceftriaxone 1g'] }), documentId: 'd', encounterRef: null, deid: noop });
  st.medicationAssertions[0].status = 'administered';   // simulate a future builder learning to lie
  assert.throws(() => assertNoAdministered(st), /no MAR exists in this substrate/);
});

test('§8 #7: no builder in this module produces an administered status', () => {
  const states = [
    dischargeState({ extracted: extracted({ medications: ['Tab Pan 40'] }), documentId: 'd', encounterRef: null, deid: noop }),
    otRow(),
    narrativeDocState({ docKind: 'progress', sourceUid: 'p1', encounterRef: null, narrative: 'Inj Ceftriaxone given at 8am.', templateName: null, at: null, deid: noop }),
    notAuditableState({ docKind: 'ot', reason: 'absent', encounterRef: 'IPNO-19' }),
  ];
  for (const st of states) {
    assert.doesNotThrow(() => assertNoAdministered(st));
    assert.ok(!st.medicationAssertions.some((m) => m.status === 'administered'));
  }
  // A progress note SAYING a drug was given is narrative, not a MAR row: it must not become an
  // assertion at all.
  assert.deepEqual(states[2].medicationAssertions, []);
});

// ══ §8 #6 — the stay-shaped assertions ══════════════════════════════════════════════════

test('§8 #6: discharge + OT + progress yields three states with spans', () => {
  const docs = [
    dischargeState({ extracted: extracted({ procedure: 'Laparoscopic cholecystectomy', rawNotes: 'Laparoscopic cholecystectomy done.' }), documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop }),
    otRow(),
    narrativeDocState({ docKind: 'progress', sourceUid: 'p1', encounterRef: 'IPNO-19', narrative: 'Afebrile. Tolerating orals.', templateName: null, at: null, deid: noop }),
  ];
  assert.equal(docs.length, 3);
  for (const st of docs) {
    assert.equal(stayDocMetaOf(st)?.status, 'ok');
    // every finding on every state carries a source field — the "with spans" half of #6
    for (const f of st.positives) assert.ok(f.provenance.sourceField.length > 0 && f.provenance.rawText.length > 0);
  }
  assert.equal(procedureFactsOf(docs[1])[0].provenance.trust, 'structured_db');
});

test('§8 #6: discharge only ⇒ OT records not_auditable and invents no procedure', () => {
  const built: BuiltDoc[] = [
    { docKind: 'discharge', sourceUid: 'doc-1', status: 'ok', state: dischargeState({ extracted: extracted(), documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop }) },
    { docKind: 'ot', sourceUid: absentSourceUid('ot', 'IPNO-19'), status: 'not_auditable', reason: 'absent', state: notAuditableState({ docKind: 'ot', reason: 'absent', encounterRef: 'IPNO-19' }) },
  ];
  const ot = built.find((d) => d.docKind === 'ot')!;
  assert.equal(ot.status, 'not_auditable');
  assert.deepEqual(procedureFactsOf(ot.state), []);
  assert.equal(spanReport(built).total, 0, 'no procedure was evidenced, so none is reported');
});

test('the span report counts what verified and NAMES what did not', () => {
  const built: BuiltDoc[] = [
    { docKind: 'ot', sourceUid: 'ot-1', status: 'ok', state: otRow() },
    { docKind: 'discharge', sourceUid: 'doc-1', status: 'ok', state: dischargeState({ extracted: extracted({ procedure: 'ERCP', rawNotes: 'no mention' }), documentId: 'doc-1', encounterRef: 'IPNO-19', deid: noop }) },
  ];
  const r = spanReport(built);
  assert.equal(r.total, 2);
  assert.equal(r.verified, 1);
  assert.deepEqual(r.unverified.map((u) => u.conceptRaw), ['ERCP']);
  assert.equal(r.unverified[0].sourceField, 'discharge_extract.procedure');
});

// ══ schema discipline ═══════════════════════════════════════════════════════════════════

test('every built state validates against the LIVE zod schema, unforked and unbumped', () => {
  const states = [
    dischargeState({ extracted: extracted({ medications: ['Tab Pan 40'], procedure: 'ERCP' }), documentId: 'd', encounterRef: 'IPNO-19', deid: noop }),
    otRow(),
    narrativeDocState({ docKind: 'pac', sourceUid: 'pac-1', encounterRef: 'IPNO-19', narrative: 'Fit for GA.', templateName: 'PAC', at: null, deid: noop }),
    notAuditableState({ docKind: 'progress', reason: 'empty', encounterRef: 'IPNO-19' }),
  ];
  for (const st of states) {
    assert.doesNotThrow(() => validateClinicalState(st), `a built state failed zClinicalState`);
    assert.equal(st.version, 'clinical-state/1.2');
  }
});

test('the library does not fork lib/clinical-state — the stay facts ride in surfaceExtras', () => {
  const schema = read('lib/clinical-state/schema.ts');
  assert.ok(schema.includes("CLINICAL_STATE_VERSION = 'clinical-state/1.2'"), 'the schema version must not be bumped');
  for (const f of ['lib/stay-library/core.ts', 'lib/stay-library/build.ts', 'lib/stay-library/store.ts']) {
    const src = code(f);
    assert.ok(!/CLINICAL_STATE_VERSION\s*=\s*'/.test(src), `${f} redeclares the schema version`);
  }
  assert.equal(STAY_LIBRARY_VERSION, 'stay-library/1');
  assert.deepEqual([...DOC_KINDS], ['discharge', 'ot', 'pac', 'progress'], 'O10 — four classes, no more');
});

// ══ source pins ═════════════════════════════════════════════════════════════════════════

test('the store names its own tables, and no audit / feedback / spine table', () => {
  const store = code('lib/stay-library/store.ts');
  assert.ok(store.includes('clinical_states'));
  for (const forbidden of [
    'ipd_discharge_audits', 'opd_note_audits', 'ipd_audit_feedback', 'opd_audit_feedback',
    'readmission_findings', 'episode_states', 'member_state', 'case_ask_turns',
  ]) {
    assert.ok(!store.includes(forbidden), `store.ts names ${forbidden}`);
  }
  // Every write verb that names a table must name one of TWO. This pin read "exactly one" until
  // H1 (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H-D2) gave the library a snapshot
  // trail, `clinical_state_versions`, which the upsert writes in the same statement as the
  // overwrite it guards. The exemption is paid for by an assertion, as the house rule requires:
  // the trail is APPEND-ONLY here, and stay-library-hardening.test.ts asserts that separately.
  // `ON CONFLICT ... DO UPDATE SET` names no table (it is still the INSERT's target), so it is
  // removed before the scan rather than matched as a bare UPDATE — the first version of this pin
  // failed on the module's own upsert.
  const sqlish = store.replace(/DO\s+UPDATE/gi, 'DO_UPSERT');
  const targets = [...sqlish.matchAll(/(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
  assert.ok(targets.length > 0, 'the store must actually write something');
  for (const t of targets) {
    assert.ok(['clinical_states', 'clinical_state_versions'].includes(t), `the store writes ${t}`);
  }
  const versionWrites = [...sqlish.matchAll(/(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+clinical_state_versions/gi)];
  for (const m of versionWrites) {
    assert.match(m[1], /INSERT\s+INTO/i, 'the version trail is never rewritten or deleted from');
  }
});

test('§4 — no Metabase table is invented: the three kx template tables and nothing else', () => {
  const src = code('lib/stay-library/core.ts') + code('lib/stay-library/build.ts');
  const kxTables = [...src.matchAll(/kx_[a-z_]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(kxTables)].sort(), [
    'kx_clinical_template_ot_notes', 'kx_clinical_template_pac_reports', 'kx_clinical_template_progress_reports',
  ], 'a fifth table appeared — the PRD says STOP and flag, not add one');
  // and the reads themselves are the EXISTING fetchers, not new SQL
  const build = code('lib/stay-library/build.ts');
  // `fetchExtractedCase` was named here until H4 (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026):
  // the library now uses `readExtractedCaseAcrossVersions` from the SAME store module, reading the
  // SAME table, because the old reader deliberately collapses "no row" with "the database faulted"
  // and the library's answer to those two is not the same one. The exemption is paid for by an
  // assertion, per the house rule: the replacement must come from the shared store and must not be
  // a query this module invented, and stay-library-hardening.test.ts pins the taxonomy separately.
  for (const fetcher of ['fetchOtNotes', 'fetchPacNotes', 'fetchProgressNotes', 'readExtractedCaseAcrossVersions']) {
    assert.ok(build.includes(fetcher), `build.ts must reuse ${fetcher}`);
  }
  assert.match(build, /from '\.\.\/discharge-extract-store'/, 'the discharge read stays the shared store\'s');
  assert.ok(!/discharge_extracted_cases/.test(build), 'build.ts must not name the extract table itself');
  assert.ok(!/metabaseQuery/.test(build), 'build.ts must not query db13 directly — it calls the existing fetchers');
  assert.equal(DOC_KIND_SOURCE.ot, 'kx_clinical_template_ot_notes');
});

test('migration 0047 is additive: it creates one table and ALTERs nothing', () => {
  for (const f of ['migrations/0047_clinical_states.sql', 'app/api/admin/migrate-clinical-states/route.ts']) {
    const src = code(f);
    assert.ok(!/\bALTER\s+TABLE\b/i.test(src), `${f} ALTERs a table`);
    assert.ok(!/\bDROP\b/i.test(src), `${f} contains DROP`);
    assert.ok(src.includes('CREATE TABLE IF NOT EXISTS clinical_states'));
    assert.ok(src.includes('clinical_states_doc_idx'), 'O9\'s unique key must be created');
  }
});

test('P2 runs no model and cannot rescore: the module holds no LLM call and no engine version', () => {
  const src = code('lib/stay-library/core.ts') + code('lib/stay-library/build.ts') + code('lib/stay-library/store.ts')
    + code('app/api/admin/build-stay-library/route.ts') + code('app/api/admin/migrate-clinical-states/route.ts');
  for (const banned of ['tracedChat', 'governedChat', 'normalizeWithLlm', 'analyzeCase', 'extractCase(', 'IPD_ENGINE_VERSION', 'care_value_index']) {
    assert.ok(!src.includes(banned), `P2 names ${banned} — this slice neither runs a model nor rescores`);
  }
  for (const banned of ['gpt-5.6', 'terra', 'mantle']) assert.ok(!src.toLowerCase().includes(banned));
});

test('the build route is dry-run by default — storing is opt-in and explicit', () => {
  const route = code('app/api/admin/build-stay-library/route.ts');
  assert.ok(route.includes('body.write === true'), 'writing must require an explicit true');
  assert.ok(route.includes('requireAdmin(req)') && route.includes('isAdminUnlocked()'), 'admin-gated like ipd-audit-feedback');
});
