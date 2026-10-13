/**
 * lib/room-admin.ts — the room and install repairs behind scribe_admin and the Bench route (ADMIN-1, 13 Oct 2026).
 *
 * The install reads and the bind write behind scribe_admin. Room enable/disable and retire are GATING's own
 * functions (lib/room-enable, lib/room-install). The tool writes the admin.* audit rows (lib/admin-audit). No hard deletes. Every function is idempotent: a no-op answers changed:false.
 * All SQL here is INFERRED against migrations 0001 (room, audit_log) and 0075 (room_install); no live DB.
 */
import { sql } from "@/lib/db";

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

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
  | { ok: true; changed: boolean; before: { retired_at: string | null }; after: { retired_at: string | null } }
  | { ok: false; error: "no_install" | "install_not_in_room" | "never_enrolled" | "live_install_exists" };

/**
 * Restore a RETIRED install of the SAME room (retired_at -> NULL): the undo for a mistaken retire.
 * Refuses an unknown install, another room's install, an install that never enrolled, and any room
 * that already has a live enrolled install. An install that is not retired is a no-op (changed:false).
 * The UPDATE repeats the live-install guard so a race loses to the partial unique index, not to a
 * second live binding.
 */
export async function bindInstall(roomId: string, installId: string): Promise<BindResult> {
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
  return { ok: true, changed, before, after };
}
