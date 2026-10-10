/**
 * lib/fleet/envelope.ts — command envelope v2 (TS-H4 #41, PRD §5.3): the shape, the issuing side (build + sign) and a REFERENCE VERIFIER that mirrors, step for step,
 * what the Swift helper does. The server never verifies an incoming command (it only issues them); the verifier lives here so the order and the reason codes are
 * tested, and so the cross-language vectors (docs/fleet/PROTOCOL.md) are checked by the same code that defines them.
 *
 * Verifier order, first failure wins (reason code in brackets):
 *   1 shape (malformed) · 2 signature under the compiled-in key for key_id (bad_signature) · 3 TTL <= 900 s and now in [issued_at-120 s, expires_at] (expired)
 *   4 nonce unseen (replay) · 5 device_id and machine are this device's (machine_mismatch) · 6 verb in the catalogue (verb_not_allowed) · 7 closed params (bad_params)
 *   8 local gates, helper side (session_open, no_console_user, clinic_hours_needs_approval, hid_active) · 9 device rate ceiling (rate_limited) · 10 kill switch (kill_switch)
 */
import { randomBytes } from "node:crypto";
import { normalizeHostname } from "@/lib/encounter-windows/types";
import { verifyEnvelopeSignature, signEnvelope, type Signer, type UnsignedEnvelope } from "./signing";
import { APPROVAL_REF_RE, inClinicHours, isFleetVerb, needsApprovalAlways, paramsValid, CATALOGUE, FLEET_SERVER_KEY_IDS, type FleetVerb } from "./verbs";

export type Envelope = UnsignedEnvelope & { signature: string };
export const ENVELOPE_FIELDS = ["v", "cmd_id", "device_id", "machine", "verb", "params", "issued_at", "expires_at", "nonce", "issuer", "approval_ref", "key_id", "signature"] as const;
export const MAX_TTL_S = 900;
export const DEFAULT_TTL_S = 300;
export const MIN_TTL_S = 30;
export const SKEW_S = 120;
export const ISSUER_KINDS = ["operator", "steward", "bot"] as const;

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE_RE = /^[A-Za-z0-9+/]{22}==$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
export const isoMs = (ms: number): string => new Date(ms).toISOString();

/** PURE. Is `e` an envelope-v2-shaped object (exactly the 13 fields, the right types)? Says nothing about the signature. */
export function envelopeShapeOk(e: unknown): e is Envelope {
  if (!isObj(e)) return false;
  const keys = Object.keys(e);
  if (keys.length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(e, k))) return false;
  const iss = e.issuer;
  return (
    e.v === 2 &&
    typeof e.cmd_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(e.cmd_id) &&
    typeof e.device_id === "string" && /^dev_[a-f0-9]{24}$/.test(e.device_id) &&
    typeof e.machine === "string" && e.machine.length >= 1 && e.machine.length <= 128 &&
    typeof e.verb === "string" && e.verb.length <= 64 &&
    isObj(e.params) &&
    typeof e.issued_at === "string" && ISO_MS_RE.test(e.issued_at) &&
    typeof e.expires_at === "string" && ISO_MS_RE.test(e.expires_at) &&
    typeof e.nonce === "string" && NONCE_RE.test(e.nonce) &&
    isObj(iss) && Object.keys(iss).length === 2 && typeof iss.kind === "string" && (ISSUER_KINDS as readonly string[]).includes(iss.kind) && typeof iss.id === "string" && iss.id.length >= 1 && iss.id.length <= 64 &&
    (e.approval_ref === null || (typeof e.approval_ref === "string" && APPROVAL_REF_RE.test(e.approval_ref))) &&
    typeof e.key_id === "string" && typeof e.signature === "string"
  );
}

export type VerifyCtx = {
  /** key_id -> public key (standard base64 of 32 raw bytes): the keys compiled into the helper */
  publicKeys: Record<string, string>;
  nowMs: number;
  nonceSeen: (nonce: string) => boolean;
  deviceId: string;
  machine: string;
  /** step 8: a helper-local gate's refusal code, or null */
  localGate?: (e: Envelope) => string | null;
  /** step 9: false = over the device's rate ceiling */
  rateOk?: () => boolean;
  /** step 10 */
  killSwitch?: boolean;
};
export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyEnvelope(e: unknown, ctx: VerifyCtx): VerifyResult {
  if (!envelopeShapeOk(e)) return { ok: false, reason: "malformed" };
  const { signature, ...unsigned } = e;
  const pub = Object.prototype.hasOwnProperty.call(ctx.publicKeys, e.key_id) ? ctx.publicKeys[e.key_id] : undefined;
  let sigOk = false;
  try {
    sigOk = !!pub && verifyEnvelopeSignature(unsigned as UnsignedEnvelope, signature, pub);
  } catch {
    sigOk = false; // a non-canonicalisable envelope (float in params, odd key) cannot carry a valid signature
  }
  if (!sigOk) return { ok: false, reason: "bad_signature" };
  const iss = Date.parse(e.issued_at);
  const exp = Date.parse(e.expires_at);
  if (!(exp > iss) || exp - iss > MAX_TTL_S * 1000 || ctx.nowMs > exp || ctx.nowMs < iss - SKEW_S * 1000) return { ok: false, reason: "expired" };
  if (ctx.nonceSeen(e.nonce)) return { ok: false, reason: "replay" };
  if (e.device_id !== ctx.deviceId || normalizeHostname(e.machine) !== normalizeHostname(ctx.machine)) return { ok: false, reason: "machine_mismatch" };
  if (!isFleetVerb(e.verb)) return { ok: false, reason: "verb_not_allowed" };
  if (!paramsValid(e.verb, e.params)) return { ok: false, reason: "bad_params" };
  const gate = ctx.localGate?.(e) ?? null;
  if (gate) return { ok: false, reason: gate };
  if (ctx.rateOk && !ctx.rateOk()) return { ok: false, reason: "rate_limited" };
  if (ctx.killSwitch) return { ok: false, reason: "kill_switch" };
  return { ok: true };
}

/** The approval rule the SERVER applies at issue time (the helper re-applies it as local gate `clinic_hours_needs_approval`). Null = fine. */
export function approvalProblem(verb: FleetVerb, params: Record<string, unknown>, approvalRef: string | null, nowMs: number): string | null {
  if (approvalRef !== null && !APPROVAL_REF_RE.test(approvalRef)) return "bad_approval_ref";
  if (approvalRef !== null) return null;
  if (needsApprovalAlways(verb, params)) return "approval_required";
  if (CATALOGUE[verb].privileged && inClinicHours(nowMs)) return "approval_required";
  return null;
}

export type IssueSpec = {
  device_id: string;
  machine: string;
  verb: string;
  params: Record<string, unknown>;
  issuer: { kind: (typeof ISSUER_KINDS)[number]; id: string };
  approval_ref: string | null;
  ttl_s: number;
  nowMs: number;
};

/** Build and sign an envelope. Throws on anything outside the catalogue (callers validate first and answer a reason; this is the last line). */
export function buildSignedEnvelope(s: IssueSpec, signer: Signer): Envelope {
  if (!isFleetVerb(s.verb) || !paramsValid(s.verb, s.params)) throw new Error("not a catalogued command");
  if (!(Number.isInteger(s.ttl_s) && s.ttl_s >= MIN_TTL_S && s.ttl_s <= MAX_TTL_S)) throw new Error("bad ttl");
  const unsigned: UnsignedEnvelope = {
    v: 2,
    cmd_id: `cmd_${randomBytes(10).toString("hex")}`,
    device_id: s.device_id,
    machine: s.machine,
    verb: s.verb,
    params: s.params,
    issued_at: isoMs(s.nowMs),
    expires_at: isoMs(s.nowMs + s.ttl_s * 1000),
    nonce: randomBytes(16).toString("base64"),
    issuer: { kind: s.issuer.kind, id: s.issuer.id },
    approval_ref: s.approval_ref,
    key_id: signer.keyId,
  };
  return { ...unsigned, signature: signEnvelope(unsigned, signer) };
}

export const publicKeysOf = (signer: Signer): Record<string, string> => ({ [signer.keyId]: signer.publicKeyB64 });
export { FLEET_SERVER_KEY_IDS };
