/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-template-core.test.ts
 * R2 source 4 — the PURE flatten / hop-planning / coverage core
 * (CDMSS-READMISSIONS-R2-PRD v1.0 §3.2/§3.4; templates PRD §4.2/§4.6; constraints 13-16).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OT_FACT_ALLOWLIST, TEMPLATE_ID_PREFIX, TEMPLATE_NARRATIVE_CAP, TEMPLATE_ROW_CAP,
  allowlistedOtFacts, coverageFor, dedupTemplateRows, flattenTemplateRow, hasUsableText,
  pacWindow, parseComponentJson, planOtProgressHops, planPacHops, readmitFallbackFrom, reduceTemplateCoverage,
  type KxTemplateRow,
} from '../readmission-template-core.ts';

const row = (over: Partial<KxTemplateRow> = {}): KxTemplateRow => ({
  uid: 'u1', encounterId: 'IPNO-229', uhid: 'UH-1', templateName: 'Doctor: OT Notes', status: 'final',
  createdAt: '2026-06-01T09:00:00Z', surgeryName: 'Cemented hemiarthroplasty', note: 'Procedure uneventful. Cement mantle satisfactory.',
  componentJson: JSON.stringify([
    { name: 'surgery-name', valueString: 'Cemented hemiarthroplasty' },
    { name: 'opfinf', valueString: 'Displaced subcapital fracture; calcar intact' },
    { name: 'TF-7835', valueString: 'should never appear' },
    { name: 'KSNC', valueString: 'cryptic' },
    { name: 'ans', valueString: 'Spinal' },
    { name: 'right-left', valueString: '' },
  ]),
  ...over,
});

// ── flatten ──────────────────────────────────────────────────────────────────────

test('component_json: allowlist only, in allowlist order; TF-* / cryptic names dropped; empty values dropped', () => {
  const f = flattenTemplateRow(row(), 'ot_note', 'index');
  assert.deepEqual(f.facts.map((x) => x.name), ['surgery-name', 'ans', 'opfinf']);
  assert.equal(f.facts.some((x) => /^TF-/.test(x.name) || x.name === 'KSNC'), false);
  assert.equal(f.facts.some((x) => x.name === 'right-left'), false);   // empty valueString → not a fact
  assert.equal(f.source, 'ot_note'); assert.equal(f.side, 'index');
  assert.equal(f.surgeryName, 'Cemented hemiarthroplasty');
  assert.equal(f.narrative, 'Procedure uneventful. Cement mantle satisfactory.');
  assert.equal(OT_FACT_ALLOWLIST.length, 11);
});

test('invalid / odd component_json → no facts, the note is kept; the first-class surgery_name stands in for surgery-name', () => {
  assert.deepEqual(parseComponentJson('{not json'), []);
  assert.deepEqual(parseComponentJson('"a string"'), []);
  assert.deepEqual(parseComponentJson('[1, null, {"name": "opfinf"}]'), []);   // no valueString → dropped
  assert.deepEqual(parseComponentJson(null), []);
  const f = flattenTemplateRow(row({ componentJson: '{not json' }), 'ot_note', 'index');
  assert.deepEqual(f.facts, [{ name: 'surgery-name', value: 'Cemented hemiarthroplasty' }]);
  assert.equal(f.narrative, 'Procedure uneventful. Cement mantle satisfactory.');
  // json wins over the column when both carry surgery-name; the column only fills a gap
  assert.deepEqual(allowlistedOtFacts([{ name: 'surgery-name', value: 'From JSON' }], 'From column')[0], { name: 'surgery-name', value: 'From JSON' });
});

test('PAC and progress contribute note ONLY in PR A — no facts even if json is present; truncation caps apply before deid', () => {
  const pac = flattenTemplateRow(row({ componentJson: JSON.stringify([{ name: 'Allergies220', valueString: 'NKDA' }]), note: 'ASA II. Airway MP-2.' }), 'pac_note', 'index');
  assert.deepEqual(pac.facts, []); assert.equal(pac.surgeryName, null); assert.equal(pac.narrative, 'ASA II. Airway MP-2.');
  const long = 'x'.repeat(5000);
  assert.equal(flattenTemplateRow(row({ note: long }), 'progress_note', 'readmit').narrative.length, TEMPLATE_NARRATIVE_CAP.progress_note + 1);   // + ellipsis
  assert.equal(flattenTemplateRow(row({ note: long }), 'ot_note', 'index').narrative.length, TEMPLATE_NARRATIVE_CAP.ot_note + 1);
  assert.deepEqual(TEMPLATE_ROW_CAP, { ot_note: 20, pac_note: 5, progress_note: 40 });
});

test('usable text = nonempty note OR a nonempty allowlisted fact; a blank progress row is not usable', () => {
  assert.equal(hasUsableText(flattenTemplateRow(row({ note: '   ' }), 'progress_note', 'index')), false);
  assert.equal(hasUsableText(flattenTemplateRow(row({ note: null }), 'progress_note', 'index')), false);
  assert.equal(hasUsableText(flattenTemplateRow(row({ note: '   ', componentJson: null, surgeryName: null }), 'ot_note', 'index')), false);
  assert.equal(hasUsableText(flattenTemplateRow(row({ note: '   ', componentJson: null }), 'ot_note', 'index')), true);   // surgery_name column is a fact
  assert.equal(hasUsableText(flattenTemplateRow(row({ note: 'wound dry' }), 'progress_note', 'index')), true);
});

// ── hop planning (T-3, constraints 15-16) ─────────────────────────────────────────

test('OT / progress: encounter primary, discharged-history fallback ONLY when a discharge row exists', () => {
  assert.deepEqual(planOtProgressHops({ encounterId: 'IPNO-229', fallback: null }), [{ kind: 'encounter', encounterId: 'IPNO-229' }]);
  assert.deepEqual(planOtProgressHops({ encounterId: 'IPNO-229', fallback: { uhid: 'UH-1', ipdNo: 'IPNO-229' } }),
    [{ kind: 'encounter', encounterId: 'IPNO-229' }, { kind: 'uhid_ipdno', uhid: 'UH-1', ipdNo: 'IPNO-229' }]);
  assert.equal(planOtProgressHops({ encounterId: 'IP-1', fallback: { uhid: null, ipdNo: 'IP-1' } }).length, 1);
});

test('Addendum A1: the readmit fallback plan uses the readmit summary row\'s OWN ipd_no (distinct from the primary encounter hop) — or is absent when no readmit summary row exists', () => {
  // The readmit stay's discharge row supplies uhid + ipd_no → a real second hop, on a different id.
  const fb = readmitFallbackFrom({ uhid: 'UH-9', ipdNo: 'ADM-77' }, 'UH-1');
  assert.deepEqual(fb, { uhid: 'UH-9', ipdNo: 'ADM-77' });
  const plan = planOtProgressHops({ encounterId: 'IP-77', fallback: fb });
  assert.deepEqual(plan, [{ kind: 'encounter', encounterId: 'IP-77' }, { kind: 'uhid_ipdno', uhid: 'UH-9', ipdNo: 'ADM-77' }]);
  assert.notEqual((plan[1] as { ipdNo: string }).ipdNo, 'IP-77');
  // Summary row without a uhid → the finding row's uhid fills in; the ipd_no still comes from the row.
  assert.deepEqual(readmitFallbackFrom({ uhid: null, ipdNo: 'ADM-77' }, 'UH-1'), { uhid: 'UH-1', ipdNo: 'ADM-77' });
  // No readmit summary row (still admitted / never summarised) → NO fallback: the plan is the primary hop alone.
  assert.equal(readmitFallbackFrom(null, 'UH-1'), null);
  assert.equal(readmitFallbackFrom(undefined, 'UH-1'), null);
  assert.equal(readmitFallbackFrom({ uhid: 'UH-9', ipdNo: null }, 'UH-1'), null);
  assert.deepEqual(planOtProgressHops({ encounterId: 'IP-77', fallback: readmitFallbackFrom(null, 'UH-1') }), [{ kind: 'encounter', encounterId: 'IP-77' }]);
  // No uhid anywhere → the uhid+ipd_no hop cannot be formed; skipped, never half-built.
  assert.equal(readmitFallbackFrom({ uhid: null, ipdNo: 'ADM-77' }, null), null);
});

test('PAC: NEVER encounter alone — the uhid window hop is always planned beside it (OPR pre-admit rows do not carry the IP encounter id)', () => {
  const w = { fromTs: '2026-05-02T00:00:00.000Z', toTs: '2026-06-01T10:00:00.000Z' };
  const hops = planPacHops({ encounterId: 'IPNO-229', uhid: 'UH-1', window: w });
  assert.deepEqual(hops.map((h) => h.kind), ['encounter', 'uhid_window']);
  assert.deepEqual(hops[1], { kind: 'uhid_window', uhid: 'UH-1', ...w });
  // A pre-admit OPR PAC row (encounter_id 'OPR-…') pairs on uhid + window, not on the IP encounter.
  const opr = row({ uid: 'p1', encounterId: 'OPR-5512', createdAt: '2026-05-28T08:00:00Z' });
  assert.notEqual(opr.encounterId, 'IPNO-229');
  // Without a uhid the window hop cannot run — only the encounter hop is planned (coverage rests on one hop).
  assert.equal(planPacHops({ encounterId: 'IPNO-229', uhid: null, window: w }).length, 1);
});

test('pacWindow is [admit − 30d, discharge]; unknown ends → null (never guessed)', () => {
  assert.deepEqual(pacWindow('2026-06-01T00:00:00Z', '2026-06-05T10:00:00Z'), { fromTs: '2026-05-02T00:00:00.000Z', toTs: '2026-06-05T10:00:00.000Z' });
  assert.equal(pacWindow(null, '2026-06-05T10:00:00Z'), null);
  assert.equal(pacWindow('2026-06-01T00:00:00Z', null), null);
  assert.equal(pacWindow('garbage', '2026-06-05'), null);
});

test('hop union dedups by uid; rows without uid are kept', () => {
  const a = row({ uid: 'x' }); const b = row({ uid: 'x', note: 'dup' }); const c = row({ uid: null }); const d = row({ uid: null });
  assert.equal(dedupTemplateRows([a, b, c, d]).length, 3);
});

// ── coverage reducer (constraints 13-14, 21) ─────────────────────────────────────

test('coverage: present / empty / absent / fetch_failed — a fault is NEVER absent, blank rows are NEVER present', () => {
  const usable = flattenTemplateRow(row(), 'ot_note', 'index');
  const blank = flattenTemplateRow(row({ note: '  ', componentJson: null, surgeryName: null }), 'ot_note', 'index');
  assert.deepEqual(coverageFor('ok', [usable, blank]), { status: 'present', count: 2 });
  assert.deepEqual(coverageFor('ok', [blank, blank]), { status: 'empty', count: 2 });
  assert.deepEqual(coverageFor('ok', []), { status: 'absent', count: 0 });
  assert.deepEqual(coverageFor('fetch_failed', []), { status: 'fetch_failed', count: 0 });
  assert.deepEqual(coverageFor('fetch_failed', [usable]), { status: 'fetch_failed', count: 0 });   // partial rows never upgrade a faulted look
});

test('reduceTemplateCoverage keys per source; a pair with no templates is absent ×3 and still an audit', () => {
  const rows = [
    flattenTemplateRow(row(), 'ot_note', 'index'),
    flattenTemplateRow(row({ note: ' ' }), 'progress_note', 'index'),
    flattenTemplateRow(row({ note: 'wound dry, drain out' }), 'progress_note', 'readmit'),
  ];
  assert.deepEqual(reduceTemplateCoverage({ ot_note: 'ok', pac_note: 'ok', progress_note: 'ok' }, rows), {
    ot: { status: 'present', count: 1 }, pac: { status: 'absent', count: 0 }, progress: { status: 'present', count: 2 },
  });
  assert.deepEqual(reduceTemplateCoverage({ ot_note: 'ok', pac_note: 'fetch_failed', progress_note: 'ok' }, []), {
    ot: { status: 'absent', count: 0 }, pac: { status: 'fetch_failed', count: 0 }, progress: { status: 'absent', count: 0 },
  });
});

test('evidence-id prefixes do not collide with the catalog\'s S R L LX M IX RX T F', () => {
  const used = ['S', 'R', 'L', 'LX', 'M', 'IX', 'RX', 'T', 'F'];
  for (const p of Object.values(TEMPLATE_ID_PREFIX)) {
    assert.equal(used.includes(p), false, p);
    // A template id like OT1 / PAC1 / P1 must not parse as an existing prefix + number.
    for (const u of used) assert.equal(new RegExp(`^${u}\\d+$`).test(`${p}1`), false, `${p}1 vs ${u}`);
  }
});
