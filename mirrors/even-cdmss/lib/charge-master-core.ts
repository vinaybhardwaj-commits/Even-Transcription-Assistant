/**
 * lib/charge-master-core.ts — EHRC charge-master matching CORE (pure, dependency-free).
 * JSON-backed wrappers live in lib/charge-master.ts. Unit-testable in isolation.
 *
 * Two tariff kinds:
 *   - 'package'      : inpatient surgical/procedure packages (token matcher; tier prices)
 *   - 'investigation': labs/imaging/etc (substring matcher — source names are concatenated,
 *                      e.g. "MRIBRAINROUTINE"; OPD + tier prices)
 */

export type TariffKind = 'package' | 'investigation';

export interface TariffRow {
  kind: TariffKind;
  code: string;
  item: string;
  dept?: string;
  type?: string;
  general: number;
  semiPrivate?: number | null;  // Semi-Pvt / twin-sharing tier
  private?: number | null;
  suite?: number | null;
  icu?: number | null;          // ICU tier
  opd?: number | null;          // investigations carry an outpatient price
  days?: number | null;         // packages carry a package period (days)
}
export interface TariffMatch extends TariffRow { score: number; matched_on: string; }

// Room/bed category → the tariff tier that applies to that admission. 'general' is the
// lowest inpatient tier (reference for room-category inflation).
export type TariffTier = 'opd' | 'general' | 'semiPrivate' | 'private' | 'suite' | 'icu';
export function tierForCareSetting(careSetting: unknown): TariffTier {
  const s = String(careSetting ?? '').toLowerCase().replace(/[_/]+/g, ' ');
  if (/icu|intensive|critical|ccu|nicu|picu/.test(s)) return 'icu';
  if (/suite|deluxe|luxury|executive|vip/.test(s)) return 'suite';
  if (/twin|semi|sharing|shared|double/.test(s)) return 'semiPrivate';
  if (/private|single|pvt|deluxe single|individual/.test(s)) return 'private';
  if (/day.?care|opd|ambulatory|out.?patient/.test(s)) return 'opd';
  return 'general';
}
/** Price for a tariff row at a given tier, falling back sensibly when a tier is absent. */
export function priceAtTier(r: TariffRow, tier: TariffTier): number | null {
  const order: TariffTier[] = tier === 'opd'
    ? ['opd', 'general', 'semiPrivate', 'private', 'suite', 'icu']
    : tier === 'icu'
      ? ['icu', 'suite', 'private', 'semiPrivate', 'general']
      : [tier, 'private', 'semiPrivate', 'general', 'suite', 'opd'];
  for (const t of order) { const v = r[t]; if (typeof v === 'number' && v > 0) return v; }
  return typeof r.general === 'number' && r.general > 0 ? r.general : null;
}

// Anatomical SIDE (right/left) is dropped; procedure LATERALITY (unilateral/bilateral) is kept.
const STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'with', 'to', 'in', 'on', 'as',
  'package', 'pkg', 'procedure', 'surgery', 'operation', 'primary', 'elective', 'right', 'left',
]);

const SYNONYMS: Record<string, string> = {
  tkr: 'total knee replacement', tka: 'total knee replacement',
  thr: 'total hip replacement', tha: 'total hip replacement',
};

export function normalizeTariffText(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function expand(q: string): string {
  let s = ` ${normalizeTariffText(q)} `;
  for (const [k, v] of Object.entries(SYNONYMS)) s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  return s.trim();
}
function tokenize(s: string): string[] {
  return expand(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
}
const alnum = (s: string): string => normalizeTariffText(s).replace(/[^a-z0-9]/g, '');

/** PACKAGE matcher: token-overlap. Conservative — ≥2 shared tokens (or exact single-token), score floor. */
export function matchTariffIn(query: string, rows: TariffRow[], opts: { min?: number } = {}): TariffMatch | null {
  const min = opts.min ?? 0.6;
  const qt = tokenize(query);
  if (qt.length === 0) return null;
  const overlapNeeded = Math.min(2, qt.length);
  const effMin = qt.length === 1 ? Math.max(min, 0.85) : min;
  const qHasBilateral = /\bbilateral\b/.test(expand(query));
  let best: TariffMatch | null = null;
  for (const r of rows) {
    const it = tokenize(r.item);
    if (it.length === 0) continue;
    const itSet = new Set(it);
    const overlap = qt.filter((t) => itSet.has(t)).length;
    if (overlap < overlapNeeded) continue;
    const qFrac = overlap / qt.length;
    const iFrac = overlap / it.length;
    let score = qFrac * 0.6 + iFrac * 0.4;
    if (/\bbilateral\b/.test(normalizeTariffText(r.item)) && !qHasBilateral) score -= 0.2;
    if (score >= effMin && (!best || score > best.score)) {
      best = { ...r, score: Number(score.toFixed(3)), matched_on: query };
    }
  }
  return best;
}

/** INVESTIGATION matcher: source names are concatenated, so match on normalized-alnum
 *  containment (full query inside the item) OR all multi-word tokens present. Picks the
 *  closest-length (most specific) item. */
export function matchInvestigationIn(query: string, rows: TariffRow[], opts: { min?: number } = {}): TariffMatch | null {
  const min = opts.min ?? 0.3;
  const qNorm = alnum(expand(query));
  const qt = tokenize(query).map(alnum).filter(Boolean);
  if (qNorm.length < 4 && qt.length < 2) return null; // too vague (e.g. "mri", "ct")
  const cands: TariffMatch[] = [];
  for (const r of rows) {
    const iNorm = alnum(r.item);
    if (iNorm.length < 3) continue;
    const contained = qNorm.length >= 4 && iNorm.includes(qNorm);
    const allTokens = qt.length >= 2 && qt.every((t) => iNorm.includes(t));
    if (!contained && !allTokens) continue;
    const score = qNorm.length / iNorm.length; // closeness → favor the most specific item
    cands.push({ ...r, score: Number(score.toFixed(3)), matched_on: query });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score);
  if (cands[0].score < min) return null;
  // Among near-equal matches (a generic query can hit many variants), prefer the basic/
  // cheapest study so we don't default to a pricier variant the clinician didn't specify.
  const top = cands[0].score;
  const near = cands.filter((c) => top - c.score <= 0.08);
  near.sort((a, b) => (a.opd ?? a.general ?? Infinity) - (b.opd ?? b.general ?? Infinity));
  return near[0];
}

export interface InflationResult { atTier: number; atGeneral: number; delta: number; tier: TariffTier; n: number }
/**
 * Room-category cost inflation: for a set of matched tariff rows, the extra cost of having
 * them charged at the patient's room tier vs the lowest inpatient (General) tier. This makes
 * concrete the billing rule that "room category multiplies the whole episode". 0 at general/opd.
 */
export function roomCategoryInflation(rows: TariffRow[], tier: TariffTier): InflationResult {
  if (tier === 'general' || tier === 'opd') return { atTier: 0, atGeneral: 0, delta: 0, tier, n: 0 };
  let atTier = 0, atGeneral = 0, n = 0;
  for (const r of rows) {
    const a = priceAtTier(r, tier); const g = priceAtTier(r, 'general');
    if (a != null && g != null) { atTier += a; atGeneral += g; n += 1; }
  }
  return { atTier, atGeneral, delta: Math.max(0, atTier - atGeneral), tier, n };
}

export function formatINR(n: number | null | undefined): string {
  return '₹' + Number(n ?? 0).toLocaleString('en-IN');
}

export function formatTariffForPrompt(m: TariffMatch): string {
  if (m.kind === 'investigation') {
    const opd = m.opd != null ? `${formatINR(m.opd)} OPD` : '';
    const inp = m.general != null ? `${formatINR(m.general)} general (inpatient)` : '';
    return `${m.item} (EHRC ${m.code}): ${[opd, inp].filter(Boolean).join(' / ')} — authoritative EHRC investigation tariff (2025-26).`;
  }
  return `${m.item} (EHRC ${m.code}): ${formatINR(m.general)} general ward / ${formatINR(m.private)} private / ${formatINR(m.suite)} suite — authoritative EHRC inpatient package tariff (2025-26).`;
}
