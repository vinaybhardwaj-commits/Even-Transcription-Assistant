/**
 * GET /api/care/review-stats — Review-Mode gamification stats (REVIEW-GAMIFICATION-PRD §4). CM-gated
 * (same authed() pattern as review-queue). Optional ?reviewer= adds a personal `me` block.
 *
 * ⚠️ SQL INFERRED (no live DB here). The route ONLY fetches the counted-label rows and delegates every
 * computation to lib/review-stats-core (goal parsing, counting basis §3.4, streak §3.2, pairwise
 * agreement §3.3). FAIL-SAFE: any error → { ok:true, degraded:true } with zeroed/empty fields (the UI
 * omits blocks) — NEVER a 500, so the identity screen never breaks reviewing.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { getSettings } from '@/lib/mini-backfill';
import {
  parseGoal, personalWeeklyTarget, computeReviewStats, DEFAULT_GOAL, FALLBACK_ROSTER,
  type LabelRow,
} from '@/lib/review-stats-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

function parseRoster(raw: string | undefined): string[] {
  if (!raw) return FALLBACK_ROSTER;
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) { const l = j.map((x) => String(x).trim()).filter(Boolean); if (l.length) return l; }
  } catch { /* fall through */ }
  return FALLBACK_ROSTER;
}
/** IST calendar 'today' (UTC+5:30), independent of the DB so it survives a fetch failure. */
function istToday(): string { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

export async function GET(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const reviewer = (req.nextUrl.searchParams.get('reviewer') || '').trim().slice(0, 64) || null;

  try {
    const settings = await getSettings(['review_goal', 'review_roster']).catch(() => ({} as Record<string, string>));
    const goal = parseGoal(settings.review_goal);
    const roster = parseRoster(settings.review_roster);

    // Counted-label rows for roster authors (finding + missed; impact excluded here AND in the core).
    // Ordered ASC so the core's current-state dedup ("later row wins") is correct. Fail-safe → [].
    // study-filter-exempt (D12): roster stats read UNFILTERED by design — study labels are counted
    // work for the roster's goal basis, and the roster match at :47 depends on raw stored authors.
    const rows = (await run(
      `SELECT author, scope, audit_id::text AS audit_id, finding_ref, verdict,
              to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day
       FROM opd_audit_feedback
       WHERE app_source = $1 AND scope IN ('finding','missed') AND author = ANY($2) AND author IS NOT NULL
       ORDER BY created_at ASC`,
      [APP, roster]).catch(() => [])) as Array<Record<string, unknown>>;

    const labelRows: LabelRow[] = rows.map((r) => ({
      author: String(r.author), scope: String(r.scope),
      audit_id: r.audit_id == null ? '' : String(r.audit_id),
      finding_ref: r.finding_ref == null ? null : String(r.finding_ref),
      verdict: r.verdict == null ? null : String(r.verdict),
      day: String(r.day || ''),
    }));

    const stats = computeReviewStats({ rows: labelRows, roster, today: istToday(), goal });
    const me = reviewer && stats.perAuthor[reviewer]
      ? { week: stats.perAuthor[reviewer].week, personal_weekly_target: stats.personal_weekly_target, streak: stats.perAuthor[reviewer].streak }
      : undefined;

    return NextResponse.json({ ok: true, goal: stats.goal, roster, team: stats.team, badges: stats.badges, ...(me ? { me } : {}) });
  } catch {
    // degraded: zeroed fields so the UI renders exactly as today (no block, no badges), never a 500.
    const roster = FALLBACK_ROSTER;
    const me = reviewer ? { week: 0, personal_weekly_target: personalWeeklyTarget(DEFAULT_GOAL.weekly_target, roster.length), streak: 0 } : undefined;
    return NextResponse.json({
      ok: true, degraded: true,
      goal: { target: DEFAULT_GOAL.target, label: DEFAULT_GOAL.label, weekly_target: DEFAULT_GOAL.weekly_target },
      roster, team: { total: 0, week: 0 }, badges: [], ...(me ? { me } : {}),
    });
  }
}
