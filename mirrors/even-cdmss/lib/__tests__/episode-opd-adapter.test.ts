// lib/__tests__/episode-opd-adapter.test.ts — EpisodeState (#4) SL4: the OPD-linkage PHI-drop.
//
// The pre/post phases are built from the patient's OPD record, resolved through the uhid join. The
// uhid is PHI and must never leave the join; the projected linkage must carry ONLY structured,
// de-identified clinical values (ICD codes, drug names, dates). This test is STRUCTURAL: it feeds
// OPD rows that ALSO carry PHI columns (name, uhid, mobile, the free-text complaint narrative) and
// asserts none survives — the projector is a whitelist that reads only day/dx/meds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectOpdLinkage, type OpdRow } from '../ipd-audit/episode-opd-adapter';
import { buildEpisodeState, type KxEnvelope, type OpdLinkage } from '../episode-state/build-intra';
import { fabricationViolations } from '../episode-state/build-intra';
import { validateEpisodeState } from '../episode-state/schema';
import type { ExtractedCase } from '../doc-audit-core';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// OPD rows shaped like the real db13 read, but SPIKED with PHI fields the projector must ignore.
const PHI_NAME = '__PHI__Jane Patient';
const PHI_UHID = '__PHI__UHID-17777';
const PHI_COMPLAINT = '__PHI__<p>Mrs Jane Patient, mobile 98765, c/o knee pain</p>';
const preRows: (OpdRow & Record<string, unknown>)[] = [
  { day: '2026-05-13', dx: '["M23"]', meds: '[{"brand_name":"Chymoral Forte Tablet","generic_name":"Trypsin"}]',
    patient_name: PHI_NAME, uhid: PHI_UHID, complaints: PHI_COMPLAINT, mobile: '9876500000' },
  { day: '2026-02-28', dx: '["Z00","M23"]', meds: '[{"brand_name":"Pan-D"}]', patient_name: PHI_NAME },
];
const postRows: (OpdRow & Record<string, unknown>)[] = [
  { day: '2026-06-22', dx: '["H69"]', meds: '[]', uhid: PHI_UHID, complaints: PHI_COMPLAINT },
];

test('projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts', () => {
  const linkage = projectOpdLinkage(preRows, postRows);
  const blob = JSON.stringify(linkage);
  for (const phi of [PHI_NAME, PHI_UHID, PHI_COMPLAINT, '98765', 'mobile', 'patient_name', 'Jane']) {
    assert.ok(!blob.includes(phi), `PHI '${phi}' leaked into the OPD linkage`);
  }
  assert.ok(!blob.includes('__PHI__'), 'no PHI marker survives');
  // the de-identified STRUCTURED facts DO come through
  assert.deepEqual(linkage.pre.conditions, ['M23', 'Z00']);          // ICD codes, deduped
  assert.deepEqual(linkage.pre.medications, ['Chymoral Forte Tablet', 'Pan-D']);   // drug names
  assert.equal(linkage.post.followUps[0], '2026-06-22 · H69');       // date · ICD
});

test('the projector never reads a PHI field name (structural guard against a future column)', () => {
  const src = code('lib/ipd-audit/episode-opd-adapter.ts');
  for (const phi of ['patient_name', 'patientName', 'complaints', 'mobile', 'age_gender']) {
    assert.ok(!src.includes(phi), `the projector must not read the '${phi}' field`);
  }
  // uhid appears ONLY as a transient join key in the resolver, never in the pure projector
  const projector = src.slice(src.indexOf('export function projectOpdLinkage'), src.indexOf('export interface OpdLinkageResult'));
  assert.ok(!/uhid/i.test(projector), 'the pure projector never touches uhid');
  assert.ok(/kx_uhid/.test(src), 'the resolver uses the uhid only as the individuals.kx_uhid join key');
});

// ── the builder populates pre/post from the linkage, verbatim + no fabrication ──
const EXTRACT: ExtractedCase = {
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.9,
  patient: { age: 40, sex: 'male' }, diagnosis: 'PCL avulsion', indication: null, procedure: null,
  investigations: [], treatments: [], medications: [], courseSummary: 'stay', disposition: null,
  followUp: null, rawNotes: '', adminFacts: { lengthOfStayDays: 3, admissionType: 'elective', careSetting: 'ward' },
};
const KX: KxEnvelope = { episodeRef: 'IP-100', speciality: 'Orthopedics', ward: 'W', dischargeType: 'Routine',
  admitDate: '2026-05-20', dischargeDate: '2026-05-23', losDays: 3, netTotal: 1000 };

test('the builder fills pre/post from the OPD linkage — reported facts, no fabrication', () => {
  const opd: OpdLinkage = { pre: { conditions: ['M23', 'Z00'], medications: ['Pan-D'] }, post: { followUps: ['2026-06-22 · H69'] } };
  const s = buildEpisodeState(EXTRACT, KX, opd);
  assert.equal(s.version, 'episode-state/0.2');
  assert.deepEqual(s.pre.priorConditions.map((f) => f.value), ['M23', 'Z00']);
  assert.deepEqual(s.pre.homeMedications.map((f) => f.value), ['Pan-D']);
  assert.deepEqual(s.post.followUpPlan.map((f) => f.value), ['2026-06-22 · H69']);
  assert.equal(s.pre.presentingComplaints.length, 0, 'free-text complaints are not projected');
  // every pre/post fact carries reported provenance and no fabrication
  assert.equal(s.pre.priorConditions[0].provenance.extractionMethod, 'reported');
  assert.deepEqual(fabricationViolations(s, EXTRACT, KX), []);
  assert.doesNotThrow(() => validateEpisodeState(s));
});

test('the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error', () => {
  const none = buildEpisodeState(EXTRACT, KX, null);
  assert.deepEqual(none.pre, { presentingComplaints: [], priorConditions: [], homeMedications: [] });
  assert.deepEqual(none.post, { dischargeMedications: [], followUpPlan: [], warningSigns: [] });
  const empty = buildEpisodeState(EXTRACT, KX, { pre: { conditions: [], medications: [] }, post: { followUps: [] } });
  assert.equal(empty.pre.priorConditions.length, 0);
  assert.doesNotThrow(() => validateEpisodeState(empty));
});
