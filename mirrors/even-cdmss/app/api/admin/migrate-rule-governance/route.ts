/**
 * app/api/admin/migrate-rule-governance/route.ts — the runner for migration 0039 (R3-A).
 * Copies app/api/admin/migrate-lvp-hidden/route.ts. It once added a flag check FIRST; it no
 * longer does — see the note below. This route authenticates STRICTLY and does not gate on the
 * feature flag.
 *
 * IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step: an operator GETs it once, after
 * the deploy is READY.
 *
 * ⚠️ THE FLAG CHECK IS GONE, AND THE DOC BLOCK THAT JUSTIFIED IT WAS TRUE WHEN IT WAS WRITTEN
 * (D2 §2, Saul Rep 48). It used to say the flag ran BEFORE auth because `requireAdmin()` FAILS
 * OPEN when ADMIN_TOKEN is unset — "if unset (dev mode), allow all" — so auth was not what made
 * this route dormant; the flag was. That reasoning was sound and its premise is now false: this
 * route authenticates with `requireConfiguredAdmin`, which REFUSES when ADMIN_TOKEN is absent
 * instead of allowing all. Auth is now what makes it safe, so the flag no longer has to.
 *
 * ⚠️ AND THE FLAG MUST NOT GATE IT ANY MORE, WHICH IS THE POINT RATHER THAN A SIMPLIFICATION.
 * Creating the SCHEMA and enabling the FEATURE are different decisions, and coupling them forced
 * an operator to turn the feature on in order to create empty tables — arming the thing before its
 * storage existed. Schema is authenticated; the FEATURE stays exact-flag gated everywhere it
 * matters, which is the proposal route and every operational store write.
 *
 * ⚠️ NO ADMIN-COOKIE BYPASS ON THIS ROUTE. The cookie is a browser session, and admitting it would
 * reintroduce a path that does not depend on a configured credential — which is the whole defect
 * being closed. The cookie remains in use on unrelated admin routes.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireConfiguredAdmin } from '@/lib/admin-gate';
import { ensureRuleGovernanceTables } from '@/lib/rule-governance-store';

export const runtime = 'nodejs';

/** One-click, idempotent: create the four rule-governance objects (migration 0039).
 *  STRICT admin only — no flag, no cookie. */
export async function GET(req: NextRequest) {
  const denied = requireConfiguredAdmin(req);
  if (denied) return denied;
  try {
    await ensureRuleGovernanceTables();
    return NextResponse.json({
      ok: true,
      migrated: ['lvc_rule_versions', 'lvc_rule_activation_events', 'rule_pattern_map', 'v_lvc_rule_validity'],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
