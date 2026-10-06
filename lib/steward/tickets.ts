/**
 * lib/steward/tickets.ts — the Room Steward repair-ticket contract (part 1: storage + signing only; nothing here acts on a room or a kiosk).
 *
 * A ticket is a small JSON object the server signs with Ed25519 and a kiosk verifies against the committed public key (ticket-public-key.ts):
 *   { v:1, ticket_id, machine, action, params, issued_at, expires_at, nonce }
 *   issued_at / expires_at are ISO-8601 UTC with milliseconds ("2026-10-06T10:00:00.000Z"); nonce is 16 random bytes, base64url.
 * The signature covers canonicalTicket(ticket): JSON, keys sorted bytewise recursively (integer-like keys are forbidden, see KEY_RE), no whitespace, UTF-8.
 * It travels as standard base64 (RFC 4648, with padding): exactly 88 characters, no trailing junk.
 *
 * verifyTicket rejects, in this check order, with these reasons: malformed (not an object of the right shape, v != 1, or any object key not matching KEY_RE),
 * bad_signature (including a signature that is not strict standard base64 of 64 bytes), expired, action_not_allowed, bad_params, machine_mismatch.
 * issueTicket enforces ttl <= 900 s, a valid action/params pair, and at most ONE outstanding (issued or fetched) ticket per (machine, action).
 *
 * Timestamps are written by the app as ISO strings and read back through to_char so the bytes a kiosk verifies are the bytes that were signed.
 */
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";

export const ACTION_ALLOWLIST = ["wake", "open_pulse", "relaunch_chrome", "policy_cycle", "restart_recorder_app", "restart_kiosk_health"] as const;
export type StewardAction = (typeof ACTION_ALLOWLIST)[number];

export const MAX_TTL_S = 900;
export const TICKET_VERSION = 1;
export const PROFILE_MAX = 64;
const MACHINE_MAX = 128;
// NUL and lone UTF-16 surrogates are refused by Postgres text.
const BAD_STRING = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type Ticket = {
  v: number;
  ticket_id: string;
  machine: string;
  action: StewardAction;
  params: Record<string, unknown>;
  issued_at: string;
  expires_at: string;
  nonce: string;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function isAllowedAction(a: unknown): a is StewardAction {
  return typeof a === "string" && (ACTION_ALLOWLIST as readonly string[]).includes(a);
}

/** True when `params` is exactly the shape the action takes: open_pulse / relaunch_chrome / policy_cycle { profile: string 1..64 }, every other action {}. */
export function paramsValid(action: unknown, params: unknown): boolean {
  if (!isAllowedAction(action) || !isObj(params)) return false;
  const keys = Object.keys(params);
  if (action === "open_pulse" || action === "relaunch_chrome" || action === "policy_cycle") {
    const p = params.profile;
    return keys.length === 1 && keys[0] === "profile" && typeof p === "string" && p.length >= 1 && p.length <= PROFILE_MAX && !BAD_STRING.test(p);
  }
  return keys.length === 0;
}

// Every object key, at any depth, must match this. It rules out integer-like keys ("1", "10"), which JS orders before all others whatever the sort, so a
// non-JS verifier sorting bytewise would disagree. Keys are therefore sorted bytewise; integer-like keys are forbidden.
export const KEY_RE = /^[a-z_][a-z0-9_]*$/;

export function keysCanonical(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(keysCanonical);
  if (isObj(v)) return Object.keys(v).every((k) => KEY_RE.test(k) && keysCanonical(v[k]));
  return true;
}

/** Standard base64 of a 64-byte Ed25519 signature: exactly 88 chars, padded, canonical (re-encoding the decoded bytes gives the same text). */
export function decodeSignature(b64: string): Buffer | null {
  if (typeof b64 !== "string" || b64.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length === 64 && buf.toString("base64") === b64 ? buf : null;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** JSON with keys sorted recursively, no whitespace. JS strings serialise as UTF-8 when encoded; see canonicalBytes. */
export function canonicalTicket(t: unknown): string {
  return JSON.stringify(sortKeys(t));
}

const canonicalBytes = (t: unknown) => Buffer.from(canonicalTicket(t), "utf8");

/** PEM from an env var: tolerates literal "\n" sequences (a one-line paste) and surrounding whitespace. */
function normalisePem(pem: string): string {
  const s = pem.trim();
  return s.includes("\n") ? s : s.replace(/\\n/g, "\n");
}

export function signTicket(t: unknown, privateKeyPem: string): string {
  return edSign(null, canonicalBytes(t), createPrivateKey(normalisePem(privateKeyPem))).toString("base64");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "action_not_allowed" | "bad_params" | "machine_mismatch" };

/**
 * Verify a ticket as the kiosk does. `opts.machine` is the machine doing the verifying (required: a ticket for another Mac is refused);
 * `opts.now` is epoch ms (default Date.now()).
 */
export function verifyTicket(t: unknown, signatureB64: string, publicKeyPem: string, opts: { machine: string; now?: number }): VerifyResult {
  if (
    !isObj(t) || t.v !== TICKET_VERSION || typeof t.ticket_id !== "string" || typeof t.machine !== "string" || typeof t.action !== "string" ||
    !isObj(t.params) || typeof t.issued_at !== "string" || typeof t.expires_at !== "string" || typeof t.nonce !== "string" || typeof signatureB64 !== "string" ||
    !keysCanonical(t)
  ) {
    return { ok: false, reason: "malformed" };
  }
  let sigOk = false;
  try {
    const sig = decodeSignature(signatureB64);
    sigOk = sig !== null && edVerify(null, canonicalBytes(t), createPublicKey(normalisePem(publicKeyPem)), sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "bad_signature" };
  const exp = Date.parse(t.expires_at);
  if (!Number.isFinite(exp) || exp <= (opts.now ?? Date.now())) return { ok: false, reason: "expired" };
  if (!isAllowedAction(t.action)) return { ok: false, reason: "action_not_allowed" };
  if (!paramsValid(t.action, t.params)) return { ok: false, reason: "bad_params" };
  if (t.machine !== opts.machine) return { ok: false, reason: "machine_mismatch" };
  return { ok: true };
}

/** The app's tagged-template sql (Neon HTTP driver), as this module uses it. */
export type StewardSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export type IssueInput = {
  machine: string;
  action: StewardAction;
  params: Record<string, unknown>;
  decision_id: number | null;
  ttl_s: number;
  /** Test seams. Production leaves both unset: the key comes from STEWARD_TICKET_PRIVATE_KEY and the clock from Date.now(). */
  privateKeyPem?: string;
  now?: number;
};

export type IssueResult = { ok: true; ticket: Ticket; signature: string } | { ok: false; reason: "outstanding" };

function privateKeyFromEnv(): string {
  const pem = process.env.STEWARD_TICKET_PRIVATE_KEY;
  if (!pem || !pem.trim()) throw new Error("STEWARD_TICKET_PRIVATE_KEY is not set: cannot sign repair tickets");
  return pem;
}

/**
 * Sign and store one ticket (status 'issued'). Throws on a bad ttl (> 900 s or <= 0), a bad machine/action/params, or an unset key.
 * Returns { ok:false, reason:"outstanding" } when the same (machine, action) already has an unexpired issued/fetched ticket; stale ones are expired first.
 */
export async function issueTicket(sql: StewardSql, input: IssueInput): Promise<IssueResult> {
  const { machine, action, params, decision_id, ttl_s } = input;
  if (!Number.isFinite(ttl_s) || ttl_s <= 0 || ttl_s > MAX_TTL_S) throw new Error(`ttl_s must be in (0, ${MAX_TTL_S}]`);
  if (typeof machine !== "string" || machine.length === 0 || machine.length > MACHINE_MAX || BAD_STRING.test(machine)) throw new Error("bad machine");
  if (!isAllowedAction(action)) throw new Error("action not in allow-list");
  if (!paramsValid(action, params)) throw new Error("params do not match the action schema");
  const pem = input.privateKeyPem ?? privateKeyFromEnv();

  const now = input.now ?? Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl_s * 1000).toISOString();
  const ticket: Ticket = {
    v: TICKET_VERSION,
    ticket_id: randomUUID(),
    machine,
    action,
    params,
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const signature = signTicket(ticket, pem);

  await sql`
    UPDATE steward_tickets SET status = 'expired'
     WHERE machine = ${machine} AND action = ${action} AND status IN ('issued', 'fetched') AND expires_at <= ${issuedAt}::timestamptz
  `;
  const rows = (await sql`
    INSERT INTO steward_tickets (ticket_id, machine, action, params, decision_id, issued_at, expires_at, nonce, signature, status)
    VALUES (${ticket.ticket_id}, ${machine}, ${action}, ${JSON.stringify(params)}::jsonb, ${decision_id}::bigint, ${issuedAt}::timestamptz, ${expiresAt}::timestamptz, ${ticket.nonce}, ${signature}, 'issued')
    ON CONFLICT (machine, action) WHERE status IN ('issued', 'fetched') DO NOTHING
    RETURNING ticket_id
  `) as unknown[];
  if (!rows || rows.length === 0) return { ok: false, reason: "outstanding" };
  return { ok: true, ticket, signature };
}
