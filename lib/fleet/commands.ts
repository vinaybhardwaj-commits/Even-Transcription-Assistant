/**
 * lib/fleet/commands.ts — queue a SIGNED command for a device (TS-H3 #40, TS-H4 #41).
 *
 *   issueCommand(sql, signer, spec)   the only path an operator action takes: validate against the closed catalogue, apply the approval rule, build + sign envelope v2, store it.
 *   queueCommand(sql, envelope, keys) storage with a gate: the envelope must be shaped, in the catalogue, closed-params, and carry a VALID SIGNATURE under `keys`. An unsigned,
 *                                     forged or already-expired envelope is refused and nothing is stored. (The library is internal; the only route that calls it is the
 *                                     admin-only POST /api/admin/fleet/commands.)
 * Nothing here runs on a schedule. No cron, worker or poll handler ever calls these.
 */
import { normalizeHostname } from "@/lib/encounter-windows/types";
import type { FleetSql } from "./device-auth";
import { approvalProblem, buildSignedEnvelope, envelopeShapeOk, isoMs, verifyEnvelope, publicKeysOf, DEFAULT_TTL_S, MAX_TTL_S, MIN_TTL_S, type Envelope, type IssueSpec } from "./envelope";
import type { Signer } from "./signing";
import { isFleetVerb, paramsValid, CATALOGUE } from "./verbs";

export const MAX_PARAMS_BYTES = 2048;
export type QueueResult = { ok: true; cmd_id: string; expires_at: string } | { ok: false; reason: string };

export async function queueCommand(sql: FleetSql, e: unknown, publicKeys: Record<string, string>, nowMs: number = Date.now()): Promise<QueueResult> {
  if (!envelopeShapeOk(e)) return { ok: false, reason: "malformed" };
  if (!isFleetVerb(e.verb)) return { ok: false, reason: "verb_not_allowed" };
  if (!paramsValid(e.verb, e.params) || Buffer.byteLength(JSON.stringify(e.params)) > MAX_PARAMS_BYTES) return { ok: false, reason: "bad_params" };
  const ttlMs = Date.parse(e.expires_at) - Date.parse(e.issued_at);
  if (!(ttlMs > 0 && ttlMs <= MAX_TTL_S * 1000)) return { ok: false, reason: "bad_ttl" };
  // signature, TTL and expiry exactly as the helper will check them; the device/nonce steps are the database's (below)
  const v = verifyEnvelope(e, { publicKeys, nowMs, nonceSeen: () => false, deviceId: e.device_id, machine: e.machine });
  if (!v.ok) return { ok: false, reason: v.reason };
  const dev = (await sql`SELECT machine, status FROM fleet_devices WHERE device_id = ${e.device_id}`) as Array<{ machine: string; status: string }>;
  if (!dev[0]) return { ok: false, reason: "unknown_device" };
  if (dev[0].status !== "active") return { ok: false, reason: "device_revoked" };
  if (normalizeHostname(dev[0].machine) !== normalizeHostname(e.machine)) return { ok: false, reason: "machine_mismatch" };
  const ins = await sql`
    INSERT INTO fleet_commands (cmd_id, device_id, machine, verb, params, issued_at, expires_at, nonce, issuer_kind, issuer_id, approval_ref, key_id, signature)
    VALUES (${e.cmd_id}, ${e.device_id}, ${e.machine}, ${e.verb}, ${JSON.stringify(e.params)}::jsonb, ${e.issued_at}::timestamptz, ${e.expires_at}::timestamptz, ${e.nonce}, ${e.issuer.kind}, ${e.issuer.id}, ${e.approval_ref}, ${e.key_id}, ${e.signature})
    ON CONFLICT DO NOTHING
    RETURNING cmd_id
  `;
  if (ins.length === 0) return { ok: false, reason: "duplicate" };
  await sql`INSERT INTO fleet_audit (actor, action, cmd_id, machine, summary)
    VALUES (${`${e.issuer.kind}:${e.issuer.id}`}, 'queue', ${e.cmd_id}, ${e.machine}, ${`verb ${e.verb}${e.approval_ref ? " (approval_ref given)" : ""}`})`;
  return { ok: true, cmd_id: e.cmd_id, expires_at: e.expires_at };
}

export type IssueInput = {
  device_id: string;
  verb: unknown;
  params?: unknown;
  approval_ref?: unknown;
  ttl_s?: unknown;
  issuer: IssueSpec["issuer"];
  nowMs?: number;
};

/** Validate, apply the approval rule, sign, store. `reason` is one of: verb_not_allowed bad_params bad_ttl bad_approval_ref approval_required unknown_device device_revoked outstanding. */
export async function issueCommand(sql: FleetSql, signer: Signer, i: IssueInput): Promise<QueueResult> {
  const nowMs = i.nowMs ?? Date.now();
  if (!isFleetVerb(i.verb)) return { ok: false, reason: "verb_not_allowed" };
  const params = i.params === undefined ? {} : i.params;
  if (typeof params !== "object" || params === null || Array.isArray(params) || !paramsValid(i.verb, params)) return { ok: false, reason: "bad_params" };
  const ttl = i.ttl_s === undefined ? DEFAULT_TTL_S : i.ttl_s;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_TTL_S || ttl > MAX_TTL_S) return { ok: false, reason: "bad_ttl" };
  const approval = i.approval_ref === undefined || i.approval_ref === null ? null : i.approval_ref;
  if (approval !== null && typeof approval !== "string") return { ok: false, reason: "bad_approval_ref" };
  const problem = approvalProblem(i.verb, params as Record<string, unknown>, approval, nowMs);
  if (problem) return { ok: false, reason: problem };
  const dev = (await sql`SELECT machine, status FROM fleet_devices WHERE device_id = ${i.device_id}`) as Array<{ machine: string; status: string }>;
  if (!dev[0]) return { ok: false, reason: "unknown_device" };
  if (dev[0].status !== "active") return { ok: false, reason: "device_revoked" };
  // one outstanding command per (device, verb): a double click or a retry does not stack work on a Mac
  const open = await sql`
    SELECT 1 FROM fleet_commands WHERE device_id = ${i.device_id} AND verb = ${i.verb} AND expires_at > now() AND state IN ('queued', 'delivered') LIMIT 1
  `;
  if (open.length > 0) return { ok: false, reason: "outstanding" };
  const env: Envelope = buildSignedEnvelope({ device_id: i.device_id, machine: dev[0].machine, verb: i.verb, params: params as Record<string, unknown>, issuer: i.issuer, approval_ref: approval, ttl_s: ttl, nowMs }, signer);
  return queueCommand(sql, env, publicKeysOf(signer), nowMs);
}

/** Revoke a device's key (operator action; no route yet). A revoked device is answered 401 revoked and stops. */
export async function revokeDevice(sql: FleetSql, deviceId: string, actor: string): Promise<boolean> {
  const r = await sql`UPDATE fleet_devices SET status = 'revoked', revoked_at = now() WHERE device_id = ${deviceId} AND status = 'active' RETURNING machine`;
  if (r.length === 0) return false;
  await sql`INSERT INTO fleet_audit (actor, action, machine, summary) VALUES (${actor}, 'revoke', ${(r[0] as { machine: string }).machine}, ${`device ${deviceId} revoked`})`;
  return true;
}
export { CATALOGUE, isoMs };
