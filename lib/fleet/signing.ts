/**
 * lib/fleet/signing.ts — the server's command-signing key (TS-H4 #41). The PRIVATE key comes from the environment and is never in the repo, never served, never logged:
 *   FLEET_COMMAND_SIGNING_KEY      base64 of the PKCS#8 DER of an Ed25519 private key (one line; `node scripts/fleet-gen-signing-key.mjs` prints a fresh pair)
 *   FLEET_COMMAND_SIGNING_KEY_ID   which compiled-in public key verifies it: "fk1" or "fk2" (default fk1)
 * Vercel bakes env at build time, so a key change needs a redeploy. Unset = the issue route answers 503 `signer_not_configured` and nothing can be queued.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./canonical";
import { FLEET_SERVER_KEY_IDS } from "./verbs";

export type Signer = { keyId: string; privateKey: KeyObject; publicKeyB64: string };

export function loadSigner(env: Record<string, string | undefined> = process.env): Signer | null {
  const raw = env.FLEET_COMMAND_SIGNING_KEY?.trim();
  if (!raw) return null;
  const keyId = (env.FLEET_COMMAND_SIGNING_KEY_ID ?? "fk1").trim();
  if (!(FLEET_SERVER_KEY_IDS as readonly string[]).includes(keyId)) return null;
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    const publicKeyB64 = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    return { keyId, privateKey, publicKeyB64 };
  } catch {
    return null; // never echo the value or the parser's message
  }
}

export type UnsignedEnvelope = {
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
};

/** The bytes the signature covers: canonical JSON of the envelope WITHOUT `signature`. */
export const signingBytes = (e: UnsignedEnvelope): Buffer => Buffer.from(canonicalJson(e), "utf8");

export const signEnvelope = (e: UnsignedEnvelope, signer: Signer): string => edSign(null, signingBytes(e), signer.privateKey).toString("base64");

/** Standard base64 of a 64-byte signature: 88 chars, padded, canonical. */
export function decodeSig(b64: unknown): Buffer | null {
  if (typeof b64 !== "string" || b64.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length === 64 && buf.toString("base64") === b64 ? buf : null;
}

export function verifyEnvelopeSignature(e: UnsignedEnvelope, signature: string, publicKeyB64: string): boolean {
  const sig = decodeSig(signature);
  const raw = Buffer.from(publicKeyB64, "base64");
  if (!sig || raw.length !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    return edVerify(null, signingBytes(e), key, sig);
  } catch {
    return false;
  }
}
