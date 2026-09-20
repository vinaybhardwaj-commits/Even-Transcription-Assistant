import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

// Require ADMIN_TOKEN via Authorization: Bearer <token> or ?token=<token>.
//
// AN UNSET (OR EMPTY, OR BLANK) ADMIN_TOKEN MEANS REFUSE, NEVER ALLOW. This used to read
// `if (!expected) return null; // dev mode`, so a deployment with the secret missing let every
// caller through — the fall-through app/api/run-migrations/route.ts avoids by refusing when its
// secret is unset. The refusal is the same 401 a wrong token gets, so a caller cannot tell "not
// configured" from "wrong". A dev machine that wants the gate open sets a token and sends it.
//
// Both sides are hashed with SHA-256 before timingSafeEqual, so a length mismatch does not
// short-circuit. Neither the secret nor the presented value is logged or returned.
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export function requireAdmin(req: NextRequest): NextResponse | null {
  const refuse = () => NextResponse.json({ error: 'admin token required' }, { status: 401 });

  const expected = (process.env.ADMIN_TOKEN ?? '').trim();
  if (expected === '') return refuse(); // unset: there is nothing to compare against, so nothing can pass

  const header = req.headers.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const qsToken = req.nextUrl.searchParams.get('token') || '';
  const presented = bearer || qsToken;
  if (presented && timingSafeEqual(sha256(presented), sha256(expected))) return null;

  return refuse();
}
