/**
 * lib/freescript/auth.ts — HMAC for POST /api/freescript/ingest and GET /api/freescript/pending.
 *
 * The box holds FREESCRIPT_INGEST_SECRET and no database credential. Headers: x-freescript-ts (unix seconds) and
 * x-freescript-signature = hex HMAC-SHA256(secret, `${ts}.${rawBody}`) for POST, or `${ts}.GET ${pathAndQuery}` for GET.
 * A timestamp more than 10 minutes off is refused. An unset or blank secret FAILS CLOSED with 503. Never echoes a header.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const FREESCRIPT_INGEST_SECRET_ENV = "FREESCRIPT_INGEST_SECRET";
export const MAX_SKEW_S = 600;

export type FreescriptAuthFailure = { status: 401 | 503; error: "unauthorized" | "stale" | "not_configured" };

export function signFreescript(body: string, secret: string, ts: number): string {
  return createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
}

export function signFreescriptGet(pathAndQuery: string, secret: string, ts: number): string {
  return createHmac("sha256", secret).update(`${ts}.GET ${pathAndQuery}`).digest("hex");
}

function check(
  headers: Headers,
  mac: (secret: string, ts: number) => string,
  env: Record<string, string | undefined>,
  nowS: number,
): FreescriptAuthFailure | null {
  const secret = env[FREESCRIPT_INGEST_SECRET_ENV]?.trim();
  if (!secret) return { status: 503, error: "not_configured" };
  const tsText = (headers.get("x-freescript-ts") ?? "").trim();
  const sig = (headers.get("x-freescript-signature") ?? "").trim().toLowerCase();
  if (!/^\d{9,11}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(sig)) return { status: 401, error: "unauthorized" };
  const ts = Number(tsText);
  if (Math.abs(nowS - ts) > MAX_SKEW_S) return { status: 401, error: "stale" };
  const want = Buffer.from(mac(secret, ts), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got) ? null : { status: 401, error: "unauthorized" };
}

export function checkFreescriptHmac(
  headers: Headers,
  rawBody: string,
  env: Record<string, string | undefined> = process.env,
  nowS: number = Math.floor(Date.now() / 1000),
): FreescriptAuthFailure | null {
  return check(headers, (secret, ts) => signFreescript(rawBody, secret, ts), env, nowS);
}

export function checkFreescriptGet(
  headers: Headers,
  pathAndQuery: string,
  env: Record<string, string | undefined> = process.env,
  nowS: number = Math.floor(Date.now() / 1000),
): FreescriptAuthFailure | null {
  return check(headers, (secret, ts) => signFreescriptGet(pathAndQuery, secret, ts), env, nowS);
}
