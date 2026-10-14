import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { CARE_COOKIE, careTokenMatches, careTokenConfigured } from '@/lib/care-cookie';

export const runtime = 'nodejs';

// Care-manager login for the /care surface. Posts the shared CARE_TOKEN; on match, sets the
// fail-closed `cat_care` cookie (httpOnly, Path=/). Mirrors app/api/audit/login.
export async function POST(req: NextRequest) {
  if (!careTokenConfigured()) {
    return NextResponse.json({ error: 'CARE_TOKEN not configured' }, { status: 503 });
  }
  let body: { token?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const token = (body.token || '').trim();
  if (!token || !careTokenMatches(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(CARE_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 12,
  });
  return res;
}
