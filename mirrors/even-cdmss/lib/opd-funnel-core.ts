/**
 * Pure core for Right Care O/E + funnel math (RIGHT-CARE-INDICATOR-PRD §4). NO db / Next imports —
 * strip-types testable; the data layer (lib/opd-audit-doctor.ts) feeds it (doctor, stratum)-cell
 * aggregates and the surfaces render whatever it returns.
 *
 * Strata (§4): complexity band (4) × age band (4) = 16; NEW_TO_US strata use age band only. Stratum
 * mean rate = LVC-note rate among distinct current-engine notes in that stratum (gated rules only).
 * Thin-cell fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global.
 *
 * ⚠️ AGE NOTE (flagged): the Branch-1 data layer stores complexity_band/complexity_inputs but NOT
 * patient age, so the data layer supplies age_band = null for every cell. With age absent, band×age
 * collapses to the band-marginal level — which is exactly the level the validated gate used
 * (band-mix-weighted expected 0.618–0.680). The age dimension is implemented here so it activates the
 * moment age lands in the data layer, with no math change. See the build report.
 *
 * Per doctor: O = Σ notes with ≥1 gated LVC finding; E = Σ over their notes of the note's stratum
 * mean; O/E, raw rate, expected rate, n, band mix. Funnel (within specialty): center = pooled rate p̄,
 * limits p̄ ± z·√(p̄(1−p̄)/n) for z = 1.96 (95%) and 3.09 (99.8%); n < 10 plotted but greyed.
 */

export const AGE_BANDS = ['0-17', '18-44', '45-64', '65+'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const MIN_STRATUM_N = 30;   // thin-cell rule: a stratum needs ≥30 notes to be its own mean
export const FUNNEL_MIN_N = 10;    // doctors with n < 10 are greyed; no vs-expected on the index
export const Z_95 = 1.96;
export const Z_998 = 3.09;

/** One (doctor, stratum) aggregate over distinct current-engine notes. o = notes with ≥1 gated LVC. */
export interface LvcCell {
  doctor_uid: string;
  band: string | null;         // complexity_band; null cells are UNBANDED and excluded from O/E
  age_band?: string | null;    // patient age band, or null (unavailable — see AGE NOTE)
  n: number;                   // distinct notes in this (doctor, band, age) cell
  o: number;                   // of those, how many have ≥1 gated LVC finding
}

/** Deriving the age band from a numeric age (for when age reaches the data layer). */
export function ageBandOf(age: number | null | undefined): AgeBand | null {
  if (age == null || !Number.isFinite(age) || age < 0) return null;
  if (age <= 17) return '0-17';
  if (age <= 44) return '18-44';
  if (age <= 64) return '45-64';
  return '65+';
}

const bandAgeKey = (band: string | null, age: string | null | undefined): string => `${band ?? '∅'}|${age ?? '∅'}`;

type Tot = { n: number; o: number };
function add(map: Map<string, Tot>, key: string, n: number, o: number): void {
  const t = map.get(key) || { n: 0, o: 0 };
  t.n += n; t.o += o; map.set(key, t);
}

export interface StratumModel {
  /** Stratum mean rate for a note in (band, age), applying the fallback hierarchy. */
  rateFor(band: string | null, age: string | null | undefined): number;
  global: number;
  byBand: Map<string, Tot>;
  byBandAge: Map<string, Tot>;
}

/** Build stratum means from BANDED cells (band != null). Unbanded cells are ignored (excluded from
 *  O/E per §8). `exclude` drops those doctors' cells entirely (house accounts — decision 15). */
export function buildStratumModel(cells: LvcCell[], exclude: ReadonlySet<string> = new Set()): StratumModel {
  const byBand = new Map<string, Tot>();
  const byBandAge = new Map<string, Tot>();
  let gN = 0, gO = 0;
  for (const c of cells) {
    if (exclude.has(c.doctor_uid) || c.band == null) continue;
    add(byBand, c.band, c.n, c.o);
    add(byBandAge, bandAgeKey(c.band, c.age_band), c.n, c.o);
    gN += c.n; gO += c.o;
  }
  const global = gN > 0 ? gO / gN : 0;
  const rateFor = (band: string | null, age: string | null | undefined): number => {
    if (band == null) return global;
    const ba = byBandAge.get(bandAgeKey(band, age));
    if (ba && ba.n >= MIN_STRATUM_N) return ba.o / ba.n;
    const b = byBand.get(band);
    if (b && b.n >= MIN_STRATUM_N) return b.o / b.n;
    return global;
  };
  return { rateFor, global, byBand, byBandAge };
}

export interface DoctorOE {
  doctor_uid: string;
  n: number;                 // banded distinct notes
  o: number;                 // notes with ≥1 gated LVC finding
  raw_rate: number;          // O / n
  expected_rate: number;     // E / n  (case-mix expected)
  oe: number | null;         // O / E, or null when E = 0 or n = 0 (zero-denominator → null)
  band_mix: Record<string, number>;   // band → share of n (0..1)
}

/** Per-doctor O/E over banded cells. Zero denominator (n=0 or E=0) → oe null (§9). Excluded doctors
 *  are dropped. Age unavailable (null) collapses band×age → band marginal (see AGE NOTE). */
export function computeDoctorOE(cells: LvcCell[], exclude: ReadonlySet<string> = new Set()): DoctorOE[] {
  const model = buildStratumModel(cells, exclude);
  const byDoctor = new Map<string, LvcCell[]>();
  for (const c of cells) {
    if (exclude.has(c.doctor_uid) || c.band == null) continue;
    const g = byDoctor.get(c.doctor_uid);
    if (g) g.push(c); else byDoctor.set(c.doctor_uid, [c]);
  }
  const out: DoctorOE[] = [];
  for (const [doctor_uid, dc] of byDoctor) {
    let n = 0, o = 0, e = 0;
    const bandN: Record<string, number> = {};
    for (const c of dc) {
      n += c.n; o += c.o;
      e += c.n * model.rateFor(c.band, c.age_band);
      bandN[c.band as string] = (bandN[c.band as string] || 0) + c.n;
    }
    const band_mix: Record<string, number> = {};
    if (n > 0) for (const b of Object.keys(bandN)) band_mix[b] = bandN[b] / n;
    out.push({
      doctor_uid, n, o,
      raw_rate: n > 0 ? o / n : 0,
      expected_rate: n > 0 ? e / n : 0,
      oe: n > 0 && e > 0 ? o / e : null,
      band_mix,
    });
  }
  return out;
}

// ── funnel (within specialty) ─────────────────────────────────────────────────
export interface FunnelPoint { doctor_uid: string; n: number; rate: number; greyed: boolean }
export interface FunnelLimit { n: number; lo95: number; hi95: number; lo998: number; hi998: number }

/** Pooled specialty rate p̄ = Σo / Σn over the specialty's doctors. */
export function pooledRate(points: Array<{ n: number; o: number }>): number {
  let n = 0, o = 0;
  for (const p of points) { n += p.n; o += p.o; }
  return n > 0 ? o / n : 0;
}

/** Funnel control limits at volume n: p̄ ± z·√(p̄(1−p̄)/n), clamped to [0,1]. n≤0 → flat at p̄. */
export function funnelLimit(pBar: number, n: number, z: number): { lo: number; hi: number } {
  if (n <= 0) return { lo: pBar, hi: pBar };
  const se = Math.sqrt((pBar * (1 - pBar)) / n);
  return { lo: Math.max(0, pBar - z * se), hi: Math.min(1, pBar + z * se) };
}

/** A ready-to-plot funnel band across a range of n values (deduped, ascending). */
export function funnelCurve(pBar: number, ns: number[]): FunnelLimit[] {
  const uniq = Array.from(new Set(ns.filter((x) => x > 0))).sort((a, b) => a - b);
  return uniq.map((n) => {
    const a = funnelLimit(pBar, n, Z_95);
    const b = funnelLimit(pBar, n, Z_998);
    return { n, lo95: a.lo, hi95: a.hi, lo998: b.lo, hi998: b.hi };
  });
}

/** Classify a doctor's dot vs the 95%/99.8% limits at their n (for the plain sentence). */
export function funnelPosition(rate: number, pBar: number, n: number): 'within' | 'above' | 'below' | 'building' {
  if (n < FUNNEL_MIN_N) return 'building';
  const l = funnelLimit(pBar, n, Z_95);
  if (rate > l.hi) return 'above';
  if (rate < l.lo) return 'below';
  return 'within';
}
