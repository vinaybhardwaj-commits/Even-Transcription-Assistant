import { NextRequest, NextResponse } from 'next/server';
import { adminTokenMatches } from './admin-cookie';

// Bearer ADMIN_TOKEN or ?token=ADMIN_TOKEN, compared in constant time.
// ADMIN_TOKEN unset → deny. An unconfigured deployment is not an open one.
// The cat_admin cookie is a separate principal, checked by isAdminUnlocked();
// callers that accept either the cookie or the bearer keep that order themselves.
export function requireAdmin(req: NextRequest): NextResponse | null {
  if (!process.env.ADMIN_TOKEN) {
    const path = req.nextUrl?.pathname || '(unknown path)';
    console.error(`[admin-gate] ADMIN_TOKEN is unset; refusing ${path}. Fail closed.`);
    return NextResponse.json({ error: 'admin token not configured' }, { status: 401 });
  }

  const header = req.headers.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const qsToken = req.nextUrl.searchParams.get('token') || '';
  const presented = bearer || qsToken;
  if (adminTokenMatches(presented)) return null;

  return NextResponse.json({ error: 'admin token required' }, { status: 401 });
}
