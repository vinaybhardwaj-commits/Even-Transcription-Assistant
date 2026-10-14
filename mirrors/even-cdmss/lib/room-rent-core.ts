/**
 * lib/room-rent-core.ts — room/bed-rent matching + avoidable-bed-day cost (VS.2, PURE).
 *
 * Costs the avoidable bed-days of an over-stay onto the Care-Value Scorecard's Cost
 * domain. The per-day rate comes from data/room-rent.json (passed IN as a table so this
 * core never imports JSON — keeps it `node --experimental-strip-types` testable).
 *
 * HONESTY: until the real EHRC Room-Rent card is loaded (table.status==='estimate'),
 * the resulting ₹ is a LABELLED MODEL ESTIMATE, kept separate from cited charge-master
 * tariffs. We only ever cost bed-days the auditor independently flagged as an over-stay.
 */

export interface RoomCategory { key: string; label: string; perDay: number; aliases: string[] }
export interface RoomRentTable {
  default: { key: string; perDay: number };
  categories: RoomCategory[];
  dayCareBenchmarkDays?: number;
  status?: string;   // 'estimate' | 'tariff'
}
export interface RoomMatch { key: string; label: string; perDay: number; matched: boolean }

const INPATIENT_NONBILLABLE = new Set(['day_care']);  // settings that don't accrue room rent

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().trim().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ');
}

/** Match a free-text care-setting (e.g. "Single Room (Second Floor)") to a room category. */
export function matchRoomCategory(careSetting: unknown, table: RoomRentTable): RoomMatch {
  const s = norm(careSetting);
  const fallback: RoomMatch = {
    key: table.default.key,
    label: table.categories.find((c) => c.key === table.default.key)?.label ?? table.default.key,
    perDay: table.default.perDay, matched: false,
  };
  if (!s) return fallback;
  // Prefer the longest alias that appears in the string (so "single room" beats "room").
  let best: { cat: RoomCategory; len: number } | null = null;
  for (const cat of table.categories) {
    for (const a of [cat.key, ...cat.aliases]) {
      const an = norm(a);
      if (an && s.includes(an) && (!best || an.length > best.len)) best = { cat, len: an.length };
    }
  }
  if (best) return { key: best.cat.key, label: best.cat.label, perDay: best.cat.perDay, matched: true };
  return fallback;
}

/** Whole avoidable bed-days = LOS − day-care benchmark (≥0). Benchmark default 1 (day-care/overnight). */
export function excessBedDays(los: number | null | undefined, table: RoomRentTable, benchmarkOverride?: number): number {
  const n = Math.round(Number(los));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const bench = Number.isFinite(Number(benchmarkOverride)) ? Number(benchmarkOverride) : (table.dayCareBenchmarkDays ?? 1);
  return Math.max(0, n - Math.max(0, bench));
}

export interface BedDayCost { cost: number; days: number; perDay: number; categoryLabel: string; estimate: boolean; detail: string }

/**
 * Cost the avoidable bed-days of an over-stay. Returns 0-cost when not an inpatient
 * over-stay. `overStayFlagged` must be true (the auditor flagged the intensity) — we
 * never invent an over-stay the model didn't raise.
 */
export function computeBedDayCost(
  los: number | null | undefined,
  careSetting: unknown,
  overStayFlagged: boolean,
  table: RoomRentTable,
  benchmarkOverride?: number,
): BedDayCost {
  const none: BedDayCost = { cost: 0, days: 0, perDay: 0, categoryLabel: '', estimate: table.status !== 'tariff', detail: '' };
  if (!overStayFlagged) return none;
  const cat = matchRoomCategory(careSetting, table);
  if (INPATIENT_NONBILLABLE.has(cat.key) || cat.perDay <= 0) return none;
  const days = excessBedDays(los, table, benchmarkOverride);
  if (days <= 0) return none;
  const cost = days * cat.perDay;
  const estimate = table.status !== 'tariff';
  return {
    cost, days, perDay: cat.perDay, categoryLabel: cat.label, estimate,
    detail: `${days} excess bed-day${days === 1 ? '' : 's'} × ₹${cat.perDay.toLocaleString('en-IN')} ${cat.label.toLowerCase()}${estimate ? ' (est.)' : ''}`,
  };
}
