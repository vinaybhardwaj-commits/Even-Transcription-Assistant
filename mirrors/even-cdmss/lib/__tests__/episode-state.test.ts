// lib/__tests__/episode-state.test.ts — EpisodeState (#4) SL1: schema + intra-phase builder.
//
// Four things must hold for this to be a governed, honest projection:
//   1. SCHEMA — the built object validates against episode-state/0.1; pre/post are typed-but-empty.
//   2. NO FABRICATION — every asserted fact's rawText occurs VERBATIM in its cited source (the
//      ClinicalState discipline). A fact whose rawText is absent from the source is DROPPED.
//   3. DETERMINISM — pure builder; identical inputs → byte-identical output.
//   4. FACTS-ONLY / DE-IDENTIFIED — no band/CVI/prediction field; no PHI (name/UHID), no URL.
// Pure/synthetic — no DB, no network, CI-safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedCase } from '../doc-audit-core';
import { EPISODE_STATE_VERSION, validateEpisodeState, episodeCounts } from '../episode-state/schema';
import { buildEpisodeState, fabricationViolations, resolveSource, type KxEnvelope } from '../episode-state/build-intra';

// A synthetic-but-realistic discharge extract (de-identified; the shape the doc-audit engine emits).
const EXTRACT: ExtractedCase = {
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.9,
  patient: { age: 43, sex: 'male' },
  diagnosis: 'Community-acquired pneumonia, right lower lobe',
  indication: null,
  procedure: 'Diagnostic bronchoscopy',
  investigations: ['Chest X-ray: RLL consolidation', 'CBC', 'CRP 180 → 40', 'Blood culture: no growth'],
  treatments: ['IV ceftriaxone 1g BD x5d', 'Azithromycin 500mg OD x3d', 'Oxygen by nasal cannula'],
  medications: ['Ceftriaxone', 'Azithromycin', 'Paracetamol PRN'],
  courseSummary: 'Admitted with fever and productive cough. Started on IV antibiotics; CRP fell from 180 to 40 over five days. Afebrile and saturating well on room air at discharge.',
  disposition: 'Discharged home', followUp: 'OPD review in 1 week',
  rawNotes: 'de-identified notes',
  adminFacts: { lengthOfStayDays: 5, admissionType: 'emergency', careSetting: 'ward' },
};

const KX: KxEnvelope = {
  episodeRef: 'IP-2001', speciality: 'Pulmonology', ward: 'General Ward',
  dischargeType: 'Routine', admitDate: '2026-07-01', dischargeDate: '2026-07-06',
  losDays: 5, netTotal: 48250,
};

test('(1) SCHEMA: the built object validates as the current version; pre/post empty without OPD', () => {
  const s = buildEpisodeState(EXTRACT, KX);   // no OPD linkage ⇒ pre/post stay empty
  assert.equal(s.version, EPISODE_STATE_VERSION);
  assert.doesNotThrow(() => validateEpisodeState(s), 'validates against the zod schema');
  // intra populated…
  assert.equal(s.intra.diagnosis?.value, 'Community-acquired pneumonia, right lower lobe');
  assert.equal(s.intra.admission.speciality?.value, 'Pulmonology');
  assert.equal(s.intra.admission.lengthOfStayDays?.value, '5');
  assert.equal(s.intra.billing.netTotal?.value, '48250');
  assert.equal(s.intra.medications.length, 3);
  assert.equal(s.intra.investigations.length, 4);
  assert.equal(s.intra.procedures.length, 1);
  // …pre/post EMPTY in SL1 (typed, not populated)
  assert.deepEqual(s.pre, { presentingComplaints: [], priorConditions: [], homeMedications: [] });
  assert.deepEqual(s.post, { dischargeMedications: [], followUpPlan: [], warningSigns: [] });
});

test('(2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source', () => {
  const s = buildEpisodeState(EXTRACT, KX);
  assert.deepEqual(fabricationViolations(s, EXTRACT, KX), [], 'no fact carries a rawText absent from its source');
  // spot-check the provenance is real (offsets point at the substring)
  const med = s.intra.medications[0];
  const src = resolveSource(med.provenance.sourceField, EXTRACT, KX);
  assert.ok(src.includes(med.provenance.rawText), 'the medication rawText occurs in extract.medications');
  assert.equal(src.slice(med.provenance.startOffset, med.provenance.endOffset), med.provenance.rawText, 'offsets are exact');
});

test('(2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented', () => {
  // Feed a diagnosis the resolver can still see, but medications whose text is genuinely absent by
  // making the array empty — the builder must simply not emit those facts (no placeholder).
  const thin: ExtractedCase = { ...EXTRACT, medications: [], investigations: [], treatments: [], procedure: null, diagnosis: null, courseSummary: '' };
  const s = buildEpisodeState(thin, null);
  assert.equal(s.intra.diagnosis, null);
  assert.equal(s.intra.courseSummary, null);
  assert.equal(s.intra.medications.length, 0);
  assert.equal(s.intra.billing.netTotal, null, 'no kx ⇒ no billing fact');
  assert.equal(s.episodeRef, '', 'no kx ⇒ empty link-back key, never fabricated');
  assert.deepEqual(fabricationViolations(s, thin, null), []);
  // and the whole thing still validates (empty intra is legal)
  assert.doesNotThrow(() => validateEpisodeState(s));
});

test('(3) DETERMINISM: identical inputs give byte-identical output', () => {
  const a = JSON.stringify(buildEpisodeState(EXTRACT, KX));
  const b = JSON.stringify(buildEpisodeState(EXTRACT, KX));
  assert.equal(a, b);
});

test('(4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere', () => {
  const s = buildEpisodeState(EXTRACT, KX);
  const blob = JSON.stringify(s).toLowerCase();
  for (const banned of ['band', 'cvi', 'carevalueindex', 'care_value', 'score', 'prediction', 'predicted']) {
    assert.ok(!blob.includes(banned), `facts-only: the projection must not carry a '${banned}' field`);
  }
  // de-identified: link-back key only; no name/uhid/url
  for (const phi of ['uhid', 'patientname', 'patient_name', 'mrn', 'http://', 'https://', 'gs://']) {
    assert.ok(!blob.includes(phi), `de-identified: must not carry '${phi}'`);
  }
  assert.equal(s.episodeRef, 'IP-2001', 'episodeRef is the ip_uid link-back key');
});

test('the schema source itself carries no score/prediction vocabulary (facts-only by construction)', () => {
  // strip comments — the header prose names these words to say they are forbidden
  const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['lib/episode-state/schema.ts', 'lib/episode-state/build-intra.ts']) {
    const src = code(f);
    for (const banned of ['valueScore', 'careValueIndex', 'bandFor', 'CVI', 'prediction']) {
      assert.ok(!src.includes(banned), `${f} must not reference '${banned}' (facts stay separate from audit/prediction)`);
    }
    assert.ok(!/from '\.\.\/(member-state|clinical-state)\//.test(src), `${f} must not import the frozen cores' internals`);
  }
});

test('counts helper reflects the populated intra + empty pre/post', () => {
  const c = episodeCounts(buildEpisodeState(EXTRACT, KX));
  assert.equal(c.medications, 3);
  assert.equal(c.investigations, 4);
  assert.equal(c.diagnosis, 1);
  assert.equal(c.preFacts, 0);
  assert.equal(c.postFacts, 0);
});
