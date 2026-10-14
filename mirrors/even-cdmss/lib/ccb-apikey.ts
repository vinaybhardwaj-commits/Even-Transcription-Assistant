import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

// Programmatic API-key auth for the CCB consumer API (Pulse). Separate from CRON_SECRET so an
// external consumer gets its own scoped key. Presented via `x-api-key` or `Authorization: Bearer`.
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

export function ccbApiKeyConfigured(): boolean { return !!process.env.CCB_API_KEY; }

export function ccbApiKeyValid(req: NextRequest): boolean {
  const key = process.env.CCB_API_KEY;
  if (!key) return false;
  const hdr = req.headers.get('x-api-key') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const presented = hdr || bearer;
  return !!presented && safeEq(presented, key);
}
