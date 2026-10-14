// lib/proms/schedule-core.ts — Care-Call 0.2 PROMs pure compiler + scoring (prom-sched/0.1 +
// prom-scoring/0.1). Deterministic, DB-free, LLM-free; `now` is PASSED IN (no Date.now). Selects
// and schedules instruments over the frozen catalog and scores house responses; never writes item text.

import {
  ARCHETYPE_WINDOWS, PREM_POINTS, FAMILY_PACKS, FAMILY_REGEX, REGEX_FAMILY_PACK, SHARED_SCALES,
  instrumentById, type Archetype, type Item, type Window,
} from './catalog';

export const PROM_SCHED_VERSION = 'prom-sched/0.1' as const;
export const PROM_SCORING_VERSION = 'prom-scoring/0.1' as const;

// The surgery_type_uid → family map — RATIFIED v1.0 (12 Jul 2026), 31 live db13 types. Consulted
// BEFORE the regex (precision layer: only ever adds accuracy; unmapped types still fall to regex).
// 'excluded' is a reserved sentinel (kidney biopsy → no series; fetchSurgicalSeries clean-exits).
// Amend in CDMSS-PROMS-UID-FAMILY-MAP-RATIFIED-v1.0, not here.
export const UID_FAMILY_MAP: Record<string, string> = {
  K6fs7LCiWZ3gb3DWetCT: 'circumcision_adult',        // Stapler circumcission under GA (typo defeats regex)
  GSiIiRM0A7CaDtMM0nCH: 'circumcision_adult',        // Stapler circumcission under RA (typo)
  dYxdgQW7eEujVtI2uKiS: 'knee_arthroplasty',         // TKR – Bilateral (regex MISS → core-only)
  FSNrDBSwyPEhIfCOK4OY: 'knee_arthroplasty',         // TKR – Unilateral (regex MISS)
  AWTrcA8jVcNoVZCedXud: 'knee_arthroplasty',         // Total Knee Replacement (regex MISS)
  fxg6LQ1SvZW2RlrDb97x: 'knee_arthroplasty',         // TKR – Bilateral (regex MISS)
  '53mudO2js6vFiQ1ywLj9': 'knee_arthroplasty',       // TKR Megaprosthesis (regex → ortho_spine/lumbar)
  PoWNdt84bEjKfnKkwYBl: 'knee_arthroscopy_acl',      // ACL Reconstruction (regex → plastics)
  n4UBaBCM3tohm1YBWL9n: 'shoulder',                  // Rotator Cuff Repair (regex → ortho_spine/lumbar)
  '3HjShOGLMffpLVPJ41Dv': 'fracture_trauma',         // ORIF (regex → ortho_spine/lumbar)
  GI6MUeHU7vEagIBht0ia: 'hernia',                    // Incisional Hernia Mesh Repair
  u0K69frzJJqKUVd4swIs: 'hernia',                    // Umbilical Hernia Mesh Repair
  TSLKD4dco6guKBkGKcSr: 'hernia',                    // Umbilical Hernia Mesh Repair Under LA
  '5RPxu2PYOGSn9V5OYXs7': 'cholecystectomy',         // Laparoscopic Cholecystectomy
  sbpgJJL7gh8pUylwvhIM: 'proctology',                // LASER ASSISTED FISTULA ABLATION
  TWfI62wLoNENHXsKisDm: 'proctology',                // Laser Fistulectomy (regex MISS: /fistula/≠fistulectomy)
  XrucVpM4ApUGQwMCh5v7: 'proctology',                // EUA + Laser Hemorrhoidopexy
  yeDsHfLjs1dsuuVgR1xd: 'proctology',                // Laser Haemorrhoidectomy
  SnoBMj7fmjo5TF2lBzbU: 'proctology',                // Fistulotomy (regex MISS)
  gA0XoYna4sy8JSiDgtwt: 'proctology',                // Laser pilonidal sinus ablation (regex → fess_sinus!)
  mJKYit6R43Ta8dlNtRQT: 'scrotal',                   // Hydrocele Unilateral
  b0QTU34tvuJsE8g6ZzuV: 'urinary_stones',            // RIRS Unilateral (regex MISS)
  yOtncTFbysIAiQNl3EAL: 'hysteroscopy_mirena',       // Hysteroscopic Polypectomy (regex MISS)
  pmCwGAH3VRSZ1LSK3rgh: 'septoplasty_turbinoplasty', // Septoplasty
  Z0xYkybao6zSP5mqOmtG: 'varicose_veins',            // Varicose Veins (Surgical)
  lKHiO6rfQhWrlypPIvOB: 'minor_excisions',           // Debridement
  v0UG7DvId8yChyxVO1sg: 'minor_excisions',           // Wide Local Excision [RATIFIED]
  extQZCtK0D68D4pbVcsY: 'obstetric_csection',        // LSCS
  bYRTqDaeWGWib6n0qwOJ: 'obstetric_csection',        // Normal Delivery (Package) [RATIFIED]
  tXRcDLD8FHZ7wM4cRR3a: 'facial_ent',                // Nasal Bone Fracture Reduction [NEW family]
  SgKRBQaHVOGWtxeElbW9: 'excluded',                  // Kidney Biopsy – USG Guided [EXCLUDED — no series]
};

/** uid-map THEN name-regex map v1 (first match) → family | 'unknown' (Decision E). Caller applies
 *  NULLIF (empty-string-for-null); this is also defensive about ''/whitespace. */
export function classifyFamily(input: { surgeryTypeUid?: string | null; procedureName?: string | null }): string {
  const uid = input.surgeryTypeUid && String(input.surgeryTypeUid).trim() ? String(input.surgeryTypeUid).trim() : null;
  if (uid && UID_FAMILY_MAP[uid]) return UID_FAMILY_MAP[uid];
  const name = input.procedureName && String(input.procedureName).trim() ? String(input.procedureName).trim() : null;
  if (name) {
    for (const { family, re } of FAMILY_REGEX) {
      if (family === 'universal_core') break;   // the catch-all is "no specific match" → unknown
      if (re.test(name)) return family;
    }
  }
  return 'unknown';
}

/** Pack lookup → archetype; a coarse regex family bridges via REGEX_FAMILY_PACK; unknown → STANDARD. */
export function archetypeFor(family: string): Archetype {
  const pack = FAMILY_PACKS.find((p) => p.family === family);
  if (pack) return pack.archetype;
  const mapped = REGEX_FAMILY_PACK[family];
  if (mapped && mapped !== 'unknown') {
    const p2 = FAMILY_PACKS.find((p) => p.family === mapped);
    if (p2) return p2.archetype;
  }
  return 'STANDARD';   // unknown → core + PREM on STANDARD
}

/** The pack's scheduled add-on instrument id: prefer the primary; a permission-required (Pv) pack
 *  whose sweep isn't confirmed falls back to its house set (per §Pv-resolution). null → core-only. */
function packInstrumentFor(family: string): string | null {
  const pack = FAMILY_PACKS.find((p) => p.family === family) ?? (REGEX_FAMILY_PACK[family] && REGEX_FAMILY_PACK[family] !== 'unknown' ? FAMILY_PACKS.find((p) => p.family === REGEX_FAMILY_PACK[family]) : undefined);
  if (!pack) return null;
  if (pack.lic === 'Pv' && pack.fallback) return pack.fallback;   // sweep unconfirmed → house fallback
  return pack.primary;
}

// ── Window math (deterministic; days off the anchor) ──
const OFFSET: Record<Exclude<Window, 'baseline'>, number> = { d72h: 3, w2: 14, w6: 42, m3: 90, m6: 180, m12: 365 };
const BAND: Record<Exclude<Window, 'baseline'>, number> = { d72h: 2, w2: 7, w6: 14, m3: 21, m6: 30, m12: 45 };   // ± tolerance (docs silent — flagged default)
function parseDay(iso: string): number { const t = Date.parse(iso); return Number.isNaN(t) ? NaN : Math.floor(t / 86400000); }
function addDays(iso: string, n: number): string { const t = Date.parse(iso); if (Number.isNaN(t)) return iso; return new Date(t + n * 86400000).toISOString().slice(0, 10); }

export interface SeriesInput { anchorDate: string; plannedSurgeryDate?: string | null; dischargeDate?: string | null; cancelled?: boolean }
export interface DueInstrument { window: Window; instrumentId: string; status: 'due' | 'in_window' | 'out_of_window' | 'missed'; opensAt: string; closesAt: string }

function statusOf(now: string, opensAt: string, closesAt: string): DueInstrument['status'] {
  const n = parseDay(now), o = parseDay(opensAt), c = parseDay(closesAt);
  if (Number.isNaN(n) || Number.isNaN(o) || Number.isNaN(c)) return 'out_of_window';
  if (n < o) return 'out_of_window';       // upcoming — not open yet
  if (n <= c) return 'in_window';          // administer now
  return 'missed';                          // window closed, unadministered
}

/** Deterministic per-member due list: CORE + the family pack add-on at every archetype window, plus
 *  the PREM module at the archetype's PREM points. Baseline anchors pre-op; post-op windows anchor on
 *  the discharge date (absent ⇒ pre-op/baseline only). cancelled ⇒ [] (clean exit). */
export function instrumentsDue(family: string, series: SeriesInput, now: string): DueInstrument[] {
  if (series.cancelled) return [];
  const archetype = archetypeFor(family);
  const windows = ARCHETYPE_WINDOWS[archetype];
  const packInstr = packInstrumentFor(family);
  const coreIds = ['whodas12', 'pain_nrs', 'hs-return-to-function', ...(packInstr ? [packInstr] : [])];
  const out: DueInstrument[] = [];

  const bounds = (w: Window): { opensAt: string; closesAt: string } | null => {
    if (w === 'baseline') {
      const close = series.plannedSurgeryDate && String(series.plannedSurgeryDate).trim() ? String(series.plannedSurgeryDate).slice(0, 10) : series.anchorDate.slice(0, 10);
      return { opensAt: series.anchorDate.slice(0, 10), closesAt: close };
    }
    if (!series.dischargeDate || !String(series.dischargeDate).trim()) return null;   // no discharge → post-op not anchored
    const anchor = String(series.dischargeDate).slice(0, 10);
    return { opensAt: addDays(anchor, OFFSET[w] - BAND[w]), closesAt: addDays(anchor, OFFSET[w] + BAND[w]) };
  };

  for (const w of windows) {
    const b = bounds(w);
    if (!b) continue;
    for (const id of coreIds) out.push({ window: w, instrumentId: id, status: statusOf(now, b.opensAt, b.closesAt), opensAt: b.opensAt, closesAt: b.closesAt });
  }
  for (const w of PREM_POINTS[archetype]) {
    const b = bounds(w);
    if (!b) continue;
    out.push({ window: w, instrumentId: 'prem', status: statusOf(now, b.opensAt, b.closesAt), opensAt: b.opensAt, closesAt: b.closesAt });
  }
  return out;
}

// ── Scoring (deterministic; house = simple sum by option index; validated = ref rule, not encoded here) ──
export interface ItemResponse { itemId: string; value: string }

function optionIndex(scale: string, value: string): number | null {
  const opts = SHARED_SCALES[scale as keyof typeof SHARED_SCALES];
  if (scale === 'NRS-11') { const n = parseInt(value, 10); return Number.isFinite(n) ? n : null; }
  if (!opts) return null;
  const i = opts.indexOf(value.trim());
  return i >= 0 ? i : null;
}
/** Does this item's response trigger its ⚠ escalation? (deterministic; positive/severe by scale.) */
function triggers(scale: string, value: string): boolean {
  const v = value.trim();
  switch (scale) {
    case 'YN': return v === 'yes';
    case 'NRS-11': { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 8; }
    case 'S5-SEV': case 'S5-FRQ': { const i = optionIndex(scale, v); return i != null && i >= 3; }
    case 'S5-CMP': return v === 'worse' || v === 'much worse';
    case 'DIET4': return v === 'liquids only' || v === 'barely';
    case 'SUPPORT3': return v === 'struggling';
    default: { const i = optionIndex(scale, v); return i != null && i >= 3; }
  }
}

// WHODAS 2.0 (12-item, interviewer version) response scale — None/Mild/Moderate/Severe/Extreme
// (-or-cannot-do), coded 0..4. Item text is encoded verbatim in catalog.ts (WHODAS5); this recode is
// case/label-tolerant so both the chip label ('Extreme or cannot do') and a bare 'extreme' map to 4.
const WHODAS_SCALE = ['none', 'mild', 'moderate', 'severe', 'extreme'];
function whodasIndex(value: string): number {
  const v = String(value ?? '').trim().toLowerCase();
  const exact = WHODAS_SCALE.indexOf(v);
  if (exact >= 0) return exact;
  return WHODAS_SCALE.findIndex((a) => v.startsWith(a));   // tolerate "extreme or cannot do"
}

// ── Phase-2b validated interval tables (verbatim from the freeze record; raw sum index → 0–100). ──
// KOOS, JR. © HSS — raw 0–28 → interval (higher = BETTER).
const KOOS_JR_INTERVAL = [
  100.000, 91.975, 84.600, 79.914, 76.332, 73.342, 70.704, 68.284, 65.994, 63.776,
  61.583, 59.381, 57.140, 54.840, 52.465, 50.012, 47.487, 44.905, 42.281, 39.625,
  36.931, 34.174, 31.307, 28.251, 24.875, 20.941, 15.939, 8.291, 0.000,
] as const;
// HOOS, JR. © HSS — raw 0–24 → interval (higher = BETTER).
const HOOS_JR_INTERVAL = [
  100.000, 92.340, 85.257, 80.550, 76.776, 73.472, 70.426, 67.516, 64.664, 61.815,
  58.930, 55.985, 52.965, 49.858, 46.652, 43.335, 39.902, 36.363, 32.735, 29.009,
  25.103, 20.805, 15.633, 8.104, 0.000,
] as const;

/** Sum option indices across the given items; null if ANY is unanswered/unmappable (partial → null). */
function sumItemIndices(items: { id: string; scale: string }[], byId: Map<string, string>): number | null {
  let sum = 0;
  for (const it of items) {
    const v = byId.has(it.id) ? byId.get(it.id) : null;
    const idx = v == null ? null : optionIndex(it.scale, String(v));
    if (idx == null) return null;
    sum += idx;
  }
  return sum;
}

/** The frozen house-scoring kernel (extracted verbatim from the 0.2 house branch, behaviour-preserving):
 *  Σ optionIndex over ALL items; complete-gate (every item answered) else null; ⚠ escalations via the
 *  shared triggers() ('always'→E5, the 'E2-with-item-3' wound special, else the code verbatim, deduped).
 *  The SINGLE source of truth for scoring house sets (scoreInstrument) AND adhoc sets (scoreAdhocSet). */
export function scoreHouseItems(items: Item[], byId: Map<string, string>): { score: number | null; escalations: string[] } {
  let sum = 0;
  const escalations: string[] = [];
  for (const it of items) {
    const v = byId.get(it.id);
    if (v == null) continue;
    const idx = optionIndex(it.scale, v);
    if (idx != null) sum += idx;
    if (it.escalation && triggers(it.scale, v)) {
      if (it.escalation === 'always') escalations.push('E5');
      else if (it.escalation === 'E2-with-item-3') { const fever = items.find((x) => x.scale === 'YN' && /fever/i.test(x.text || '')); if (fever && (byId.get(fever.id) || '').trim() === 'yes') escalations.push('E2'); }
      else escalations.push(it.escalation);
    }
  }
  const complete = items.every((it) => byId.has(it.id));
  return { score: complete ? sum : null, escalations: Array.from(new Set(escalations)) };
}

export function scoreInstrument(instrumentId: string, responses: ItemResponse[]): { score: number | null; scale: string; version: string; escalations: string[] } {
  const def = instrumentById(instrumentId);
  const byId = new Map((responses || []).map((r) => [r.itemId, r.value]));
  // WHODAS-12 SIMPLE scoring (WHO): sum of the 12 item scores (each 0..4 on the None…Extreme scale)
  // → 0–48 (higher = greater difficulty). Complete set (all 12 mapped) required → else honest null.
  if (instrumentId === 'whodas12') {
    const scores = (responses || []).map((r) => whodasIndex(r.value)).filter((i) => i >= 0);
    const complete = scores.length === 12;
    return { score: complete ? scores.reduce((a, b) => a + b, 0) : null, scale: 'whodas12-simple', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // House PREM experience score = sum of prem1..prem7 (EXP4 0–3) → 0–21, higher = BETTER (reversed vs
  // symptom sets). prem8 (overall NRS) is NOT summed — surfaced separately by the caller. Partial (any
  // 1–7 unanswered/unmapped) → null. No clinical ⚠ (the service flag is evaluated by the wired layer).
  if (instrumentId === 'prem') {
    const expIds = ['prem1', 'prem2', 'prem3', 'prem4', 'prem5', 'prem6', 'prem7'];
    const idxs = expIds.map((id) => (byId.has(id) ? optionIndex('EXP4', String(byId.get(id))) : null));
    const complete = idxs.every((i) => i != null);
    return { score: complete ? idxs.reduce((a, b) => (a as number) + (b as number), 0) as number : null, scale: 'prem-experience', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // ── Phase-2b validated instruments (explicit branches; verbatim items live in catalog.ts) ──
  const vItems = def ? def.items : [];
  // KOOS-JR / HOOS-JR: raw sum → interval-table lookup (higher = better). Any item unanswered → null.
  if (instrumentId === 'koos_jr' || instrumentId === 'hoos_jr') {
    const table = instrumentId === 'koos_jr' ? KOOS_JR_INTERVAL : HOOS_JR_INTERVAL;
    const need = instrumentId === 'koos_jr' ? 7 : 6;
    const raw = vItems.length === need ? sumItemIndices(vItems, byId) : null;
    const score = raw != null && raw >= 0 && raw < table.length ? table[raw] : null;
    return { score, scale: instrumentId === 'koos_jr' ? 'koos-jr' : 'hoos-jr', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // SPADI: total = round((Σ13 / 130) × 100), 0–100, higher = worse. Any of 13 unanswered → null.
  if (instrumentId === 'spadi') {
    const sum = vItems.length === 13 ? sumItemIndices(vItems, byId) : null;
    return { score: sum == null ? null : Math.round((sum / 130) * 100), scale: 'spadi', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // RMDQ: count of ticked sentences ('Applies to me today' = index 1) → 0–24, higher = worse. No partial-null.
  if (instrumentId === 'rmdq') {
    let count = 0;
    for (const it of vItems) if (optionIndex(it.scale, String(byId.get(it.id) ?? '')) === 1) count++;
    return { score: count, scale: 'rmdq', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // NDI: sum 10 section indices (0–5) → 0–50, higher = worse. Any of 10 unanswered → null.
  if (instrumentId === 'ndi') {
    const sum = vItems.length === 10 ? sumItemIndices(vItems, byId) : null;
    return { score: sum, scale: 'ndi', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // IPSS: ΣQ1–Q7 (0–35), higher = worse. ipss_qol (0–6) NOT summed — surfaced separately (like prem8). q-partial → null.
  if (instrumentId === 'ipss') {
    const symptomItems = vItems.filter((it) => it.id !== 'ipss_qol');
    const sum = symptomItems.length === 7 ? sumItemIndices(symptomItems, byId) : null;
    return { score: sum, scale: 'ipss', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // NOSE: raw sum (0–20) × 5 = 0–100, higher = worse (×5 per Cowork fix, NOT ×20). Partial → null.
  if (instrumentId === 'nose') {
    const raw = vItems.length === 5 ? sumItemIndices(vItems, byId) : null;
    return { score: raw == null ? null : raw * 5, scale: 'nose', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // NYHA: single item; score = selected class index+1 (Class I→1 … Class IV→4), higher = worse. Unanswered → null.
  if (instrumentId === 'nyha') {
    const it = vItems[0];
    const idx = it ? optionIndex(it.scale, String(byId.get(it.id) ?? '')) : null;
    return { score: idx == null ? null : idx + 1, scale: 'nyha', version: PROM_SCORING_VERSION, escalations: [] };
  }
  if (!def || def.kind === 'validated') {
    // validated scoring rule is entered with the item text at 0.2a-2 → honest null now.
    return { score: null, scale: def ? def.scale : 'unknown', version: PROM_SCORING_VERSION, escalations: [] };
  }
  // house: simple sum of option indices; partial (any item unanswered) → honest null. Delegates to the
  // shared scoreHouseItems kernel (single source of truth for house + adhoc sets) — identical output.
  const { score, escalations } = scoreHouseItems(def.items, byId);
  return { score, scale: 'house', version: PROM_SCORING_VERSION, escalations };
}
