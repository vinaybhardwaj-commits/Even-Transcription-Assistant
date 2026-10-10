/**
 * lib/fleet/poll.ts — GET /api/fleet/poll?wait=25 (TS-H3 #40, PRD §5.5). The long-poll.
 *
 * Returns {server_time, kill_switch:{global,reason?}, commands:[envelope v2…]}. It holds the request open up to `wait` seconds (0..25, default 25), checking every
 * POLL_INTERVAL_MS, and returns the moment a command is deliverable; an empty list after the wait is normal and the helper re-polls at once. With the kill switch ON
 * the poll still waits the full time (so a helper does not spin) and returns no commands.
 *
 * DELIVERY is at-least-once: a command goes out as state 'queued' -> 'delivered' (delivered_at, delivery_count+1). A delivered command with no result is offered
 * again after REDELIVER_AFTER_S, until it expires; the helper dedups on cmd_id / nonce. A command past expires_at is never delivered (queued ones are flipped to
 * 'expired' here), and one whose issued_at is more than 120 s in the future is held back. At most MAX_BATCH per poll, oldest first.
 *
 * Envelope: every field is served as the issuer signed it, including `machine` (stored on the command at queue time, never read from fleet_devices). `params` comes back
 * from jsonb with its keys reordered; verification canonicalises first (PRD §5.3), so that is harmless.
 * Timestamps are ISO-8601 UTC with milliseconds; `approval_ref` is always present (string or null);
 * `issuer` is {kind,id}. This code never signs and never alters a command.
 */
import type { FleetSql } from "./device-auth";

export const MAX_WAIT_S = 25;
export const POLL_INTERVAL_MS = 1500;
export const REDELIVER_AFTER_S = 30;
export const MAX_BATCH = 10;

export type Envelope = {
  v: 2;
  cmd_id: string;
  device_id: string;
  machine: string;
  verb: string;
  params: Record<string, unknown>;
  issued_at: string;
  expires_at: string;
  nonce: string;
  issuer: { kind: string; id: string };
  approval_ref: string | null;
  key_id: string;
  signature: string;
};

export type PollBody = { server_time: string; kill_switch: { global: boolean; reason?: string }; commands: Envelope[] };

/** `wait` query: absent -> 25; an integer 0..25; anything else is null (HTTP 400). */
export function parseWait(raw: string | null): number | null {
  if (raw === null) return MAX_WAIT_S;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_WAIT_S ? n : null;
}

export async function readKillSwitch(sql: FleetSql): Promise<{ global: boolean; reason?: string }> {
  const rows = (await sql`SELECT value FROM fleet_control WHERE key = 'kill_switch'`) as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  if (typeof v !== "object" || v === null) return { global: false };
  const o = v as { global?: unknown; reason?: unknown };
  return o.global === true ? { global: true, ...(typeof o.reason === "string" ? { reason: o.reason.slice(0, 200) } : {}) } : { global: false };
}

type Row = {
  cmd_id: string; device_id: string; machine: string; verb: string; params: Record<string, unknown>; issued_at: string; expires_at: string; nonce: string;
  issuer_kind: string; issuer_id: string; approval_ref: string | null; key_id: string; signature: string;
};

/** One claim pass: flip expired queued commands, then take the deliverable ones. */
export async function claimCommands(sql: FleetSql, deviceId: string): Promise<Envelope[]> {
  await sql`UPDATE fleet_commands SET state = 'expired' WHERE device_id = ${deviceId} AND state = 'queued' AND expires_at <= now()`;
  const rows = (await sql`
    WITH c AS (
      UPDATE fleet_commands SET state = 'delivered', delivered_at = now(), delivery_count = delivery_count + 1
       WHERE cmd_id IN (
         SELECT cmd_id FROM fleet_commands
          WHERE device_id = ${deviceId} AND expires_at > now() AND issued_at <= now() + interval '120 seconds'
            AND (state = 'queued' OR (state = 'delivered' AND delivered_at < now() - ${`${REDELIVER_AFTER_S} seconds`}::interval))
          ORDER BY issued_at, cmd_id
          LIMIT ${MAX_BATCH}
          FOR UPDATE SKIP LOCKED)
      RETURNING cmd_id, device_id, machine, verb, params, issued_at, expires_at, nonce, issuer_kind, issuer_id, approval_ref, key_id, signature
    )
    SELECT c.cmd_id, c.device_id, c.machine, c.verb, c.params,
           to_char(c.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
           to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
           c.nonce, c.issuer_kind, c.issuer_id, c.approval_ref, c.key_id, c.signature
      FROM c
     ORDER BY c.issued_at, c.cmd_id
  `) as Row[];
  return rows.map((r) => ({
    v: 2 as const,
    cmd_id: r.cmd_id,
    device_id: r.device_id,
    machine: r.machine,
    verb: r.verb,
    params: r.params,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    nonce: r.nonce,
    issuer: { kind: r.issuer_kind, id: r.issuer_id },
    approval_ref: r.approval_ref ?? null,
    key_id: r.key_id,
    signature: r.signature,
  }));
}

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function longPoll(sql: FleetSql, deviceId: string, waitS: number, clock: Clock = realClock, intervalMs: number = POLL_INTERVAL_MS): Promise<PollBody> {
  await sql`UPDATE fleet_devices SET last_poll_at = now() WHERE device_id = ${deviceId}`;
  const deadline = clock.now() + waitS * 1000;
  for (;;) {
    const kill = await readKillSwitch(sql);
    const commands = kill.global ? [] : await claimCommands(sql, deviceId);
    if (commands.length > 0 || clock.now() + intervalMs > deadline) {
      return { server_time: new Date(clock.now()).toISOString(), kill_switch: kill, commands };
    }
    await clock.sleep(intervalMs);
  }
}
