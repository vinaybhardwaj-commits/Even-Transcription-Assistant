/**
 * Pure-core tests for lib/runs-export.ts buildRunSheets / mergeRunSheets.
 * Run: node --experimental-strip-types --test lib/__tests__/runs-export.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunSheets, mergeRunSheets, type ExportRun } from '../runs-export.ts';

function sheet(defs: ReturnType<typeof buildRunSheets>, name: string) {
  return defs.find((d) => d.name === name);
}

test('check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id', () => {
  const run: ExportRun = {
    id: 'R1', mode: 'check', created_at: '2026-06-28T00:00:00Z', scenario: '34M LBP, MRI?',
    output: {
      valueAnalysis: {
        disclaimer: 'advisory',
        interventions: [{
          intervention: 'MRI lumbar spine', net_value: 'low-value', confidence: 0.9, summary: 'not indicated',
          long_term_benefit: { level: 'low', detail: 'no benefit' }, harms_risks: { level: 'moderate', detail: 'incidental' },
          upfront_cost: { level: 'high', detail: '₹7200' }, long_term_care: { level: 'low', detail: '-' },
          alternatives: [{ name: 'conservative', note: 'first' }], what_would_change: ['red flags'],
          evidence: ['NICE NG59', 'StatPearls'], estimates: ['est ₹X'], citation_ids: [1, 3],
          tariffs: [{ code: 'RAD00538', item: 'MRI LS', general: 9000, opd: 7200, kind: 'investigation' }],
        }],
      },
      valueSources: [
        { n: 1, book: 'UpToDate', chapter: 'LBP', page_start: 5, item_number: null, url: null, similarity: 0.85, preview: 'x' },
        { n: 2, book: 'Lancet', item_number: '30857957', url: 'https://pubmed.ncbi.nlm.nih.gov/30857957/', similarity: 0.8, preview: 'y' },
      ],
      flags: [{ statement: "Don't image", society: 'CW', region: 'US', why_it_applies: 'no red flags', consider_instead: 'wait', confidence: 0.7, citation: { url: 'u', pmid: '123', doi: null, year: 2019 } }],
    },
  };
  const defs = buildRunSheets(run);
  assert.deepEqual(defs.map((d) => d.name), ['Runs', 'Interventions', 'CW_Flags', 'Citations']);
  const iv = sheet(defs, 'Interventions')!.rows[0];
  assert.equal(iv.run_id, 'R1');
  assert.equal(iv.net_value, 'low-value');
  assert.equal(iv.citation_ids, '1;3');
  assert.equal(iv.benefit_level, 'low');
  assert.equal(iv.evidence, 'NICE NG59 | StatPearls');
  assert.ok(String(iv.tariffs).includes('RAD00538'));
  // pmid derived only for the pubmed source
  const cites = sheet(defs, 'Citations')!.rows;
  assert.equal(cites[0].pmid, '');
  assert.equal(cites[1].pmid, '30857957');
  // master run row
  assert.equal(sheet(defs, 'Runs')!.rows[0].scenario, '34M LBP, MRI?');
});

test('pathway mode → PathwayStages merges skeleton+enrichment by id, ordered', () => {
  const run: ExportRun = {
    id: 'R2', mode: 'pathway', output: {
      skeleton: { detectedStage: 'order', workingDiagnosis: 'mechanical LBP', needsDdx: false, summary: 's',
        stages: [{ id: 's1', kind: 'triage', title: 'Red flags', action: 'screen', flag: 'essential' }, { id: 's2', kind: 'diagnosis', title: 'MRI?', action: 'decide', flag: 'caution' }] },
      enrichment: { disclaimer: 'd', nodes: [{ id: 's2', flag: 'low-value', detail: 'no imaging', decisionCriteria: 'unless red flags', order: 'MRI lumbar spine', evidence: ['e1'], estimates: [], citation_ids: [2], tariffs: [{ code: 'RAD00538', item: 'MRI LS', general: 9000 }] }] },
      sources: [{ n: 1, book: 'UpToDate', similarity: 0.8 }],
    },
  };
  const defs = buildRunSheets(run);
  const ps = sheet(defs, 'PathwayStages')!.rows;
  assert.equal(ps.length, 2);
  assert.equal(ps[0].order_index, 1);
  assert.equal(ps[0].stage_id, 's1');
  assert.equal(ps[1].stage_id, 's2');
  assert.equal(ps[1].flag, 'low-value');       // enrichment overrides skeleton
  assert.equal(ps[1].detail, 'no imaging');
  assert.equal(ps[1].citation_ids, '2');
  assert.equal(sheet(defs, 'Runs')!.rows[0].working_diagnosis, 'mechanical LBP');
});

test('audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations', () => {
  const run: ExportRun = {
    id: 'R3', mode: 'audit', output: {
      extracted: { docType: 'discharge_summary', confidence: 1, patient: { age: 54, sex: 'male' }, diagnosis: 'cholecystitis', procedure: 'lap chole', investigations: ['USG', 'CT'], treatments: ['IV abx'], medications: ['PPI'], courseSummary: 'uneventful' },
      report: {
        completeness: { coverage: 0.55, items: [{ key: 'diagnosis', label: 'Diagnosis', section: 'clinical', ref: 'AAC.14', status: 'present', mandatory: true, note: '' }] },
        findings: [{ subject: 'Repeat CT', verdict: 'low-value', confidence: 0.8, rationale: 'USG dx', order: 'CT abdomen', evidence: ['g'], estimates: [], citation_ids: [1, 2], tariffs: [{ code: 'RAD00617', item: 'CT' }] }],
        diff: [{ kind: 'overuse', text: 'repeat CT' }], suggestions: [{ priority: 1, text: 'add follow-up', ref: 'AAC.14' }],
        idealisedStages: [{ id: 's1', kind: 'assessment', title: 'Workup', action: 'a', flag: 'routine' }],
        idealisedSummary: 'early chole', disclaimer: 'advisory', sources: [{ n: 1, book: 'StatPearls' }],
      },
    },
  };
  const defs = buildRunSheets(run);
  const names = defs.map((d) => d.name);
  for (const n of ['Runs', 'AuditFindings', 'Completeness', 'Diff', 'Suggestions', 'IdealisedCourse', 'ExtractedCase', 'Citations']) assert.ok(names.includes(n), `missing ${n}`);
  assert.equal(sheet(defs, 'AuditFindings')!.rows[0].citation_ids, '1;2');
  assert.equal(sheet(defs, 'Completeness')!.rows[0].status, 'present');
  assert.equal(sheet(defs, 'ExtractedCase')!.rows[0].patient_age, 54);
  assert.equal(sheet(defs, 'Runs')!.rows[0].completeness_pct, 55);
});

test('mergeRunSheets stacks rows across runs by sheet name', () => {
  const a: ExportRun = { id: 'A', mode: 'check', output: { valueAnalysis: { interventions: [{ intervention: 'x', net_value: 'low-value', confidence: 1 }] }, valueSources: [{ n: 1, book: 'B' }] } };
  const b: ExportRun = { id: 'B', mode: 'check', output: { valueAnalysis: { interventions: [{ intervention: 'y', net_value: 'high-value', confidence: 1 }] }, valueSources: [{ n: 1, book: 'C' }] } };
  const merged = mergeRunSheets([a, b]);
  assert.equal(sheet(merged, 'Runs')!.rows.length, 2);
  assert.equal(sheet(merged, 'Interventions')!.rows.length, 2);
  assert.deepEqual(sheet(merged, 'Interventions')!.rows.map((r) => r.run_id), ['A', 'B']);
});
