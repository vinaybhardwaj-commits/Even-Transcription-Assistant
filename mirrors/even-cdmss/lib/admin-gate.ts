import { NextRequest, NextResponse } from 'next/server';

// If ADMIN_TOKEN env var is set, require it via Authorization: Bearer <token> or ?token=<token>.
// If unset (dev mode), allow all.
export function requireAdmin(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return null; // dev mode

  const header = req.headers.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const qsToken = req.nextUrl.searchParams.get('token') || '';
  const presented = bearer || qsToken;
  if (presented && presented === expected) return null;

  return NextResponse.json({ error: 'admin token required' }, { status: 401 });
}
