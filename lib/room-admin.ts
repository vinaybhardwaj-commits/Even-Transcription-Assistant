/**
 * lib/room-admin.ts — the room and install repairs behind scribe_admin and the Bench route (ADMIN-1, 13 Oct 2026).
 *
 * One home for the SQL, so the MCP tool and the existing Bench PATCH route cannot drift, and so every
 * one of these writes leaves an audit_log row naming who did it (lib/admin-audit; RCA: nothing recorded
 * who disabled OPD 4). No hard deletes. Every function is idempotent: a no-op answers changed:false.
 * All SQL here is INFERRED against migrations 0001 (room, audit_log) and 0075 (room_install); no live DB.
 */
import { sql } from "@/lib/db";
import { writeAdminAudit, type AdminActor } from "@/lib/admin-audit";

export type RoomEnableResult =
  | { found: false }
  | { found: true; changed: boolean; before: { disabled_at: string | null }; after: { disabled_at: string | null }; audited: boolean };

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/**
 * Enable or disable a room. Disable sets disabled_at = now() (only if it is clear). Enable clears
 * disabled_at AND the PIN lockout (failed_attempts, locked_until) exactly as the Bench route always did.
 * One audit row either way, no-ops included.
 */
export async function setRoomEnabled(roomId: string, enabled: boolean, actor: AdminActor, reason: string, opts: { skipAudit?: boolean } = {}): Promise<RoomEnableResult> {
  const rows = (await sql`SELECT disabled_at FROM room WHERE id = ${roomId} LIMIT 1`) as Array<{ disabled_at: string | Date | null }>;
  if (rows.length === 0) return { found: false };
  const before = { disabled_at: iso(rows[0]!.disabled_at) };
  let after = before;
  let changed = false;
  if (enabled) {
    await sql`
      UPDATE room
         SET disabled_at = NULL,
             failed_attempts = 0,
             locked_until = NULL
       WHERE id = ${roomId}
    `;
    after = { disabled_at: null };
    changed = before.disabled_at !== null;
  } else if (before.disabled_at === null) {
    const upd = (await sql`UPDATE room SET disabled_at = NOW() WHERE id = ${roomId} AND disabled_at IS NULL RETURNING disabled_at`) as Array<{ disabled_at: string | Date }>;
    if (upd[0]) {
      after = { disabled_at: iso(upd[0].disabled_at) };
      changed = true;
    }
  }
  const audited = opts.skipAudit ? false : await writeAdminAudit({
    actor,
    action: enabled ? "admin.room_enable" : "admin.room_disable",
    targetType: "room",
    targetId: roomId,
    meta: { reason, before, after, room_id: roomId, changed },
  });
  return { found: true, changed, before, after, audited };
}

export type InstallRow = {
  install_id: string;
  room_id: string;
  created_at: string | Date;
  enrolled_at: string | Date | null;
  retired_at: string | Date | null;
  hostname: string | null;
  app_version: string | null;
  last_seen_at: string | Date | null;
  update_channel: string | null;
  session_open: boolean | null;
  mic_state: string | null;
};

/** One install by id, or null. */
export async function findInstall(installId: string): Promise<InstallRow | null> {
  const rows = (await sql`
    SELECT install_id, room_id, created_at, enrolled_at, retired_at, hostname, app_version,
           last_seen_at, update_channel, session_open, mic_state
      FROM room_install
     WHERE install_id = ${installId}
     LIMIT 1
  `) as InstallRow[];
  return rows[0] ?? null;
}

/** The room's live enrolled install (the binding the steward reads), or null. */
export async function findBoundInstall(roomId: string): Promise<InstallRow | null> {
  const rows = (await sql`
    SELECT install_id, room_id, created_at, enrolled_at, retired_at, hostname, app_version,
           last_seen_at, update_channel, session_open, mic_state
      FROM room_install
     WHERE room_id = ${roomId}
       AND enrolled_at IS NOT NULL
       AND retired_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
  `) as InstallRow[];
  return rows[0] ?? null;
}

/** The room's installs, newest first, at most `limit`. */
export async function listRoomInstalls(roomId: string, limit = 10): Promise<InstallRow[]> {
  return (await sql`
    SELECT install_id, room_id, created_at, enrolled_at, retired_at, hostname, app_version,
           last_seen_at, update_channel, session_open, mic_state
      FROM room_install
     WHERE room_id = ${roomId}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `) as InstallRow[];
}

export type BindResult =
  | { ok: true; changed: boolean; before: { retired_at: string | null }; after: { retired_at: string | null }; audited: boolean }
  | { ok: false; error: "no_install" | "install_not_in_room" | "never_enrolled" | "live_install_exists" };

/**
 * Restore a RETIRED install of the SAME room (retired_at -> NULL): the undo for a mistaken retire.
 * Refuses an unknown install, another room's install, an install that never enrolled, and any room
 * that already has a live enrolled install. An install that is not retired is a no-op (changed:false).
 * The UPDATE repeats the live-install guard so a race loses to the partial unique index, not to a
 * second live binding.
 */
export async function bindInstall(roomId: string, installId: string, actor: AdminActor, reason: string, opts: { skipAudit?: boolean } = {}): Promise<BindResult> {
  const inst = await findInstall(installId);
  if (!inst) return { ok: false, error: "no_install" };
  if (inst.room_id !== roomId) return { ok: false, error: "install_not_in_room" };
  if (!inst.enrolled_at) return { ok: false, error: "never_enrolled" };
  let changed = false;
  const before = { retired_at: iso(inst.retired_at) };
  let after = before;
  if (inst.retired_at) {
    const live = await findBoundInstall(roomId);
    if (live) return { ok: false, error: "live_install_exists" };
    const upd = (await sql`
      UPDATE room_install
         SET retired_at = NULL
       WHERE install_id = ${installId}
         AND room_id = ${roomId}
         AND retired_at IS NOT NULL
         AND enrolled_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM room_install o
            WHERE o.room_id = ${roomId} AND o.retired_at IS NULL AND o.enrolled_at IS NOT NULL
         )
       RETURNING install_id
    `) as Array<{ install_id: string }>;
    if (!upd[0]) return { ok: false, error: "live_install_exists" };
    changed = true;
    after = { retired_at: null };
  }
  const audited = opts.skipAudit ? false : await writeAdminAudit({
    actor,
    action: "admin.bind",
    targetType: "room_install",
    targetId: installId,
    meta: { reason, before, after, room_id: roomId, install_id: installId, changed },
  });
  return { ok: true, changed, before, after, audited };
}
