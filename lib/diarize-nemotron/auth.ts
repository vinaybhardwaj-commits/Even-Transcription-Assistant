/**
 * lib/diarize-nemotron/auth.ts — the bearer check for /api/diarize/nemotron/{pending,ingest,heartbeat}.
 *
 * Authorization: Bearer <NEMOTRON_WORKER_TOKEN>. The worker holds this token and nothing else — no
 * database credential (PRD §6.1). Same compare as lib/brain/auth.ts: SHA-256 digests through
 * timingSafeEqual, so a length mismatch does not short-circuit. The configured token is trimmed, because
 * a token saved with a trailing newline must still match (the kiosk-health lesson). An unset or blank
 * token FAILS CLOSED with 503, never opens.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const NEMOTRON_WORKER_TOKEN_ENV = "NEMOTRON_WORKER_TOKEN";

export type WorkerAuthFailure = { status: 401 | 503; error: "unauthorized" | "not_configured" };

/** Null when authorised, else the failure to send. Never throws, never echoes a header or the token. */
export function checkWorkerBearer(req: Request, env: Record<string, string | undefined> = process.env): WorkerAuthFailure | null {
  const expected = env[NEMOTRON_WORKER_TOKEN_ENV]?.trim();
  if (!expected) return { status: 503, error: "not_configured" };
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  if (!m) return { status: 401, error: "unauthorized" };
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? null : { status: 401, error: "unauthorized" };
}
