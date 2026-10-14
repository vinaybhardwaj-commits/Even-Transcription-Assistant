import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFamily, archetypeFor, instrumentsDue, scoreInstrument,
  PROM_SCHED_VERSION, PROM_SCORING_VERSION, UID_FAMILY_MAP, type SeriesInput,
} from '../proms/schedule-core';
import {
  FAMILY_PACKS, HOUSE_SETS, CORE, SHARED_SCALES, ARCHETYPE_WINDOWS, PREM_POINTS,
  instrumentById, FAMILY_REGEX, PROM_CATALOG_VERSION, HS_SETS_VERSION, PREM_MODULE, PREM_SERVICE_FLAG,
} from '../proms/catalog';

// ── versions ──
test('versions', () => {
  assert.equal(PROM_CATALOG_VERSION, 'prom-catalog/0.1');
  assert.equal(HS_SETS_VERSION, 'hs-sets/0.2');
  assert.equal(PROM_SCHED_VERSION, 'prom-sched/0.1');
  assert.equal(PROM_SCORING_VERSION, 'prom-scoring/0.1');
});

// ── classifyFamily: regex map v1, first-match-wins ──
test('classifyFamily: each regex family (order = first-match-wins)', () => {
  assert.equal(classifyFamily({ procedureName: 'ORIF of femur' }), 'ortho_spine');
  assert.equal(classifyFamily({ procedureName: 'rotator cuff repair' }), 'ortho_spine');
  assert.equal(classifyFamily({ procedureName: 'Total Thyroidectomy' }), 'thyroid');
  assert.equal(classifyFamily({ procedureName: 'LSCS' }), 'obstetric');
  assert.equal(classifyFamily({ procedureName: 'EVLT varicose veins' }), 'vascular');
  assert.equal(classifyFamily({ procedureName: 'liposuction' }), 'plastics');
  assert.equal(classifyFamily({ procedureName: 'sebaceous cyst excision' }), 'minor_excision_wound');
  assert.equal(classifyFamily({ procedureName: 'meatotomy' }), 'urology');   // v1.1: DJ-stent/holep now route to stones/bph — coarse urology still catches urethra/meatotomy
  assert.equal(classifyFamily({ procedureName: 'grommet insertion' }), 'ent');
  assert.equal(classifyFamily({ procedureName: 'mastectomy' }), 'breast');
  assert.equal(classifyFamily({ procedureName: 'liver transplant' }), 'rare_major');
});

test('classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled', () => {
  // v1.1: appendicectomy + cholecystectomy are now COVERED (asserted in the v1.1 block below); a
  // truly-unknown name still falls through to core+PREM.
  assert.equal(classifyFamily({ procedureName: 'excision of lump nos xyz' }), 'minor_excision_wound');
  assert.equal(classifyFamily({ procedureName: 'something with no keyword zzz' }), 'unknown');
  assert.equal(classifyFamily({ surgeryTypeUid: '', procedureName: '' }), 'unknown');
  assert.equal(classifyFamily({ surgeryTypeUid: '   ', procedureName: 'ORIF' }), 'ortho_spine');   // empty uid → regex
  assert.equal(classifyFamily({}), 'unknown');
});

// ── classifyFamily: v1.1 main-family coverage (prepended, specific-first) ──
test('classifyFamily v1.1: main surgical families reach their existing packs', () => {
  // proctology (real db names)
  assert.equal(classifyFamily({ procedureName: 'Laser Haemorrhoidectomy' }), 'proctology');
  assert.equal(classifyFamily({ procedureName: 'Fissure in Ano' }), 'proctology');
  assert.equal(classifyFamily({ procedureName: 'LASER ASSISTED FISTULA ABLATION' }), 'proctology');
  assert.equal(classifyFamily({ procedureName: 'EUA+ LASER HEMORRHOIDOPEXY' }), 'proctology');
  // cholecystectomy — the misroute is fixed (specific-first beats minor_excision_wound's `cyst`)
  assert.equal(classifyFamily({ procedureName: 'Cholecystectomy (Lap)' }), 'cholecystectomy');
  assert.notEqual(classifyFamily({ procedureName: 'Cholecystectomy (Lap)' }), 'minor_excision_wound');
  // hysterectomy / hernia / appendicectomy
  assert.equal(classifyFamily({ procedureName: 'Hysterectomy' }), 'hysterectomy');
  assert.equal(classifyFamily({ procedureName: 'Inguinal hernia' }), 'hernia');
  assert.equal(classifyFamily({ procedureName: 'Umbilical Hernia Mesh Repair' }), 'hernia');
  assert.equal(classifyFamily({ procedureName: 'appendicectomy' }), 'appendicectomy_emergency');
  // urology split: BPH/TURP + stones win before the coarse `urology` (stent/holep) pattern
  assert.equal(classifyFamily({ procedureName: 'TURP' }), 'bph_turp_laser');
  assert.equal(classifyFamily({ procedureName: 'PCNL for renal stone' }), 'urinary_stones');
  assert.equal(classifyFamily({ procedureName: 'DJ stent removal' }), 'urinary_stones');   // was 'urology' in v1 — now stones
  // ENT / eye / other
  assert.equal(classifyFamily({ procedureName: 'Tonsillectomy' }), 'tonsillectomy');
  assert.equal(classifyFamily({ procedureName: 'FESS' }), 'fess_sinus');
  assert.equal(classifyFamily({ procedureName: 'Phacoemulsification cataract surgery' }), 'cataract');
  assert.equal(classifyFamily({ procedureName: 'Hydrocele repair' }), 'scrotal');
  assert.equal(classifyFamily({ procedureName: 'Myomectomy' }), 'fibroids_myomectomy');
});

test('classifyFamily v1.1: existing coarse families unregressed', () => {
  assert.equal(classifyFamily({ procedureName: 'ORIF of femur' }), 'ortho_spine');
  assert.equal(classifyFamily({ procedureName: 'Total Thyroidectomy' }), 'thyroid');
  assert.equal(classifyFamily({ procedureName: 'something nonsense xyz' }), 'unknown');
});

test('classifyFamily v1.1: proctology routes to its house pack end-to-end', () => {
  const due = instrumentsDue('proctology', BASE, '2026-02-04');
  assert.ok(new Set(due.map((d) => d.instrumentId)).has('hs-procto'));
});

test('classifyFamily: the universal_core catch-all is never returned as a family', () => {
  assert.ok(!FAMILY_REGEX.slice(0, -1).some((r) => r.family === 'universal_core'));
  assert.equal(FAMILY_REGEX[FAMILY_REGEX.length - 1].family, 'universal_core');
  assert.equal(classifyFamily({ procedureName: 'something with no keyword xyz' }), 'unknown');
});

// ── UID_FAMILY_MAP v1.0 (ratified 12 Jul): uid-map is the precision layer, consulted before regex ──
test('UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives', () => {
  assert.equal(classifyFamily({ surgeryTypeUid: 'dYxdgQW7eEujVtI2uKiS' }), 'knee_arthroplasty');
  assert.equal(classifyFamily({ surgeryTypeUid: 'PoWNdt84bEjKfnKkwYBl' }), 'knee_arthroscopy_acl');
  assert.equal(classifyFamily({ surgeryTypeUid: 'gA0XoYna4sy8JSiDgtwt' }), 'proctology');
  assert.equal(classifyFamily({ surgeryTypeUid: 'SgKRBQaHVOGWtxeElbW9' }), 'excluded');
  assert.equal(classifyFamily({ surgeryTypeUid: 'tXRcDLD8FHZ7wM4cRR3a' }), 'facial_ent');
});

test('UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)', () => {
  // ACL uid present → knee_arthroscopy_acl, NOT what the free-text regex would return for the name.
  assert.equal(classifyFamily({ procedureName: 'ACL Reconstruction' }), 'plastics');   // regex-only (misroute)
  assert.equal(classifyFamily({ surgeryTypeUid: 'PoWNdt84bEjKfnKkwYBl', procedureName: 'ACL Reconstruction' }), 'knee_arthroscopy_acl');
  // pilonidal-sinus uid → proctology even though the name regex would hit fess_sinus.
  assert.equal(classifyFamily({ surgeryTypeUid: 'gA0XoYna4sy8JSiDgtwt', procedureName: 'Laser pilonidal sinus ablation' }), 'proctology');
});

test('UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)', () => {
  assert.equal(archetypeFor('facial_ent'), 'STANDARD');
  const series: SeriesInput = { anchorDate: '2026-01-01', plannedSurgeryDate: '2026-01-10', dischargeDate: '2026-02-01' };
  const ids = new Set(instrumentsDue('facial_ent', series, '2026-02-04').map((d) => d.instrumentId));
  // exactly the 3 CORE instruments + the PREM module — no pack add-on (primary/fallback both null).
  assert.deepEqual([...ids].sort(), ['hs-return-to-function', 'pain_nrs', 'prem', 'whodas12']);
});

test('UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family', () => {
  const packFamilies = new Set(FAMILY_PACKS.map((p) => p.family));
  for (const fam of Object.values(UID_FAMILY_MAP)) {
    if (fam === 'excluded') continue;
    assert.ok(packFamilies.has(fam), `mapped family "${fam}" missing from FAMILY_PACKS`);
  }
  assert.equal(Object.keys(UID_FAMILY_MAP).length, 31);
});

// ── archetypeFor ──
test('archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD', () => {
  assert.equal(archetypeFor('knee_arthroplasty'), 'LONG_ARC');
  assert.equal(archetypeFor('thyroid'), 'STANDARD');
  assert.equal(archetypeFor('ortho_spine'), 'LONG_ARC');       // via REGEX_FAMILY_PACK → lumbar_spine
  assert.equal(archetypeFor('minor_excision_wound'), 'DAYCARE');
  assert.equal(archetypeFor('unknown'), 'STANDARD');
});

// ── instrumentsDue window math ──
const BASE: SeriesInput = { anchorDate: '2026-01-01', plannedSurgeryDate: '2026-01-10', dischargeDate: '2026-02-01' };

test('instrumentsDue: cancelled → empty', () => {
  assert.deepEqual(instrumentsDue('thyroid', { ...BASE, cancelled: true }, '2026-02-04'), []);
});

test('instrumentsDue: no discharge → pre-op (baseline) only', () => {
  const due = instrumentsDue('thyroid', { anchorDate: '2026-01-01', plannedSurgeryDate: '2026-01-10', dischargeDate: null }, '2026-01-05');
  assert.ok(due.length > 0);
  assert.ok(due.every((d) => d.window === 'baseline'));
});

test('instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close', () => {
  const at = (now: string) => instrumentsDue('thyroid', BASE, now).find((d) => d.window === 'd72h' && d.instrumentId === 'whodas12')!;
  assert.equal(at('2026-02-01').status, 'out_of_window');   // discharge day, before the 72h window opens (02-02)
  assert.equal(at('2026-02-04').status, 'in_window');       // +3d, within ±2
  assert.equal(at('2026-03-01').status, 'missed');          // long past close (02-06)
});

test('instrumentsDue: baseline — in_window before surgery, missed after', () => {
  const bl = (now: string) => instrumentsDue('thyroid', BASE, now).find((d) => d.window === 'baseline' && d.instrumentId === 'whodas12')!;
  assert.equal(bl('2026-01-05').status, 'in_window');       // between anchor 01-01 and surgery 01-10
  assert.equal(bl('2026-01-20').status, 'missed');          // after the planned surgery date
});

test('instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)', () => {
  const due = instrumentsDue('thyroid', BASE, '2026-02-04');
  const ids = new Set(due.map((d) => d.instrumentId));
  assert.ok(ids.has('whodas12') && ids.has('pain_nrs') && ids.has('hs-return-to-function'));
  assert.ok(ids.has('hs-thyroid'));   // the thyroid pack add-on (house)
  assert.ok(ids.has('prem'));         // PREM module at PREM_POINTS
  assert.deepEqual(ARCHETYPE_WINDOWS.STANDARD, ['baseline', 'd72h', 'w2', 'w6', 'm3']);
});

test('instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback', () => {
  // fess_sinus: primary snot22 (Pv), fallback hs-sinus → fallback selected pre-sweep.
  const due = instrumentsDue('fess_sinus', BASE, '2026-02-04');
  const ids = new Set(due.map((d) => d.instrumentId));
  assert.ok(ids.has('hs-sinus'));
  assert.ok(!ids.has('snot22'));
});

// ── scoring ──
test('scoreInstrument: house simple sum; complete set scored', () => {
  const r = scoreInstrument('hs-gi', [{ itemId: 'g1', value: 'sometimes' }, { itemId: 'g2', value: 'sometimes' }, { itemId: 'g3', value: 'sometimes' }]);
  assert.equal(r.score, 6);       // 3 × index(sometimes)=2
  assert.equal(r.scale, 'house');
  assert.equal(r.version, 'prom-scoring/0.1');
});

test('scoreInstrument: partial set → honest null', () => {
  const r = scoreInstrument('hs-gi', [{ itemId: 'g1', value: 'often' }, { itemId: 'g2', value: 'never' }]);
  assert.equal(r.score, null);
});

test('scoreInstrument: ⚠ items emit the escalation code', () => {
  assert.ok(scoreInstrument('hs-wound', [{ itemId: 'w1', value: 'no' }, { itemId: 'w2', value: 'no' }, { itemId: 'w3', value: 'no' }, { itemId: 'w4', value: 'yes' }]).escalations.includes('E5'));   // wound opened → always → E5
  assert.ok(scoreInstrument('hs-procto', [{ itemId: 'p1', value: 'often' }, { itemId: 'p2', value: '2' }, { itemId: 'p3', value: 'never' }, { itemId: 'p4', value: 'no' }]).escalations.includes('E4'));   // bleeding often → E4
  // wound E2 only when the wound item AND the fever item are positive
  assert.ok(scoreInstrument('hs-wound', [{ itemId: 'w1', value: 'yes' }, { itemId: 'w2', value: 'no' }, { itemId: 'w3', value: 'yes' }, { itemId: 'w4', value: 'no' }]).escalations.includes('E2'));
  assert.ok(!scoreInstrument('hs-wound', [{ itemId: 'w1', value: 'yes' }, { itemId: 'w2', value: 'no' }, { itemId: 'w3', value: 'no' }, { itemId: 'w4', value: 'no' }]).escalations.includes('E2'));
});

test('scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)', () => {
  // koos_jr/hoos_jr/… are now scored (Phase 2b); the KOOS-full (koos) + Pv instruments remain null.
  const r = scoreInstrument('koos', []);
  assert.equal(r.score, null);
  assert.equal(r.scale, 'validated');
});

// ── WHODAS-12 simple scoring (0.2a-2): sum of the 12 item scores (0..4 on WHODAS5 None…Extreme) ──
const whodas = (values: string[]) => scoreInstrument('whodas12', values.map((v, i) => ({ itemId: `whodas_s${i + 1}`, value: v })));
test('scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48', () => {
  const allNone = whodas(Array(12).fill('None'));
  assert.equal(allNone.score, 0);
  assert.equal(allNone.scale, 'whodas12-simple');
  assert.equal(allNone.version, 'prom-scoring/0.1');
  const allExtreme = whodas(Array(12).fill('Extreme or cannot do'));
  assert.equal(allExtreme.score, 48);   // 12 × 4
  const mixed = whodas(['None', 'Mild', 'Moderate', 'Severe', 'Extreme or cannot do', 'None', 'Mild', 'Moderate', 'Severe', 'Extreme or cannot do', 'Mild', 'Moderate']);
  assert.equal(mixed.score, 0 + 1 + 2 + 3 + 4 + 0 + 1 + 2 + 3 + 4 + 1 + 2);   // = 23
});

test('scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null', () => {
  assert.equal(whodas(Array(11).fill('None')).score, null);          // 11 items → incomplete
  assert.equal(whodas(Array(12).fill('unknownword')).score, null);   // none map → incomplete
});

test('catalog: whodas12 has exactly 12 items, each on WHODAS5', () => {
  const def = instrumentById('whodas12')!;
  assert.equal(def.items.length, 12);
  assert.equal(def.itemCount, 12);
  assert.ok(def.items.every((it) => it.scale === 'WHODAS5'));
  assert.equal(def.items[0].id, 'whodas_s1');
  assert.equal(def.items[11].id, 'whodas_s12');
});

// ── house PREM module scoring (0.2a-2): experience sum of prem1..prem7 (item 8 excluded) ──
const premResp = (vals: Record<string, string>) => scoreInstrument('prem', Object.entries(vals).map(([itemId, value]) => ({ itemId, value })));
test('scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21', () => {
  const full = premResp({
    prem1: 'yes, fully', prem2: 'mostly', prem3: 'yes, fully', prem4: 'partly',
    prem5: 'mostly', prem6: 'no', prem7: 'yes, fully', prem8: '9',
  });
  // 3 + 2 + 3 + 1 + 2 + 0 + 3 = 14 (prem8=9 NOT summed)
  assert.equal(full.score, 14);
  assert.equal(full.scale, 'prem-experience');
  assert.deepEqual(full.escalations, []);
  const allBest = premResp({ prem1: 'yes, fully', prem2: 'yes, fully', prem3: 'yes, fully', prem4: 'yes, fully', prem5: 'yes, fully', prem6: 'yes, fully', prem7: 'yes, fully', prem8: '10' });
  assert.equal(allBest.score, 21);   // 7 × 3, higher = better
});

test('scoreInstrument: PREM partial (an EXP4 item missing) → honest null', () => {
  const partial = premResp({ prem1: 'yes, fully', prem2: 'mostly', prem3: 'yes, fully', prem4: 'partly', prem5: 'mostly', prem6: 'no', prem8: '9' });   // prem7 missing
  assert.equal(partial.score, null);
});

test('catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present', () => {
  assert.equal(PREM_MODULE.items.length, 8);
  assert.equal(PREM_MODULE.itemCount, 8);
  for (let i = 1; i <= 7; i++) assert.equal(PREM_MODULE.items.find((it) => it.id === `prem${i}`)!.scale, 'EXP4');
  assert.equal(PREM_MODULE.items.find((it) => it.id === 'prem8')!.scale, 'NRS-11');
  assert.equal(PREM_SERVICE_FLAG.kind, 'service_recovery');
});

test('catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves', () => {
  assert.deepEqual(SHARED_SCALES['WHODAS5'], ['None', 'Mild', 'Moderate', 'Severe', 'Extreme or cannot do']);
  assert.deepEqual(SHARED_SCALES['EXP4'], ['no', 'partly', 'mostly', 'yes, fully']);
  for (const it of instrumentById('whodas12')!.items) assert.ok(it.scale in SHARED_SCALES);
  for (const it of PREM_MODULE.items) assert.ok(it.scale in SHARED_SCALES);
});

// ── catalog integrity ──
test('integrity: every FamilyPack primary/fallback resolves to a known instrument', () => {
  for (const p of FAMILY_PACKS) {
    if (p.primary) assert.ok(instrumentById(p.primary), `${p.family} primary ${p.primary} unresolved`);
    if (p.fallback) assert.ok(instrumentById(p.fallback), `${p.family} fallback ${p.fallback} unresolved`);
  }
});

test('integrity: every HOUSE item uses a SHARED_SCALES scale', () => {
  const houseDefs = [...Object.values(HOUSE_SETS), ...CORE.filter((c) => c.kind === 'house')];
  for (const def of houseDefs) for (const it of def.items) assert.ok(it.scale in SHARED_SCALES, `${def.id}/${it.id} scale ${it.scale}`);
});

test('integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes', () => {
  for (const a of ['SCOPE', 'DAYCARE', 'STANDARD', 'LONG_ARC', 'ONCO_MAJOR'] as const) {
    assert.ok(ARCHETYPE_WINDOWS[a]?.length, `${a} windows`);
    assert.ok(ARCHETYPE_WINDOWS[a].includes('baseline'));
    assert.ok(PREM_POINTS[a]?.length, `${a} prem points`);
  }
});

test('integrity: every house item scale has response options; whodas12 now carries its 12 items', () => {
  for (const def of Object.values(HOUSE_SETS)) { assert.equal(def.kind, 'house'); assert.ok(def.items.length > 0); }
  // 0.2a-2: whodas12 item text is now encoded verbatim (12 items on WHODAS5).
  assert.equal(instrumentById('whodas12')!.items.length, 12);
  assert.equal(instrumentById('whodas12')!.itemCount, 12);
});

// ── Phase-2b validated instruments: verbatim items + scoring ──
// Build a full response set for an instrument by picking each item's option at a chosen index.
const atIndex = (id: string, k: number) => {
  const def = instrumentById(id)!;
  return def.items.map((it) => ({ itemId: it.id, value: SHARED_SCALES[it.scale as keyof typeof SHARED_SCALES][k] }));
};

test('2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)', () => {
  assert.equal(scoreInstrument('koos_jr', atIndex('koos_jr', 0)).score, 100.000);   // all 'None' → raw 0
  assert.equal(scoreInstrument('koos_jr', atIndex('koos_jr', 2)).score, 52.465);    // all 'Moderate' → raw 14
  assert.equal(scoreInstrument('koos_jr', atIndex('koos_jr', 0)).scale, 'koos-jr');
  assert.equal(scoreInstrument('hoos_jr', atIndex('hoos_jr', 0)).score, 100.000);   // all 'None' → raw 0
  assert.equal(scoreInstrument('hoos_jr', atIndex('hoos_jr', 4)).score, 0.000);     // all 'Extreme' → raw 24
});

test('2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count', () => {
  // spadi all '5' (NRS-11 index 5) → Σ=65 → round(65/130×100)=50, higher=worse.
  assert.equal(scoreInstrument('spadi', atIndex('spadi', 5)).score, 50);
  // ndi all index-2 → Σ=20 (0–50), higher=worse.
  assert.equal(scoreInstrument('ndi', atIndex('ndi', 2)).score, 20);
  // nose all 'Severe Problem' (index 4) → raw 20 × 5 = 100 (NOT ×20).
  assert.equal(scoreInstrument('nose', atIndex('nose', 4)).score, 100);
  // ipss all symptom items at index 5 → ΣQ1–Q7 = 35; qol answer present but excluded.
  const ipss = scoreInstrument('ipss', atIndex('ipss', 5));
  assert.equal(ipss.score, 35);
  assert.equal(ipss.scale, 'ipss');
  // nyha 'Class III' → class index+1 = 3.
  assert.equal(scoreInstrument('nyha', [{ itemId: 'nyha_class', value: 'Class III' }]).score, 3);
  // rmdq: exactly 3 sentences ticked → 3 (no partial-null).
  assert.equal(scoreInstrument('rmdq', [
    { itemId: 'rmdq_1', value: 'Applies to me today' },
    { itemId: 'rmdq_5', value: 'Applies to me today' },
    { itemId: 'rmdq_20', value: 'Applies to me today' },
  ]).score, 3);
  assert.equal(scoreInstrument('rmdq', []).score, 0);   // no ticks → 0, not null
});

test('2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)', () => {
  assert.equal(scoreInstrument('koos_jr', atIndex('koos_jr', 0).slice(1)).score, null);   // 6/7 answered
  assert.equal(scoreInstrument('hoos_jr', atIndex('hoos_jr', 0).slice(1)).score, null);
  assert.equal(scoreInstrument('spadi', atIndex('spadi', 5).slice(1)).score, null);
  assert.equal(scoreInstrument('ndi', atIndex('ndi', 2).slice(1)).score, null);
  assert.equal(scoreInstrument('ipss', atIndex('ipss', 5).slice(1)).score, null);         // missing a symptom item
  assert.equal(scoreInstrument('nose', atIndex('nose', 4).slice(1)).score, null);
  assert.equal(scoreInstrument('nyha', []).score, null);
});

test('2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections', () => {
  for (const s of ['KOOS5', 'NOSE5', 'IPSS6', 'IPSS_NOCT', 'IPSS_QOL', 'NYHA4', 'RMDQ_TICK'] as const) {
    assert.ok(Array.isArray(SHARED_SCALES[s]) && SHARED_SCALES[s].length > 0, `scale ${s} missing`);
  }
  const counts: Record<string, number> = { koos_jr: 7, hoos_jr: 6, spadi: 13, rmdq: 24, ndi: 10, ipss: 8, nose: 5, nyha: 1 };
  for (const [id, n] of Object.entries(counts)) {
    const def = instrumentById(id)!;
    assert.equal(def.items.length, n, `${id} item count`);
    for (const it of def.items) assert.ok(it.scale in SHARED_SCALES, `${id}.${it.id} scale ${it.scale} not in SHARED_SCALES`);
  }
  // NDI options are exactly 6 per section; NYHA4 has 4 classes.
  for (let i = 1; i <= 10; i++) assert.equal(SHARED_SCALES[`NDI_S${i}` as keyof typeof SHARED_SCALES].length, 6);
  assert.equal(SHARED_SCALES['NYHA4'].length, 4);
  // the 2 sweep lic corrections
  assert.equal(FAMILY_PACKS.find((p) => p.family === 'cervical_spine')!.lic, 'F');
  // dental_maxillofacial lic corrected house→Pv in Phase 2a so the Pv-fallback rule fires (→ hs-dental).
  assert.equal(FAMILY_PACKS.find((p) => p.family === 'dental_maxillofacial')!.lic, 'Pv');
});

// ── Phase-2a house fallback sets (hs-sets/0.2): 6 families → 6 verbatim house sets ──
// (family, hs-set id, primary that must NOT be selected pre-sweep)
const HS2A: [string, string, string][] = [
  ['hand_wrist', 'hs-wrist', 'prwe'],
  ['fibroids_myomectomy', 'hs-fibroid', 'ufsqol'],
  ['endometriosis', 'hs-endo', 'ehp5'],
  ['prolapse', 'hs-prolapse', 'pfdi20'],
  ['varicose_veins', 'hs-varicose', 'avvq'],
  ['dental_maxillofacial', 'hs-dental', 'ohip14'],
];

test('2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)', () => {
  for (const [family, hs, primary] of HS2A) {
    const ids = new Set(instrumentsDue(family, BASE, '2026-02-04').map((d) => d.instrumentId));
    assert.ok(ids.has(hs), `${family} should schedule ${hs}`);
    assert.ok(!ids.has(primary), `${family} should NOT schedule the unconfirmed primary ${primary}`);
    assert.ok(instrumentById(hs), `${hs} unresolved`);
  }
});

test('2a scoring: complete house set → numeric sum (scale house); partial → honest null', () => {
  for (const [, hs] of HS2A) {
    const items = instrumentById(hs)!.items;
    // every item at option index 1 (valid for all scales incl. YN len-2, NRS-11) → sum = item count.
    const full = items.map((it) => ({ itemId: it.id, value: SHARED_SCALES[it.scale as keyof typeof SHARED_SCALES][1] }));
    const r = scoreInstrument(hs, full);
    assert.equal(r.scale, 'house');
    assert.equal(r.score, items.length, `${hs} complete sum`);
    assert.equal(scoreInstrument(hs, full.slice(1)).score, null, `${hs} partial → null`);
  }
});

test('2a escalation: red-flag responses fire the expected code', () => {
  assert.ok(scoreInstrument('hs-varicose', [{ itemId: 'vv8', value: 'yes' }]).escalations.includes('E5'));   // always → E5
  assert.ok(scoreInstrument('hs-dental', [{ itemId: 'dn8', value: 'yes' }]).escalations.includes('E5'));      // airway always → E5
  assert.ok(scoreInstrument('hs-prolapse', [{ itemId: 'pl7', value: 'always' }]).escalations.includes('E5')); // S5-FRQ 'always' (idx4) → E5
  assert.ok(scoreInstrument('hs-fibroid', [{ itemId: 'hf2', value: 'often' }]).escalations.includes('E4'));   // S5-FRQ 'often' (idx3) → E4
  assert.ok(scoreInstrument('hs-fibroid', [{ itemId: 'hf8', value: 'yes' }]).escalations.includes('E5'));     // YN yes → E5
  assert.ok(scoreInstrument('hs-wrist', [{ itemId: 'hw7', value: 'yes' }]).escalations.includes('E5'));       // YN yes → E5
});

test('2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES', () => {
  assert.deepEqual(SHARED_SCALES['WORK4'], ['fully', 'avoiding some', 'avoiding most', 'not yet']);
  assert.deepEqual(SHARED_SCALES['EAT4'], ['fully able', 'mostly', 'soft foods only', 'liquids only']);
  assert.deepEqual(SHARED_SCALES['OPEN4'], ['fully', 'mildly limited', 'moderately limited', 'severely limited']);
  for (const [, hs] of HS2A) {
    const def = instrumentById(hs)!;
    assert.equal(def.kind, 'house');
    assert.ok(def.items.length > 0, `${hs} has items`);
    for (const it of def.items) assert.ok(it.scale in SHARED_SCALES, `${hs}.${it.id} scale ${it.scale} not in SHARED_SCALES`);
  }
});

// ── determinism ──
test('determinism: classify / instrumentsDue / score twice → deep-equal', () => {
  assert.equal(classifyFamily({ procedureName: 'ORIF' }), classifyFamily({ procedureName: 'ORIF' }));
  assert.deepEqual(instrumentsDue('thyroid', BASE, '2026-02-04'), instrumentsDue('thyroid', BASE, '2026-02-04'));
  const rs = [{ itemId: 'g1', value: 'often' }, { itemId: 'g2', value: 'never' }, { itemId: 'g3', value: 'always' }];
  assert.deepEqual(scoreInstrument('hs-gi', rs), scoreInstrument('hs-gi', rs));
});
