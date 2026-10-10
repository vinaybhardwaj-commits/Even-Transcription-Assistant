/**
 * lib/fleet/commands.ts — queue a command for a device (TS-H3 #40). A LIBRARY ONLY: no route calls it, so nothing in this slice can send anything to a room Mac.
 * The issuer (operator UI / Steward / MCP, TS-H4 #41) builds and SIGNS the envelope v2 (canonical JSON, Ed25519, a server key id from FLEET_SERVER_KEY_IDS); this
 * function checks the SHAPE and the closed catalogue (FLEET_VERBS) and stores it. It does not verify the signature (the server's signing keys land with #41); the
 * helper verifies it against its compiled-in keys and refuses a bad one (`bad_signature`).
 */
import type { FleetSql } from "./device-auth";
import { FLEET_SERVER_KEY_IDS, isFleetVerb } from "./verbs";

const KEY_RE = /^[a-z_][a-z0-9_]*$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MAX_PARAMS_BYTES = 2048;
export const MAX_COMMAND_TTL_S = 900;

export type QueueInput = {
  cmd_id: string; device_id: string; machine: string; verb: string; params: Record<string, unknown>;
  issued_at: string; expires_at: string; nonce: string;
  issuer: { kind: "operator" | "steward" | "bot"; id: string };
  approval_ref: string | null; key_id: string; signature: string;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const paramsOk = (v: unknown, depth = 0): boolean =>
  depth <= 4 && (Array.isArray(v) ? v.every((x) => paramsOk(x, depth + 1)) : isObj(v) ? Object.keys(v).every((k) => KEY_RE.test(k) && paramsOk(v[k], depth + 1)) : typeof v !== "number" || Number.isInteger(v));

export type QueueResult = { ok: true } | { ok: false; reason: string };

export async function queueCommand(sql: FleetSql, c: QueueInput): Promise<QueueResult> {
  if (typeof c.cmd_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(c.cmd_id)) return { ok: false, reason: "malformed" };
  if (!isFleetVerb(c.verb)) return { ok: false, reason: "verb_not_allowed" };
  if (!isObj(c.params) || !paramsOk(c.params) || Buffer.byteLength(JSON.stringify(c.params)) > MAX_PARAMS_BYTES) return { ok: false, reason: "bad_params" };
  if (!ISO_MS_RE.test(c.issued_at) || !ISO_MS_RE.test(c.expires_at)) return { ok: false, reason: "bad_time" };
  const ttl = (Date.parse(c.expires_at) - Date.parse(c.issued_at)) / 1000;
  if (!(ttl > 0 && ttl <= MAX_COMMAND_TTL_S)) return { ok: false, reason: "bad_ttl" };
  if (typeof c.nonce !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(c.nonce)) return { ok: false, reason: "bad_nonce" };
  if (!(FLEET_SERVER_KEY_IDS as readonly string[]).includes(c.key_id)) return { ok: false, reason: "unknown_key_id" };
  if (typeof c.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(c.signature)) return { ok: false, reason: "bad_signature_shape" };
  if (!["operator", "steward", "bot"].includes(c.issuer?.kind) || typeof c.issuer?.id !== "string" || c.issuer.id.length < 1 || c.issuer.id.length > 64) return { ok: false, reason: "bad_issuer" };
  if (c.approval_ref !== null && !(typeof c.approval_ref === "string" && c.approval_ref.length >= 1 && c.approval_ref.length <= 64)) return { ok: false, reason: "bad_approval_ref" };
  const dev = (await sql`SELECT machine, status FROM fleet_devices WHERE device_id = ${c.device_id}`) as Array<{ machine: string; status: string }>;
  if (!dev[0]) return { ok: false, reason: "unknown_device" };
  if (dev[0].status !== "active") return { ok: false, reason: "device_revoked" };
  if (dev[0].machine !== c.machine) return { ok: false, reason: "machine_mismatch" };
  const ins = await sql`
    INSERT INTO fleet_commands (cmd_id, device_id, machine, verb, params, issued_at, expires_at, nonce, issuer_kind, issuer_id, approval_ref, key_id, signature)
    VALUES (${c.cmd_id}, ${c.device_id}, ${c.machine}, ${c.verb}, ${JSON.stringify(c.params)}::jsonb, ${c.issued_at}::timestamptz, ${c.expires_at}::timestamptz, ${c.nonce}, ${c.issuer.kind}, ${c.issuer.id}, ${c.approval_ref}, ${c.key_id}, ${c.signature})
    ON CONFLICT DO NOTHING
    RETURNING cmd_id
  `;
  if (ins.length === 0) return { ok: false, reason: "duplicate" };
  await sql`INSERT INTO fleet_audit (actor, action, cmd_id, machine, summary) VALUES (${`${c.issuer.kind}:${c.issuer.id}`}, 'queue', ${c.cmd_id}, ${c.machine}, ${`verb ${c.verb}`})`;
  return { ok: true };
}

/** Revoke a device's key (operator action; no route yet). A revoked device is answered 401 revoked and stops. */
export async function revokeDevice(sql: FleetSql, deviceId: string, actor: string): Promise<boolean> {
  const r = await sql`UPDATE fleet_devices SET status = 'revoked', revoked_at = now() WHERE device_id = ${deviceId} AND status = 'active' RETURNING machine`;
  if (r.length === 0) return false;
  await sql`INSERT INTO fleet_audit (actor, action, machine, summary) VALUES (${actor}, 'revoke', ${(r[0] as { machine: string }).machine}, ${`device ${deviceId} revoked`})`;
  return true;
}
