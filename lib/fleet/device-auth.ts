/**
 * lib/fleet/device-auth.ts — per-device request authentication for /api/fleet/* (TS-H3 #40). Wire format: docs/fleet/PROTOCOL.md.
 *
 * `Authorization: Device <JWS>`; the JWS is EdDSA over the device's registered Ed25519 key.
 *   header  { alg:"EdDSA", typ:"JWT", kid:<device_id> }
 *   claims  { iss:<device_id>, aud:"evenscribe-fleet", iat, exp, jti, htm:"GET"|"POST", htu:"/api/fleet/…" , bsha? }
 * exp - iat <= 300; iat may be at most 120 s in the future and exp at most 120 s in the past (clock skew). `htm` + `htu` bind the token to ONE request line;
 * on a POST `bsha` = base64url(SHA-256(raw body bytes)) binds it to ONE body, so a captured token cannot carry a different body. A `jti` is accepted once per signer
 * (fleet_jti, kept 15 min, longer than the 540 s a token can be accepted for: iat up to 120 s ahead, then 300 s lifetime, then 120 s past exp).
 *
 * Refusal reasons (all HTTP 401 except where noted): malformed · unknown_device · revoked · bad_signature · bad_audience · expired · not_yet_valid · ttl_too_long · request_mismatch · replay.
 */
import { fromB64url, parseJws, sha256b64url, verifyJws, type Jws } from "./jws";

export const FLEET_AUD = "evenscribe-fleet";
export const FLEET_REGISTER_AUD = "evenscribe-fleet-register";
export const MAX_TOKEN_TTL_S = 300;
export const SKEW_S = 120;
export const JTI_KEEP = "15 minutes";
const JTI_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type FleetSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export type AuthFail = { ok: false; status: number; code: string };
export type DeviceRow = { device_id: string; install_id: string; room_id: string; machine: string; public_key: string; status: string };

/** `bodyBound:false` (the registration proof lives INSIDE the body, so it cannot hash it): a POST then needs no `bsha`. */
export type ClaimsCtx = { aud: string; nowMs: number; method: string; path: string; bodyText?: string; bodyBound?: boolean };

/** PURE. The claim checks, in a fixed order; the first failure wins. Null = the claims are acceptable. */
export function checkClaims(c: Record<string, unknown>, ctx: ClaimsCtx): string | null {
  const { iss, aud, iat, exp, jti, htm, htu, bsha } = c;
  if (typeof iss !== "string" || typeof jti !== "string" || !JTI_RE.test(jti)) return "malformed";
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return "malformed";
  if (aud !== ctx.aud) return "bad_audience";
  const nowS = Math.floor(ctx.nowMs / 1000);
  const i = iat as number;
  const e = exp as number;
  if (e <= i || e - i > MAX_TOKEN_TTL_S) return "ttl_too_long";
  if (e < nowS - SKEW_S) return "expired";
  if (i > nowS + SKEW_S) return "not_yet_valid";
  if (htm !== ctx.method || htu !== ctx.path) return "request_mismatch";
  if (ctx.method === "POST" && ctx.bodyBound === false) {
    if (bsha !== undefined) return "request_mismatch";
  } else if (ctx.method === "POST") {
    if (typeof bsha !== "string" || bsha !== sha256b64url(Buffer.from(ctx.bodyText ?? "", "utf8"))) return "request_mismatch";
  } else if (bsha !== undefined) return "request_mismatch";
  return null;
}

const fail = (code: string, status = 401): AuthFail => ({ ok: false, status, code });

/** Record a (signer, jti) pair. False = it was already there: a replay. Prunes this signer's old rows first (bounded: a signer has few live rows). */
export async function claimJti(sql: FleetSql, signer: string, jti: string): Promise<boolean> {
  await sql`DELETE FROM fleet_jti WHERE signer = ${signer} AND seen_at < now() - ${JTI_KEEP}::interval`;
  const rows = await sql`INSERT INTO fleet_jti (signer, jti) VALUES (${signer}, ${jti}) ON CONFLICT DO NOTHING RETURNING jti`;
  return rows.length === 1;
}

export function parseDeviceAuthorization(h: string | null): Jws | null {
  if (!h) return null;
  const m = /^Device ([A-Za-z0-9_.-]+)$/.exec(h.trim());
  return m ? parseJws(m[1]) : null;
}

export async function authenticateDevice(
  sql: FleetSql,
  req: { authorization: string | null; method: "GET" | "POST"; path: string; bodyText?: string; nowMs: number },
): Promise<{ ok: true; device: DeviceRow } | AuthFail> {
  const jws = parseDeviceAuthorization(req.authorization);
  if (!jws) return fail("malformed");
  const { header, payload } = jws;
  if (header.alg !== "EdDSA" || typeof header.kid !== "string" || payload.iss !== header.kid) return fail("malformed");
  const deviceId = header.kid;
  if (!/^dev_[a-f0-9]{24}$/.test(deviceId)) return fail("malformed");

  // A retired install revokes its key (PRD: "retire revokes the key"): the join makes a retired install indistinguishable from a revoked device.
  const rows = (await sql`
    SELECT d.device_id, d.install_id, d.room_id, d.machine, d.public_key,
           CASE WHEN d.status = 'active' AND ri.retired_at IS NULL THEN 'active' ELSE 'revoked' END AS status
      FROM fleet_devices d
      LEFT JOIN room_install ri ON ri.install_id = d.install_id
     WHERE d.device_id = ${deviceId}
  `) as DeviceRow[];
  const device = rows[0];
  if (!device) return fail("unknown_device");
  if (device.status !== "active") return fail("revoked");
  if (!verifyJws(jws, device.public_key)) return fail("bad_signature");
  const why = checkClaims(payload, { aud: FLEET_AUD, nowMs: req.nowMs, method: req.method, path: req.path, bodyText: req.bodyText });
  if (why) return fail(why);
  if (!(await claimJti(sql, deviceId, payload.jti as string))) return fail("replay");
  return { ok: true, device };
}

export { fromB64url };
