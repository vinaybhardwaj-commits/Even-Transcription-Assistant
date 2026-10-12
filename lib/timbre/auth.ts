/**
 * lib/timbre/auth.ts — HMAC check for POST /api/timbre/ingest (Architecture #79: the GPU host holds this secret and no
 * database credential; brain_svc is never involved, #56).
 *
 * Headers: x-timbre-ts (unix seconds) and x-timbre-signature = hex HMAC-SHA256(secret, `${ts}.${rawBody}`), the same as
 * tools/timbre/store.py::sign. A timestamp more than 10 minutes off is refused (replay window). An unset or blank
 * TIMBRE_INGEST_SECRET FAILS CLOSED with 503. Never echoes a header or the secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TIMBRE_INGEST_SECRET_ENV = "TIMBRE_INGEST_SECRET";
export const MAX_SKEW_S = 600;

export type TimbreAuthFailure = { status: 401 | 503; error: "unauthorized" | "stale" | "not_configured" };

export function signTimbre(body: string, secret: string, ts: number): string {
  return createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
}

export function checkTimbreHmac(
  headers: Headers,
  rawBody: string,
  env: Record<string, string | undefined> = process.env,
  nowS: number = Math.floor(Date.now() / 1000),
): TimbreAuthFailure | null {
  const secret = env[TIMBRE_INGEST_SECRET_ENV]?.trim();
  if (!secret) return { status: 503, error: "not_configured" };
  const tsText = (headers.get("x-timbre-ts") ?? "").trim();
  const sig = (headers.get("x-timbre-signature") ?? "").trim().toLowerCase();
  if (!/^\d{9,11}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(sig)) return { status: 401, error: "unauthorized" };
  const ts = Number(tsText);
  if (Math.abs(nowS - ts) > MAX_SKEW_S) return { status: 401, error: "stale" };
  const want = Buffer.from(signTimbre(rawBody, secret, ts), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got) ? null : { status: 401, error: "unauthorized" };
}

/** GET variant for /api/timbre/consults: hex HMAC-SHA256(secret, `${ts}.GET ${pathAndQuery}`) — tools/timbre/nightly.py::sign_get. */
export function signTimbreGet(pathAndQuery: string, secret: string, ts: number): string {
  return createHmac("sha256", secret).update(`${ts}.GET ${pathAndQuery}`).digest("hex");
}

export function checkTimbreGet(
  headers: Headers,
  pathAndQuery: string,
  env: Record<string, string | undefined> = process.env,
  nowS: number = Math.floor(Date.now() / 1000),
): TimbreAuthFailure | null {
  const secret = env[TIMBRE_INGEST_SECRET_ENV]?.trim();
  if (!secret) return { status: 503, error: "not_configured" };
  const tsText = (headers.get("x-timbre-ts") ?? "").trim();
  const sig = (headers.get("x-timbre-signature") ?? "").trim().toLowerCase();
  if (!/^\d{9,11}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(sig)) return { status: 401, error: "unauthorized" };
  const ts = Number(tsText);
  if (Math.abs(nowS - ts) > MAX_SKEW_S) return { status: 401, error: "stale" };
  const want = Buffer.from(signTimbreGet(pathAndQuery, secret, ts), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got) ? null : { status: 401, error: "unauthorized" };
}
