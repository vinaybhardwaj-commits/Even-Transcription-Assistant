/**
 * lib/formulary.ts — EHRC Pharmacy Formulary 2026 lookup (loads the bundled JSON,
 * builds the resolver once). Matching logic is in lib/formulary-match-core.ts (pure,
 * unit-tested). Used by the OPD note-quality audit to recover the molecule + class +
 * schedule + ISMP high-alert + LASA + VED behind a brand-only prescription.
 *
 * Same formulary the pharmacist Medication-Audit surface seeds into Neon `formulary`;
 * here we read it in-process (no DB round-trip per audited note).
 */

import FORMULARY from '@/data/formulary-2026.json';
import {
  buildFormularyMatcher, classifyUnmatched, normalizeDrugName, lineIsTopical,
  type FormularyRow, type FormularyMatch, type NonFormularyTag,
} from './formulary-match-core';
import type { OpdMed } from './opd-ingest-core';

type RawFormularyRow = {
  brand?: string; generic?: string; generic_canon?: string; major?: string; minor?: string;
  schedule_dc?: string; high_risk?: boolean; lasa?: string; ved?: string; restricted?: boolean;
  form?: string;   // 0.81.11 — carried through so matchers can become form-aware (Stage 1: plumbed, unread)
};

const ROWS: FormularyRow[] = ((FORMULARY as unknown as RawFormularyRow[]) || []).map((r) => ({
  brand: r.brand || '',
  generic: r.generic || '',
  generic_canon: r.generic_canon || r.generic || '',
  major: r.major || undefined,
  minor: r.minor || undefined,
  schedule_dc: r.schedule_dc || undefined,
  high_risk: !!r.high_risk,
  lasa: r.lasa || undefined,
  ved: r.ved || undefined,
  restricted: !!r.restricted,
  form: r.form || undefined,   // 0.81.11 — no longer dropped at the projection (Matcher-Scoping Audit §2.2)
}));

const MATCHER = buildFormularyMatcher(ROWS);

/** Resolve one medication ({brand, generic}) against the formulary. null = no signal at all. */
export function resolveMed(med: { brand?: string | null; generic?: string | null }): FormularyMatch | null {
  return MATCHER.resolve(med);
}

/** Enrich OPD meds IN PLACE with the formulary molecule + class + schedule + safety profile.
 *  Shared by the audit orchestrator and the case-view note panel so both show the same. */
// Phase 1 (audit-integrity, bug 3) — the EMR category gate, layer 1. Source-system enums,
// compared case-sensitively on the trimmed string. A line the EMR itself files as non-medicine
// (the Atarax Cream line carries ALLOPATHY_NON_MEDICINE — as do all 15,438 topical non-medicine
// lines measured) never reaches the matcher: no molecule, no confident:true, no deterministic
// safety finding built on a product the formulary does not hold.
const NON_MEDICINE_CATEGORIES = new Set([
  'ALLOPATHY_NON_MEDICINE',
  'COSMETIC_TREATMENTS_CATEGORY',
  'NUTRITIONAL_SUPPLIMENTS',
]);

// ── Per-molecule class fallback (FORMULARY-CLASS-RESOLUTION PRD §5, 2 Aug 2026) ─────────────────
// A whole-string match cannot see a molecule inside a combination the formulary lacks as a
// composition row: 'Cefpodoxime Proxetil+Clavulanic Acid' resolved (source-generic, trusted) with
// NO class — 181 of 744 antibiotic lines a month — and noAntibioticClassOnNote() then reported no
// antibiotic on the note. Runs ONLY when the whole-string path yields no class; the formulary
// itself gains NO rows (it is a hospital artefact — the defect is in the matcher).
const BRACKET_GROUP_RE = /\([^)]*\)/g;   // '(500Mg+125Mg)' — stripped BEFORE the '+' split so a bracketed strength can never split the line
const STRENGTH_TAIL_RE = /(?:\s+\d+(?:\.\d+)?\s*(?:mg|mcg|ug|g|gm|ml|iu|%)(?:\s*w\/[wv])?)+\s*$/i;   // '500 Mg' · '550 Mg' · '0.3 %' · '2% W/W' · '100 Mg'
const ESTER_SALT_TAIL_RE = /\s+(?:proxetil|axetil|phosphate|sodium|potassium)\s*$/i;
const CLAVULANATE_RE = /clavulan/i;      // 'Clavulanic Acid' and 'Potassium Clavulanate' are the SAME molecule

/** Resolve ONE '+'-fragment to a formulary match carrying a class, or null. Candidates are tried
 *  in order: the strength-stripped fragment verbatim, its clavulanate synonyms, then the fragment
 *  with a trailing ester/salt suffix removed ('Cefpodoxime Proxetil' → 'Cefpodoxime'). */
function fragmentClassMatch(fragment: string): FormularyMatch | null {
  const frag = fragment.replace(STRENGTH_TAIL_RE, '').trim();
  if (!frag) return null;
  const candidates = [frag];
  if (CLAVULANATE_RE.test(frag)) candidates.push('Potassium Clavulanate', 'Clavulanic Acid');
  const deSuffixed = frag.replace(ESTER_SALT_TAIL_RE, '').trim();
  if (deSuffixed && deSuffixed !== frag) candidates.push(deSuffixed);
  for (const c of candidates) {
    const m = MATCHER.resolve({ generic: c });
    if (m?.major) return m;
  }
  return null;
}

/** §5 steps 1–4: split the generic on '+' (bracket groups stripped first), resolve each fragment,
 *  keep EVERY class found — one entry per resolving fragment, in fragment order, never picking one.
 *  minor is taken from the FIRST resolving fragment (the one that owns therapeuticClasses[0]). */
function perMoleculeClasses(generic: string): { classes: string[]; minor?: string } | null {
  const fragments = generic.replace(BRACKET_GROUP_RE, ' ').split('+').map((s) => s.trim()).filter(Boolean);
  const classes: string[] = [];
  let minor: string | undefined;
  for (const f of fragments) {
    const m = fragmentClassMatch(f);
    if (!m?.major) continue;
    if (classes.length === 0) minor = m.minor;
    classes.push(m.major);
  }
  return classes.length ? { classes, minor } : null;
}

export function enrichOpdMeds(meds: OpdMed[]): void {
  for (const m of meds) {
    // Phase 1.1 (route-aware gate, addendum A-6): the category ALONE gated ~24,614 ORAL lines —
    // crocin/Paracetamol, buscogast, limcee, and Depura/Vitamin D3 (1,166 lines, which would have
    // blinded the phase-3 vitamin D rule) all stopped resolving. THE PRINCIPLE: silence requires
    // positive evidence of a topical form, never the absence of a route string — a category alone
    // is not evidence. lineIsTopical already falls back to the brand text on a blank route.
    if (NON_MEDICINE_CATEGORIES.has(String(m.serviceCategory ?? '').trim())
        && lineIsTopical(m.brand, m.route)) {
      m.formularyMatch = 'none';
      m.nonFormulary = 'nutraceutical-cosmetic';
      continue;   // layer 1 (§4.2 as corrected): skip the matcher for topical non-medicines only
    }
    const match = MATCHER.resolve({ brand: m.brand, generic: m.generic, route: m.route });
    if (match) {
      m.resolvedGeneric = match.generic;
      m.therapeuticClass = match.major;
      m.subClass = match.minor;
      if (match.major) {
        m.therapeuticClasses = [match.major];
      } else if (m.generic) {
        // §5 fallback — the whole-string path (untouched above) yielded no class; resolve per
        // molecule. Class fields ONLY: schedule/highAlert/LASA/VED stay whatever the whole-string
        // match said, because a fragment's safety profile does not describe the combination.
        const pm = perMoleculeClasses(m.generic);
        if (pm) {
          m.therapeuticClass = pm.classes[0];
          m.therapeuticClasses = pm.classes;
          m.subClass = pm.minor;
        }
      }
      m.schedule = match.schedule;
      m.highAlert = match.highAlert;
      m.lasa = match.lasa.length ? match.lasa : undefined;
      m.ved = match.ved;
      m.restricted = match.restricted;
      m.form = match.form;                 // 0.81.11 — raw dosage form (Stage 1: available, unread by matchers)
      m.dosageForm = match.dosageForm;     // parsed coarse form
      m.formularyMatch = match.matchType;
    } else {
      m.formularyMatch = 'none';
      if (m.brand || m.generic) m.nonFormulary = classifyUnmatched(m.brand || m.generic || '');
    }
  }
}

export { classifyUnmatched, normalizeDrugName };
export type { FormularyMatch, NonFormularyTag };
export const FORMULARY_SIZE = ROWS.length;
