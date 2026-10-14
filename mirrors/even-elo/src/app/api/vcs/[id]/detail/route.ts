import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { pullVcData } from "@/lib/scoring/persist";
import { computeScore } from "@/lib/scoring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteParams {
  params: { id: string };
}

/**
 * GET /api/vcs/[id]/detail
 *
 * Returns everything the per-VC dashboard needs in one round trip:
 *   - VC metadata
 *   - Latest snapshot (composite + 3 component scores + tier)
 *   - 90-day snapshot history (for trajectory chart)
 *   - Fresh engine result with per-stream sub-scores (component breakdown)
 *   - Recent activity (last 50 audit_log entries scoped to this VC)
 *   - Cases list with completion % per case
 *   - Stream catalogue (so the UI can label sub-scores)
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  try {
    const vcRows = (await sql`
      SELECT id, full_name, specialty, registration_no, status, created_at
      FROM vcs WHERE id = ${params.id}
    `) as Array<Record<string, unknown>>;
    if (vcRows.length === 0) {
      return NextResponse.json({ ok: false, error: "VC not found" }, { status: 404 });
    }
    const vc = vcRows[0];

    // Run the engine fresh against current DB state to get per-stream sub-scores.
    const data = await pullVcData(params.id);
    const result = computeScore({
      cases: data.cases,
      observations: data.observations,
      streams: data.streams,
      weights: data.weights,
    });

    // Snapshot history (last 90 days) for trajectory chart.
    const snapshotHistory = await sql`
      SELECT
        composite::float AS composite,
        caseload_score::float AS caseload_score,
        outcomes_score::float AS outcomes_score,
        adherence_score::float AS adherence_score,
        tier, low_confidence, trigger, computed_at
      FROM score_snapshots
      WHERE vc_id = ${params.id}
        AND computed_at >= now() - INTERVAL '90 days'
      ORDER BY computed_at ASC
    `;

    // Cases for this VC with completion %.
    const casesRows = await sql`
      SELECT
        sc.id, sc.case_ref, sc.surgery_date::text AS surgery_date,
        sc.procedure_label, sc.patient_name, sc.case_status,
        (
          SELECT COUNT(DISTINCT co.stream_id)::int
          FROM case_observations co
          WHERE co.case_id = sc.id AND co.is_current = true
        ) AS observation_count
      FROM surgical_cases sc
      WHERE sc.vc_id = ${params.id}
      ORDER BY sc.surgery_date DESC
      LIMIT 100
    `;

    // Number of `unknown`-default streams (the denominator for completion %).
    const requiredStreamCount = data.streams.filter((s) => s.default_rule === "unknown").length;

    // Activity feed (last 50). Joins audit_log with surgical_cases for case_ref display.
    const activity = await sql`
      SELECT
        al.id, al.actor_position, al.action, al.entity_type, al.entity_id,
        al.before_json, al.after_json, al.at,
        sc.case_ref AS case_ref_for_obs
      FROM audit_log al
      LEFT JOIN case_observations co ON al.entity_type = 'observation' AND co.id::text = al.entity_id
      LEFT JOIN surgical_cases sc ON co.case_id = sc.id
      WHERE
        (al.entity_type = 'vc' AND al.entity_id = ${params.id})
        OR (al.entity_type = 'observation' AND co.case_id IN (
            SELECT id FROM surgical_cases WHERE vc_id = ${params.id}
          ))
        OR (al.entity_type = 'case' AND al.entity_id IN (
            SELECT id::text FROM surgical_cases WHERE vc_id = ${params.id}
          ))
      ORDER BY al.at DESC
      LIMIT 50
    `;

    return NextResponse.json({
      ok: true,
      vc,
      result,
      streams: data.streams,
      snapshot_history: snapshotHistory,
      cases: casesRows,
      activity,
      required_stream_count: requiredStreamCount,
      weights: data.weights,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
