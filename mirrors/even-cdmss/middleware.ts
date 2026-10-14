import { NextResponse, type NextRequest } from 'next/server';

// Host-based routing + surface tagging.
//   medaudit.evenos.app  → ONLY the Clinical Pharmacist audit surface, and the
//                          root layout renders it CHROME-FREE (no CAT sidebar).
//   even-cdmss.vercel.app (CAT) → untouched; the audit tool appears as a nav item.
// We tag the request with `x-surface: medaudit` so the (server) root layout can
// decide chrome by HOST — robust even for the bare domain, which is rewritten to
// /audit (a path-based check missed that and leaked the CAT sidebar through).
export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase();
  if (!host.startsWith('medaudit.')) return NextResponse.next();

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-surface', 'medaudit');
  const { pathname } = req.nextUrl;

  if (pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/audit';
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }
  const allowed =
    pathname.startsWith('/audit') ||
    pathname.startsWith('/api/audit') ||
    pathname.startsWith('/api/drugs'); // shared interaction engine
  if (allowed) return NextResponse.next({ request: { headers: requestHeaders } });

  const url = req.nextUrl.clone();
  url.pathname = '/audit';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|globals.css|icon.png).*)'],
};
