import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NODES } from "./config.js";

/** Backward skew (stale request) tolerance. */
export const MAX_SKEW_MS = 300_000;
/** Forward skew tolerance: small, so nothing stamped ahead can outlive the boot floor (CONTRACT-A1 amendment Y1). */
export const MAX_FORWARD_SKEW_MS = 5_000;
export const NONCE_WINDOW_MS = 600_000;
const NONCE_CAP_PER_NODE = 20_000;

export type AuthResult = { ok: true; node: string } | { ok: false; status: 401 | 503; reason: string };

export function sha256Hex(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** CONTRACT-A1: HMAC-SHA256(key, method \n path?query \n ts \n nonce \n sha256hex(body)). */
export function signRequest(key: string | Buffer, method: string, pathQuery: string, ts: string, nonce: string, body: string | Buffer): string {
  return createHmac("sha256", key).update([method.toUpperCase(), pathQuery, ts, nonce, sha256Hex(body)].join("\n")).digest("hex");
}

function constantEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * In-memory per-node nonce memory: a nonce seen in the last 600 s is refused. At the cap
 * nothing is evicted (that would re-open replay of in-window requests); new nonces are refused.
 */
export class NonceCache {
  private seen = new Map<string, Map<string, number>>();

  private live(node: string, nowMs: number): Map<string, number> {
    let m = this.seen.get(node);
    if (!m) this.seen.set(node, (m = new Map()));
    for (const [n, at] of m) {
      if (nowMs - at <= NONCE_WINDOW_MS) break;
      m.delete(n);
    }
    return m;
  }

  has(node: string, nonce: string, nowMs: number): boolean {
    return this.live(node, nowMs).has(nonce);
  }

  full(node: string, nowMs: number): boolean {
    return this.live(node, nowMs).size >= NONCE_CAP_PER_NODE;
  }

  /** Records the nonce; false if it was already seen inside the window or the node is at the cap. */
  take(node: string, nonce: string, nowMs: number): boolean {
    const m = this.live(node, nowMs);
    if (m.has(nonce) || m.size >= NONCE_CAP_PER_NODE) return false;
    m.set(nonce, nowMs);
    return true;
  }
}

/** Reads <keyDir>/<node>.key; null if absent or if group/other can access it. */
export function readNodeKey(keyDir: string, node: string): Buffer | null {
  if (!(NODES as readonly string[]).includes(node)) return null;
  const path = join(keyDir, `${node}.key`);
  try {
    const st = statSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const key = Buffer.from(readFileSync(path, "utf8").trim());
    return key.length ? key : null;
  } catch {
    return null;
  }
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export interface RequestParts {
  method: string;
  pathQuery: string;
  authorization: string | undefined;
  ts: string | undefined;
  nonce: string | undefined;
  body: Buffer;
}

/** Authorization: Node <node>:<hex> + X-Ubus-Ts (ISO, +-300 s) + X-Ubus-Nonce (16 bytes hex, single use). */
export function authenticate(keyDir: string, req: RequestParts, nowMs: number, nonces: NonceCache, bootMs = 0): AuthResult {
  const m = /^Node ([a-z0-9]+):([0-9a-f]{64})$/.exec(req.authorization ?? "");
  if (!m) return { ok: false, status: 401, reason: "bad_authorization" };
  const stamp = req.ts && ISO_TS.test(req.ts) ? Date.parse(req.ts) : NaN;
  if (!Number.isFinite(stamp) || nowMs - stamp > MAX_SKEW_MS || stamp - nowMs > MAX_FORWARD_SKEW_MS) return { ok: false, status: 401, reason: "bad_timestamp" };
  if (stamp <= bootMs + MAX_FORWARD_SKEW_MS) return { ok: false, status: 401, reason: "before_boot" };
  if (!req.nonce || !/^[0-9a-f]{32}$/.test(req.nonce)) return { ok: false, status: 401, reason: "bad_nonce" };
  const key = readNodeKey(keyDir, m[1]);
  if (!key) return { ok: false, status: 401, reason: "unknown_node" };
  if (!constantEqual(signRequest(key, req.method, req.pathQuery, req.ts!, req.nonce, req.body), m[2])) return { ok: false, status: 401, reason: "bad_signature" };
  if (nonces.has(m[1], req.nonce, nowMs)) return { ok: false, status: 401, reason: "nonce_replay" };
  if (nonces.full(m[1], nowMs)) return { ok: false, status: 503, reason: "nonce_cache_full" };
  if (!nonces.take(m[1], req.nonce, nowMs)) return { ok: false, status: 401, reason: "nonce_replay" };
  return { ok: true, node: m[1] };
}
