/**
 * lib/gov-auth.ts — GOV_API_KEY check for the governance contract endpoints.
 * Same service-key pattern as /api/governance/opd-signals (x-api-key OR Bearer). EPI proxies
 * server-side; the token never reaches a browser. Admin session is also accepted (for testing).
 */
import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

export function govKeyValid(req: NextRequest): boolean {
  const key = process.env.GOV_API_KEY;
  if (!key) return false;
  const hdr = req.headers.get('x-api-key') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const presented = hdr || bearer || req.nextUrl.searchParams.get('token') || '';
  if (!presented) return false;
  const a = Buffer.from(presented); const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}
