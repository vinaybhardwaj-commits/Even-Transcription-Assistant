// lib/__tests__/episode-course.test.ts — EpisodeState (#4) SL3: the phased-course render.
//
// Two invariants for the SL3 element:
//   1. FACTS-ONLY — the render introduces NO band / CVI / scored / predicted field, and never
//      borrows the scored A–E palette (bandColor/scoreColor). The audit's Care-Value Index belongs
//      to the AUDIT, not to EpisodeState; they must stay separate.
//   2. TIMELINE REUSE — the datable admission events map to CCB TimelineItem[] ordered by the
//      shared mergeTimeline (discharge above admit), and undated facts are NOT forced onto it.
// Plus READ-ONLY: the store read is a SELECT; the page reads it best-effort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EpisodeState } from '../episode-state/schema';
import { admissionTimeline } from '../../app/admin/ipd-audit/[id]/episode-course';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const fact = (value: string, sourceField: string, method: 'deterministic' | 'reported' = 'deterministic') =>
  ({ value, provenance: { sourceField, rawText: value, extractionMethod: method, confidence: 1 } });

const STATE: EpisodeState = {
  version: 'episode-state/0.2', episodeRef: 'IP-2',
  demographics: { age: null, sex: 'F', sexRaw: 'female' },
  pre: { presentingComplaints: [], priorConditions: [], homeMedications: [] },
  intra: {
    admission: {
      speciality: fact('Internal Medicine', 'kx.speciality', 'reported'),
      ward: fact('Single Room', 'kx.ward', 'reported'),
      admissionType: fact('Regular', 'extract.adminFacts.admissionType'),
      careSetting: fact('Single Room', 'extract.adminFacts.careSetting'),
      dischargeType: fact('Normal Discharge', 'kx.dischargeType', 'reported'),
      lengthOfStayDays: fact('9', 'kx.losDays', 'reported'),
      admitDate: fact('2025-07-31', 'kx.admitDate', 'reported'),
      dischargeDate: fact('2025-08-09', 'kx.dischargeDate', 'reported'),
    },
    diagnosis: fact('Acute gastroenteritis with severe dehydration', 'extract.diagnosis'),
    procedures: [], medications: [fact('TAB PAN-D 40MG', 'extract.medications')],
    investigations: [], treatments: [fact('IV antibiotics', 'extract.treatments')],
    courseSummary: fact('Admitted with…', 'extract.courseSummary'),
    billing: { netTotal: fact('25118', 'kx.netTotal', 'reported') },
  },
  post: { dischargeMedications: [], followUpPlan: [], warningSigns: [] },
};

test('(timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)', () => {
  const tl = admissionTimeline(STATE);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].title, 'Discharged');           // date desc — 2025-08-09 above 2025-07-31
  assert.equal(tl[0].date, '2025-08-09');
  assert.equal(tl[1].title, 'Admitted');
  assert.equal(tl[1].date, '2025-07-31');
  // TimelineItem shape is honoured (kind from the shared union; refUid present-but-null)
  assert.equal(tl[0].kind, 'ipd');
  assert.equal(tl[0].refUid, null);
  assert.ok(tl[1].subtitle?.includes('Internal Medicine'), 'admit subtitle carries the documented facts');
});

test('(timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)', () => {
  const undated: EpisodeState = { ...STATE, intra: { ...STATE.intra, admission: { ...STATE.intra.admission, admitDate: null, dischargeDate: null } } };
  assert.deepEqual(admissionTimeline(undated), []);
});

test('(facts-only) the render introduces no band/CVI/scored/predicted field or palette', () => {
  const src = code('app/admin/ipd-audit/[id]/episode-course.tsx');
  for (const banned of ['bandColor', 'scoreColor', 'careValueIndex', 'valueScore', 'careVal', '.band', 'CVI', 'prediction']) {
    assert.ok(!src.includes(banned), `the EpisodeState render must not reference '${banned}'`);
  }
  // it reuses the shared timeline primitives, not a bespoke fork
  assert.ok(/from '@\/lib\/ccb-dossier-core'/.test(src) && /mergeTimeline/.test(src), 'reuses TimelineItem/mergeTimeline');
});

test('(read-only) the store read is a SELECT; the page renders it best-effort', () => {
  const store = code('lib/episode-state/store.ts');
  const fetchFn = store.slice(store.indexOf('export async function fetchEpisodeState'));
  assert.ok(/SELECT state FROM episode_states/.test(fetchFn), 'fetchEpisodeState reads');
  assert.ok(!/INSERT|UPDATE|DELETE/.test(fetchFn), 'the read never writes');
  const page = code('app/admin/ipd-audit/[id]/page.tsx');
  assert.ok(/fetchEpisodeState\(documentId\)\.catch\(\(\) => null\)/.test(page), 'the page read is best-effort (a failure hides the element)');
  assert.ok(/\{episode && <EpisodeCourse/.test(page), 'the element is hidden when no row exists');
});
