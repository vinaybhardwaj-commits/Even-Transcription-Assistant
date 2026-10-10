/**
 * lib/fleet/jws.ts — compact JWS (EdDSA / Ed25519) for the fleet control plane (TS-H3 #40). PURE; node:crypto only.
 *
 * A token is `base64url(header).base64url(payload).base64url(signature)`; the signature covers the ASCII bytes of `header.payload` (RFC 7515 §5.1).
 * Header: {"alg":"EdDSA","typ":"JWT","kid":"<device_id>"} (registration proof: kid "install:<install_id>"). The public key travels as standard base64 of the
 * 32 raw bytes (RFC 8032), exactly 44 characters with padding; it is wrapped in an SPKI DER prefix here to build a KeyObject.
 */
import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** Strict base64url: no padding, no '+' '/', canonical (re-encoding gives the same text). */
export function fromB64url(s: unknown): Buffer | null {
  if (typeof s !== "string" || s.length === 0 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/** Standard base64 of a 32-byte Ed25519 public key: 44 chars, padded, canonical. Returns the raw bytes or null. */
export function decodePublicKey(b64: unknown): Buffer | null {
  if (typeof b64 !== "string" || b64.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length === 32 && buf.toString("base64") === b64 ? buf : null;
}

export function publicKeyObject(b64: string): KeyObject | null {
  const raw = decodePublicKey(b64);
  if (!raw) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export const sha256b64url = (data: string | Buffer): string => createHash("sha256").update(data).digest("base64url");

export type Jws = { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer };

/** Split and decode a compact JWS. Null when it is not three canonical base64url parts of JSON objects with a 64-byte signature. */
export function parseJws(token: unknown): Jws | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const h = fromB64url(parts[0]);
  const p = fromB64url(parts[1]);
  const s = fromB64url(parts[2]);
  if (!h || !p || !s || s.length !== 64) return null;
  try {
    const header = JSON.parse(h.toString("utf8"));
    const payload = JSON.parse(p.toString("utf8"));
    if (typeof header !== "object" || header === null || Array.isArray(header)) return null;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: s };
  } catch {
    return null;
  }
}

/** True when `signature` is a valid Ed25519 signature of `signingInput` under the base64 public key. */
export function verifyJws(jws: Jws, publicKeyB64: string): boolean {
  const key = publicKeyObject(publicKeyB64);
  if (!key) return false;
  try {
    return edVerify(null, Buffer.from(jws.signingInput, "ascii"), key, jws.signature);
  } catch {
    return false;
  }
}

/** Sign a compact JWS. The server never holds device private keys; this is for tests and for the reference client. */
export function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: KeyObject): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(edSign(null, Buffer.from(input, "ascii"), privateKey))}`;
}
