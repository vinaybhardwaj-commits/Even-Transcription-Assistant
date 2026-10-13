/**
 * lib/buddy/relay.ts — Encounter Buddy L1: relay a consult's open and close from the presence ingest to the room recorder.
 *
 * POST /api/presence calls `relayInserted(rows)` AFTER its insert. For each landed row whose event is `encounter_open` or
 * `encounter_close` and whose payload carries a non-null encounter_id (the consult_uid), this file:
 *   - open:  INSERT a buddy_consult_ref row (opaque_id = 32 hex); only if THIS call created it, enqueue `consult_started`.
 *   - close: UPDATE closed_at on the open row; only if a row was updated, enqueue `consult_ended`.
 * The command args are `{ opaque_id }` and nothing else. consult_uid, doctor_uid and prescription ids never go to the recorder.
 *
 * GATE. env BUDDY_RELAY_ROOMS = comma list of recorder room_ids. Unset or empty = off: no read, no write.
 * ROOM MAPPING. The presence row's `machine` (normalised hostname) is matched to the ACTIVE room_install.hostname of a gated
 * room (the same mapping lib/fleet-attention.ts uses). No new mapping table, no env map.
 * VERSION FLOOR. A room whose app is below VERBS_MIN_APP_VERSION (0.1.22) gets nothing: an older app cannot decode a new kind.
 * Same floor the native verbs use; at or above it an app that does not know the kind acks `unsupported_kind` and polls on.
 *
 * NEVER AFFECTS THE INGEST. relayInserted never throws and never takes longer than RELAY_TIMEOUT_MS; failures are logged as
 * counts only (no ids, no machine names).
 */
import { randomBytes } from "crypto";
import { sql } from "@/lib/db";
import { normalizeHostname } from "@/lib/encounter-windows/types";
import { appVersionAtLeast, insertCommand, VERBS_MIN_APP_VERSION } from "@/lib/bench-commands";
import type { PresenceRow } from "@/lib/presence-ingest";

export const RELAY_TIMEOUT_MS = 2000;

export type RelayOutcome = "sent" | "duplicate" | "skipped";

/** The gated room ids, or [] when the relay is off. */
export function relayRooms(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.BUDDY_RELAY_ROOMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

const consultUidOf = (row: PresenceRow): string | null => {
  const id = row.payload?.encounter_id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/** Gated room for this machine (and whether its app can take the kind), or null. */
async function resolveRoom(machine: string | null, gate: string[]): Promise<string | null> {
  if (!machine) return null;
  const rows = (await sql`
    SELECT room_id, hostname, app_version
      FROM room_install
     WHERE room_id = ANY(${gate}::text[]) AND retired_at IS NULL AND enrolled_at IS NOT NULL
  `) as Array<{ room_id: string; hostname: string | null; app_version: string | null }>;
  const want = normalizeHostname(machine);
  const hit = rows.find((r) => r.hostname && normalizeHostname(r.hostname) === want);
  if (!hit || !appVersionAtLeast(hit.app_version, VERBS_MIN_APP_VERSION)) return null;
  return hit.room_id;
}

/** One landed presence row. Throws on a database fault; relayInserted catches. */
export async function relayConsultEvent(row: PresenceRow): Promise<RelayOutcome> {
  if (row.event !== "encounter_open" && row.event !== "encounter_close") return "skipped";
  const consultUid = consultUidOf(row);
  if (!consultUid) return "skipped";
  const gate = relayRooms();
  if (gate.length === 0) return "skipped";
  const roomId = await resolveRoom(row.machine, gate);
  if (!roomId) return "skipped";

  if (row.event === "encounter_open") {
    const opaqueId = randomBytes(16).toString("hex");
    const made = (await sql`
      INSERT INTO buddy_consult_ref (opaque_id, consult_uid, room_id, doctor_uid, opened_at)
      VALUES (${opaqueId}, ${consultUid}, ${roomId}, ${null}, ${row.ts}::timestamptz)
      ON CONFLICT (consult_uid) DO NOTHING
      RETURNING opaque_id
    `) as Array<{ opaque_id: string }>;
    if (made.length === 0) return "duplicate";
    await insertCommand({ roomId, kind: "consult_started", args: { opaque_id: made[0]!.opaque_id }, source: "buddy" });
    return "sent";
  }

  const closed = (await sql`
    UPDATE buddy_consult_ref
       SET closed_at = ${row.ts}::timestamptz
     WHERE consult_uid = ${consultUid} AND closed_at IS NULL
    RETURNING opaque_id
  `) as Array<{ opaque_id: string }>;
  if (closed.length === 0) return "duplicate";
  await insertCommand({ roomId, kind: "consult_ended", args: { opaque_id: closed[0]!.opaque_id }, source: "buddy" });
  return "sent";
}

/**
 * Relay every landed row, one at a time, under one hard timeout. Never throws. Returns nothing the caller may use:
 * the ingest's response, status and counts do not depend on this.
 */
export async function relayInserted(rows: PresenceRow[]): Promise<void> {
  try {
    if (relayRooms().length === 0) return;
    const todo = rows.filter((r) => (r.event === "encounter_open" || r.event === "encounter_close") && consultUidOf(r));
    if (todo.length === 0) return;
    const counts = { sent: 0, duplicate: 0, skipped: 0, failed: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      for (const r of todo) {
        try {
          counts[await relayConsultEvent(r)]++;
        } catch {
          counts.failed++;
        }
      }
    })();
    const outcome = await Promise.race([
      work.then(() => "done" as const),
      new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), RELAY_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout" || counts.failed > 0) {
      console.warn(`[buddy-relay] ${outcome === "timeout" ? "timeout" : "fault"}: items=${todo.length} sent=${counts.sent} duplicate=${counts.duplicate} skipped=${counts.skipped} failed=${counts.failed}`);
    }
  } catch {
    console.warn("[buddy-relay] fault: relay aborted");
  }
}
