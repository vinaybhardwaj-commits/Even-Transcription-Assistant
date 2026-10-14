/**
 * app/api/admin/migrate-rule-governance/route.ts — the runner for migration 0039 (R3-A).
 * Copies app/api/admin/migrate-lvp-hidden/route.ts, with the flag check added FIRST.
 *
 * IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step: an operator GETs it once, after
 * the deploy is READY and after LVC_RULE_GOVERNANCE_ENABLED has been set to '1'.
 *
 * THE FLAG IS CHECKED BEFORE THE AUTH GATE, deliberately. requireAdmin() FAILS OPEN when
 * ADMIN_TOKEN is unset (lib/admin-gate.ts:6 — "if unset (dev mode), allow all"), so auth is not
 * what makes this dormant. The flag is: unset ⇒ 404, before any auth work, any DDL and any DB
 * connection (kickoff §6 trap 5, acceptance 6).
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureRuleGovernanceTables, ruleGovernanceEnabled } from '@/lib/rule-governance-store';

export const runtime = 'nodejs';

/** One-click, idempotent: create the four rule-governance objects (migration 0039).
 *  Flag first, then admin session or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!ruleGovernanceEnabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
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
