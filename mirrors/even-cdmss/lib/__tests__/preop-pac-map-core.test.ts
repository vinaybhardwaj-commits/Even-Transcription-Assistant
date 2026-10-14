/**
 *   node --test --import tsx lib/__tests__/preop-pac-map-core.test.ts
 *
 * B3 — the KareXpert PAC template map, exercised against THREE REAL payload shapes taken
 * from production and anonymised (lib/__tests__/fixtures/preop-pac-payloads.json): the
 * richest report in the corpus, one carrying both the vitals and the investigations JSON,
 * and the thinnest non-empty one. Every verbatim field in those fixtures is redacted —
 * free clinical prose is the only PHI the payload holds; the coded values, numerics and
 * nested JSON that the parser actually has to handle are real and untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAC_MAP, PAC_TEMPLATE_NAME, PREOP_PAC_MAP_VERSION, pacAgeMismatch, pacBodyMetrics,
  pacFieldForKey, pacObservations, parsePacComponentJson, parsePacInvestigations,
  parsePacVitals,
} from '../preop-pac-map-core.ts';

const FIXTURES = JSON.parse(
  readFileSync(join(process.cwd(), 'lib/__tests__/fixtures/preop-pac-payloads.json'), 'utf8'),
) as Array<{ uid: string; shape: string; created_at: string; component_json: string }>;

const byShape = (s: string) => FIXTURES.find((f) => f.shape === s)!;

test('three real payload shapes are fixtured, and all three parse without error', () => {
  assert.equal(FIXTURES.length, 3);
  assert.deepEqual(FIXTURES.map((f) => f.shape).sort(), ['labs+vitals', 'richest', 'thinnest']);
  for (const f of FIXTURES) {
    const p = parsePacComponentJson(f.component_json);
    assert.equal(p.parseError, null, `${f.shape} must parse`);
    // Only 56 of the 95 live reports carry templateName/title at all, so its ABSENCE is a
    // normal payload shape and must not be read as a different template. The section
    // labels are the reliable identity, and every report has them.
    assert.ok(p.templateName === null || p.templateName === PAC_TEMPLATE_NAME, `${f.shape} template name`);
    assert.ok(p.sections.length > 10, `${f.shape} carries its section labels`);
  }
  assert.ok(FIXTURES.some((f) => parsePacComponentJson(f.component_json).templateName === PAC_TEMPLATE_NAME),
    'at least one fixture names the template outright');
});

test('the map is internally consistent — one key per entry, one id per entry', () => {
  assert.equal(PREOP_PAC_MAP_VERSION, 'preop-pac-map/1');
  assert.equal(new Set(PAC_MAP.map((f) => f.key)).size, PAC_MAP.length, 'no duplicate keys');
  assert.equal(new Set(PAC_MAP.map((f) => f.id)).size, PAC_MAP.length, 'no duplicate ids');
  assert.equal(pacFieldForKey('WWW8S')?.id, 'pac_asa');
  assert.equal(pacFieldForKey('not-a-key'), undefined);
});

test('every mapped field declares its read type and how it was decoded', () => {
  for (const f of PAC_MAP) {
    assert.ok(['verbatim', 'numeric', 'boolean', 'enum', 'json'].includes(f.read), f.id);
    assert.ok(['key_name', 'value_domain', 'section_position'].includes(f.decodedBy), f.id);
    assert.ok(['certain', 'provisional'].includes(f.confidence), f.id);
  }
});

// ── the D4 boundary, enforced by test rather than by intention ──────────────────

test('NO free-text field can reach an instrument — the B5 boundary is structural', () => {
  for (const f of PAC_MAP) {
    if (f.read === 'verbatim') {
      assert.equal(f.rules, undefined, `${f.id} is free text and must feed no instrument`);
    }
  }
});

test('NO provisional field can move a score', () => {
  // ASA and Mallampati are decoded from their value domain alone, with no label anywhere
  // in the note render to cross-check them against. They are displayed and nothing more.
  for (const f of PAC_MAP) {
    if (f.confidence === 'provisional') assert.equal(f.rules, undefined, `${f.id} is provisional`);
  }
  assert.equal(PAC_MAP.find((f) => f.id === 'pac_asa')?.confidence, 'provisional');
  assert.equal(PAC_MAP.find((f) => f.id === 'pac_mallampati')?.confidence, 'provisional');
});

test('acute renal failure is NOT read as Charlson chronic renal disease', () => {
  const renal = PAC_MAP.find((f) => f.id === 'pac_renal_findings');
  assert.equal(renal?.rules, undefined, 'ARF and chronic kidney disease are different diseases');
});

// ── the payloads themselves ─────────────────────────────────────────────────────

test('the richest payload maps the fields the coverage table says it does', () => {
  const p = parsePacComponentJson(byShape('richest').component_json);
  // ASA and Mallampati — the two fields the PRD's text scan recorded as 5/95 and 0/95.
  assert.ok(p.fields.pac_asa, 'ASA is present in the payload');
  assert.ok(/^(I|II|III|IV|V|VI|E)$/.test(p.fields.pac_asa.tokens[0].trim()));
  assert.ok(p.fields.pac_mallampati.tokens.some((t) => /^MP [1-4]$/.test(t)));
  // A redacted verbatim field still parses as text, so blank-vs-present is preserved.
  assert.ok(p.fields.pac_diagnosis.text?.includes('redacted'));
  assert.equal(p.fields.pac_diagnosis.read, 'verbatim');
});

test('an unticked checkbox group is NOT RECORDED, never "recorded as no"', () => {
  // KareXpert serialises an untouched multi-select as the literal `false`. Reading that
  // as a negative would silently assert absence across a template nobody filled in.
  const p = parsePacComponentJson(JSON.stringify([
    { name: 'TF-7824', valueString: 'Review of Systems' },
    { name: 'SD2DC', valueString: 'false' },
  ]));
  assert.equal(p.fields.pac_cvs_ros, undefined);
  assert.deepEqual(pacObservations(p, null, null), []);
});

test('coded review-of-systems values feed the instruments, in both directions', () => {
  const mi = parsePacComponentJson(JSON.stringify([{ name: 'SD2DC', valueString: '["MI"]' }]));
  const obs = pacObservations(mi, '2026-08-20T00:00:00Z', 'pac-1');
  assert.deepEqual(obs.map((o) => [o.inputId, o.status]).sort(),
    [['ischaemic_heart_disease', 'present'], ['myocardial_infarction', 'present']].sort());
  assert.equal(obs[0].source, 'PAC');
  assert.equal(obs[0].observedAt, '2026-08-20T00:00:00Z');

  // ...and the one negative assertion: a ticked "within normal limits".
  const wnl = parsePacComponentJson(JSON.stringify([{ name: 'SD2DC', valueString: '["WNL"]' }]));
  const neg = pacObservations(wnl, null, null);
  assert.deepEqual(neg.map((o) => o.inputId).sort(),
    ['congestive_heart_failure', 'ischaemic_heart_disease', 'myocardial_infarction']);
  assert.ok(neg.every((o) => o.status === 'absent'));
});

test('NIDDM resolves the insulin question the booking form cannot answer (A1-1)', () => {
  const p = parsePacComponentJson(JSON.stringify([{ name: 'S8F4S', valueString: '["NIDDM"]' }]));
  const obs = pacObservations(p, null, null);
  const by = new Map(obs.map((o) => [o.inputId, o.status]));
  assert.equal(by.get('diabetes_mellitus'), 'present');
  assert.equal(by.get('diabetes_uncomplicated'), 'present');
  assert.equal(by.get('insulin_treated_diabetes'), 'absent');   // non-insulin-dependent
});

test('an antihypertensive on the medication list settles the mFI-5 hypertension item', () => {
  const p = parsePacComponentJson(JSON.stringify([{ name: 'Q6D5F', valueString: '["Anti Hypertensive"]' }]));
  const obs = pacObservations(p, null, null);
  assert.deepEqual(obs.map((o) => [o.inputId, o.status]), [['hypertension_on_medication', 'present']]);
  // ...whereas the hypertension DIAGNOSIS alone does not, because the item is
  // "hypertension requiring medication".
  const dx = parsePacComponentJson(JSON.stringify([{ name: 'CDC58VVZ', valueString: '["HTN"]' }]));
  assert.deepEqual(pacObservations(dx, null, null), []);
});

test('an oral hypoglycaemic confirms diabetes but does NOT settle insulin treatment', () => {
  const p = parsePacComponentJson(JSON.stringify([{ name: 'JHGF', valueString: '["Oral Hypoglycemic"]' }]));
  const ids = pacObservations(p, null, null).map((o) => o.inputId);
  assert.deepEqual(ids, ['diabetes_mellitus']);
  assert.ok(!ids.includes('insulin_treated_diabetes'));
});

// ── the nested payloads ─────────────────────────────────────────────────────────

test('the vitals JSON parses to typed, unit-carrying values', () => {
  const p = parsePacComponentJson(byShape('labs+vitals').component_json);
  assert.ok(p.vitals.length > 0);
  for (const v of p.vitals) assert.equal(typeof v.type, 'string');
  const bp = p.vitals.find((v) => v.type === 'systolic');
  if (bp) { assert.equal(bp.unit, 'mm/Hg'); assert.equal(typeof bp.value, 'number'); }
});

test('the investigations JSON parses, and creatinine reaches RCRI as a numeric', () => {
  const p = parsePacComponentJson(JSON.stringify([{
    name: 'okhufuv',
    valueString: JSON.stringify([
      { serviceItemName: 'Creatinine - Serum / Plasma', value: '2.4', referenceRange: { low: 0.6, high: 1.3 } },
      { serviceItemName: 'Haemoglobin', value: '14.9', referenceRange: { low: 13, high: 17 } },
      { serviceItemName: 'Advice', value: 'review with reports' },
    ]),
  }]));
  assert.equal(p.investigations.length, 3);
  const obs = pacObservations(p, null, null);
  assert.deepEqual(obs.map((o) => [o.inputId, o.status, o.value]), [['creatinine_over_2', 'present', 2.4]]);

  // A normal creatinine collapses the range the other way.
  const low = parsePacComponentJson(JSON.stringify([{ name: 'okhufuv', valueString: JSON.stringify([
    { serviceItemName: 'Creatinine - Serum / Plasma', value: '0.89', referenceRange: { low: 0.5, high: 1 } }]) }]));
  assert.equal(pacObservations(low, null, null)[0].status, 'absent');

  // A ratio analyte is a different quantity and is never compared against 2.0 mg/dL.
  const ratio = parsePacComponentJson(JSON.stringify([{ name: 'okhufuv', valueString: JSON.stringify([
    { serviceItemName: 'BUN Creatinine Ratio', value: '18.7' }]) }]));
  assert.deepEqual(pacObservations(ratio, null, null), []);
});

test('a creatinine reported on a non-mg/dL scale is skipped, not mis-compared', () => {
  const umol = parsePacComponentJson(JSON.stringify([{ name: 'okhufuv', valueString: JSON.stringify([
    { serviceItemName: 'Creatinine - Serum / Plasma', value: '88', referenceRange: { low: 60, high: 110 } }]) }]));
  assert.deepEqual(pacObservations(umol, null, null), []);
});

// ── tolerance ───────────────────────────────────────────────────────────────────

test('the parser is tolerant of blanks, junk and an absent payload', () => {
  assert.equal(parsePacComponentJson(null).parseError, 'no component_json on the report');
  assert.equal(parsePacComponentJson('{"not":"an array"}').parseError, 'component_json is not an array');
  assert.ok(parsePacComponentJson('not json at all').parseError?.startsWith('component_json did not parse'));
  // An entry with no name, a null value, and an unknown key together must not throw.
  const p = parsePacComponentJson(JSON.stringify([
    { valueString: 'orphan' }, { name: 'iu87', valueString: null },
    { name: 'BRAND_NEW_KEY', valueString: 'something' },
  ]));
  assert.equal(p.parseError, null);
  assert.deepEqual(p.unmappedKeys, ['BRAND_NEW_KEY']);   // listed, never silently dropped
  assert.equal(p.fields.pac_diagnosis, undefined);
  assert.deepEqual(parsePacVitals('{{{'), []);
  assert.deepEqual(parsePacInvestigations('{{{'), []);
});

test('body metrics compute a BMI when the template did not', () => {
  const p = parsePacComponentJson(JSON.stringify([{ name: 'svxn8976', valueString: JSON.stringify({
    vitalsName: [
      { vitalType_id: 'height', value: 170, units: 'cm', name: 'Height' },
      { vitalType_id: 'weight', value: 72, units: 'kg', name: 'Weight' },
    ] }) }]));
  assert.deepEqual(pacBodyMetrics(p), { heightCm: 170, weightKg: 72, bmi: 24.9 });
});

test('the PAC\'s own age is carried to flag a mismatch, never to score one', () => {
  const p = parsePacComponentJson(JSON.stringify([{ name: 'Age', valueString: '73' }]));
  assert.equal(pacAgeMismatch(p, 73), null);
  assert.equal(pacAgeMismatch(p, 74), null);     // a birthday, not a data problem
  assert.equal(pacAgeMismatch(p, 68), 5);
  assert.equal(pacAgeMismatch(p, null), null);
  // ...and it never becomes an observation.
  assert.deepEqual(pacObservations(p, null, null), []);
});

test('the conclusion is quoted verbatim from the anaesthetist\'s own last box', () => {
  const p = parsePacComponentJson(JSON.stringify([
    { name: 'QQQWWW_g', valueString: 'PATIENT CAN BE TAKEN FOR SURGERY' },
  ]));
  assert.equal(p.conclusion, 'PATIENT CAN BE TAKEN FOR SURGERY');
  assert.deepEqual(pacObservations(p, null, null), []);   // it is displayed, never scored
});
