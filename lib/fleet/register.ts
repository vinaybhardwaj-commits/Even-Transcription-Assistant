/**
 * lib/fleet/register.ts — POST /api/fleet/register (TS-H3 #40, PRD §5.1).
 *
 * Who may register: the holder of a ROOM session JWT (`Authorization: Bearer <room jwt>`, aud "room"; the helper gets it over XPC from the app) for the room that
 * owns `install_id`. The public key is bound by a proof of possession: `proof` is a JWS signed by the NEW key (header kid "install:<install_id>", claims iss=install_id,
 * aud "evenscribe-fleet-register", iat/exp/jti, htm "POST", htu "/api/fleet/register", pk = base64url(SHA-256(raw 32-byte key))). An expired, replayed or mismatched
 * proof is refused, so a leaked room JWT alone cannot bind an attacker's key to a Mac that does not hold it... except by an attacker who also makes the proof, which is
 * why one active key per install_id is the rule (a different key is 409 KEY_CONFLICT, never an overwrite).
 *
 * Rules: one device per install_id. Same key again = idempotent 200. A different key = 409 KEY_CONFLICT (rotation/re-enrol, TS-H3 later slice). A revoked device = 409 REVOKED. A
 * retired install = 409 RETIRED. Room mismatch = 403. machine must equal the install's hostname (normalised) when the install has one.
 */
import { randomBytes } from "node:crypto";
import { normalizeHostname } from "@/lib/encounter-windows/types";
import { isValidMachine } from "@/lib/kiosk-health-ingest";
import { FLEET_REGISTER_AUD, checkClaims, claimJti, type FleetSql } from "./device-auth";
import { decodePublicKey, parseJws, sha256b64url, verifyJws } from "./jws";
import { FLEET_SERVER_KEY_IDS } from "./verbs";

export type RegisterBody = {
  install_id: string;
  machine: string;
  hw_model: string | null;
  serial_hash: string | null;
  helper_version: string | null;
  key_alg: "ed25519";
  public_key: string;
  proof: string;
};

export type RegisterResult =
  | { ok: true; status: 200 | 201; body: { device_id: string; server_key_ids: readonly string[]; poll_url: string; registered_at: string } }
  | { ok: false; status: number; code: string };

const bad = (code: string, status = 400): RegisterResult => ({ ok: false, status, code });
const isStr = (x: unknown, min: number, max: number): x is string => typeof x === "string" && x.length >= min && x.length <= max && !/[\u0000-\u001f]/.test(x);

/** PURE. Shape-check the JSON body. */
export function parseRegisterBody(raw: unknown): { ok: true; body: RegisterBody } | { ok: false; code: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, code: "bad_body" };
  const b = raw as Record<string, unknown>;
  if (!isStr(b.install_id, 1, 64)) return { ok: false, code: "bad_install_id" };
  if (!isValidMachine(b.machine)) return { ok: false, code: "bad_machine" };
  if (b.hw_model !== undefined && b.hw_model !== null && !isStr(b.hw_model, 1, 64)) return { ok: false, code: "bad_hw_model" };
  if (b.serial_hash !== undefined && b.serial_hash !== null && !(typeof b.serial_hash === "string" && /^[a-f0-9]{64}$/.test(b.serial_hash))) return { ok: false, code: "bad_serial_hash" };
  if (b.helper_version !== undefined && b.helper_version !== null && !isStr(b.helper_version, 1, 32)) return { ok: false, code: "bad_helper_version" };
  if (b.key_alg !== "ed25519") return { ok: false, code: "bad_key_alg" };
  if (!decodePublicKey(b.public_key)) return { ok: false, code: "bad_public_key" };
  if (typeof b.proof !== "string") return { ok: false, code: "bad_proof" };
  return {
    ok: true,
    body: {
      install_id: b.install_id,
      machine: b.machine as string,
      hw_model: (b.hw_model as string | null | undefined) ?? null,
      serial_hash: (b.serial_hash as string | null | undefined) ?? null,
      helper_version: (b.helper_version as string | null | undefined) ?? null,
      key_alg: "ed25519",
      public_key: b.public_key as string,
      proof: b.proof,
    },
  };
}

type DeviceRow = { device_id: string; public_key: string; status: string; registered_at: string; room_id: string };
const FIELDS = (d: DeviceRow) => ({ device_id: d.device_id, server_key_ids: FLEET_SERVER_KEY_IDS, poll_url: "/api/fleet/poll", registered_at: d.registered_at });

export async function registerDevice(sql: FleetSql, input: { roomId: string; body: RegisterBody; nowMs: number }): Promise<RegisterResult> {
  const { body: b, roomId, nowMs } = input;

  // 1. proof of possession of the new key (cheap, before any database read)
  const jws = parseJws(b.proof);
  if (!jws || jws.header.alg !== "EdDSA" || jws.header.kid !== `install:${b.install_id}` || jws.payload.iss !== b.install_id) return bad("bad_proof", 401);
  if (!verifyJws(jws, b.public_key)) return bad("bad_signature", 401);
  const raw = decodePublicKey(b.public_key)!;
  const why = checkClaims(jws.payload, { aud: FLEET_REGISTER_AUD, nowMs, method: "POST", path: "/api/fleet/register", bodyBound: false });
  if (why) return bad(why, 401);
  if (jws.payload.pk !== sha256b64url(raw)) return bad("proof_key_mismatch", 401);

  // 2. the install: must exist, belong to the caller's room, be live, and be this machine
  const inst = (await sql`
    SELECT install_id, room_id, hostname, retired_at FROM room_install WHERE install_id = ${b.install_id}
  `) as Array<{ install_id: string; room_id: string; hostname: string | null; retired_at: unknown }>;
  const i = inst[0];
  if (!i) return bad("unknown_install", 404);
  if (i.room_id !== roomId) return bad("room_mismatch", 403);
  if (i.retired_at) return bad("RETIRED", 409);
  if (i.hostname && normalizeHostname(i.hostname) !== normalizeHostname(b.machine)) return bad("machine_mismatch", 403);

  // 3. a registration proof is accepted once
  if (!(await claimJti(sql, `install:${b.install_id}`, jws.payload.jti as string))) return bad("replay", 401);

  // 4. one device per install
  const existing = async () =>
    ((await sql`
      SELECT device_id, public_key, status, room_id, to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at
        FROM fleet_devices WHERE install_id = ${b.install_id}
    `) as DeviceRow[])[0];
  const answerExisting = async (d: DeviceRow): Promise<RegisterResult> => {
    if (d.status !== "active") return bad("REVOKED", 409);
    if (d.public_key !== b.public_key) return bad("KEY_CONFLICT", 409);
    await sql`UPDATE fleet_devices SET machine = ${b.machine}, hw_model = ${b.hw_model}, serial_hash = ${b.serial_hash}, helper_version = ${b.helper_version} WHERE device_id = ${d.device_id}`;
    return { ok: true, status: 200, body: FIELDS(d) };
  };
  const found = await existing();
  if (found) return answerExisting(found);

  const deviceId = `dev_${randomBytes(12).toString("hex")}`;
  const ins = await sql`
    INSERT INTO fleet_devices (device_id, install_id, room_id, machine, hw_model, serial_hash, helper_version, key_alg, public_key)
    VALUES (${deviceId}, ${b.install_id}, ${roomId}, ${b.machine}, ${b.hw_model}, ${b.serial_hash}, ${b.helper_version}, 'ed25519', ${b.public_key})
    ON CONFLICT (install_id) DO NOTHING
    RETURNING device_id
  `;
  if (ins.length === 0) {
    const raced = await existing(); // two registrations for one install raced: the first wins, the second is judged against it
    return raced ? answerExisting(raced) : bad("db", 503);
  }
  await sql`INSERT INTO fleet_audit (actor, action, machine, summary) VALUES (${`room:${roomId}`}, 'register', ${b.machine}, ${`device ${deviceId} registered (helper ${b.helper_version ?? "unknown"})`})`;
  const made = (await existing())!;
  return { ok: true, status: 201, body: FIELDS(made) };
}
