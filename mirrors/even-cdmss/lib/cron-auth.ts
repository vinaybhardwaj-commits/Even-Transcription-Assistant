/**
 * Cron and worker authorization.
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set
 * on the project. That bearer token is the only cron credential this module accepts.
 *
 * `x-vercel-cron` is not a credential. Any caller can set it, and it used to
 * authorize the OPD worker and the other scheduled routes by itself.
 * A `?secret=` query value is not a cron credential either: it lands in access logs.
 *
 * CRON_SECRET unset → refuse and log. An unconfigured deployment is not an open one.
 */
import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { secretEqual } from './secret-equal';

function timingSafeEqualString(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const ab = Buffer.from(presented);
  const bb = Buffer.from(expected);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

export function bearerToken(authorization: string | null): string {
  const header = authorization || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

export function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    const path = req.nextUrl?.pathname || '(unknown path)';
    console.error(`[cron-auth] CRON_SECRET is unset; refusing ${path}. Vercel Cron sends Authorization: Bearer only when CRON_SECRET is set. Fail closed.`);
    return false;
  }
  const presented = bearerToken(req.headers.get('authorization'));
  if (!presented) return false;
  return timingSafeEqualString(presented, expected);
}

/**
 * Pulse patient-summary (V1 pilot) still presents the shared CRON_SECRET, either as
 * a bearer token or as `?secret=`. That sharing cannot be split in this change —
 * rotating Pulse onto its own key is an ops follow-up. The compare is constant-time
 * and fails closed when the secret is unset. This is not a cron grant: cron routes
 * do not call it, and it does not accept `x-vercel-cron`.
 */
export function pilotSharedSecretAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[patient-summary] CRON_SECRET is unset; refusing (fail closed). This pilot reuses CRON_SECRET and must be split before live clinical traffic.');
    return false;
  }
  const bearer = bearerToken(req.headers.get('authorization'));
  const query = req.nextUrl.searchParams.get('secret') || '';
  const bearerOk = bearer ? secretEqual(bearer, expected) : false;
  const queryOk = query ? secretEqual(query, expected) : false;
  return bearerOk || queryOk;
}
