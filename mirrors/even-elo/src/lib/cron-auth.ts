/**
 * Cron route authentication (A1).
 *
 * The only accepted credential is `Authorization: Bearer ${CRON_SECRET}`, which Vercel Cron sends
 * automatically when the CRON_SECRET env var is set on the project. Nothing else counts:
 *   · not the `vercel-cron/` User-Agent (any caller can send that header);
 *   · not a signed-in staff session (cron routes are machine endpoints; operators who need a manual
 *     run call them with the bearer token);
 *   · not "no secret configured" (a missing secret fails CLOSED with 503 and a log line, rather
 *     than falling back to something weaker).
 *
 * Pure and edge-safe (no node imports) so middleware.ts and the route handlers share one decision.
 */

import { NextResponse } from "next/server";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: "Unauthorized" | "cron_not_configured" };

/** Constant-time string comparison (length is not secret: the secret's length is fixed per deploy). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PURE. Decide a cron request from its Authorization header and the configured secret. */
export function checkCronAuth(
  authorization: string | null | undefined,
  secret: string | undefined,
): CronAuthResult {
  if (!secret) return { ok: false, status: 503, error: "cron_not_configured" };
  const header = authorization ?? "";
  const expected = `Bearer ${secret}`;
  if (!safeEqual(header, expected)) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true };
}

/**
 * Route guard. Returns a response to send when the request is refused, or null when it may proceed.
 * Logs the misconfiguration case so a missing CRON_SECRET is visible in Vercel logs, not silent.
 */
export function cronGuard(req: Request, route: string): NextResponse | null {
  const result = checkCronAuth(req.headers.get("authorization"), process.env.CRON_SECRET);
  if (result.ok) return null;
  if (result.status === 503) {
    console.error(`[cron-auth] CRON_SECRET is not set; refusing ${route} (fail closed)`);
  }
  return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
}
