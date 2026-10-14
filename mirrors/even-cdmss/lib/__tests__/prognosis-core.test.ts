import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrognosis, buildPxUser, buildPxSummary, normNetStatus, normLikelihood, normSeverity,
  offsetPrognosisCitations, parsePxCritique, PX_ENGINE_VERSION, PX_DISCLAIMER, type PxCaseInput,
} from '../prognosis-core.ts';

const DRAFT = JSON.stringify({
  complications: [
    { complication: 'Surgical-site infection / wound complication', likelihood: 'common', incidence_note: 'reported in 2–5% [4]', horizon: 'days 3–14', severity: 'moderate', modifiers: [{ factor: 'open anorectal wound', direction: 'raises' }], evidence: ['SSI is a recognised complication of anorectal surgery [4]'], estimates: [], citation_ids: [4] },
    { complication: 'Post-operative urinary retention', likelihood: 'common', severity: 'minor', modifiers: [{ factor: 'spinal anaesthesia', direction: 'raises' }, { factor: 'post-op opioids', direction: 'raises' }], evidence: [], estimates: ['risk elevated with spinal + tramadol (est.)'], citation_ids: [] },
    { complication: 'Anal stenosis', likelihood: 'rare', severity: 'serious', modifiers: [], evidence: [], estimates: ['late complication (est.)'], citation_ids: [] },
  ],
  benefit: {
    intended_benefit: 'Resolution of prolapse and defecatory pain',
    time_to_benefit: '2–4 weeks',
    success_rate_note: 'recurrence after laser hemorrhoidopexy reported up to 10% (est.)',
    failure_signature: 'Persistent severe anal pain beyond 3–4 weeks, or recurrent prolapse/bleeding',
    documented_expectation_setting: 'absent',
    evidence: [], estimates: [], citation_ids: [1],
  },
  safety_net: [
    { risk: 'Surgical-site infection', expected_mitigation: 'Wound care instructions + wound-specific warning signs (discharge/pus, worsening pain)', found_in_document: 'Sitz bath 1-1-1; betadine for sitz bath', status: 'partially_mitigated', note: 'Hygiene measure present; no wound-inspection or discharge/pus warning' },
    { risk: 'Urinary retention', expected_mitigation: 'Warning to return if unable to pass urine', found_in_document: null, status: 'unmitigated' },
    { risk: 'Benefit failure (persistent pain)', expected_mitigation: 'Recovery trajectory + review trigger', found_in_document: 'Follow up after one week', status: 'partially_mitigated', note: 'Interval only; no symptom trigger' },
  ],
  summary: '3 foreseeable risks; 1 unmitigated; recovery expectations not documented.',
});

test('parses a full draft: caps, ranking, counts, version, disclaimer', () => {
  const r = parsePrognosis(DRAFT, 8);
  assert.ok(r);
  assert.equal(r!.version, PX_ENGINE_VERSION);
  assert.equal(r!.disclaimer, PX_DISCLAIMER);
  assert.equal(r!.complications.length, 3);
  // ranked likelihood×severity: SSI (3×2=6) before POUR (3×1=3) before stenosis (1×3=3, stable after POUR)
  assert.equal(r!.complications[0].complication.includes('infection'), true);
  assert.equal(r!.n_unmitigated, 1);
  assert.equal(r!.n_partial, 2);
  assert.equal(r!.benefit!.documented_expectation_setting, 'absent');
  assert.equal(r!.safetyNet[1].found_in_document, null);
});

test('citation ids bounded by the SHARED source count', () => {
  const r = parsePrognosis(DRAFT, 3); // id 4 out of range
  assert.deepEqual(r!.complications.find((c) => c.complication.includes('infection'))!.citation_ids, []);
  const r2 = parsePrognosis(DRAFT, 8);
  assert.deepEqual(r2!.complications.find((c) => c.complication.includes('infection'))!.citation_ids, [4]);
});

test('unknown enums fall to safe defaults', () => {
  assert.equal(normLikelihood('quite likely'), 'uncommon');
  assert.equal(normLikelihood('very common'), 'common');
  assert.equal(normSeverity('catastrophic'), 'moderate');
  assert.equal(normSeverity('life-threatening'), 'serious');
  assert.equal(normNetStatus('partial'), 'partially_mitigated');
  assert.equal(normNetStatus('MISSING'), 'unmitigated');
  assert.equal(normNetStatus('n/a'), 'not_assessable');
  assert.equal(normNetStatus('covered'), 'mitigated');
  assert.equal(normNetStatus('???'), 'not_assessable');
});

test('caps: complications 8, safety-net 10', () => {
  const many = {
    complications: Array.from({ length: 12 }, (_, i) => ({ complication: `C${i}`, likelihood: 'rare', severity: 'minor' })),
    safety_net: Array.from({ length: 14 }, (_, i) => ({ risk: `R${i}`, expected_mitigation: 'x', status: 'mitigated' })),
  };
  const r = parsePrognosis(JSON.stringify(many), 0);
  assert.equal(r!.complications.length, 8);
  assert.equal(r!.safetyNet.length, 10);
});

test('malformed / empty inputs return null', () => {
  assert.equal(parsePrognosis('not json', 5), null);
  assert.equal(parsePrognosis('{"complications":[],"safety_net":[]}', 5), null);
  assert.equal(parsePrognosis('', 5), null);
});

test('summary fallback built when model omits it', () => {
  const d = { complications: [{ complication: 'X', likelihood: 'common', severity: 'serious' }], safety_net: [{ risk: 'X', expected_mitigation: 'y', status: 'unmitigated' }] };
  const r = parsePrognosis(JSON.stringify(d), 0);
  assert.match(r!.summary, /1 foreseeable risk/);
  assert.match(r!.summary, /1 unmitigated/);
  assert.equal(buildPxSummary(0, 0, null), '0 foreseeable risks identified · all safety-netted or assess-limited.');
});

test('buildPxUser: lens per doc type + documented plan block + empty-plan fallback', () => {
  const base: PxCaseInput = {
    docType: 'discharge_summary', patientLine: '38y, male',
    diagnosis: 'Grade III hemorrhoids; posterior fissure', indication: null,
    procedure: 'EUA + laser sphincterotomy + laser hemorrhoidopexy',
    investigations: [], treatments: [], medications: ['Tab Ceftum 500mg'],
    riskFactors: ['Known allergy to Diclofenac Sodium'],
    courseSummary: 'Elective procedure, uneventful stay.',
    disposition: 'Discharged home', followUp: 'After one week',
    aftercareInstructions: ['Sitz bath 1-1-1'], warningSigns: ['Fever not subsiding'],
    followUpDetail: 'Follow up after one week', adminFactsLine: 'Stay: length of stay 1 day; elective',
  };
  const u = buildPxUser(base, '[1] excerpt');
  assert.match(u, /LENS \(discharge summary\)/);
  assert.match(u, /Stated risk factors: Known allergy to Diclofenac Sodium/);
  assert.match(u, /Documented warning signs .*Fever not subsiding/);
  const ot = buildPxUser({ ...base, docType: 'ot_note', aftercareInstructions: [], warningSigns: [], followUpDetail: null, followUp: null }, '');
  assert.match(ot, /LENS \(OT\/operative note\)/);
  assert.match(ot, /\(no aftercare instructions, warning signs, or follow-up detail documented\)/);
  assert.match(ot, /no excerpts retrieved/);
  const opd = buildPxUser({ ...base, docType: 'opd_rx' }, '[1] x');
  assert.match(opd, /LENS \(OPD prescription\)/);
});

test('parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays', () => {
  const c = parsePxCritique(JSON.stringify({
    missing_complications: ['Surgical-site infection absent from the list'],
    unsupported_evidence: [], unmarked_estimates: [], wrong_net_status: [], vague_failure_signature: [],
    severity: 'major',
  }));
  assert.equal(c.needs_revision, true);
  assert.equal(c.severity, 'major');
  assert.equal(c.missing_complications.length, 1);
  const clean = parsePxCritique('{"needs_revision":false,"severity":"none"}');
  assert.equal(clean.needs_revision, false);
  const garbage = parsePxCritique('not json');
  assert.equal(garbage.needs_revision, false);
  assert.equal(garbage.severity, 'none');
});

test('R5: offsetPrognosisCitations shifts every citation id by the analyze-source count', () => {
  const r = parsePrognosis(DRAFT, 8)!;
  const shifted = offsetPrognosisCitations(r, 8); // 8 analyze sources before the PX block
  assert.deepEqual(shifted.complications.find((c) => c.complication.includes('infection'))!.citation_ids, [12]);
  assert.deepEqual(shifted.benefit!.citation_ids, [9]);
  // zero offset is identity; original untouched (copy semantics)
  assert.deepEqual(offsetPrognosisCitations(r, 0).benefit!.citation_ids, [1]);
  assert.deepEqual(r.benefit!.citation_ids, [1]);
});

test('modifiers parsed with direction defaulting to raises; capped at 6', () => {
  const d = {
    complications: [{
      complication: 'X', likelihood: 'common', severity: 'moderate',
      modifiers: [
        { factor: 'a', direction: 'raises' }, { factor: 'b', direction: 'lowers' }, { factor: 'c' },
        { factor: 'd' }, { factor: 'e' }, { factor: 'f' }, { factor: 'g' },
      ],
    }],
  };
  const r = parsePrognosis(JSON.stringify(d), 0);
  const m = r!.complications[0].modifiers;
  assert.equal(m.length, 6);
  assert.equal(m[1].direction, 'lowers');
  assert.equal(m[2].direction, 'raises');
});
