/**
 * lib/formulary-match-core.ts — PURE brand→generic+class resolver over the EHRC
 * Pharmacy Formulary 2026 (2,174 items).
 *
 * WHY. ~36% of OPD medication lines arrive BRAND-ONLY (no generic_name): the note-quality
 * auditor then sees an unrecognisable proprietary string ("Ecosprin 75mg", "Augmentin
 * 625mg") and cannot reason about the molecule, class, schedule, interactions or
 * duplications. This resolver recovers the molecule + therapeutic class + D&C schedule +
 * ISMP high-alert flag + LASA list + VED from the hospital formulary, so the LLM and the
 * deterministic prescribing-safety checks both see the DRUG, not the brand.
 *
 * PURE + unit-testable under `node --experimental-strip-types`: the formulary data is
 * INJECTED (buildFormularyMatcher(rows)); the JSON loader lives in lib/formulary.ts.
 * Mirrors the charge-master-core / charge-master split.
 *
 * MATCH TIERS (most→least reliable). `confident` gates whether a match may drive
 * deterministic safety findings (DDI / high-alert): an approximate brand-prefix match can
 * drop a molecule from a combination ("Rosuvas F" → Rosuvastatin, losing fenofibrate), so
 * those are used for display / class-hinting only, never to assert a safety alert.
 *   source-generic  — the EMR already gave a generic (trusted)            confident
 *   brand-exact     — normalised brand == a formulary brand               confident
 *   embedded-generic— a known molecule name appears verbatim in the text  confident
 *   brand-token     — brand family (1st token) maps to a single molecule  confident
 *   brand-prefix    — longest formulary brand that prefixes the text      APPROX
 *   none            — unmatched → tag non-formulary / nutraceutical
 */

export interface FormularyRow {
  brand: string;
  generic?: string;        // optional — every read is guarded (generic_canon || generic || '')
  generic_canon: string;
  major?: string;
  minor?: string;
  schedule_dc?: string;   // OTC | H | H1 | X | Biological | —
  high_risk?: boolean;    // ISMP high-alert
  // ⚠️ AUDIT NOTE (Matcher-Scoping Audit, 23 Jul 2026): this `lasa` column does NOT contain
  // look-alike/sound-alike NAME confusables. Measured: 1,752/2,174 rows carry a value, and the values
  // are SAME-CLASS THERAPEUTIC ALTERNATIVES (Minoxidil→Finasteride, thiopentone→Propofol/Ketamine),
  // not confusable names. The `lasa_pair` check that read this as a LASA list was DELETED (0.81.12) —
  // 0/88 live findings were genuine confusables. Kept here because the column may seed a future
  // therapeutic-duplication / class-overlap check. Do NOT rebuild a "LASA" check on this data.
  lasa?: string;          // MISNAMED: same-class therapeutic alternatives, NOT name confusables (see note)
  ved?: string;           // V | E | D
  restricted?: boolean;
  form?: string;          // raw dosage form, e.g. "Tablet 10 MG", "Syrup 100 ML", "Capsule ." (0.81.11)
}

// ── Dosage-form normalisation (0.81.11, Matcher-Scoping Audit Stage 1) ─────────
// The raw formulary `form` embeds strength + junk ("Tablet 10 MG", "Capsule .", "Syrup 100 ML").
// This pure normaliser parses it to a coarse controlled vocabulary that every later matcher can gate
// on (route/form-awareness), WITHOUT discarding the raw string. Stage 1 populates both; NO matcher
// reads either yet (score-invariant). Order matters: form words that embed shorter ones (rotaCAP,
// eye DROPs) are matched by their most specific rule first.
export type DosageForm =
  | 'tablet' | 'capsule' | 'syrup' | 'injection' | 'topical' | 'drops' | 'inhaler' | 'other';

const DOSAGE_FORM_RULES: { re: RegExp; form: DosageForm }[] = [
  { re: /\b(inhaler|rotacap|rotahaler|respule|smartule|sustule|mdi|puff|inhalation|nebul)/i, form: 'inhaler' },
  { re: /\b(drops?|eye|ear|ophthalmic|otic)\b/i, form: 'drops' },   // "drops" plural must match (Stage-1 distribution fix)
  { re: /\b(inj(?:ection)?|vial|amp(?:oule)?|prefilled|parenteral|infusion|\bdrip\b)\b/i, form: 'injection' },   // infusion/drip = IV
  { re: /\b(cream|ointment|oint|\bgel\b|lotion|paste|topical|apply|application|liniment|emollient|balm|patch|transderm)\b/i, form: 'topical' },
  { re: /\b(syrup|syp|syr|suspension|susp|solution|soln|elixir|liquid|drink)\b/i, form: 'syrup' },
  { re: /\b(cap(?:sule)?s?|softgel|softgelatin)\b/i, form: 'capsule' },
  { re: /\b(tab(?:let)?s?|caplet|dispersible|chewable)\b/i, form: 'tablet' },
];

/** Parse a raw formulary form string → coarse DosageForm. Junk/empty → 'other'. Pure. */
export function normalizeDosageForm(raw: string | undefined | null): DosageForm {
  const s = (raw || '').toLowerCase();
  for (const r of DOSAGE_FORM_RULES) if (r.re.test(s)) return r.form;
  return 'other';   // kit, powder, sachet, spray, suppository, pessary, mouthwash, lozenge, "." , empty
}

export type FormularyMatchType =
  | 'source-generic' | 'brand-exact' | 'embedded-generic' | 'brand-token' | 'brand-prefix' | 'none';

export interface FormularyMatch {
  generic: string;
  major?: string;
  minor?: string;
  schedule?: string;
  highAlert: boolean;
  lasa: string[];
  ved?: string;
  restricted: boolean;
  form?: string;          // raw dosage form from the formulary row (0.81.11 — plumbed, read by nothing yet)
  dosageForm?: DosageForm; // parsed coarse form (0.81.11)
  matchType: FormularyMatchType;
  confident: boolean;     // true → may drive deterministic DDI / high-alert findings
}

export type NonFormularyTag = 'nutraceutical-cosmetic' | 'non-formulary';

// Form / pack tokens stripped during normalisation — these are NOT product-distinguishing.
// Product-distinguishing suffixes (plus, forte, ds, dsr, sr, er, od, xt, l, m, h, av …) are
// DELIBERATELY kept so combination brands ("Pantocid" vs "Pantocid DSR") stay distinct.
const FORM_WORDS = new Set([
  'tablet', 'tablets', 'tab', 'tabs', 'captab', 'captabs', 'caplet', 'caplets',
  'capsule', 'capsules', 'cap', 'caps', 'softgel', 'softgels', 'softgelatin',
  'syrup', 'syp', 'syr', 'suspension', 'susp', 'injection', 'inj', 'gel', 'cream',
  'ointment', 'oint', 'lotion', 'solution', 'soln', 'spray', 'drops', 'drop',
  'sachet', 'sachets', 'powder', 'pow', 'kit', 'inhaler', 'respules', 'smartules',
  'granules', 'vaccine', 'liquid', 'eye', 'ear', 'mouthwash', 'lozenge', 'lozenges',
  'sustules', 'rotacaps', 'nasal', 'oral', 'topical', 'application', 'local', 'spf', 'pa',
]);
// Connector words that only ever appear in marketing fragments.
const STOP_WORDS = new Set(['with', 'for', 'of', 'the', 'and', 'a', 'an', 'in', 'to']);

// number+unit dose tokens + standalone numbers + small pack counts (e.g. "15s", "60k", "6l").
const DOSE = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|ug|g|gm|ml|iu|kiu|ku|k|%|spf\d*|l|s)\b/gi;
const RATIO = /\b\d+\s*\/\s*\d+\b/g;
const NUM = /\b\d+(?:\.\d+)?\b/g;

/** Normalise a drug/brand string: drop marketing tail, dose, form words → comparable tokens. */
export function normalizeDrugName(raw: string): string {
  let s = (raw || '').toLowerCase();
  s = s.split('|')[0];                   // drop everything after a marketing pipe
  s = s.replace(/\(.*?\)/g, ' ');        // drop parentheticals
  s = s.replace(/[+&/-]/g, ' ');
  s = s.replace(RATIO, ' ').replace(DOSE, ' ').replace(NUM, ' ');
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  const toks = s.split(/\s+/).filter((t) => t && !FORM_WORDS.has(t) && !STOP_WORDS.has(t));
  return toks.join(' ').trim();
}

function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function splitLasa(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(/[;,/]| and /i).map((x) => x.trim()).filter((x) => x && x !== '—' && x !== '-');
}

export interface FormularyMatcher {
  resolve(med: { brand?: string | null; generic?: string | null; route?: string | null }): FormularyMatch | null;
  size: number;
}

interface VocabEntry { key: string; molecule: string }

/** Build an in-memory matcher from formulary rows (injected → keeps this core pure). */
export function buildFormularyMatcher(rows: FormularyRow[]): FormularyMatcher {
  const byBrand = new Map<string, FormularyRow>();       // exact normalised brand
  const byFirstTok = new Map<string, FormularyRow[]>();  // brand family → rows
  const byGeneric = new Map<string, FormularyRow>();      // normalised generic / canon → a row
  const brandNorms: { nb: string; row: FormularyRow }[] = [];
  const vocab: VocabEntry[] = [];
  const vocabSeen = new Set<string>();

  // BUG-0.8-15: build the generic/molecule index in TWO passes so a SINGLE-molecule (mono) row
  // always wins its molecule key over a COMBINATION row that merely contains it. Otherwise a
  // molecule whose first formulary occurrence (by array order) is inside a combo inherits that
  // combo's class for ALL its mono products (Pantoprazole → the H.pylori kit's "Antibiotic";
  // Etodolac → an Etodolac+Thiocolchicoside FDC's "Muscle relaxant").
  // Pass 1: brands, vocab (embedded-molecule tier), and MONO generic keys.
  for (const row of rows) {
    const nb = normalizeDrugName(row.brand || '');
    if (nb) {
      if (!byBrand.has(nb)) byBrand.set(nb, row);
      brandNorms.push({ nb, row });
      const ft = nb.split(' ')[0];
      if (ft.length >= 4) { const arr = byFirstTok.get(ft) || []; arr.push(row); byFirstTok.set(ft, arr); }
    }
    const canon = (row.generic_canon || row.generic || '').trim();
    if (!canon) continue;
    const mols = canon.split(/[+/]/);
    // vocab: each molecule maps to ITSELF (not the combo). Order-independent (sorted later).
    for (const mol of mols) {
      const mnorm = normalizeDrugName(mol);
      if (mnorm.length >= 5 && !vocabSeen.has(mnorm)) { vocabSeen.add(mnorm); vocab.push({ key: mnorm, molecule: titleCase(mol) }); }
    }
    // MONO row → its single-molecule generic key wins (first mono of a molecule wins; same class).
    if (mols.length === 1) {
      const ng = normalizeDrugName(canon);
      if (ng && !byGeneric.has(ng)) byGeneric.set(ng, row);
    }
  }
  // Pass 2: COMBINATION rows — full-composition key + each component molecule key, but ONLY where
  // a mono row hasn't already claimed it, so a mono always beats a combo for a molecule key.
  for (const row of rows) {
    const canon = (row.generic_canon || row.generic || '').trim();
    if (!canon) continue;
    const mols = canon.split(/[+/]/);
    if (mols.length === 1) continue;                          // monos handled in pass 1
    const ng = normalizeDrugName(canon);
    if (ng && !byGeneric.has(ng)) byGeneric.set(ng, row);     // full-composition key
    for (const mol of mols) {
      const mnorm = normalizeDrugName(mol);
      if (mnorm.length >= 5 && !byGeneric.has(mnorm)) byGeneric.set(mnorm, row);  // only if no mono
    }
  }
  brandNorms.sort((a, b) => b.nb.length - a.nb.length);     // longest brand first (prefix tier)
  vocab.sort((a, b) => b.key.length - a.key.length);        // longest molecule first (embedded tier)

  function rowToMatch(row: FormularyRow | undefined, generic: string, matchType: FormularyMatchType, confident: boolean): FormularyMatch {
    return {
      generic,
      major: row?.major || undefined,
      minor: row?.minor || undefined,
      schedule: row?.schedule_dc || undefined,
      highAlert: !!row?.high_risk,
      lasa: splitLasa(row?.lasa),
      ved: row?.ved || undefined,
      restricted: !!row?.restricted,
      form: row?.form || undefined,                   // 0.81.11 — plumbed through, consumed by nothing yet
      dosageForm: normalizeDosageForm(row?.form),
      matchType,
      confident,
    };
  }

  function enrichByGeneric(generic: string, matchType: FormularyMatchType, confident: boolean): FormularyMatch {
    const row = byGeneric.get(normalizeDrugName(generic));
    return rowToMatch(row, generic, matchType, confident);
  }

  return {
    size: byBrand.size,
    resolve(med) {
      const srcGeneric = (med.generic || '').trim();
      const brand = (med.brand || '').trim();

      // 1) EMR already gave a generic — trust it (enrich class best-effort).
      if (srcGeneric) return enrichByGeneric(srcGeneric, 'source-generic', true);
      if (!brand) return null;

      const nb = normalizeDrugName(brand);
      if (!nb) return null;

      // 2) exact normalised brand.
      const exact = byBrand.get(nb);
      if (exact) return rowToMatch(exact, exact.generic_canon || exact.generic || '', 'brand-exact', true);

      // 3) embedded molecule name (verbatim in the brand string).
      const low = ` ${nb} `;
      for (const v of vocab) {
        if (low.includes(` ${v.key} `)) return enrichByGeneric(v.molecule, 'embedded-generic', true);
      }

      // Phase-1 form gate (bug 3): a topical LINE may not take a family/prefix match unless the
      // matched rows include a topical form. Computed once — tiers 1–3 above are deliberately
      // outside the gate (source generic / exact brand / verbatim molecule are not guesses).
      const topicalLine = lineIsTopical(brand, med.route);

      // 4) brand family (first token) maps unambiguously to one molecule.
      const ft = nb.split(' ')[0];
      if (ft.length >= 4) {
        const fam = byFirstTok.get(ft);
        if (fam && fam.length) {
          const canons = new Set(fam.map((r) => (r.generic_canon || r.generic || '').trim().toLowerCase()).filter(Boolean));
          if (canons.size === 1) {
            // THE DEFECT: `atarax` → 3 oral hydroxyzine rows, canons.size === 1, confident:true —
            // for a CREAM the formulary does not hold. If the line is topical and NO row in the
            // family carries a topical form, this is not the product on the note: return null so
            // the item is tagged, never approximated (§4.3).
            if (topicalLine && !fam.some((r) => TOPICAL_FORM_RE.test(String(r.form ?? '').toLowerCase()))) return null;
            const row = fam[0];
            return rowToMatch(row, row.generic_canon || row.generic || '', 'brand-token', true);
          }
        }
      }

      // 5) longest formulary brand that prefixes (or is contained in) the text — APPROX.
      for (const { nb: fnb, row } of brandNorms) {
        if (fnb.length >= 4 && (nb === fnb || nb.startsWith(`${fnb} `) || ` ${nb} `.includes(` ${fnb} `))) {
          // Same gate: a topical line never takes an APPROXIMATE oral match (§4.3).
          if (topicalLine && !TOPICAL_FORM_RE.test(String(row.form ?? '').toLowerCase())) return null;
          return rowToMatch(row, row.generic_canon || row.generic || '', 'brand-prefix', false);
        }
      }

      return null;
    },
  };
}

const NUTRA = /sunscreen|spf\b|face\s?wash|facewash|\bserum\b|moistur|shampoo|cleanser|supplement|multivitamin|protein|omega|biotin|probiotic|hygiene|anti.?perspirant|exfoliat|brighten|wrinkle|petroleum jelly|hair (?:growth|therapy|serum|cleanser|fall)|nutraceutical|\bors\b|electrolyte|jelly|fish oil|collagen|whey|softgel|\bgummies?\b|skin (?:soothing|tone)|feminine/i;

/** Classify an UNMATCHED brand: a likely nutraceutical/cosmetic vs an out-of-formulary drug. */
export function classifyUnmatched(brand: string): NonFormularyTag {
  return NUTRA.test(brand || '') ? 'nutraceutical-cosmetic' : 'non-formulary';
}

// ── The form gate (audit-integrity batch phase 1, bug 3 / class B) ─────────────────────────────
//
// "Atarax Cream For Distressed Dry And Itchy Skin" matched tier 4: the family `atarax` holds 3
// ORAL hydroxyzine rows (2 tablets, 1 syrup) — no cream — yet the cosmetic emollient resolved to
// Hydroxyzine with confident:true, which licensed a deterministic prescribing-safety finding. The
// engine poisoned its own prompt: the LLM reasoned correctly from a false premise, so no
// contradiction detector could catch it (bug register §3).
//
// The gate: a TOPICAL line may not take a tier-4/5 match from a family with no topical row. It
// falls through to null so classifyUnmatched tags it — an unmatched item is tagged, not scored,
// and the system prompt already forbids inventing interactions for non-formulary items (§4.4).
// Tiers 1–3 are untouched: a source generic is trusted, an exact brand is exact, and an embedded
// molecule name is verbatim evidence.

/** Route vocabulary — MEASURED live: `Topical`, `topical ` (trailing space), `local`, and the
 *  PHRASES `Topical application` (934 lines), `apply locally` (547), `Intranasal/ topical
 *  application` (384), `Local application` (160). Phase 1.1 widened the anchored token match to a
 *  word-boundary phrase match — ~2,025 topical-by-route lines were recognised only when their
 *  brand text happened to carry a form word. Lowercase + trim first (unchanged); `local` IS
 *  topical. */
// ⚠️ DEVIATION, FLAGGED: the kickoff's literal /\b(topical|local)\b/ does NOT match 'apply
// locally' — 'locally' has no word boundary after 'local' — yet its §3 and test 6 both REQUIRE
// that match (547 live lines). The behaviour spec wins over the literal regex: local(ly)? is the
// minimal widening that satisfies every required case. Direction unchanged — still only widens.
export const TOPICAL_ROUTE_RE = /\b(topical|local(ly)?)\b/;

/** Topical dosage forms, applied to LOWERCASED strings (a prescription line's brand text, or a
 *  formulary row's raw `form`). */
export const TOPICAL_FORM_RE = /cream|ointment|lotion|\bgel\b|soap|shampoo|serum|face ?wash|dusting powder|\bbalm\b/;

/** True when the prescription LINE is topical: by route, or failing that by its own text. Pure. */
export function lineIsTopical(brand: string | null | undefined, route: string | null | undefined): boolean {
  if (TOPICAL_ROUTE_RE.test(String(route ?? '').trim().toLowerCase())) return true;
  return TOPICAL_FORM_RE.test(String(brand ?? '').toLowerCase());
}
