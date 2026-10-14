import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PHARM_COOKIE, pharmacistTokenMatches, pharmacistTokenConfigured } from '@/lib/pharmacist-cookie';

export const runtime = 'nodejs';

// Pharmacist login for the audit surface. Posts the shared PHARMACIST_TOKEN;
// on match, sets the fail-closed `med_audit` cookie (httpOnly, Path=/).
export async function POST(req: NextRequest) {
  if (!pharmacistTokenConfigured()) {
    return NextResponse.json({ error: 'PHARMACIST_TOKEN not configured' }, { status: 503 });
  }
  let body: { token?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const token = (body.token || '').trim();
  if (!token || !pharmacistTokenMatches(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PHARM_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 12,
  });
  return res;
}
