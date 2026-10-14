/**
 * lib/as-of-core.ts — PURE temporal primitives shared across planes.
 *
 * Home for any pure "as-of" temporal cut the longitudinal spine needs. Deliberately
 * neutral: this module imports NOTHING from findings, score, formulary, member-state,
 * or the longitudinal advisory core — so the spine can use it without crossing the
 * spine→advisory boundary (architecture rule 3, scripts/architecture-check.mjs).
 *
 * applyAsOfCut moved here VERBATIM from lib/opd-longitudinal-core.ts (Architecture
 * Governance Slice 1, Part A — behaviour-preserving relocation; 13 Jul 2026).
 */

// ── D2 knowability cut (PRD §2, the normative rule) ─────────────────────────────────────────────────
/** STRICT PRIOR-DAY: keep evidence dated strictly before the visit day (ISO YYYY-MM-DD string compare),
 *  and always drop the audited encounter's own ref. Applies IDENTICALLY to opd/lab/care_call+PROM folds. */
export function applyAsOfCut<T extends { encounterRef: string; date: string }>(
  encounters: T[], asOfDate: string, auditedEncounterRef?: string | null,
): T[] {
  const cut = String(asOfDate).slice(0, 10);
  const audited = auditedEncounterRef ? String(auditedEncounterRef) : '';
  return (encounters || []).filter((e) => {
    const d = String(e.date).slice(0, 10);
    if (!d || !(d < cut)) return false;                   // strict prior-day only (same-day excluded)
    if (audited && e.encounterRef === audited) return false;   // the audited note never counts against itself
    return true;
  });
}
