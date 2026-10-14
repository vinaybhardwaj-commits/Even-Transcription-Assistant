/**
 * lib/clinical-bands.ts — ratified clinical reference bands and dose-concordance matrices.
 * PURE and dependency-free (testable under `node --experimental-strip-types`).
 *
 * ═══ WHY THIS IS CODE, NOT THE SCORING-POLICY SURFACE ═══
 * `lib/scoring-policy/*` states in its own header that it is a READ LAYER over stored scores and
 * that the scoring cores "stay closed". A band table consumed by a DETERMINISTIC RULE AT AUDIT
 * TIME is not a read layer — it changes which findings are produced. Every other ratified clinical
 * rule in this engine already lives in code (NSAID_MOLECULES, MUSCLE_RELAXANT_MOLECULES,
 * PREGNANCY_CONTRA_MOLECULES, the CDSCO banned-FDC seed, vitaminDRepletionFindings). This follows
 * that pattern: ratified by the clinical-rulings process, changed by commit.
 *
 * ═══ WHY THE BANDS ARE CONTIGUOUS ═══
 * MEASURED (register bug 8, P0): two notes from ONE prescriber on ONE day — vitamin D 17 and
 * 18 ng/mL, identical 60,000 IU weekly × 8 week regimens — scored 100 and 60. A 40-point spread on
 * one nanogram. The engine held NO vitamin D threshold at all; the cutoff came from model recall,
 * attributed in the stored rationale to "cited guidelines" that do not exist in the system. The
 * published Endocrine Society text reads "below 20" and "21 to 29", leaving 20.0–20.9 undefined —
 * an ambiguous boundary is exactly what produced bug 8, so these bands are CONTIGUOUS with no gap.
 */

/** Named beside the table because every finding derived from it must disclose its standard. */
export const VITAMIN_D_STANDARD = 'Endocrine Society';
export const VITAMIN_D_UNITS = 'ng/mL';

export type VitaminDBand = 'deficient' | 'insufficient' | 'sufficient';

// The two boundaries, contiguous and exclusive-upper. deficient < 20.0 ≤ insufficient < 30.0 ≤ sufficient.
export const VITAMIN_D_DEFICIENT_BELOW = 20.0;
export const VITAMIN_D_SUFFICIENT_AT_OR_ABOVE = 30.0;

/**
 * Band for a 25(OH)D level in ng/mL. Total over finite numbers; null for anything unusable
 * (NaN, ±Infinity, negative) so a caller can never band a value the lab did not produce.
 */
export function vitaminDBand(ngPerMl: number): VitaminDBand | null {
  const v = Number(ngPerMl);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v < VITAMIN_D_DEFICIENT_BELOW) return 'deficient';
  if (v < VITAMIN_D_SUFFICIENT_AT_OR_ABOVE) return 'insufficient';
  return 'sufficient';
}

/**
 * Pull a 25(OH)D level out of free note text. FAIL-SAFE by design, mirroring
 * `vitaminDRepletionFindings`' doctrine that an unparseable input emits NOTHING: anything this
 * cannot read confidently returns null, and null means the dose rule stays silent. It deliberately
 * requires BOTH a vitamin-D token and an ng/mL unit within a short window — a bare number, or a
 * level in nmol/L (a different scale entirely), is not read.
 */
const VIT_D_LEVEL_RE = /(?:vit(?:amin)?\.?\s*-?\s*d3?|25\s*[-(]?\s*oh\s*\)?\s*d?|cholecalciferol)[^.\n]{0,40}?(\d{1,3}(?:\.\d+)?)\s*ng\s*\/\s*ml/i;
export function parseVitaminDLevel(text: string | null | undefined): number | null {
  const m = String(text ?? '').match(VIT_D_LEVEL_RE);
  if (!m) return null;
  const v = Number(m[1]);
  // A 25(OH)D above 200 ng/mL is not a plausible outpatient reading; refuse rather than band it.
  return Number.isFinite(v) && v >= 0 && v <= 200 ? v : null;
}

// ═══ The dose concordance matrix ═══════════════════════════════════════════════════════════════
//
// RATIFIED by Dr Zaki, 29 Jul 2026. EXACTLY TWO ROWS, both "concordant — emit no finding".
// EVERY other band-and-regimen pair emits NOTHING. Silence is the designed default, not a gap:
// that includes a course beyond 8 weeks, monthly maintenance, any course at a sufficient level,
// and a daily 60,000 IU grid. Do not invent rows — a new row is a clinical ratification, not a
// build decision.

/** The one ratified regimen shape, parsed from a prescription line. */
export interface VitaminDRegimen { iu: number; weekly: boolean; weeks: number | null }

export type ConcordanceVerdict = 'concordant';

interface MatrixRow { band: VitaminDBand; iu: number; weekly: boolean; weeks: number; verdict: ConcordanceVerdict; note: string }

export const VITAMIN_D_DOSE_MATRIX: readonly MatrixRow[] = [
  { band: 'deficient', iu: 60000, weekly: true, weeks: 8, verdict: 'concordant',
    note: 'Standard repletion for a deficient level.' },
  { band: 'insufficient', iu: 60000, weekly: true, weeks: 8, verdict: 'concordant',
    note: 'Ratified by Dr Zaki as acceptable in the Indian context.' },
] as const;

/**
 * Look up a (band, regimen) pair. Returns the ratified verdict, or null when the matrix holds no
 * entry — and null MUST mean "emit nothing", never "emit a discordance finding".
 */
export function vitaminDConcordance(band: VitaminDBand | null, regimen: VitaminDRegimen | null): ConcordanceVerdict | null {
  if (!band || !regimen || regimen.weeks == null) return null;
  const row = VITAMIN_D_DOSE_MATRIX.find(
    (r) => r.band === band && r.iu === regimen.iu && r.weekly === regimen.weekly && r.weeks === regimen.weeks,
  );
  return row ? row.verdict : null;
}
