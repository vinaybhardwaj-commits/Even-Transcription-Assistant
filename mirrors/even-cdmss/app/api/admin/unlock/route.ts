export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { ADMIN_COOKIE } from '@/lib/admin-cookie';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// Unlock the observability surface: POST a token (form field) -> set httpOnly
// cookie if it matches ADMIN_TOKEN, then redirect back. Token is never placed
// in a URL. Also clears the cookie on ?action=logout.
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_TOKEN || '';
  const dest = new URL('/admin/observability', req.url);

  if (req.nextUrl.searchParams.get('action') === 'logout') {
    const res = NextResponse.redirect(dest, { status: 303 });
    res.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
    return res;
  }

  const form = await req.formData().catch(() => null);
  const presented = String(form?.get('token') ?? '');
  if (!token || !presented || !safeEq(presented, token)) {
    dest.searchParams.set('locked', '1');
    return NextResponse.redirect(dest, { status: 303 });
  }
  const res = NextResponse.redirect(dest, { status: 303 });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
