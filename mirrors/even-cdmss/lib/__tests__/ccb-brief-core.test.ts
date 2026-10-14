/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-brief-core.test.ts
 * Pure brief-generator core (ccb-brief-core): the cite-or-label invariant, the deterministic
 * COMMERCIAL WALL (pitchGate — the ethics tripwire), grounding math, parsers, the de-identified
 * episode-text composer, and envelope assembly. The wall tests are the safety contract (PRD §6.2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson, normalizeFinding, parseClinical, parseCommercial, parseExtractedReport,
  pitchGate, isSpecificSurgicalIndication, defaultPriority, buildCommercial, groundingSummary, composeEpisodeText,
  retrievalQuery, assembleEnvelope,
  type ClinicalFinding,
} from '../ccb-brief-core.ts';

// A pitch-worthy indication under the calibrated gate: specific claim, cited, above the conf floor.
const SPECIFIC = "The documented obstructing ureteric calculus with hydronephrosis warrants ureteroscopic stone removal";
import type { EpisodeBundle, EpisodeKeys, EpisodePrescription } from '../ccb-fetch-core.ts';

function finding(over: Partial<ClinicalFinding>): ClinicalFinding {
  return { id: 'f1', kind: 'synthesis', claim: 'c', grounding: 'general_reasoning', citation_ids: [], confidence: 0.6, ...over };
}
function bundle(over: Partial<EpisodePrescription> = {}, coverage: 'rich' | 'order_only' = 'rich'): EpisodeBundle {
  const keys: EpisodeKeys = { prescUid: 'uTAWDQinrFFW', individualUid: 'FHpN3DmRklMEbdQAr4oV', kxUhid: 'EHRC1',
    kxEncounterId: null, doctorUid: null, doctorSpeciality: null, noteDate: '2026-06-30', consultType: null, prescriptionType: null };
  const prescription: EpisodePrescription = { url: null, meds: [{ generic: 'paracetamol' }], dxCodes: ['M54.5'], impressionCodes: [],
    diagnoses: [], presentingComplaint: 'low back pain', planOfManagement: 'MRI advised', investigations: [], specialistReferral: [], ...over };
  return { keys, prescription, orders: [{ kind: 'radiology', serviceName: 'MRI LUMBAR SPINE', orderedBy: null, serviceDate: '2026-06-30', patientType: 'OP' }], reports: [], coverage };
}

test('extractJson strips code fences and parses', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded', () => {
  const downgraded = normalizeFinding({ kind: 'surgical_indication', claim: 'needs surgery', grounding: 'corpus_cited', citation_ids: [] }, 8, 0);
  assert.equal(downgraded!.grounding, 'general_reasoning');   // can't claim cited with no citation
  const kept = normalizeFinding({ kind: 'surgical_indication', claim: 'needs surgery', grounding: 'corpus_cited', citation_ids: [1, 2] }, 8, 0);
  assert.equal(kept!.grounding, 'corpus_cited');
  assert.deepEqual(kept!.citation_ids, [1, 2]);
  assert.equal(normalizeFinding({ claim: '' }, 8, 0), null);   // empty claim dropped
});

test('parseClinical clamps citation ids to [1..max] and de-dupes finding ids', () => {
  const raw = JSON.stringify({ findings: [
    { id: 'a', kind: 'diagnosis', claim: 'x', grounding: 'corpus_cited', citation_ids: [1, 9, 2], confidence: 1.4 },
    { id: 'a', kind: 'synthesis', claim: 'dup id', grounding: 'general_reasoning', citation_ids: [] },
  ] });
  const out = parseClinical(raw, 3);
  assert.equal(out.length, 1);                       // duplicate id dropped
  assert.deepEqual(out[0].citation_ids, [1, 2]);     // 9 > max(3) removed
  assert.equal(out[0].confidence, 1);                // clamped to ≤1
});

// ── THE WALL ───────────────────────────────────────────────────────────────────
test('pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication', () => {
  assert.deepEqual(
    pitchGate([finding({ id: 's', kind: 'surgical_indication', grounding: 'corpus_cited', citation_ids: [1], claim: SPECIFIC, confidence: 0.85 })]),
    { allowed: true, gatedOn: ['s'] });
});
test('pitchGate stays SHUT for an uncited surgical indication', () => {
  assert.deepEqual(pitchGate([finding({ kind: 'surgical_indication', grounding: 'general_reasoning', citation_ids: [], claim: SPECIFIC, confidence: 0.9 })]),
    { allowed: false, gatedOn: [] });
});
test('pitchGate stays SHUT for a cited NON-surgical finding', () => {
  assert.deepEqual(pitchGate([finding({ kind: 'diagnosis', grounding: 'corpus_cited', citation_ids: [1], claim: SPECIFIC, confidence: 0.9 })]),
    { allowed: false, gatedOn: [] });
});
test('pitchGate stays SHUT with no findings', () => {
  assert.deepEqual(pitchGate([]), { allowed: false, gatedOn: [] });
});

// ── CALIBRATION: generic/conditional textbook indications must NOT open the wall ──
test('pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)', () => {
  const generic = [
    'Bariatric surgery should be considered for patients with Type 2 Diabetes and a BMI of 35 or greater',
    'A pediatric surgical referral should be considered if the patient develops abdominal distension',
    'Surgical intervention is typically reserved for patients with progressive deformities',
    'Surgical management is the mainstay of treatment for anorectal fistulas',
    'Specialist intervention may be considered in cases of chronic degenerative joint disease',
  ];
  for (const claim of generic) {
    assert.equal(isSpecificSurgicalIndication(claim), false, `should be generic: ${claim}`);
    assert.equal(pitchGate([finding({ kind: 'surgical_indication', grounding: 'corpus_cited', citation_ids: [1], claim, confidence: 0.95 })]).allowed, false, claim);
  }
});
test('isSpecificSurgicalIndication accepts an assertive member-specific indication', () => {
  assert.equal(isSpecificSurgicalIndication(SPECIFIC), true);
  assert.equal(isSpecificSurgicalIndication('Findings indicate cholecystectomy for the symptomatic gallstones documented on ultrasound'), true);
  assert.equal(isSpecificSurgicalIndication('short'), false);   // too short to be specific
  // Genuinely member-specific indications observed in the backtest — must STAY open.
  for (const good of [
    "The patient's report of recent, unexplained hearing loss warrants urgent referral to an ENT specialist",
    "The patient's profile of two-vessel disease involving the proximal LAD with left ventricular dysfunction may meet guideline criteria for coronary revascularization",
    "Referral to a nephrologist is indicated due to uncertainty about the etiology of this kidney disease",
  ]) assert.equal(isSpecificSurgicalIndication(good), true, good);
});

test('the tightened patterns catch the residual generics seen in the backtest', () => {
  for (const generic of [
    'Should the TMT show signs of ischemia, cardiac catheterization is the gold standard procedure',
    'An urgent specialist referral is indicated for patients aged 30 or older who present with a breast lump',
    'Hysterectomy is a definitive surgical treatment for symptomatic fibroids',
    'Surgical intervention is usually needed for women who have severe symptoms',
    'Hospital admission may be indicated for children with acute gastroenteritis',
    'Surgical reconstruction is often required for ACL tears',
    'Appendicitis is the most common extrauterine condition that requires an abdominal operation',
    'The evaluation of chronic cough, when asthma is suspected, includes spirometry',
  ]) assert.equal(isSpecificSurgicalIndication(generic), false, generic);
});
test('pitchGate enforces the confidence floor', () => {
  const low = finding({ kind: 'surgical_indication', grounding: 'corpus_cited', citation_ids: [1], claim: SPECIFIC, confidence: 0.5 });
  assert.equal(pitchGate([low]).allowed, false);
  assert.equal(pitchGate([low], { minConfidence: 0.4 }).allowed, true);   // knob lowers the floor
});
test('pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest', () => {
  const generic = finding({ kind: 'surgical_indication', grounding: 'corpus_cited', citation_ids: [1], claim: 'Surgery should be considered if symptoms worsen', confidence: 0.6 });
  assert.equal(pitchGate([generic]).allowed, false);                                            // NEW gate: shut
  assert.equal(pitchGate([generic], { requireSpecific: false, minConfidence: 0 }).allowed, true); // OLD gate: open
});

test('buildCommercial: walled-off when not allowed; default priority follows referral', () => {
  const noPitch = buildCommercial(bundle({ specialistReferral: [] }), { allowed: false, gatedOn: [] }, null);
  assert.equal(noPitch.pitch_allowed, false);
  assert.equal(noPitch.script, null);
  assert.equal(noPitch.priority, 'low');
  assert.equal(defaultPriority(bundle({ specialistReferral: ['ortho'] })), 'med');

  const pitch = buildCommercial(bundle(), { allowed: true, gatedOn: ['s'] }, { priority: 'high', push_harder: true, script: 'Offer a consult.' });
  assert.equal(pitch.pitch_allowed, true);
  assert.deepEqual(pitch.gated_on, ['s']);
  assert.equal(pitch.script, 'Offer a consult.');
});

test('groundingSummary counts by grounding and distinct cited sources', () => {
  const gs = groundingSummary([
    finding({ id: 'a', grounding: 'corpus_cited', citation_ids: [1, 2] }),
    finding({ id: 'b', grounding: 'corpus_cited', citation_ids: [2, 3] }),
    finding({ id: 'c', grounding: 'general_reasoning' }),
    finding({ id: 'd', grounding: 'deterministic_rule' }),
  ]);
  assert.equal(gs.findings, 4);
  assert.equal(gs.corpus_cited, 2);
  assert.equal(gs.general_reasoning, 1);
  assert.equal(gs.rule, 1);
  assert.equal(gs.citation_coverage_pct, 50);
  assert.equal(gs.distinct_sources, 3);            // {1,2,3}
});

test('parseCommercial defaults priority to med and coerces script', () => {
  assert.deepEqual(parseCommercial('{"priority":"weird","push_harder":true,"script":" x "}'), { priority: 'med', push_harder: true, script: 'x' });
  assert.equal(parseCommercial('garbage'), null);
});

test('parseExtractedReport keeps clinical content only', () => {
  const r = parseExtractedReport('{"studyOrPanel":"CBC","impression":null,"keyFindings":["anemia"],"abnormalValues":["Hb 9.1 (low)"]}', 'diagnostic');
  assert.equal(r!.kind, 'diagnostic');
  assert.equal(r!.studyOrPanel, 'CBC');
  assert.deepEqual(r!.abnormalValues, ['Hb 9.1 (low)']);
});

test('composeEpisodeText is de-identified and notes order-only coverage', () => {
  const t = composeEpisodeText(bundle({}, 'order_only'), []);
  assert.match(t, /Presenting complaint \/ history: low back pain/);
  assert.match(t, /Diagnosis \(ICD\): M54\.5/);
  assert.match(t, /Medications: paracetamol/);
  assert.match(t, /Tests done this episode: MRI LUMBAR SPINE/);
  assert.match(t, /order-level only/);
  assert.doesNotMatch(t, /FHpN3DmRklMEbdQAr4oV|EHRC1/);   // no identifiers leak into the model text
});

test('retrievalQuery surfaces the clinical content', () => {
  const q = retrievalQuery(bundle(), [parseExtractedReport('{"impression":"disc bulge L4-L5"}', 'radiology')!]);
  assert.match(q, /low back pain/);
  assert.match(q, /disc bulge L4-L5/);
  assert.match(q, /surgical indication/);
});

test('assembleEnvelope carries member_ref for join-back + the disclaimer', () => {
  const env = assembleEnvelope({
    traceId: 't1', bundle: bundle(), clinical: [finding({ grounding: 'corpus_cited', citation_ids: [1] })],
    commercial: buildCommercial(bundle(), { allowed: false, gatedOn: [] }, null),
    lowValueFlags: [], sources: [], retrieval: { ran: true, queries: ['q'], chunks_considered: 30, reranked: true },
    artifactCount: 2, now: new Date('2026-06-30T12:00:00Z'),
  });
  assert.equal(env.engine_version, 'care-brief/0.1');
  assert.equal(env.member_ref.uhid, 'EHRC1');
  assert.equal(env.member_ref.individual_uid, 'FHpN3DmRklMEbdQAr4oV');
  assert.equal(env.episode.coverage, 'rich');
  assert.equal(env.grounding_summary.corpus_cited, 1);
  assert.match(env.disclaimer, /Advisory, non-diagnostic/);
});
