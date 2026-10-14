/**
 * lib/fleet/rekey.ts — the operator's one-time approval to re-key an install, and its written reversal (gating/fleet-rekey, migration 0167).
 *
 * register.ts refuses a different key for an install (409 KEY_CONFLICT) so a leaked room JWT cannot re-key a Mac. This is the only thing that lifts that, and only
 * for ONE install AND ONE key fingerprint (pk = base64url SHA-256 of the raw 32-byte key, the proof's `pk` claim), for REKEY_WINDOW_HOURS, once: register.ts marks the
 * approval used in the same statement that swaps the device. The operator learns the fingerprint from fleet_rekey_attempt, which register.ts writes on every
 * KEY_CONFLICT; an approval for a fingerprint never seen for that install is refused (409 UNKNOWN_FINGERPRINT). Retired installs and installs with no active fleet
 * device cannot be approved. Each action is ONE statement: the change and its audit rows (audit_log + fleet_audit) land together or not at all.
 */
import { randomBytes } from "node:crypto";
import type { FleetSql } from "./device-auth";

export const REKEY_WINDOW_HOURS = 2;
export const REKEY_REASON_MAX = 200;
export const REKEY_ATTEMPTS_KEPT_PER_INSTALL = 20;
const FP = /^[A-Za-z0-9_-]{43}$/;

export type RekeyError = { ok: false; status: 404 | 409; code: "NOT_FOUND" | "RETIRED" | "NOTHING_TO_REKEY" | "UNKNOWN_FINGERPRINT" | "NOT_UNDOABLE" };
export type AllowRekeyResult = { ok: true; approval_id: string; install_id: string; pk_fingerprint: string; expires_at: string; approved_by: string } | RekeyError;
export type UndoRekeyResult = { ok: true; approval_id: string; install_id: string; restored_device_id: string; retired_device_id: string } | RekeyError;

const reasonOk = (r: unknown): r is string => typeof r === "string" && r.trim().length >= 1 && r.length <= REKEY_REASON_MAX && !/[\u0000-\u001f]/.test(r);

/** PURE. `{pk_fingerprint, reason}`. */
export function parseAllowRekeyBody(raw: unknown): { ok: true; pk_fingerprint: string; reason: string } | { ok: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const b = raw as Record<string, unknown>;
  if (typeof b.pk_fingerprint !== "string" || !FP.test(b.pk_fingerprint) || !reasonOk(b.reason)) return { ok: false };
  return { ok: true, pk_fingerprint: b.pk_fingerprint, reason: b.reason.trim() };
}

/** PURE. `{approval_id, reason}`. */
export function parseUndoRekeyBody(raw: unknown): { ok: true; approval_id: string; reason: string } | { ok: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const b = raw as Record<string, unknown>;
  if (typeof b.approval_id !== "string" || !/^rka_[a-f0-9]{24}$/.test(b.approval_id) || !reasonOk(b.reason)) return { ok: false };
  return { ok: true, approval_id: b.approval_id, reason: b.reason.trim() };
}

/** Record a refused key (register.ts calls this on every KEY_CONFLICT). One row per (install, fingerprint); only the newest REKEY_ATTEMPTS_KEPT_PER_INSTALL rows per install are kept. */
export async function recordRekeyAttempt(sql: FleetSql, installId: string, pkFingerprint: string): Promise<void> {
  await sql`
    INSERT INTO fleet_rekey_attempt (install_id, pk_fingerprint) VALUES (${installId}, ${pkFingerprint})
    ON CONFLICT (install_id, pk_fingerprint) DO UPDATE SET last_seen_at = now(), attempts = fleet_rekey_attempt.attempts + 1
  `;
  await sql`
    DELETE FROM fleet_rekey_attempt
     WHERE install_id = ${installId}
       AND pk_fingerprint NOT IN (SELECT pk_fingerprint FROM fleet_rekey_attempt WHERE install_id = ${installId} ORDER BY last_seen_at DESC, pk_fingerprint LIMIT ${REKEY_ATTEMPTS_KEPT_PER_INSTALL}::int)
  `;
}

export async function allowRekey(sql: FleetSql, input: { installId: string; pkFingerprint: string; actor: string; reason: string }): Promise<AllowRekeyResult> {
  const { installId, pkFingerprint: fp, actor, reason } = input;
  const inst = (await sql`
    SELECT retired_at,
           EXISTS (SELECT 1 FROM fleet_devices d WHERE d.install_id = ${installId} AND d.status = 'active') AS has_active,
           EXISTS (SELECT 1 FROM fleet_rekey_attempt a WHERE a.install_id = ${installId} AND a.pk_fingerprint = ${fp}) AS seen
      FROM room_install WHERE install_id = ${installId}
  `) as Array<{ retired_at: unknown; has_active: boolean; seen: boolean }>;
  const i = inst[0];
  if (!i) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (i.retired_at) return { ok: false, status: 409, code: "RETIRED" };
  if (!i.has_active) return { ok: false, status: 409, code: "NOTHING_TO_REKEY" };
  if (!i.seen) return { ok: false, status: 409, code: "UNKNOWN_FINGERPRINT" };

  const approvalId = `rka_${randomBytes(12).toString("hex")}`;
  // The guards are repeated in the statement: a retire or revoke between the read above and here inserts nothing, and nothing is a refusal.
  const done = (await sql`
    WITH chk AS (
      SELECT i.room_id FROM room_install i
       WHERE i.install_id = ${installId} AND i.retired_at IS NULL
         AND EXISTS (SELECT 1 FROM fleet_devices d WHERE d.install_id = ${installId} AND d.status = 'active')
         AND EXISTS (SELECT 1 FROM fleet_rekey_attempt a WHERE a.install_id = ${installId} AND a.pk_fingerprint = ${fp})
    ), ins AS (
      INSERT INTO fleet_rekey_approval (approval_id, install_id, pk_fingerprint, approved_by, reason, expires_at)
      SELECT ${approvalId}, ${installId}, ${fp}, ${actor}::text, ${reason}::text, now() + make_interval(hours => ${REKEY_WINDOW_HOURS}::int) FROM chk
   RETURNING approval_id, install_id, pk_fingerprint, approved_by, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_iso
    ), aud AS (
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      SELECT 'admin'::actor_type, ${actor}::text, 'install.allow_rekey', 'room_install', ins.install_id,
             jsonb_build_object('who', ${actor}::text, 'install_id', ins.install_id, 'pk_fingerprint', ins.pk_fingerprint, 'approval_id', ins.approval_id,
                                'reason', ${reason}::text, 'expires_at', ins.expires_iso, 'outcome', 'approved')
        FROM ins
   RETURNING 1
    ), faud AS (
      INSERT INTO fleet_audit (actor, action, summary)
      SELECT ${`admin:${actor}`}::text, 'fleet_rekey_allowed', 'install ' || ins.install_id || ' fingerprint ' || ins.pk_fingerprint || ' approval ' || ins.approval_id || ' until ' || ins.expires_iso || ' outcome approved' FROM ins
   RETURNING 1
    )
    SELECT approval_id, install_id, pk_fingerprint, approved_by, expires_iso FROM ins
  `) as Array<{ approval_id: string; install_id: string; pk_fingerprint: string; approved_by: string; expires_iso: string }>;
  const row = done[0];
  if (!row) return { ok: false, status: 409, code: "NOTHING_TO_REKEY" };
  return { ok: true, approval_id: row.approval_id, install_id: row.install_id, pk_fingerprint: row.pk_fingerprint, expires_at: row.expires_iso, approved_by: row.approved_by };
}

/**
 * The written reversal. In ONE statement: the new row goes 'retired' (retired_at), then the rotated row goes back to 'active', then the approval records outcome
 * 'undone'. The order matters to the partial unique index and is enforced by data dependency between the sub-statements. Refused unless the approval ended 'rekeyed' and
 * the new device is still the install's active one (a revoked successor is not undone) and the old row is still 'rotated'. Nothing is deleted.
 */
export async function undoRekey(sql: FleetSql, input: { installId: string; approvalId: string; actor: string; reason: string }): Promise<UndoRekeyResult> {
  const { installId, approvalId, actor, reason } = input;
  const a = (await sql`
    SELECT a.old_device_id, a.new_device_id, a.outcome, a.pk_fingerprint, ri.retired_at
      FROM fleet_rekey_approval a LEFT JOIN room_install ri ON ri.install_id = a.install_id
     WHERE a.approval_id = ${approvalId} AND a.install_id = ${installId}
  `) as Array<{ old_device_id: string | null; new_device_id: string | null; outcome: string | null; pk_fingerprint: string; retired_at: unknown }>;
  const r = a[0];
  if (!r) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (r.retired_at) return { ok: false, status: 409, code: "RETIRED" };
  if (r.outcome !== "rekeyed" || !r.old_device_id || !r.new_device_id) return { ok: false, status: 409, code: "NOT_UNDOABLE" };

  const done = (await sql`
    WITH nw AS (
      UPDATE fleet_devices SET status = 'retired', retired_at = now()
       WHERE device_id = ${r.new_device_id} AND install_id = ${installId} AND status = 'active'
         AND EXISTS (SELECT 1 FROM fleet_rekey_approval x WHERE x.approval_id = ${approvalId} AND x.outcome = 'rekeyed')
         AND EXISTS (SELECT 1 FROM fleet_devices o WHERE o.device_id = ${r.old_device_id} AND o.status = 'rotated')
   RETURNING device_id
    ), old AS (
      UPDATE fleet_devices SET status = 'active'
       WHERE device_id = ${r.old_device_id} AND install_id = ${installId} AND status = 'rotated' AND EXISTS (SELECT 1 FROM nw)
   RETURNING device_id
    ), apr AS (
      UPDATE fleet_rekey_approval SET outcome = 'undone', undone_at = now(), undone_by = ${actor}::text
       WHERE approval_id = ${approvalId} AND outcome = 'rekeyed' AND EXISTS (SELECT 1 FROM old)
   RETURNING approval_id
    ), aud AS (
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      SELECT 'admin'::actor_type, ${actor}::text, 'install.undo_rekey', 'room_install', ${installId},
             jsonb_build_object('who', ${actor}::text, 'install_id', ${installId}::text, 'pk_fingerprint', ${r.pk_fingerprint}::text, 'approval_id', apr.approval_id,
                                'restored_device_id', ${r.old_device_id}::text, 'retired_device_id', ${r.new_device_id}::text, 'reason', ${reason}::text, 'outcome', 'undone')
        FROM apr
   RETURNING 1
    ), faud AS (
      INSERT INTO fleet_audit (actor, action, summary)
      SELECT ${`admin:${actor}`}::text, 'fleet_rekey_undone', 'install ' || ${installId}::text || ' fingerprint ' || ${r.pk_fingerprint}::text || ' approval ' || apr.approval_id || ' restored ' || ${r.old_device_id}::text || ' retired ' || ${r.new_device_id}::text || ' outcome undone' FROM apr
   RETURNING 1
    )
    SELECT approval_id FROM apr
  `) as Array<{ approval_id: string }>;
  if (!done[0]) return { ok: false, status: 409, code: "NOT_UNDOABLE" };
  return { ok: true, approval_id: approvalId, install_id: installId, restored_device_id: r.old_device_id, retired_device_id: r.new_device_id };
}
