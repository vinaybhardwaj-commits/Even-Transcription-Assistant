/**
 * lib/rooms-live-claims.ts — data helper for Rooms Live claims (migration 0131, table rooms_live_claim). GATING owns this file;
 * FLEET's route calls it. Operational data only, no PHI.
 *
 *   openClaims(sql)            → every claim with cleared_at null, oldest first.
 *   claim(sql, input)          → opens a claim. One open claim per room (partial unique index): a second one returns
 *                                { ok:false, reason:"already_claimed", existing } and writes nothing.
 *   clear(sql, input)          → clears the room's open claim; { ok:false, reason:"no_open_claim" } when there is none.
 *
 * `sql` is lib/db's tagged template (Neon HTTP). Every value is a bound parameter; no sql.unsafe. Inputs are validated here with the same limits
 * as the table's CHECKs, and a bad input returns { ok:false, reason:"invalid", field } before any statement runs.
 * claim() uses INSERT ... ON CONFLICT DO NOTHING on the open-claim index rather than catching an error, so it behaves the same on every driver.
 */

export type ClaimSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export interface RoomClaim {
  id: number | string; // bigserial: the Neon driver returns bigint as a string
  room_id: string;
  claimed_by: string;
  claimed_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
  state_at_claim: string | null;
  note: string | null;
}

export interface ClaimInput { room_id: string; claimed_by: string; state_at_claim?: string | null; note?: string | null }
export interface ClearInput { room_id: string; cleared_by: string }

export type InvalidClaim = { ok: false; reason: "invalid"; field: string };
export type ClaimResult = { ok: true; claim: RoomClaim } | { ok: false; reason: "already_claimed"; existing: RoomClaim } | InvalidClaim;
export type ClearResult = { ok: true; claim: RoomClaim } | { ok: false; reason: "no_open_claim" } | InvalidClaim;

/** A real room id (room_ + 8 lowercase alphanumerics) or a dev/test scratch room (room_scratch_*, lib/steward/config.ts SCRATCH_ROOM_PREFIX). */
const ROOM_ID_RE = /^(?:room_[a-z0-9]{8}|room_scratch_[a-z0-9_-]{1,40})$/;

export const isValidRoomId = (v: unknown): v is string => typeof v === "string" && ROOM_ID_RE.test(v);
const labelOk = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 64;
const optOk = (v: unknown, max: number) => v === undefined || v === null || (typeof v === "string" && v.length <= max);

export async function openClaims(sql: ClaimSql): Promise<RoomClaim[]> {
  return (await sql`
    SELECT id, room_id, claimed_by, claimed_at, cleared_at, cleared_by, state_at_claim, note
      FROM rooms_live_claim
     WHERE cleared_at IS NULL
     ORDER BY claimed_at, id
     LIMIT 50
  `) as RoomClaim[];
}

export async function claim(sql: ClaimSql, input: ClaimInput): Promise<ClaimResult> {
  if (!isValidRoomId(input?.room_id)) return { ok: false, reason: "invalid", field: "room_id" };
  if (!labelOk(input.claimed_by)) return { ok: false, reason: "invalid", field: "claimed_by" };
  if (!optOk(input.state_at_claim, 64)) return { ok: false, reason: "invalid", field: "state_at_claim" };
  if (!optOk(input.note, 280)) return { ok: false, reason: "invalid", field: "note" };
  const state = input.state_at_claim ?? null;
  const note = input.note ?? null;
  // Two passes: if the open claim that blocked the insert is cleared before we read it, try the insert once more.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ins = (await sql`
      INSERT INTO rooms_live_claim (room_id, claimed_by, state_at_claim, note)
      VALUES (${input.room_id}, ${input.claimed_by}, ${state}, ${note})
      ON CONFLICT (room_id) WHERE cleared_at IS NULL DO NOTHING
      RETURNING id, room_id, claimed_by, claimed_at, cleared_at, cleared_by, state_at_claim, note
    `) as RoomClaim[];
    if (ins.length > 0) return { ok: true, claim: ins[0]! };
    const existing = (await sql`
      SELECT id, room_id, claimed_by, claimed_at, cleared_at, cleared_by, state_at_claim, note
        FROM rooms_live_claim
       WHERE room_id = ${input.room_id} AND cleared_at IS NULL
       LIMIT 1
    `) as RoomClaim[];
    if (existing.length > 0) return { ok: false, reason: "already_claimed", existing: existing[0]! };
  }
  throw new Error("rooms_live_claim: insert conflicted but no open claim found");
}

export async function clear(sql: ClaimSql, input: ClearInput): Promise<ClearResult> {
  if (!isValidRoomId(input?.room_id)) return { ok: false, reason: "invalid", field: "room_id" };
  if (!labelOk(input.cleared_by)) return { ok: false, reason: "invalid", field: "cleared_by" };
  const rows = (await sql`
    UPDATE rooms_live_claim
       SET cleared_at = now(), cleared_by = ${input.cleared_by}
     WHERE room_id = ${input.room_id} AND cleared_at IS NULL
    RETURNING id, room_id, claimed_by, claimed_at, cleared_at, cleared_by, state_at_claim, note
  `) as RoomClaim[];
  if (rows.length === 0) return { ok: false, reason: "no_open_claim" };
  return { ok: true, claim: rows[0]! };
}
