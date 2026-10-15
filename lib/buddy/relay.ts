/**
 * lib/buddy/relay.ts — Encounter Buddy L1: relay a consult's open and close from the presence ingest to the room recorder.
 *
 * POST /api/presence calls `relayInserted(rows)` AFTER its insert. For each landed row whose event is `encounter_open` or
 * `encounter_close` and whose payload carries a non-null encounter_id (the consult_uid), this file:
 *   - open:  INSERT a buddy_consult_ref row (opaque_id = 32 hex); only if THIS call created it, enqueue `consult_started`.
 *   - close: UPDATE closed_at on the open row; only if a row was updated, enqueue `consult_ended`.
 * DECIDE (A2-C5, fail closed). On open, after every gate below passes, the relay mints the opaque_id and asks newcat (POST NEWCAT_BASE_URL + DECIDE_PATH = /v1/buddy/consult-started, scope buddy.relay, Bearer NEWCAT_RELAY_KEY,
 * body {opaque_id, consult_uid, room, doctor_uid|null}, reply {window, live, reason_code}) whether a window may open. Only window:true writes the ref row and the command.
 * window:false, a timeout (DECIDE_TIMEOUT_MS), a non-2xx, an unparseable reply, or an unset NEWCAT_BASE_URL / NEWCAT_RELAY_KEY writes nothing. Logs carry
 * the counts decide_true / decide_false / decide_fault only. consult_ended is unchanged: a close with no ref row writes nothing.
 * The ref row and its command land in ONE statement. The command args are `{ opaque_id }` and nothing else. Only source 'ext' rows, only events
 * within MAX_AGE_MS / MAX_FUTURE_MS of server time, and only a non-blank encounter_id. consult_uid, doctor_uid and prescription ids never go to the recorder.
 *
 * DOCTOR. A missing or blank payload doctor_uid is resolved from the warehouse by consult_uid (exact; one distinct doctor_uid or null), capped at
 * DOCTOR_RESOLVE_TIMEOUT_MS inside the same relay budget; off/fault = null = unchanged fail-closed. The room hint (last_doctor_uid) is only counted.
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
import { metabaseQuery } from "@/lib/metabase";

export const RELAY_TIMEOUT_MS = 2000;
/** newcat's mint route. One constant, so the final route name is a one-line change. */
export const DECIDE_PATH = "/v1/buddy/consult-started";
export const DECIDE_TIMEOUT_MS = 1200;

/** Wire body to newcat (scope buddy.relay): the room goes under the key `room`. */
export type DecideRequest = { opaque_id: string; consult_uid: string; room: string; doctor_uid: string | null };
export type DecideReply = { window: boolean; live: boolean };
/** Resolves window true/false (a bare boolean, or {window, live}); throws on anything else (a 409, non-2xx, bad shape: the caller counts decide_fault). */
export type DecideClient = (req: DecideRequest) => Promise<boolean | DecideReply>;

/** The real client. Values come from env only (NEWCAT_BASE_URL, NEWCAT_RELAY_KEY); unset = throws = fail closed. */
export const defaultDecide: DecideClient = async (req) => {
  const base = (process.env.NEWCAT_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.NEWCAT_RELAY_KEY ?? "").trim();
  if (!base || !key) throw new Error("decide_not_configured");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DECIDE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${DECIDE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(req),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error("decide_non_2xx");
    const j = (await res.json()) as { window?: unknown; live?: unknown; reason_code?: unknown };
    if (typeof j?.window !== "boolean" || typeof j?.live !== "boolean" || typeof j?.reason_code !== "string") throw new Error("decide_unparseable");
    return { window: j.window, live: j.live };
  } finally {
    clearTimeout(timer);
  }
};

/** The resolve shares the 2 s relay budget and is capped here, so the decide call keeps its time. */
export const DOCTOR_RESOLVE_TIMEOUT_MS = 700;
/** A consult_uid is inlined into the Metabase statement (the endpoint takes no bound parameters), so it must match this first. */
const SAFE_CONSULT_UID = /^[a-z0-9]{20,32}$/;
const SAFE_DOCTOR_UID = /^[A-Za-z0-9_-]{1,128}$/;
/** Thrown by the resolver when METABASE_URL or METABASE_API_KEY is unset. Counted as doctor_resolve_off, not as a fault. */
export const DOCTOR_RESOLVE_OFF = "doctor_resolve_off";
/** Thrown by the resolver when consult_uid fails SAFE_CONSULT_UID: no Metabase call is made. Counted as doctor_resolve_unsafe_uid. */
export const DOCTOR_RESOLVE_UNSAFE = "doctor_resolve_unsafe_uid";

/**
 * Resolves the one exact doctor_uid, or null (zero rows, or several distinct rows). Throws on a fault, when off, or
 * DOCTOR_RESOLVE_UNSAFE for an unsafe consult_uid. `signal` is aborted by the caller when the time cap is lost.
 */
export type DoctorResolver = (consultUid: string, signal?: AbortSignal) => Promise<string | null>;

/**
 * Exact lookup in the Pulse warehouse (db13 through Metabase) on the consult record: accounts-members-calendar_events.uid = consult_uid,
 * whose doctor_uid is set at booking. By consult_uid only. Never uses the room's last_doctor_uid hint.
 * Exactly one distinct doctor_uid = that uid; anything else = null.
 */
export const defaultDoctorResolve: DoctorResolver = async (consultUid, signal) => {
  if (!(process.env.METABASE_URL ?? "").trim() || !(process.env.METABASE_API_KEY ?? "").trim()) throw new Error(DOCTOR_RESOLVE_OFF);
  if (!SAFE_CONSULT_UID.test(consultUid)) throw new Error(DOCTOR_RESOLVE_UNSAFE);
  const rows = await metabaseQuery(`SELECT doctor_uid FROM "accounts-members-calendar_events" WHERE uid = '${consultUid}'`, { signal });
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r?.doctor_uid;
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length > 0) seen.add(t);
  }
  if (seen.size !== 1) return null;
  const only = Array.from(seen)[0]!;
  return SAFE_DOCTOR_UID.test(only) ? only : null;
};

/** Counts for the doctor resolve. Counts only, never a uid. */
export type DoctorCounts = {
  doctor_resolve_off: number;
  doctor_resolve_fault: number;
  doctor_hint_would_help: number;
  doctor_resolve_unsafe_uid: number;
  doctor_resolve_null: number;
};

/** Counts for the log line. */
export type DecideCounts = { decide_true: number; decide_false: number; decide_fault: number; decide_live?: number };

export type RelayOutcome = "sent" | "duplicate" | "skipped" | "decide_false" | "decide_fault";

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

/** The 0.1.3 hint. Counted when it would have helped; never used for the decision (A2-C1). */
const hintOf = (row: PresenceRow): boolean => {
  const id = row.payload?.last_doctor_uid;
  return typeof id === "string" && id.trim().length > 0;
};

const doctorUidOf = (row: PresenceRow): string | null => {
  const id = row.payload?.doctor_uid;
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
export async function relayConsultEvent(
  row: PresenceRow,
  deadline: number = Date.now() + RELAY_TIMEOUT_MS,
  decide: DecideClient = defaultDecide,
  tally?: DecideCounts,
  resolveDoctor: DoctorResolver = defaultDoctorResolve,
  dtally?: DoctorCounts,
): Promise<RelayOutcome> {
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
    // A repeat open for a consult that already has a ref row never asks newcat again.
    const known = (await sql`SELECT 1 AS one FROM buddy_consult_ref WHERE consult_uid = ${consultUid} LIMIT 1`) as unknown[];
    if (known.length > 0) return "duplicate";
    if (Date.now() >= deadline) return "skipped";
    let doctorUid = doctorUidOf(row);
    if (!doctorUid) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ctl = new AbortController();
      try {
        const cap = Math.min(DOCTOR_RESOLVE_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
        doctorUid = await Promise.race([
          resolveDoctor(consultUid, ctl.signal),
          // Race lost: abort the in-flight Metabase fetch, then reject.
          new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error("doctor_resolve_timeout")); }, cap); }),
        ]);
        if (doctorUid === null && dtally) dtally.doctor_resolve_null++;
        if (doctorUid === null && hintOf(row) && dtally) dtally.doctor_hint_would_help++;
      } catch (e) {
        doctorUid = null;
        if (dtally) {
          const m = (e as Error)?.message;
          if (m === DOCTOR_RESOLVE_OFF) dtally.doctor_resolve_off++;
          else if (m === DOCTOR_RESOLVE_UNSAFE) dtally.doctor_resolve_unsafe_uid++;
          else dtally.doctor_resolve_fault++;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (Date.now() >= deadline) return "skipped";
    }
    let window: boolean;
    try {
      const reply = await decide({ opaque_id: opaqueId, consult_uid: consultUid, room: roomId, doctor_uid: doctorUid });
      window = typeof reply === "boolean" ? reply : reply.window === true;
      if (typeof reply !== "boolean" && reply.window === true && reply.live === true && tally) tally.decide_live = (tally.decide_live ?? 0) + 1;
    } catch {
      if (tally) tally.decide_fault++;
      return "decide_fault";
    }
    if (!window) {
      if (tally) tally.decide_false++;
      return "decide_false";
    }
    if (tally) tally.decide_true++;
    if (Date.now() >= deadline) return "skipped";
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
export async function relayInserted(rows: PresenceRow[], decide: DecideClient = defaultDecide, resolveDoctor: DoctorResolver = defaultDoctorResolve): Promise<void> {
  try {
    if (relayRooms().length === 0) return;
    const todo = rows.filter((r) => r.source === "ext" && (r.event === "encounter_open" || r.event === "encounter_close") && consultUidOf(r));
    if (todo.length === 0) return;
    const deadline = Date.now() + RELAY_TIMEOUT_MS;
    const counts = { sent: 0, duplicate: 0, skipped: 0, failed: 0, decide_false: 0, decide_fault: 0 };
    const tally: DecideCounts = { decide_true: 0, decide_false: 0, decide_fault: 0, decide_live: 0 };
    const dtally: DoctorCounts = { doctor_resolve_off: 0, doctor_resolve_fault: 0, doctor_hint_would_help: 0, doctor_resolve_unsafe_uid: 0, doctor_resolve_null: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      for (const r of todo) {
        try {
          counts[await relayConsultEvent(r, deadline, decide, tally, resolveDoctor, dtally)]++;
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
    if (tally.decide_true + tally.decide_false + tally.decide_fault > 0) {
      console.info(`[buddy-relay] decide: decide_true=${tally.decide_true} decide_false=${tally.decide_false} decide_fault=${tally.decide_fault} decide_live=${tally.decide_live}`);
    }
    if (dtally.doctor_resolve_off + dtally.doctor_resolve_fault + dtally.doctor_hint_would_help + dtally.doctor_resolve_unsafe_uid + dtally.doctor_resolve_null > 0) {
      console.info(`[buddy-relay] doctor: doctor_resolve_off=${dtally.doctor_resolve_off} doctor_resolve_fault=${dtally.doctor_resolve_fault} doctor_hint_would_help=${dtally.doctor_hint_would_help} doctor_resolve_unsafe_uid=${dtally.doctor_resolve_unsafe_uid} doctor_resolve_null=${dtally.doctor_resolve_null}`);
    }
    if (outcome === "timeout" || counts.failed > 0) {
      console.warn(`[buddy-relay] ${outcome === "timeout" ? "timeout" : "fault"}: items=${todo.length} sent=${counts.sent} duplicate=${counts.duplicate} skipped=${counts.skipped} failed=${counts.failed} decide_false=${counts.decide_false} decide_fault=${counts.decide_fault}`);
    }
  } catch {
    console.warn("[buddy-relay] fault: relay aborted");
  }
}
