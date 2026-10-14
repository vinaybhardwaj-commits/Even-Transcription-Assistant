/**
 * lib/room-rent.ts — wired room-rent loader (VS.2).
 * Loads data/room-rent.json and exposes the avoidable-bed-day cost estimator used by
 * the Care-Value Scorecard's Cost domain. See lib/room-rent-core.ts for the pure logic.
 */
import ROOM_RENT from '@/data/room-rent.json';
import { computeBedDayCost, type RoomRentTable, type BedDayCost } from './room-rent-core';
import type { AdminFacts } from './doc-audit-core';

const TABLE = ROOM_RENT as unknown as RoomRentTable;

/**
 * Estimate the avoidable bed-day cost of an over-stay (0 unless an over-stay was flagged).
 * benchmarkDays: when a matched package defines a covered period, pass it so excess = LOS −
 * package days (room rent is included within the package); otherwise the day-care benchmark applies.
 */
export function estimateBedDayCost(adminFacts: AdminFacts | undefined, overStayFlagged: boolean, benchmarkDays?: number | null): BedDayCost {
  return computeBedDayCost(
    adminFacts?.lengthOfStayDays ?? null,
    adminFacts?.careSetting ?? null,
    overStayFlagged,
    TABLE,
    benchmarkDays != null ? benchmarkDays : undefined,
  );
}
