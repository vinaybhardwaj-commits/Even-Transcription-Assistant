/**
 * lib/kiosk-health-auth.ts — the bearer check shared by the kiosk-facing routes (POST /api/kiosk-health, GET /api/steward/tickets).
 * Authorization: Bearer ${KIOSK_HEALTH_INGEST_TOKEN}, constant-time compare. A token saved with a trailing newline still matches (token is trimmed).
 */
import { timingSafeEqual } from "crypto";

/** The configured token, trimmed, or undefined when unset/blank. */
export function kioskIngestToken(): string | undefined {
  return process.env.KIOSK_HEALTH_INGEST_TOKEN?.trim() || undefined;
}

export function tokenOk(header: string, expected: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
