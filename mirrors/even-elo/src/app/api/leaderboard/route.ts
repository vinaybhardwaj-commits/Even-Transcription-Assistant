import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/leaderboard[?status=active|all][?include_no_snapshot=true]
 *
 * Returns one row per VC with their LATEST score_snapshot fields and a
 * 6-month observation count. Default filters to active VCs that have at
 * least one snapshot.
 *
 * Sort: composite DESC NULLS LAST. The UI does its own client-side sort
 * once data is loaded.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const status = params.get("status") ?? "active";
    const includeNoSnapshot = params.get("include_no_snapshot") === "true";

    // DISTINCT ON gets the latest snapshot per VC.
    // 6mo obs count groups case_observations by vc_id (via the case join).
    const rows = await sql`
      WITH latest_snapshots AS (
        SELECT DISTINCT ON (vc_id)
          vc_id, composite, caseload_score, outcomes_score, adherence_score,
          tier, low_confidence, computed_at, weights_version_id
        FROM score_snapshots
        ORDER BY vc_id, computed_at DESC
      ),
      obs_counts AS (
        SELECT sc.vc_id, COUNT(*)::int AS total_observations
        FROM case_observations co
        JOIN surgical_cases sc ON sc.id = co.case_id
        WHERE co.is_current = true
          AND sc.surgery_date >= (CURRENT_DATE - INTERVAL '180 days')
        GROUP BY sc.vc_id
      ),
      case_counts_window AS (
        SELECT vc_id, COUNT(*)::int AS case_count_window
        FROM surgical_cases
        WHERE case_status = 'completed'
          AND surgery_date >= (CURRENT_DATE - INTERVAL '180 days')
        GROUP BY vc_id
      )
      SELECT
        v.id AS vc_id,
        v.full_name,
        v.specialty,
        v.registration_no,
        v.status,
        ls.composite::float AS composite,
        ls.caseload_score::float AS caseload_score,
        ls.outcomes_score::float AS outcomes_score,
        ls.adherence_score::float AS adherence_score,
        ls.tier,
        ls.low_confidence,
        ls.computed_at,
        COALESCE(oc.total_observations, 0) AS total_observations,
        COALESCE(cc.case_count_window, 0) AS case_count_window
      FROM vcs v
      LEFT JOIN latest_snapshots ls ON ls.vc_id = v.id
      LEFT JOIN obs_counts oc ON oc.vc_id = v.id
      LEFT JOIN case_counts_window cc ON cc.vc_id = v.id
      WHERE (${status} = 'all' OR v.status = ${status})
        AND (${includeNoSnapshot} OR ls.composite IS NOT NULL)
      ORDER BY ls.composite DESC NULLS LAST, v.full_name ASC
    `;

    // Tier distribution counts.
    const distRows = await sql`
      WITH latest AS (
        SELECT DISTINCT ON (s.vc_id) s.tier
        FROM score_snapshots s
        JOIN vcs v ON v.id = s.vc_id
        WHERE (${status} = 'all' OR v.status = ${status})
        ORDER BY s.vc_id, s.computed_at DESC
      )
      SELECT tier, COUNT(*)::int AS n FROM latest GROUP BY tier
    `;
    const distribution: Record<string, number> = {};
    for (const r of distRows as Array<{ tier: string; n: number }>) {
      distribution[r.tier] = r.n;
    }

    const currentWeights = (await sql`
      SELECT caseload_pct, outcomes_pct, adherence_pct
      FROM weight_versions WHERE is_current = true LIMIT 1
    `) as Array<{ caseload_pct: number; outcomes_pct: number; adherence_pct: number }>;

    return NextResponse.json({
      ok: true,
      rows,
      distribution,
      total: (rows as unknown[]).length,
      weights: currentWeights[0] ?? null,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
