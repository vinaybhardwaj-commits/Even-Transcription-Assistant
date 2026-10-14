import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteAuditFindingToFinding, findingToNoteAuditFinding, type NoteAuditFindingRow,
  auditFindingToFinding, findingToAuditFinding,
  extractedCaseToState, stateToExtractedCase,
} from '../clinical-state/to-audit-family';
import { validateClinicalState, zClinicalFinding } from '../clinical-state/schema';
import type { ExtractedCase, AuditFinding } from '../doc-audit-core';

// ── A representative REAL opd_note_audits.findings row — the §3 contract fields PLUS the
//    extra keys the engine actually stores (rationale, confidence, evidence, estimates,
//    rule_ref, lvc_category). Round-trip must be lossless over ALL of it. ──

const NOTE_ROW: NoteAuditFindingRow = {
  subject: 'Rabeprazole+Domperidone without a documented indication',
  verdict: 'low-value',
  domain: 'appropriateness',
  source: 'llm',
  informational: false,
  signal_type: 'lvc_supplement_polypharmacy',
  finding_ref: 'a3f19c2b77d0',
  citation_ids: [1, 3],
  confidence: 0.72,
  rationale: 'PPI combination started without reflux/dyspepsia documented in the note.',
  evidence: ['No GI indication documented anywhere in the note.'],
  estimates: ['est. ₹180/month recurring'],
  rule_ref: null,
  lvc_category: 'supplement_polypharmacy',
};

test('note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core', () => {
  const f = noteAuditFindingToFinding(NOTE_ROW);
  assert.equal(f.concept, NOTE_ROW.subject);
  assert.equal(f.status, 'present');
  assert.equal(f.provenance.extractionMethod, 'llm');
  assert.equal(f.provenance.confidence, 0.72);
  assert.equal(f.ext?.kind, 'audit');
  const ext = f.ext!.kind === 'audit' ? f.ext! : null;
  assert.equal(ext!.verdict, 'low-value');
  assert.equal(ext!.domain, 'appropriateness');          // note-audit vocabulary, verbatim
  assert.equal(ext!.signalType, 'lvc_supplement_polypharmacy');
  assert.equal(ext!.findingRef, 'a3f19c2b77d0');
  assert.equal(ext!.netValue, undefined, 'netValue is the doc-audit slot — never set from a note-audit row');
  zClinicalFinding.parse(f);
});

test('LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields', () => {
  assert.deepEqual(findingToNoteAuditFinding(noteAuditFindingToFinding(NOTE_ROW)), NOTE_ROW);
});

test('note-audit round-trip preserves absence: a minimal row gains no keys', () => {
  const minimal: NoteAuditFindingRow = { subject: 'x', verdict: 'uncertain', domain: 'prescribing_safety' };
  const back = findingToNoteAuditFinding(noteAuditFindingToFinding(minimal));
  assert.deepEqual(back, minimal);
  assert.ok(!('informational' in back) && !('citation_ids' in back) && !('source' in back));
});

test('deterministic-source row maps to extractionMethod deterministic', () => {
  const f = noteAuditFindingToFinding({ ...NOTE_ROW, source: 'deterministic' });
  assert.equal(f.provenance.extractionMethod, 'deterministic');
});

// ── A representative doc-audit AuditFinding (real shape incl. non-§3 fields) ──

const DOC_FINDING: AuditFinding = {
  subject: 'IV antibiotics continued 5 days for a clean day-care procedure',
  verdict: 'low-value',
  confidence: 0.8,
  rationale: 'Guidance supports 24h prophylaxis at most for this procedure class.',
  order: 'IV Augmentin',
  evidence: ['Excerpt [2] recommends single-dose prophylaxis.'],
  estimates: ['est. 4 avoidable bed-days'],
  citation_ids: [2],
  domain: 'efficiency',
};

test('doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)', () => {
  const f = auditFindingToFinding(DOC_FINDING);
  const ext = f.ext!.kind === 'audit' ? f.ext! : null;
  assert.equal(ext!.netValue, 'low-value');
  assert.equal(ext!.domain, 'efficiency');               // doc-audit ValueDomain, verbatim
  assert.equal(ext!.verdict, undefined, 'verdict is the note-audit slot — never set from a doc-audit finding');
  assert.deepEqual(ext!.citationIds, [2]);
  zClinicalFinding.parse(f);
});

test('LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte', () => {
  assert.deepEqual(findingToAuditFinding(auditFindingToFinding(DOC_FINDING)), DOC_FINDING);
});

// ── A representative doc-audit ExtractedCase (discharge summary, full PX shape) ──

const EXTRACTED: ExtractedCase = {
  docType: 'discharge_summary',
  detectedDocType: 'discharge_summary',
  confidence: 0.9,
  patient: { age: 34, sex: 'female' },
  diagnosis: 'Acute appendicitis',
  indication: null,
  procedure: 'Laparoscopic appendicectomy',
  investigations: ['USG abdomen', 'CBC'],
  treatments: ['IV Augmentin ~5 days'],
  medications: ['Tab Augmentin 625mg BD x5d', 'Tab Pantoprazole 40mg OD'],
  courseSummary: 'Admitted with RIF pain; lap appendicectomy day 1; uneventful recovery.',
  disposition: 'discharged stable',
  followUp: 'review in 7 days or earlier if fever',
  rawNotes: 'clear digital document',
  completeness: [
    { key: 'operative_findings', status: 'present', note: '' },
    { key: 'histopathology_plan', status: 'missing', note: 'no HPE mention' },
  ],
  adminFacts: { lengthOfStayDays: 4, admissionType: 'emergency', careSetting: 'ward' },
  riskFactors: ['known allergy to Diclofenac Sodium'],
  aftercare: { instructions: ['wound care daily'], warning_signs: ['fever', 'wound discharge'], follow_up_detail: 'review in 7 days or earlier if fever' },
};

test('ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras', () => {
  const s = extractedCaseToState(EXTRACTED);
  assert.equal(s.surface, 'doc_audit');
  assert.equal(s.demographics.age, 34);
  assert.equal(s.demographics.sex, 'F');
  assert.equal(s.demographics.sexRaw, 'female');
  assert.ok(s.positives.some((f) => f.concept === 'Acute appendicitis' && f.provenance.sourceField === 'diagnosis'));
  assert.deepEqual(s.investigations.map((f) => f.test), ['USG abdomen', 'CBC']);
  assert.deepEqual(s.medications, EXTRACTED.medications);
  assert.deepEqual(s.procedures, ['Laparoscopic appendicectomy']);
  assert.deepEqual(s.riskFactors, ['known allergy to Diclofenac Sodium']);
  assert.deepEqual(s.adminFacts, EXTRACTED.adminFacts);
  assert.deepEqual(s.missingCriticalData, ['histopathology_plan'], 'missing completeness keys surface as missing data');
  assert.equal(s.surfaceExtras?.courseSummary, EXTRACTED.courseSummary);
  assert.deepEqual(validateClinicalState(s), s);
});

test('LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)', () => {
  assert.deepEqual(stateToExtractedCase(extractedCaseToState(EXTRACTED)), EXTRACTED);
});

test('LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips', () => {
  const sparse: ExtractedCase = {
    docType: 'opd_rx',
    detectedDocType: 'opd_rx',
    confidence: 0.6,
    patient: {},
    diagnosis: null,
    indication: 'knee pain',
    procedure: null,
    investigations: [],
    treatments: [],
    medications: ['Tab Etoricoxib 90mg OD'],
    courseSummary: 'OPD consult; analgesic started.',
    disposition: null,
    followUp: null,
    rawNotes: '',
  };
  assert.deepEqual(stateToExtractedCase(extractedCaseToState(sparse)), sparse);
});
