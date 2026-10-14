/**
 * lib/charge-master.ts — EHRC Charge Master lookup (CW-VA cost grounding).
 *
 * Grounds the Value Analysis cost line in EHRC's REAL prices instead of an LLM estimate.
 * Two sources, both parsed from the EHRC Tariff 2025-26 PDFs:
 *   - data/charge-master-packages.json       (201 inpatient surgical/procedure packages)
 *   - data/charge-master-investigations.json (2,208 labs/imaging/etc.)
 * Matching logic is in lib/charge-master-core.ts (pure, unit-tested).
 */

import PACKAGES_DOC from '@/data/charge-master-packages.json';
import INVESTIGATIONS_DOC from '@/data/charge-master-investigations.json';
import { matchTariffIn, matchInvestigationIn, roomCategoryInflation, tierForCareSetting, type TariffRow, type TariffMatch, type InflationResult } from './charge-master-core';

type RawPkg = { code: string; dept?: string; item: string; general: number; semi_private?: number | null; private?: number | null; suite?: number | null; icu?: number | null; days?: number | null };
type RawInv = { code: string; type?: string; item: string; opd?: number | null; general: number; semi_private?: number | null; private?: number | null; suite?: number | null; icu?: number | null };

const PACKAGE_ROWS: TariffRow[] = (((PACKAGES_DOC as { packages?: RawPkg[] }).packages) || [])
  .map((r) => ({ kind: 'package' as const, code: r.code, dept: r.dept, item: r.item, general: r.general, semiPrivate: r.semi_private ?? null, private: r.private ?? null, suite: r.suite ?? null, icu: r.icu ?? null, days: r.days ?? null }));

const INVESTIGATION_ROWS: TariffRow[] = (((INVESTIGATIONS_DOC as { investigations?: RawInv[] }).investigations) || [])
  .map((r) => ({ kind: 'investigation' as const, code: r.code, type: r.type, item: r.item, opd: r.opd ?? null, general: r.general, semiPrivate: r.semi_private ?? null, private: r.private ?? null, suite: r.suite ?? null, icu: r.icu ?? null }));

export function matchTariff(query: string): TariffMatch | null {
  return matchTariffIn(query, PACKAGE_ROWS);
}
export function matchInvestigation(query: string): TariffMatch | null {
  return matchInvestigationIn(query, INVESTIGATION_ROWS);
}

/** Match a list of proposed orders against packages first, then investigations. Dedup by code. */
export function matchAnyTariffs(queries: string[]): TariffMatch[] {
  const out: TariffMatch[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const m = matchTariff(q) || matchInvestigation(q);
    if (m && !seen.has(m.code)) { seen.add(m.code); out.push(m); }
  }
  return out;
}

/** Room-category inflation across a whole episode's matched orders, at the patient's tier vs General. */
export function episodeRoomInflation(queries: string[], careSetting: unknown): InflationResult {
  const rows = matchAnyTariffs(queries);
  return roomCategoryInflation(rows, tierForCareSetting(careSetting));
}

/** Package period (days) for the best package match of a procedure, or null. */
export function packageDaysFor(procedure: string | null | undefined): number | null {
  if (!procedure) return null;
  const m = matchTariff(procedure);
  return m && typeof m.days === 'number' && m.days > 0 ? m.days : null;
}

export {
  matchTariffIn, matchInvestigationIn, normalizeTariffText, formatINR, formatTariffForPrompt,
  roomCategoryInflation, tierForCareSetting, priceAtTier,
} from './charge-master-core';
export type { TariffRow, TariffMatch, TariffKind, TariffTier, InflationResult } from './charge-master-core';
