/**
 * Gate for the medication-audit surface (`/audit`, `/api/audit`).
 *
 * A principal is the pharmacist session cookie or the admin unlock cookie.
 * The host is not consulted: cat.evenos.app and medaudit.evenos.app use the
 * same rule. Middleware used to set `x-surface: medaudit` and the page gate
 * skipped the cookie check for every other host.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { secretEqual } from './secret-equal';
import { isPublicPath } from './public-routes';

export const PHARMACIST_COOKIE = 'med_audit';
export const ADMIN_SESSION_COOKIE = 'cat_admin';

export function isAuditSurface(pathname: string): boolean {
  return pathname === '/audit'
    || pathname.startsWith('/audit/')
    || pathname === '/api/audit'
    || pathname.startsWith('/api/audit/');
}

export function auditPrincipalFromCookies(
  pharmacistCookie: string,
  adminCookie: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const pharmacistToken = env.PHARMACIST_TOKEN;
  const adminToken = env.ADMIN_TOKEN;
  if (pharmacistToken && secretEqual(pharmacistCookie, pharmacistToken)) return true;
  if (adminToken && secretEqual(adminCookie, adminToken)) return true;
  return false;
}

/** Null means the request may proceed. A response means deny. */
export function auditGateResponse(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname;
  if (!isAuditSurface(pathname) || isPublicPath(pathname)) return null;
  const pharmacistCookie = req.cookies.get(PHARMACIST_COOKIE)?.value || '';
  const adminCookie = req.cookies.get(ADMIN_SESSION_COOKIE)?.value || '';
  if (auditPrincipalFromCookies(pharmacistCookie, adminCookie)) return null;
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'auth required' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/audit/login';
  url.search = '';
  return NextResponse.redirect(url);
}
