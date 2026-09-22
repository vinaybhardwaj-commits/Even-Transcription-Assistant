import type { Attention, RoomLive } from "@/components/admin/bench-live/types";

export type SeverityBand = "S0" | "S1" | "S2" | "S3";

export function severityBandForRank(rank: number | null): SeverityBand {
  if (rank === 0) return "S0";
  if (rank === 1) return "S1";
  if (rank === 2 || rank === 3) return "S2";
  return "S3";
}

/**
 * Sorts from tape-at-risk to healthy while preserving a deterministic room-name
 * order inside each band. The rank comes only from room-facts-derived attention
 * items; no schedule or inferred clinic expectation is introduced here.
 */
export function sortFleetRooms(
  rooms: readonly RoomLive[],
  attention: readonly Attention[],
): RoomLive[] {
  const rankByRoom = new Map<string, number>();
  for (const item of attention) {
    const previous = rankByRoom.get(item.roomId);
    if (previous === undefined || item.rank < previous) {
      rankByRoom.set(item.roomId, item.rank);
    }
  }

  return [...rooms].sort((a, b) => {
    const aRank = rankByRoom.get(a.room.id) ?? Number.POSITIVE_INFINITY;
    const bRank = rankByRoom.get(b.room.id) ?? Number.POSITIVE_INFINITY;
    if (aRank !== bRank) return aRank - bRank;
    return a.room.name.localeCompare(b.room.name);
  });
}
