/**
 * lib/encounter-catalog/auth.ts — HMAC for POST /api/encounter-catalog/ingest (migration 0168).
 *
 * Same scheme as the FreeScript ingest (lib/freescript/auth.ts): the lab box holds ENCOUNTER_CATALOG_INGEST_SECRET and no database
 * credential. Headers: x-catalog-ts (unix seconds) and x-catalog-signature = hex HMAC-SHA256(secret, `${ts}.${rawBody}`).
 * A timestamp more than 10 minutes off is refused. An unset or blank secret FAILS CLOSED with 503. Never echoes a header.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CATALOG_INGEST_SECRET_ENV = "ENCOUNTER_CATALOG_INGEST_SECRET";
export const CATALOG_TS_HEADER = "x-catalog-ts";
export const CATALOG_SIG_HEADER = "x-catalog-signature";
export const MAX_SKEW_S = 600;

export type CatalogAuthFailure = { status: 401 | 503; error: "unauthorized" | "stale" | "not_configured" };

export function signCatalog(body: string, secret: string, ts: number): string {
  return createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
}

export function checkCatalogHmac(
  headers: Headers,
  rawBody: string,
  env: Record<string, string | undefined> = process.env,
  nowS: number = Math.floor(Date.now() / 1000),
): CatalogAuthFailure | null {
  const secret = env[CATALOG_INGEST_SECRET_ENV]?.trim();
  if (!secret) return { status: 503, error: "not_configured" };
  const tsText = (headers.get(CATALOG_TS_HEADER) ?? "").trim();
  const sig = (headers.get(CATALOG_SIG_HEADER) ?? "").trim().toLowerCase();
  if (!/^\d{9,11}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(sig)) return { status: 401, error: "unauthorized" };
  const ts = Number(tsText);
  if (Math.abs(nowS - ts) > MAX_SKEW_S) return { status: 401, error: "stale" };
  const want = Buffer.from(signCatalog(rawBody, secret, ts), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got) ? null : { status: 401, error: "unauthorized" };
}
