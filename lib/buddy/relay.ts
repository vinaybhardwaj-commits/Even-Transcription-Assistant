/**
 * lib/buddy/relay.ts — Encounter Buddy L1: relay a consult's open and close from the presence ingest to the room recorder.
 *
 * POST /api/presence calls `relayInserted(rows)` AFTER its insert. For each landed row whose event is `encounter_open` or
 * `encounter_close` and whose payload carries a non-null encounter_id (the consult_uid), this file:
 *   - open:  INSERT a buddy_consult_ref row (opaque_id = 32 hex); only if THIS call created it, enqueue `consult_started`.
 *   - close: UPDATE closed_at on the open row; only if a row was updated, enqueue `consult_ended`.
 * The ref row and its command land in ONE statement. The command args are `{ opaque_id }` and nothing else. Only source 'ext' rows, only events
 * within MAX_AGE_MS / MAX_FUTURE_MS of server time, and only a non-blank encounter_id. consult_uid, doctor_uid and prescription ids never go to the recorder.
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
import { appVersionAtLeast, newCommandId, VERBS_MIN_APP_VERSION } from "@/lib/bench-commands";
import type { PresenceRow } from "@/lib/presence-ingest";

export const RELAY_TIMEOUT_MS = 2000;

export type RelayOutcome = "sent" | "duplicate" | "skipped";

/** The gated room ids, or [] when the relay is off. */
export function relayRooms(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.BUDDY_RELAY_ROOMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}


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

/** Producers' clocks: an event older than this, or further ahead than the skew allowance, is not a live consult edge. */
export const MAX_AGE_MS = 120_000;
export const MAX_FUTURE_MS = 30_000;

const consultUidOf = (row: PresenceRow): string | null => {
  const id = row.payload?.encounter_id;
  if (typeof id !== "string") return null;
  const t = id.trim();
  return t.length > 0 ? t : null;
};

function fresh(ts: string, now: number): boolean {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return now - t <= MAX_AGE_MS && t - now <= MAX_FUTURE_MS;
}

/**
 * One landed presence row. Throws on a database fault; relayInserted catches.
 * `deadline` (epoch ms) is the one budget for the whole batch: it is checked before the room read and again before the write,
 * so nothing is written once the cap has passed. The ref row and its command are ONE statement (a data-modifying CTE): both land or neither does.
 */
export async function relayConsultEvent(row: PresenceRow, deadline: number = Date.now() + RELAY_TIMEOUT_MS): Promise<RelayOutcome> {
  if (row.source !== "ext") return "skipped";
  if (row.event !== "encounter_open" && row.event !== "encounter_close") return "skipped";
  const consultUid = consultUidOf(row);
  if (!consultUid) return "skipped";
  if (!fresh(row.ts, Date.now())) return "skipped";
  const gate = relayRooms();
  if (gate.length === 0) return "skipped";
  if (Date.now() >= deadline) return "skipped";
  const roomId = await resolveRoom(row.machine, gate);
  if (!roomId) return "skipped";
  if (Date.now() >= deadline) return "skipped";

  const cmdId = newCommandId();
  if (row.event === "encounter_open") {
    const opaqueId = randomBytes(16).toString("hex");
    const made = (await sql`
      WITH made AS (
        INSERT INTO buddy_consult_ref (opaque_id, consult_uid, room_id, doctor_uid, opened_at)
        VALUES (${opaqueId}, ${consultUid}, ${roomId}, ${null}, ${row.ts}::timestamptz)
        ON CONFLICT (consult_uid) DO NOTHING
        RETURNING opaque_id, room_id
      )
      INSERT INTO bench_command (id, room_id, kind, args, status, source)
      SELECT ${cmdId}::text, room_id, 'consult_started', jsonb_build_object('opaque_id', opaque_id), 'pending', 'buddy' FROM made
      RETURNING id
    `) as Array<{ id: string }>;
    return made.length === 0 ? "duplicate" : "sent";
  }

  // The command goes to the room stored on the ref row, not to the room of the machine that closed it.
  const closed = (await sql`
    WITH closed AS (
      UPDATE buddy_consult_ref
         SET closed_at = ${row.ts}::timestamptz
       WHERE consult_uid = ${consultUid} AND closed_at IS NULL
      RETURNING opaque_id, room_id
    )
    INSERT INTO bench_command (id, room_id, kind, args, status, source)
    SELECT ${cmdId}::text, room_id, 'consult_ended', jsonb_build_object('opaque_id', opaque_id), 'pending', 'buddy' FROM closed
    RETURNING id
  `) as Array<{ id: string }>;
  return closed.length === 0 ? "duplicate" : "sent";
}

/**
 * Relay every landed row, one at a time, under one hard timeout. Never throws. Returns nothing the caller may use:
 * the ingest's response, status and counts do not depend on this.
 */
export async function relayInserted(rows: PresenceRow[]): Promise<void> {
  try {
    if (relayRooms().length === 0) return;
    const todo = rows.filter((r) => r.source === "ext" && (r.event === "encounter_open" || r.event === "encounter_close") && consultUidOf(r));
    if (todo.length === 0) return;
    const deadline = Date.now() + RELAY_TIMEOUT_MS;
    const counts = { sent: 0, duplicate: 0, skipped: 0, failed: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      for (const r of todo) {
        try {
          counts[await relayConsultEvent(r, deadline)]++;
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
