/**
 * lib/kiosk-health-auth.ts — the bearer check shared by the kiosk-facing routes (POST /api/kiosk-health, GET /api/steward/tickets).
 * Authorization: Bearer ${KIOSK_HEALTH_INGEST_TOKEN}, constant-time compare. A token saved with a trailing newline still matches (token is trimmed).
 * A second credential, checked against KIOSK_HEALTH_POLLER_TOKEN_SHA256 (hex SHA-256 of the token; the server never holds the token), is accepted by POST /api/kiosk-health ONLY (never by the steward tickets route) and may post only POLLER_KIND events from POLLER_SOURCE.
 */
import { createHash, timingSafeEqual } from "crypto";

/** The configured token, trimmed, or undefined when unset/blank. */
export function kioskIngestToken(): string | undefined {
  return process.env.KIOSK_HEALTH_INGEST_TOKEN?.trim() || undefined;
}

let warnedBadHash = false;

/** The poller token's SHA-256 digest from env (64 hex chars, trimmed), or undefined when unset, blank or malformed (the poller path is then off). */
export function kioskPollerTokenHash(): Buffer | undefined {
  const raw = process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256?.trim();
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    if (!warnedBadHash) {
      warnedBadHash = true;
      console.error("[kiosk-health] poller token hash is malformed; poller path disabled");
    }
    return undefined;
  }
  return Buffer.from(raw, "hex");
}

/** True when the header is exactly "Bearer <token>" and sha256(token) equals the configured digest (constant-time compare of the 32-byte digests). */
export function pollerTokenOk(header: string): boolean {
  const want = kioskPollerTokenHash();
  if (!want || !header.startsWith("Bearer ")) return false;
  const got = createHash("sha256").update(header.slice("Bearer ".length).trim()).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The only kind and source a poller-token post may carry. */
export const POLLER_KIND = "mic_guard";
export const POLLER_SOURCE = "mini_micguard_poller";

export function tokenOk(header: string, expected: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
