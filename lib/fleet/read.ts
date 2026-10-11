/**
 * lib/fleet/read.ts — read-only views of the fleet control plane for Bench and the MCP door (TS-H13 #50). Counts, ids, states, outcomes and timings only:
 * never a signature, nonce, public key, token or result `detail` (the closed per-verb object stays in the database).
 */
import type { FleetSql } from "./device-auth";
import { helperAttention, readHelperHeartbeats, signalsFor, type HelperHealth } from "./helper-health";

export const COMMANDS_PER_DEVICE = 20;
export const MAX_DEVICES = 60;

export type DeviceView = {
  device_id: string; room_id: string; room_name: string | null; machine: string; status: string; helper_version: string | null;
  registered_at: string | null; last_poll_at: string | null; last_poll_age_s: number | null;
  commands: { queued: number; delivered: number; done: number; expired: number };
  /** TS-H9/H6: what the helper's own heartbeat says (sanitised), read-only. Null health = no heartbeat in 24 h. */
  helper: {
    heartbeat_age_s: number | null;
    health: HelperHealth | null;
    /** bench poll age of the room's recorder app, for context */
    bench_age_s: number | null;
    /** the #46 attention rule that holds right now, if any (app_missing / helper_missing) */
    attention: { kind: "app_missing" | "helper_missing"; severity: "red" | "amber"; detail: string } | null;
  };
};
export type CommandView = {
  cmd_id: string; device_id: string; verb: string; params: Record<string, unknown>; state: string; issued_at: string; expires_at: string;
  issuer_kind: string; issuer_id: string; has_approval_ref: boolean; key_id: string; delivery_count: number;
  outcome: string | null; reason: string | null; finished_at: string | null; has_upload: boolean;
};


export async function fleetDevices(sql: FleetSql, roomId: string | null = null, nowMs: number = Date.now()): Promise<DeviceView[]> {
  const rows = (await sql`
    SELECT d.device_id, ri.hostname,
           to_char(ri.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bench_at, d.room_id, r.name AS room_name, d.machine, d.status, d.helper_version,
           to_char(d.registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at,
           to_char(d.last_poll_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_poll_at,
           floor(extract(epoch FROM now() - d.last_poll_at))::int AS last_poll_age_s,
           (SELECT count(*) FROM fleet_commands c WHERE c.device_id = d.device_id AND c.state = 'queued' AND c.expires_at > now())::int AS queued,
           (SELECT count(*) FROM fleet_commands c WHERE c.device_id = d.device_id AND c.state = 'delivered')::int AS delivered,
           (SELECT count(*) FROM fleet_commands c WHERE c.device_id = d.device_id AND c.state = 'done')::int AS done,
           (SELECT count(*) FROM fleet_commands c WHERE c.device_id = d.device_id AND (c.state = 'expired' OR (c.state = 'queued' AND c.expires_at <= now())))::int AS expired
      FROM fleet_devices d
      LEFT JOIN room r ON r.id = d.room_id
      LEFT JOIN room_install ri ON ri.install_id = d.install_id
     WHERE (${roomId}::text IS NULL OR d.room_id = ${roomId}::text)
     ORDER BY r.name NULLS LAST, d.device_id
     LIMIT ${MAX_DEVICES}
  `) as Array<Record<string, unknown>>;
  const heartbeats = await readHelperHeartbeats(sql, rows.map((r) => r.hostname as string | null).filter((h): h is string => typeof h === "string" && h.length > 0), nowMs);
  return rows.map((r) => {
    const hostname = (r.hostname as string | null) ?? null;
    const sig = signalsFor(
      { status: String(r.status), registered_at: (r.registered_at as string | null) ?? null, last_poll_at: (r.last_poll_at as string | null) ?? null },
      hostname, heartbeats, (r.bench_at as string | null) ?? null,
    );
    const att = helperAttention(sig, nowMs, String(r.room_name ?? r.room_id));
    const age = (iso: string | null): number | null => (iso ? Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000)) : null);
    return {
    device_id: String(r.device_id), room_id: String(r.room_id), room_name: (r.room_name as string | null) ?? null, machine: String(r.machine), status: String(r.status),
    helper_version: (r.helper_version as string | null) ?? null, registered_at: (r.registered_at as string | null) ?? null, last_poll_at: (r.last_poll_at as string | null) ?? null,
    last_poll_age_s: r.last_poll_age_s === null || r.last_poll_age_s === undefined ? null : Number(r.last_poll_age_s),
    commands: { queued: Number(r.queued), delivered: Number(r.delivered), done: Number(r.done), expired: Number(r.expired) },
    helper: {
      heartbeat_age_s: age(sig.heartbeat_at), health: sig.heartbeat, bench_age_s: age(sig.bench_at),
      attention: att ? { kind: att.kind, severity: att.severity, detail: att.detail } : null,
    },
    };
  });
}

/** The newest `perDevice` commands of each device (default 20), newest first, each with its result's outcome. Optionally one device. */
export async function fleetCommands(sql: FleetSql, opts: { deviceId?: string | null; roomId?: string | null; perDevice?: number } = {}): Promise<CommandView[]> {
  const per = Math.max(1, Math.min(opts.perDevice ?? COMMANDS_PER_DEVICE, 100));
  const rows = (await sql`
    SELECT * FROM (
      SELECT c.cmd_id, c.device_id, c.verb, c.params, c.state,
             to_char(c.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
             to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
             c.issuer_kind, c.issuer_id, (c.approval_ref IS NOT NULL) AS has_approval_ref, c.key_id, c.delivery_count,
             x.outcome, x.reason, to_char(x.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at, (x.upload_key IS NOT NULL) AS has_upload,
             row_number() OVER (PARTITION BY c.device_id ORDER BY c.issued_at DESC, c.cmd_id DESC) AS rn
        FROM fleet_commands c
        JOIN fleet_devices d ON d.device_id = c.device_id
        LEFT JOIN fleet_results x ON x.cmd_id = c.cmd_id
       WHERE (${opts.deviceId ?? null}::text IS NULL OR c.device_id = ${opts.deviceId ?? null}::text)
         AND (${opts.roomId ?? null}::text IS NULL OR d.room_id = ${opts.roomId ?? null}::text)
    ) q
    WHERE q.rn <= ${per}
    ORDER BY q.issued_at DESC, q.cmd_id DESC
    LIMIT 1000
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cmd_id: String(r.cmd_id), device_id: String(r.device_id), verb: String(r.verb), params: (r.params as Record<string, unknown>) ?? {}, state: String(r.state),
    issued_at: String(r.issued_at), expires_at: String(r.expires_at), issuer_kind: String(r.issuer_kind), issuer_id: String(r.issuer_id), has_approval_ref: r.has_approval_ref === true,
    key_id: String(r.key_id), delivery_count: Number(r.delivery_count), outcome: (r.outcome as string | null) ?? null, reason: (r.reason as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null, has_upload: r.has_upload === true,
  }));
}

export type AuditView = { id: number; ts: string; actor: string; action: string; cmd_id: string | null; machine: string | null; summary: string | null };
export async function fleetAudit(sql: FleetSql, limit = 50): Promise<AuditView[]> {
  const n = Math.max(1, Math.min(limit, 200));
  const rows = (await sql`
    SELECT id, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts, actor, action, cmd_id, machine, summary FROM fleet_audit ORDER BY id DESC LIMIT ${n}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), ts: String(r.ts), actor: String(r.actor), action: String(r.action), cmd_id: (r.cmd_id as string | null) ?? null, machine: (r.machine as string | null) ?? null, summary: (r.summary as string | null) ?? null }));
}
