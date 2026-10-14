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

/**
 * STRICT admin: refuses when `ADMIN_TOKEN` is ABSENT (D2 §2, Saul Rep 48).
 *
 * ⚠️ A SECOND HELPER, NOT A CHANGE TO `requireAdmin`. Rep 48 chose governance-specific fail-closed
 * authentication over a global change, and the reason is that `requireAdmin`'s fail-open branch is
 * load-bearing for local development on every other admin route in the app. Tightening it globally
 * would be a much larger blast radius than the defect being closed, and would be a security change
 * to routes nobody has reviewed for it. Other fail-open routes are separate security debt and are
 * explicitly out of D2's scope.
 *
 * ⚠️ WHY THE R3 ROUTES NEED THIS AT ALL. Until now they were made dormant by the FEATURE FLAG,
 * checked before auth, precisely because auth could not be relied on. That coupling is what this
 * removes: with authentication that actually refuses, the schema route no longer has to borrow the
 * flag's dormancy, and the flag goes back to meaning only what it says — whether the FEATURE is on.
 *
 * An absent token is a MISCONFIGURATION here, and it is reported as one rather than as a bad
 * credential, so an operator can tell "you did not present a token" from "this deployment has no
 * token configured, so nobody can authenticate".
 */
export function requireConfiguredAdmin(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'admin token is not configured on this deployment — refusing' }, { status: 401 });
  }
  const header = req.headers.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const qsToken = req.nextUrl.searchParams.get('token') || '';
  const presented = bearer || qsToken;
  if (presented && presented === expected) return null;
  return NextResponse.json({ error: 'admin token required' }, { status: 401 });
}
