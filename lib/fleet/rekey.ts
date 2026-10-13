/**
 * lib/fleet/rekey.ts — the operator's one-time approval to re-key an install (gating/fleet-rekey, migration 0167).
 *
 * register.ts refuses a different key for an install (409 KEY_CONFLICT) so a leaked room JWT cannot re-key a Mac. This is the only thing that lifts that, and only
 * for one install, for REKEY_WINDOW_HOURS, once: register.ts clears the approval in the same statement that swaps the device. Retired installs and installs with
 * no active fleet device cannot be approved. Both the approval and its audit rows are written by ONE statement, so there is no approval without an audit row.
 */
import type { FleetSql } from "./device-auth";

export const REKEY_WINDOW_HOURS = 2;
export const REKEY_REASON_MAX = 200;

export type AllowRekeyResult =
  | { ok: true; install_id: string; allowed_until: string; allowed_by: string }
  | { ok: false; status: 400 | 404 | 409; code: "BAD_ARGS" | "NOT_FOUND" | "RETIRED" | "NOTHING_TO_REKEY" };

/** PURE. The body is `{reason: string}`, 1..200 characters, no control characters. */
export function parseAllowRekeyBody(raw: unknown): { ok: true; reason: string } | { ok: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const r = (raw as Record<string, unknown>).reason;
  if (typeof r !== "string" || r.trim().length < 1 || r.length > REKEY_REASON_MAX || /[\u0000-\u001f]/.test(r)) return { ok: false };
  return { ok: true, reason: r.trim() };
}

export async function allowRekey(sql: FleetSql, input: { installId: string; actor: string; reason: string }): Promise<AllowRekeyResult> {
  const { installId, actor, reason } = input;
  const inst = (await sql`
    SELECT room_id, retired_at,
           EXISTS (SELECT 1 FROM fleet_devices d WHERE d.install_id = ${installId} AND d.status = 'active') AS has_active
      FROM room_install WHERE install_id = ${installId}
  `) as Array<{ room_id: string; retired_at: unknown; has_active: boolean }>;
  const i = inst[0];
  if (!i) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (i.retired_at) return { ok: false, status: 409, code: "RETIRED" };
  if (!i.has_active) return { ok: false, status: 409, code: "NOTHING_TO_REKEY" };

  // The guards are repeated in the UPDATE: a retire or revoke between the read above and here leaves zero rows, and zero rows is a refusal.
  const done = (await sql`
    WITH up AS (
      UPDATE room_install
         SET rekey_allowed_until = now() + make_interval(hours => ${REKEY_WINDOW_HOURS}::int), rekey_allowed_by = ${actor}
       WHERE install_id = ${installId} AND retired_at IS NULL
         AND EXISTS (SELECT 1 FROM fleet_devices d WHERE d.install_id = ${installId} AND d.status = 'active')
   RETURNING install_id, room_id, rekey_allowed_by, to_char(rekey_allowed_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS until_iso
    ), aud AS (
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      SELECT 'admin'::actor_type, ${actor}::text, 'install.allow_rekey', 'room_install', up.install_id,
             jsonb_build_object('install_id', up.install_id, 'room_id', up.room_id, 'actor', ${actor}::text, 'reason', ${reason}::text, 'until', up.until_iso)
        FROM up
   RETURNING 1
    ), faud AS (
      INSERT INTO fleet_audit (actor, action, summary)
      SELECT ${`admin:${actor}`}::text, 'fleet_rekey_allowed', 'install ' || up.install_id || ' re-key approved until ' || up.until_iso FROM up
   RETURNING 1
    )
    SELECT up.install_id, up.rekey_allowed_by, up.until_iso FROM up
  `) as Array<{ install_id: string; rekey_allowed_by: string; until_iso: string }>;
  const row = done[0];
  if (!row) return { ok: false, status: 409, code: "NOTHING_TO_REKEY" };
  return { ok: true, install_id: row.install_id, allowed_until: row.until_iso, allowed_by: row.rekey_allowed_by };
}
