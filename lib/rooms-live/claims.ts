/**
 * lib/rooms-live/claims.ts — "I'm on it" (SPEC-v1 AMENDMENT 2). The table and its helper are GATING's (migration 0131, lib/rooms-live-claims.ts: openClaims / claim / clear);
 * this file only adapts them to the screen and holds the AUTO-CLEAR rule. No SQL of mine touches rooms_live_claim.
 *
 * AUTO-CLEAR. When the API computes a room back in listening or quiet, or with no doctor signed in, and a claim is open, the snapshot calls clear(room_id, "auto"),
 * at most once per room per minute per server instance, and only after TWO consecutive resolved polls (v1.1 F27). THIS IS THE ONLY WRITE the GET /now handler makes. (A claim therefore only lasts while a doctor is present and the
 * room is in a problem state, which is exactly where the button is offered.)
 */
import { openClaims, clear as clearClaim, type ClaimSql, type RoomClaim } from "@/lib/rooms-live-claims";
import type { RoomStateName } from "./state";

export type ClaimsPort = { open(): Promise<RoomClaim[]>; clear(roomId: string): Promise<void> };
export type ClaimView = { by: string; since: string };

export const realClaimsPort = (sql: ClaimSql): ClaimsPort => ({
  open: () => openClaims(sql),
  clear: async (roomId) => {
    await clearClaim(sql, { room_id: roomId, cleared_by: "auto" });
  },
});

export const AUTO_CLEAR_GAP_MS = 60_000;
const last = new Map<string, number>();
export const resetAutoClearForTests = (): void => {
  last.clear();
  streaks.clear();
};

/** F27: a claim is cleared only after this many consecutive resolved polls */
export const CLEAR_AFTER_POLLS = 2;
const streaks = new Map<string, number>();
/** records one poll of a room that has an open claim and returns the length of the current resolved run (0 when this poll was not resolved) */
export function resolvedStreak(roomId: string, resolved: boolean): number {
  const n = resolved ? (streaks.get(roomId) ?? 0) + 1 : 0;
  streaks.set(roomId, n);
  return n;
}
/** a room with no open claim has no run */
export function forgetStreaksExcept(claimedRoomIds: readonly string[]): void {
  for (const k of [...streaks.keys()]) if (!claimedRoomIds.includes(k)) streaks.delete(k);
}

/** the room no longer needs anyone: back to fine, or nobody signed in */
/** FIX-1 F1: "no doctor" only counts as resolved when the doctor was actually READ (occupancy not degraded); listening/quiet always resolves */
export const claimResolved = (state: RoomStateName, hasDoctor: boolean, doctorKnown: boolean = true): boolean => state === "listening" || state === "quiet" || (!hasDoctor && doctorKnown && state !== "unknown");

/** true at most once per room per AUTO_CLEAR_GAP_MS (and records the attempt) */
export function autoClearDue(roomId: string, now: number): boolean {
  const t = last.get(roomId);
  if (t !== undefined && now - t < AUTO_CLEAR_GAP_MS) return false;
  last.set(roomId, now);
  return true;
}

export const toView = (c: RoomClaim): ClaimView => ({ by: String(c.claimed_by), since: new Date(c.claimed_at).toISOString() });
