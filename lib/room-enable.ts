/**
 * lib/room-enable.ts — enable / disable a room, with an audit row and an alert (gating/opd4-guard S7, gating-lead amendment 13 Oct 2026).
 * OPD 4 was found "disabled" with no trail of who or why. Every path that flips room.disabled_at goes through here or calls recordRoomToggle:
 *   - PATCH /api/bench/rooms (admin enable / disable)      -> setRoomEnabled
 *   - the PIN lockout at 30 failed attempts (room-auth)     -> recordRoomToggle, actor "system:pin_lockout"
 * The audit row is `room.enable` / `room.disable`: actor, room_id, reason if given, before -> after. A disable inside clinic hours also queues a `room_disabled`
 * alert (lib/alerts/ops-alert.ts). Neither the audit nor the alert can fail the toggle. Exposed so the scribe-mcp admin tools can call setRoomEnabled as is.
 */
import { sql } from "@/lib/db";
import { isClinicHours } from "@/lib/alerts/clinic-hours";
import { queueOpsAlert } from "@/lib/alerts/ops-alert";

export type RoomToggleResult = { ok: true; room_id: string; room_slug: string; before: "enabled" | "disabled"; after: "enabled" | "disabled" } | { ok: false; code: "NOT_FOUND" };

/** Audit row + clinic-hours alert for a toggle that has already happened. Best effort: never throws. */
export async function recordRoomToggle(r: {
  room_id: string;
  room_slug: string;
  before: "enabled" | "disabled";
  after: "enabled" | "disabled";
  actor: string;
  reason?: string | null;
  now_ms?: number;
}): Promise<void> {
  const action = r.after === "disabled" ? "room.disable" : "room.enable";
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (${r.actor.startsWith("system:") || r.actor.startsWith("mcp:") ? "system" : "admin"}::actor_type, ${r.actor}, ${action}, 'room', ${r.room_id},
              ${JSON.stringify({ actor: r.actor, room_id: r.room_id, reason: r.reason ?? null, before: r.before, after: r.after })}::jsonb)
    `;
  } catch (e) {
    console.warn("[room-enable] audit insert failed", JSON.stringify({ action, room_id: r.room_id, err: String((e as Error)?.message ?? e).slice(0, 160) }));
  }
  if (r.after === "disabled" && isClinicHours(r.now_ms ?? Date.now())) {
    await queueOpsAlert({ kind: "room_disabled", room_id: r.room_id, room_slug: r.room_slug, minutes: null, reason: r.reason ?? null });
  }
}

/** Enable or disable one room. Enabling also clears the PIN lockout (as the route always did). */
export async function setRoomEnabled(roomId: string, enabled: boolean, opts: { actor: string; reason?: string | null }): Promise<RoomToggleResult> {
  const rows = (await sql`SELECT slug, disabled_at FROM room WHERE id = ${roomId} LIMIT 1`) as Array<{ slug: string; disabled_at: unknown }>;
  const room = rows[0];
  if (!room) return { ok: false, code: "NOT_FOUND" };
  const before = room.disabled_at ? "disabled" : "enabled";
  if (enabled) {
    await sql`UPDATE room SET disabled_at = NULL, failed_attempts = 0, locked_until = NULL WHERE id = ${roomId}`;
  } else {
    await sql`UPDATE room SET disabled_at = NOW() WHERE id = ${roomId}`;
  }
  const after = enabled ? "enabled" : "disabled";
  await recordRoomToggle({ room_id: roomId, room_slug: room.slug, before, after, actor: opts.actor, reason: opts.reason });
  return { ok: true, room_id: roomId, room_slug: room.slug, before, after };
}
